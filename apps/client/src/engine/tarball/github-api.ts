import { ENGINE_CONFIG, GITHUB_ENDPOINTS } from '../../lib/config';
import type { ArchiveDiff } from './archive-store';

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': ENGINE_CONFIG.userAgent };
  const effectiveToken = token || process.env.GITHUB_TOKEN;
  if (effectiveToken) {
    headers['Authorization'] = `Bearer ${effectiveToken}`;
  }
  return headers;
}

export interface BranchHeadProbe {
  status: 'changed' | 'not-modified';
  sha?: string;
  etag?: string;
}

async function fetchBranchHead(
  owner: string,
  repo: string,
  branch: string,
  opts: { ifNoneMatch?: string | null; token?: string } = {}
): Promise<BranchHeadProbe> {
  const url = `${GITHUB_ENDPOINTS.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`;
  const headers = githubHeaders(opts.token);
  if (opts.ifNoneMatch) {
    headers['If-None-Match'] = opts.ifNoneMatch;
  }
  const { githubFetch } = await import('../../lib/github/client');
  const res = await githubFetch(
    url,
    { headers },
    { explicitToken: opts.token, endpointClass: 'api-core' },
  );

  if (res.status === 304) {
    // 304 responses with If-None-Match do not count against GitHub core rate limits.
    return { status: 'not-modified', etag: res.headers.get('etag') ?? opts.ifNoneMatch ?? undefined };
  }
  if (!res.ok) {
    throw new Error(`[RepoTarball] Failed to resolve sha for ${owner}/${repo}@${branch}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { sha?: string };
  if (!data.sha) {
    throw new Error(`[RepoTarball] No sha returned for ${owner}/${repo}@${branch}`);
  }
  return { status: 'changed', sha: data.sha, etag: res.headers.get('etag') ?? undefined };
}

export async function resolveLatestSha(owner: string, repo: string, branch: string, token?: string): Promise<string> {
  const probe = await fetchBranchHead(owner, repo, branch, { token });
  if (probe.status !== 'changed' || !probe.sha) {
    throw new Error(`[RepoTarball] Unexpected probe status for ${owner}/${repo}@${branch}`);
  }
  return probe.sha;
}

// GitHub Compare caps files at 300 and commits at 250 without a truncated flag; hitting either falls back to archive diff.
const COMPARE_API_MAX_FILES = 300;
const COMPARE_API_MAX_COMMITS = 250;

export interface GitHubCompareFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  previous_filename?: string;
}

export interface GitHubCompareResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files?: GitHubCompareFile[];
}

export async function fetchCompareDiff(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  token?: string
): Promise<ArchiveDiff | null> {
  if (!baseSha || !headSha || baseSha === headSha) return null;

  try {
    const url = `${GITHUB_ENDPOINTS.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`;
    const headers = githubHeaders(token);
    const { githubFetch } = await import('../../lib/github/client');
    const res = await githubFetch(
      url,
      { headers },
      { explicitToken: token, endpointClass: 'api-core' },
    );

    if (!res.ok) {
      console.warn(`[RepoTarball] fetchCompareDiff HTTP ${res.status} for ${owner}/${repo}@${baseSha}...${headSha}`);
      return null;
    }

    const data = (await res.json()) as GitHubCompareResponse;
    const files = data.files || [];
    if (files.length >= COMPARE_API_MAX_FILES) {
      console.warn(`[RepoTarball] fetchCompareDiff files hit GitHub cap (${files.length}/${COMPARE_API_MAX_FILES}), possibly truncated`);
      return null;
    }
    if ((data.total_commits ?? 0) >= COMPARE_API_MAX_COMMITS) {
      console.warn(`[RepoTarball] fetchCompareDiff total_commits hit GitHub cap (${data.total_commits}/${COMPARE_API_MAX_COMMITS}), possibly truncated`);
      return null;
    }
    // Force-push divergence makes three-dot compare relative to merge-base rather than fromSha->toSha; fall back to archive diff.
    if (data.status === 'diverged') {
      console.warn(`[RepoTarball] fetchCompareDiff status=diverged for ${owner}/${repo}@${baseSha}...${headSha}`);
      return null;
    }

    const added = new Set<string>();
    const modified = new Set<string>();
    const removed = new Set<string>();
    const renamed: Array<{ from: string; to: string }> = [];

    for (const f of files) {
      if (!f.filename) continue;
      switch (f.status) {
        case 'added':
          added.add(f.filename);
          break;
        case 'modified':
        case 'changed':
          modified.add(f.filename);
          break;
        case 'removed':
          removed.add(f.filename);
          break;
        case 'renamed':
          if (f.previous_filename) {
            renamed.push({ from: f.previous_filename, to: f.filename });
          } else {
            added.add(f.filename);
          }
          break;
        default:
          modified.add(f.filename);
          break;
      }
    }

    return { added, modified, removed, renamed };
  } catch (error) {
    console.warn(`[RepoTarball] fetchCompareDiff failed for ${owner}/${repo}:`, error);
    return null;
  }
}

export async function fetchRawFileHead(
  owner: string,
  repo: string,
  sha: string,
  filePath: string,
  maxBytes?: number,
  token?: string
): Promise<string | null> {
  if (!sha || !filePath) return null;

  try {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = `${GITHUB_ENDPOINTS.raw}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/${encodedPath}`;
    const { githubFetch } = await import('../../lib/github/client');
    const res = await githubFetch(
      url,
      { headers: githubHeaders(token) },
      { explicitToken: token, endpointClass: 'raw' },
    );

    if (!res.ok || !res.body) {
      console.warn(`[RepoTarball] fetchRawFileHead HTTP ${res.status} for ${owner}/${repo}@${sha}/${filePath}`);
      return null;
    }

    const cap = maxBytes && maxBytes > 0 ? maxBytes : 64 * 1024;
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    while (received < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.byteLength;
    }
    void reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks).subarray(0, cap).toString('utf8');
  } catch (error) {
    console.warn(`[RepoTarball] fetchRawFileHead failed for ${owner}/${repo}@${sha}/${filePath}:`, error);
    return null;
  }
}

// 职责：GitHub 轻量 API 面（repo-tarball 拆分模块之二）。
// - 分支头探测（fetchBranchHead / resolveLatestSha，304 零配额）
// - Compare API 文件变动清单（fetchCompareDiff，300 files / 250 commits 截断护栏）
// - raw 文件头部拉取（fetchRawFileHead，读满即断流）
// 任一 API 失败/触线返回 null 或抛错，调用方回退本地归档路径（archive-store / tree-parse）。

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

/** 分支头探测结果：changed=有新 commit（sha 必有）；not-modified=304（不计 GitHub 配额） */
export interface BranchHeadProbe {
  status: 'changed' | 'not-modified';
  sha?: string;
  /** 响应 ETag 原文（含 W/"…" 引号）；304 且响应无 ETag 时沿用传入的 previousEtag */
  etag?: string;
}

/**
 * 分支头条件探测核：GET /repos/{o}/{r}/commits/{branch}，支持 If-None-Match。
 * GitHub 对该端点的 304 响应不计入核心速率限额——上游保鲜轮询的配额基石。
 * 非 200/304 一律抛错（限流/网络/私仓不可见），调用方保留旧状态自行回退。
 */
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
  // 统一咽喉：显式 token 直用（调度器探测语义不变），配额头采样进埋点
  const { githubFetch } = await import('../../lib/github/client');
  const res = await githubFetch(
    url,
    { headers },
    { explicitToken: opts.token, endpointClass: 'api-core' },
  );

  if (res.status === 304) {
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

/**
 * 解析分支当前最新 commit sha（1 个廉价 API 请求）。
 * 失败抛错，调用方自行决定回退策略。
 */
export async function resolveLatestSha(owner: string, repo: string, branch: string, token?: string): Promise<string> {
  const probe = await fetchBranchHead(owner, repo, branch, { token });
  if (probe.status !== 'changed' || !probe.sha) {
    // 理论不可达（无 If-None-Match 不会 304）；防御性兜底
    throw new Error(`[RepoTarball] Unexpected probe status for ${owner}/${repo}@${branch}`);
  }
  return probe.sha;
}

/**
 * GitHub Compare API 截断护栏（官方文档口径）：
 * - files 数组硬上限恰为 300 条，无 files 分页、无 truncated 标志——达到上限即应视为"可能被截断"
 * - 无分页参数时 commits 列表硬上限 250 条（total_commits 达到即同样视为截断信号）
 * 任一触线返回 null 回退本地 Tarball 双归档精确 diff：宁慢勿漏文件。
 */
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

/**
 * 通过 GitHub Compare API（GET /repos/{owner}/{repo}/compare/{base}...{head}）轻量获取两版本间的文件变动清单。
 * 优势：单次轻量 JSON 请求（毫秒级），无需下载几十 MB 的全量 Tarball。
 * 失败（网络异常 / 截断触线 / base 与 head 分叉 / 404）时返回 null，调用方回退 diffArchives。
 */
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
    // force-push 等导致 base 与 head 分叉时，三点 diff 是"自共同祖先以来 head 侧的变化"，
    // ≠ 冻结版 → 新版 的真实差异；回退双归档 diff（按完整树对比，天然不受分叉影响）
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

/**
 * readFileLocal 的网络回退：按 sha 精确拉取 raw 文件头部（读满 maxBytes 即断流，不下载余量）。
 * 采样级用途——归档未就绪时避免为 1KB 片段下载整仓 Tarball；失败返回 null 由调用方跳过采样。
 */
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

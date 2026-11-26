import 'dotenv/config';
import fs from 'fs-extra';
import { wrapCodeAsMdx } from './code-to-mdx';
import { ENGINE_CONFIG, NOISY_PATH_PREFIXES, IGNORED_FILENAMES, ALLOWED_FILE_EXTENSIONS, GITHUB_ENDPOINTS, BINARY_EXTENSIONS, classifyExcludedFile, ExclusionCategoryKey } from '../lib/config';
import { MODULE_ROLE_PATTERNS } from './language-map';
import { getCachedTree, setCachedTree, hydrateTreeFromDisk } from '../lib/tree-cache';
import { ignoreBestEffort } from '@/lib/best-effort';

export interface GitHubNode {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  url: string;
  docType?: 'migration' | 'textbook' | 'standard' | string;
}

interface ExclusionItem {
  path: string;
  category: ExclusionCategoryKey;
  categoryLabel: string;
  reason: string;
  size?: number;
}

export interface ExclusionReport {
  totalExcludedCount: number;
  byCategory: Record<ExclusionCategoryKey, number>;
  sampleExcludedFiles: ExclusionItem[];
  allExcludedFiles?: ExclusionItem[];
}

function isHighPriorityMigrationFile(filePath: string): boolean {
  const normalized = filePath.replace(/^\/+/, '');
  const lower = normalized.toLowerCase();
  const segments = lower.split('/');
  const filename = segments[segments.length - 1];

  if (!MODULE_ROLE_PATTERNS.markdownExtensions.some(ext => filename.endsWith(ext))) {
    return false;
  }

  const stem = filename.replace(/\.mdx?$/, '');
  const { keywords, versionPattern } = MODULE_ROLE_PATTERNS.highPriorityMigrationPatterns;

  if (keywords.includes(stem) || segments.some(seg => keywords.includes(seg))) {
    return true;
  }

  if (versionPattern.test(stem)) {
    return true;
  }

  return false;
}

export class EmptyRepoError extends Error {
  code = 'EMPTY_REPO';
  statusCode = 422;
  httpStatus = 422;
  constructor(message = '仓库没有任何可读内容（空仓库或全部文件被忽略）') {
    super(message);
    this.name = 'EmptyRepoError';
  }
}

const FETCHER_404_RETRY_DELAY_MS = 800;

export class Fetcher {
  private owner: string;
  private repo: string;
  private branch: string;
  private headers: Record<string, string>;
  private explicitToken?: string;
  private signal?: AbortSignal;

  constructor(
    owner: string,
    repo: string,
    branch: string = ENGINE_CONFIG.defaultBranch,
    token?: string,
    options?: { signal?: AbortSignal }
  ) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.explicitToken = token || undefined;
    this.signal = options?.signal;

    this.headers = {
      'User-Agent': 'OpenGits-Engine',
    };

    const effectiveToken = token || process.env.GITHUB_TOKEN;
    if (effectiveToken) {
      this.headers['Authorization'] = `Bearer ${effectiveToken}`;
    }
  }

  private gh(url: string): Promise<Response> {
    return import('../lib/github/client').then(({ githubFetch }) =>
      githubFetch(
        url,
        { headers: { ...this.headers }, signal: this.signal },
        { explicitToken: this.explicitToken, endpointClass: this.classifyEndpoint(url) },
      ),
    );
  }

  private classifyEndpoint(url: string): 'raw' | 'api-core' {
    try {
      const rawHost = new URL(GITHUB_ENDPOINTS.raw).host;
      return new URL(url).host === rawHost ? 'raw' : 'api-core';
    } catch {
      return 'api-core';
    }
  }

  async getRepoTree(retries = 3, cacheSha?: string): Promise<GitHubNode[] & { truncated?: boolean; exclusionReport?: ExclusionReport }> {
    if (cacheSha) {
      const cached = getCachedTree(this.owner, this.repo, cacheSha);
      if (cached) {
        console.log(`[Fetcher] Tree cache HIT for ${this.owner}/${this.repo}@${cacheSha.slice(0, 7)}`);
        return cached;
      }
      const hydrated = await hydrateTreeFromDisk(this.owner, this.repo, cacheSha);
      if (hydrated) {
        console.log(`[Fetcher] Tree cache DISK HIT for ${this.owner}/${this.repo}@${cacheSha.slice(0, 7)}`);
        return hydrated;
      }
    }
    const url = `${GITHUB_ENDPOINTS.api}/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`;
    console.log(`[Fetcher] Fetching tree from ${url}...`);
    
    let res: Response | null = null;
    let notFoundRetries = 0;
    for (let i = 0; i < retries; i++) {
      res = await this.gh(url);
      if (res.ok) break;
      
      if (this.signal?.aborted) {
        throw new Error(`[Fetcher] aborted during tree fetch`);
      }
      if (res.status === 409) {
        throw new EmptyRepoError();
      }
      if (res.status === 404) {
        // Bounded single retry absorbs GitHub eventual consistency on newly created repos/SHAs.
        if (i === retries - 1 || notFoundRetries >= 1) {
          throw new EmptyRepoError();
        }
        notFoundRetries++;
        await new Promise((resolve) => setTimeout(resolve, FETCHER_404_RETRY_DELAY_MS));
        continue;
      }
      if (res.status === 403 || res.status === 429) {
        if (i === retries - 1) {
          throw new Error(`[FATAL] GitHub API Rate Limit Exceeded after ${retries} attempts: ${res.statusText}`);
        }
        const retryAfter = res.headers.get('retry-after') || '2';
        console.warn(`[WARN] GitHub rate limit hit on tree fetch. Retrying in ${retryAfter}s...`);
        await new Promise(resolve => setTimeout(resolve, parseInt(retryAfter) * 1000));
        continue;
      }
      if (i === retries - 1) {
        throw new Error(`[FATAL] Failed to fetch repo tree: ${res.statusText}`);
      }
    }
    
    if (!res) throw new Error(`[FATAL] Unknown fetch error`);
    
    const data = await res.json();
    if (!data || !Array.isArray(data.tree) || data.tree.length === 0) {
      throw new EmptyRepoError();
    }
    const isTruncated = !!data.truncated;
    if (isTruncated) {
      console.warn('[WARN] The GitHub tree was truncated. Attempting Contents API fallback for missing top-level items...');
    }
    
    const exclusionReport: ExclusionReport = {
      totalExcludedCount: 0,
      byCategory: {
        archive: 0,
        executable: 0,
        office_media: 0,
        build_db: 0,
        oversized: 0,
      },
      sampleExcludedFiles: [],
      allExcludedFiles: [],
    };

    let filteredTree = data.tree.filter((node: GitHubNode) => {
      if (node.type === 'blob') {
        const verdict = classifyExcludedFile(node.path, node.size);
        if (verdict.isExcluded && verdict.category) {
          exclusionReport.totalExcludedCount++;
          exclusionReport.byCategory[verdict.category] = (exclusionReport.byCategory[verdict.category] || 0) + 1;
          const item: ExclusionItem = {
            path: node.path,
            category: verdict.category,
            categoryLabel: verdict.categoryLabel || verdict.category,
            reason: verdict.reason || '文件格式不支持',
            size: node.size,
          };
          // Cap retained exclusion details to bound V8 heap on million-file repos.
          if (exclusionReport.allExcludedFiles!.length < ENGINE_CONFIG.fetcher.exclusionDetailBudget) {
            exclusionReport.allExcludedFiles!.push(item);
          }
          if (exclusionReport.sampleExcludedFiles.length < 15) {
            exclusionReport.sampleExcludedFiles.push(item);
          }
          return false;
        }
      }

      if (node.type === 'blob' && isHighPriorityMigrationFile(node.path)) {
        node.docType = 'migration';
        return true;
      }

      if (NOISY_PATH_PREFIXES.some(prefix => node.path.startsWith(prefix))) return false;
      
      const segments = node.path.split('/');
      if (segments.some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) return false;

      const filename = segments[segments.length - 1].toLowerCase();
      const metaFiles = IGNORED_FILENAMES.map(f => f.toLowerCase());
      if (metaFiles.includes(filename)) return false;

      if (BINARY_EXTENSIONS.some(ext => filename.endsWith(ext))) return false;

      return true;
    });

    if (isTruncated) {
      await this.fetchTruncatedRootContents(filteredTree);
    }
    
    const result = filteredTree as GitHubNode[] & { truncated?: boolean; exclusionReport?: ExclusionReport };
    result.truncated = isTruncated;
    result.exclusionReport = exclusionReport;
    if (cacheSha) {
      setCachedTree(this.owner, this.repo, cacheSha, result);
    }
    return result;
  }

  private async fetchTruncatedRootContents(filteredTree: GitHubNode[]): Promise<void> {
    try {
      const contentsUrl = `${GITHUB_ENDPOINTS.api}/repos/${this.owner}/${this.repo}/contents?ref=${encodeURIComponent(this.branch)}`;
      const contentsRes = await this.gh(contentsUrl);
      if (!contentsRes.ok) return;

      const contents = await contentsRes.json();
      if (!Array.isArray(contents)) return;

      const existingPaths = new Set(filteredTree.map((n: GitHubNode) => n.path));
      for (const item of contents) {
        if (!existingPaths.has(item.path)) {
          filteredTree.push({
            path: item.path,
            mode: '100644',
            type: item.type === 'dir' ? 'tree' : 'blob',
            sha: item.sha,
            size: item.size || 0,
            url: item.url,
          } as GitHubNode);
        }
      }
    } catch (_err) {
      ignoreBestEffort(_err);
    }
  }

  async getRawContent(filePath: string, ref?: string, retries = 3): Promise<string> {
    const targetRef = ref || this.branch;
    const encodedRef = targetRef.split('/').map(encodeURIComponent).join('/');
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = `${GITHUB_ENDPOINTS.raw}/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${encodedRef}/${encodedPath}`;
    
    for (let i = 0; i < retries; i++) {
      try {
        const res = await this.gh(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const text = await res.text();
        if (!MODULE_ROLE_PATTERNS.markdownExtensions.some(ext => filePath.endsWith(ext))) {
          return wrapCodeAsMdx(filePath, text);
        }
        return text;
      } catch (err) {
        if (this.signal?.aborted) throw err;
        if (i === retries - 1) {
          console.error(`[ERROR] Failed to download ${filePath} after ${retries} attempts.`);
          // Throw rather than returning a placeholder so callers retain retryable ERROR state instead of indexing fake content.
          throw new Error(`Failed to fetch ${filePath} after ${retries} attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    throw new Error(`Failed to fetch ${filePath}`);
  }
}

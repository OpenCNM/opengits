import 'dotenv/config';
import fs from 'fs-extra';
import { wrapCodeAsMdx } from './code-to-mdx';
import { ENGINE_CONFIG, NOISY_PATH_PREFIXES, IGNORED_FILENAMES, ALLOWED_FILE_EXTENSIONS, GITHUB_ENDPOINTS, BINARY_EXTENSIONS, classifyExcludedFile, ExclusionCategoryKey } from '../lib/config';
import { MODULE_ROLE_PATTERNS } from './language-map';
import { getCachedTree, setCachedTree, hydrateTreeFromDisk } from '../lib/tree-cache';

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

/**
 * Checks if a file path points to a high-priority migration, changelog, or release document.
 */
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

  // Version transition files (e.g., v15.md, v14-to-v15.md, v2.0-to-v3.0.md)
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

/** 404 单次短退避（与 Go 侧 github404RetryDelay 同口径）：吸收 GitHub 新建仓/新 SHA 最终一致窗口 */
const FETCHER_404_RETRY_DELAY_MS = 800;

export class Fetcher {
  private owner: string;
  private repo: string;
  private branch: string;
  private headers: Record<string, string>;
  private explicitToken?: string;
  /** 取消信号（Phase 4 T5）：墙钟超时真取消——在途 fetch 中断、重试循环提前退出 */
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

  /** 统一咽喉：显式 token 直用（无则池轮询），配额头采样；headers 内遗留 Authorization 由 client 剥离重注 */
  private gh(url: string): Promise<Response> {
    return import('../lib/github/client').then(({ githubFetch }) =>
      githubFetch(
        url,
        { headers: { ...this.headers }, signal: this.signal },
        // host 判定（T6.5）：url.includes 对自定义 GITHUB_RAW_BASE 代理会误判为 api-core
        { explicitToken: this.explicitToken, endpointClass: this.classifyEndpoint(url) },
      ),
    );
  }

  /** raw 端点判定按解析后的 host（GITHUB_RAW_BASE 可指向代理域名） */
  private classifyEndpoint(url: string): 'raw' | 'api-core' {
    try {
      const rawHost = new URL(GITHUB_ENDPOINTS.raw).host;
      return new URL(url).host === rawHost ? 'raw' : 'api-core';
    } catch {
      return 'api-core';
    }
  }

  /**
   * Fetch the complete repository tree.
   */
  async getRepoTree(retries = 3, cacheSha?: string): Promise<GitHubNode[] & { truncated?: boolean; exclusionReport?: ExclusionReport }> {
    // sha 级全树缓存：同 sha 必同树，整个导入流程（scout/prefix-outline/ingest/code-ingest）共享。
    // 命中跳过 GitHub API 调用（消除重复网络往返，如 hybrid 导入原 3 次 → 1 次）。
    // 内存 miss → 磁盘持久层回填（进程重启后首次请求免冷拉取，慢链路下一棵全树 5~16s）。
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
        // 有界重试：GitHub 对刚创建仓库/刚 push 的 SHA 存在最终一致性窗口的瞬时 404。
        // 至多重试一次（总调用 ≤ 2，配额保护）；持续 404 按空仓/不存在终态。
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

    // Heuristic Filtering: Ignore common noisy directories & exclude large/binary files
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
          // 认知预算硬顶：计数器始终精确累加，明细数组封顶——无界 push
          // 在百万文件级大仓会堆积数百 MB V8 堆（下游决策只需计数 + 样本）
          if (exclusionReport.allExcludedFiles!.length < ENGINE_CONFIG.fetcher.exclusionDetailBudget) {
            exclusionReport.allExcludedFiles!.push(item);
          }
          if (exclusionReport.sampleExcludedFiles.length < 15) {
            exclusionReport.sampleExcludedFiles.push(item);
          }
          return false;
        }
      }

      // High-priority migration / changelog files whitelist
      if (node.type === 'blob' && isHighPriorityMigrationFile(node.path)) {
        node.docType = 'migration';
        return true;
      }

      // 1. Ignore specific prefixes entirely
      if (NOISY_PATH_PREFIXES.some(prefix => node.path.startsWith(prefix))) return false;
      
      // 2. Ignore hidden directories/files (e.g. .agents/, .gitignore)
      const segments = node.path.split('/');
      if (segments.some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) return false;

      // 3. Ignore non-curriculum meta files
      const filename = segments[segments.length - 1].toLowerCase();
      const metaFiles = IGNORED_FILENAMES.map(f => f.toLowerCase());
      if (metaFiles.includes(filename)) return false;

      // 4. Basic binary check
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
      // Fallback silently if Contents API fails
    }
  }


  /**
  * Fetch the raw content of a specific file with retries.
  * @param ref 可选的 ref 覆盖（branch 或 commit sha）。传 sha 时保证拿到的是
  *            "导入瞬间"的内容，避免仓库更新后按 branch 拉到新版本破坏冻结语义。
  *            ref 段裸插值（与 branch 一致）：带斜杠的 branch 依赖 GitHub 最长匹配路由。
  */
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
        if (this.signal?.aborted) throw err; // 取消优先于重试
        if (i === retries - 1) {
          console.error(`[ERROR] Failed to download ${filePath} after ${retries} attempts.`);
          // 抛错而非返回占位串：占位内容会被下游当真文档处理，产出 PROCESSED 假文档
          // 污染搜索与图谱。抛错 → 调用方(processDocumentContent)置 ERROR + retryCount++，
          // 文档保留可重试状态，而不是被"假成功"。
          throw new Error(`Failed to fetch ${filePath} after ${retries} attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
      }
    }
    // throw 后不可达(保留编译期类型完整性)
    throw new Error(`Failed to fetch ${filePath}`);
  }
}


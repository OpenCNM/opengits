/**
 * 物理源码归档读取域：确定性切片与签名提取（零语法正则，行扫描状态机）。
 * 与 Go 原生快路径逐条对齐，保证 Node MCP 与 Go mcp-sidecar 输出语义一致：
 * - readSymbolSourceCode ≡ services/worker-sidecar/internal/mcp/tools_symbol.go
 * - extractSymbolSignature ≡ services/worker-sidecar/internal/armor/code_slot.go
 */
import { readFileLocal } from '@/engine/tarball/archive-store';
import { GITHUB_ENDPOINTS } from '@/lib/config';
import { WEB_DOC_OWNER } from '@/lib/constants';

const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const SOURCE_FALLBACK_TIMEOUT_MS = 15_000;
const SOURCE_FALLBACK_HIT_TTL_MS = 15 * 60 * 1000;
const SOURCE_FALLBACK_BRANCH_TTL_MS = 2 * 60 * 1000;
const SOURCE_FALLBACK_MISS_TTL_MS = 60 * 1000;
const SOURCE_FALLBACK_CACHE_LIMIT = 512;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const IMMUTABLE_SHA_RE = /^[0-9a-f]{7,40}$/i;

type SourceFallbackFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

const sourceFallbackCache = new Map<string, { value: string | null; expiresAt: number }>();
const sourceFallbackInFlight = new Map<string, Promise<string | null>>();
let sourceFallbackFetcherOverride: SourceFallbackFetcher | null = null;

/** 测试钩子：注入/重置源码回源 HTTP Fetcher */
export function setSourceFallbackFetcherForTest(fetcher: SourceFallbackFetcher | null): void {
  sourceFallbackFetcherOverride = fetcher;
}

/** 测试钩子：清空源码回源缓存 */
export function clearSourceFallbackCacheForTest(): void {
  sourceFallbackCache.clear();
  sourceFallbackInFlight.clear();
}

function setFallbackCache(key: string, value: string | null, ttlMs: number): void {
  if (sourceFallbackCache.size >= SOURCE_FALLBACK_CACHE_LIMIT) {
    const oldest = sourceFallbackCache.keys().next().value;
    if (oldest !== undefined) {
      sourceFallbackCache.delete(oldest);
    }
  }
  sourceFallbackCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function fetchImmutableRawFile(
  owner: string,
  repo: string,
  ref: string,
  relPath: string
): Promise<string | null> {
  const cleanPath = cleanSourcePath(relPath);
  if (!cleanPath || !owner || !repo || !ref || owner.toLowerCase() === WEB_DOC_OWNER) {
    return null;
  }
  if (!SAFE_SEGMENT_RE.test(owner) || !SAFE_SEGMENT_RE.test(repo) || !SAFE_SEGMENT_RE.test(ref)) {
    return null;
  }
  if (process.env.VITEST === 'true' && !sourceFallbackFetcherOverride && !process.env.GITHUB_RAW_BASE) {
    return null;
  }

  const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}@${ref}:${cleanPath}`;
  const cached = sourceFallbackCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) {
    sourceFallbackCache.delete(cacheKey);
  }

  const pending = sourceFallbackInFlight.get(cacheKey);
  if (pending) {
    return pending;
  }

  const task = (async (): Promise<string | null> => {
    const base = (process.env.GITHUB_RAW_BASE || GITHUB_ENDPOINTS.raw).replace(/\/+$/, '');
    const encodedPath = cleanPath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const targetUrl = `${base}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedPath}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_FALLBACK_TIMEOUT_MS);
    try {
      const token = process.env.GITHUB_TOKEN || process.env.OCTOKIT_PERSONAL_ACCESS_TOKEN || '';
      const fetcher: SourceFallbackFetcher =
        sourceFallbackFetcherOverride ||
        ((url, signal) =>
          fetch(url, {
            signal,
            headers: {
              'User-Agent': process.env.USER_AGENT || 'OpenGits-Engine/1.0',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          }));
      const res = await fetcher(targetUrl, controller.signal);
      if (!res.ok) {
        setFallbackCache(cacheKey, null, SOURCE_FALLBACK_MISS_TTL_MS);
        return null;
      }
      const contentLength = Number(res.headers.get('content-length') || 0);
      if (contentLength > MAX_SOURCE_FILE_BYTES) {
        setFallbackCache(cacheKey, null, SOURCE_FALLBACK_MISS_TTL_MS);
        return null;
      }
      const text = await res.text();
      if (!text || Buffer.byteLength(text, 'utf8') > MAX_SOURCE_FILE_BYTES) {
        setFallbackCache(cacheKey, null, text ? SOURCE_FALLBACK_MISS_TTL_MS : SOURCE_FALLBACK_MISS_TTL_MS);
        return null;
      }
      const ttl = IMMUTABLE_SHA_RE.test(ref) ? SOURCE_FALLBACK_HIT_TTL_MS : SOURCE_FALLBACK_BRANCH_TTL_MS;
      setFallbackCache(cacheKey, text, ttl);
      return text;
    } catch (err) {
      console.warn(`[source-archive] immutable raw fallback failed for ${owner}/${repo}@${ref}/${cleanPath}:`, err);
      setFallbackCache(cacheKey, null, SOURCE_FALLBACK_MISS_TTL_MS);
      return null;
    } finally {
      clearTimeout(timer);
      sourceFallbackInFlight.delete(cacheKey);
    }
  })();

  sourceFallbackInFlight.set(cacheKey, task);
  return task;
}

/**
 * 本地归档直读 + 不可变 Git Ref 上游按需回源（read_source_file / read_symbol / dissect_code 共用）。
 */
export async function readSourceFileWithFallback(
  owner: string,
  repo: string,
  refs: string[],
  relPath: string
): Promise<{ content: string; usedRef: string } | null> {
  const cleanPath = cleanSourcePath(relPath);
  if (!cleanPath || !owner || !repo) return null;

  const validRefs = refs.filter(Boolean);
  for (const ref of validRefs) {
    try {
      const local = await readFileLocal(owner, repo, ref, cleanPath);
      if (local !== null) {
        return { content: local, usedRef: ref };
      }
    } catch (err) {
      // 容错降级: 本地归档读取失败时记录告警并继续尝试下一 ref 或上游回源
      console.warn(`[source-archive] local archive read failed for ${owner}/${repo}@${ref}/${cleanPath}:`, err);
    }
  }

  for (const ref of validRefs) {
    const remote = await fetchImmutableRawFile(owner, repo, ref, cleanPath);
    if (remote !== null) {
      return { content: remote, usedRef: ref };
    }
  }

  return null;
}

/** 源码路径清洗：拒绝路径穿越与绝对路径（比 /api/code 路由更严：裸 '/' 前缀直接拒绝而非静默剥除） */
export function cleanSourcePath(rawPath: string): string | null {
  const cleanPath = (rawPath.startsWith('./') ? rawPath.slice(2) : rawPath).trim();
  if (
    !cleanPath ||
    cleanPath.includes('..') ||
    cleanPath.startsWith('/') ||
    cleanPath.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(cleanPath)
  ) {
    return null;
  }
  return cleanPath;
}

/** 按扩展名映射代码围栏语言标识（tools/symbol.ts 原实现上移共享） */
export function detectSourceLanguage(path: string): string {
  const ext = path.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'go':
      return 'go';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
      return 'cpp';
    case 'rb':
      return 'ruby';
    case 'php':
      return 'php';
    case 'cs':
      return 'csharp';
    case 'swift':
      return 'swift';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'sql':
      return 'sql';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    default:
      return 'text';
  }
}

/**
 * 从本地解压归档中安全提取源码切片（readFileLocal 内建路径穿越防御）。
 * 切片规则与 Go readSymbolSourceCode 一致：
 * 1) 有准确起止行号 → 精确切片；2) 行号缺失 → 符号声明行起 40 行窗口；
 * 3) 文件 ≤120 行 → 全量；4) 超大文件 → 前 60 行 + 截断标记。
 */
export async function readSymbolSourceCode(
  owner: string,
  repo: string,
  ref: string,
  relPath: string,
  symName: string,
  startLine: number,
  endLine: number
): Promise<string> {
  if (!owner || !repo || !ref || !relPath) return '';
  let raw: string | null = null;
  try {
    raw = await readFileLocal(owner, repo, ref, relPath);
  } catch (err) {
    // 容错降级: 本地归档读取失败时置 null，交由不可变上游回源兜底
    console.warn(`[source-archive] local symbol read failed for ${owner}/${repo}@${ref}/${relPath}:`, err);
    raw = null;
  }
  if (raw === null) {
    raw = await fetchImmutableRawFile(owner, repo, ref, relPath);
  }
  if (raw === null || raw === '') return '';
  const lines = raw.split('\n');
  if (lines.length === 0) return '';

  // 1. 若有准确起止行号，直接切片
  if (startLine > 0 && endLine >= startLine && startLine <= lines.length) {
    const clampedEnd = Math.min(endLine, lines.length);
    return lines.slice(startLine - 1, clampedEnd).join('\n');
  }

  // 2. 若行号缺失，扫描符号定义签名行并取 40 行窗口
  if (symName) {
    const symLower = symName.toLowerCase();
    let matchIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      if (
        lineLower.includes(symLower) &&
        (lineLower.includes('func ') ||
          lineLower.includes('type ') ||
          lineLower.includes('def ') ||
          lineLower.includes('class ') ||
          lineLower.includes('function ') ||
          lineLower.includes('interface '))
      ) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx >= 0) {
      const targetEnd = Math.min(matchIdx + 40, lines.length);
      return lines.slice(matchIdx, targetEnd).join('\n');
    }
  }

  // 3. 文件整体较小（≤120 行）输出全量
  if (lines.length <= 120) return raw;

  // 4. 超大文件截断输出前 60 行
  return (
    lines.slice(0, 60).join('\n') +
    '\n\n// ... [Truncated: specify symbol start_line/end_line for targeted inspection]'
  );
}

/**
 * 确定性符号签名提取——armor.ExtractSymbolSignature 的 TS 镜像。
 * 规则：定位声明行（跳过注释行）→ 收集 ≤5 行前置文档注释 →
 * - python：括号深度归零且行尾 ':' 即签名结束（≤15 行）；
 * - 类 C 语言：函数捕获到首个 '{'（截为 `... { ... }`）；
 *   类型声明捕获至匹配闭合 '}'（≤30 行）。
 */
export function extractSymbolSignature(sourceCode: string, symName: string, lang: string): string {
  const rawTrimmed = sourceCode.trim();
  if (!rawTrimmed) return '';
  const lines = sourceCode.split('\n');
  if (lines.length === 0) return '';

  // 1. 查找包含 symName 的声明起始行
  let startIdx = -1;
  const symLower = symName.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) continue;
    if (symLower && trimmed.toLowerCase().includes(symLower)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) startIdx = 0;

  // 2. 收集紧邻的前置文档注释（最多 5 行）
  let docCommentStart = startIdx;
  while (docCommentStart > 0) {
    const prev = lines[docCommentStart - 1].trim();
    if (prev.startsWith('//') || prev.startsWith('#') || prev.startsWith('*') || prev.startsWith('/*')) {
      docCommentStart--;
      if (startIdx - docCommentStart >= 5) break;
    } else {
      break;
    }
  }
  const commentLines = lines.slice(docCommentStart, startIdx);

  const sigLines: string[] = [];
  if (lang === 'python') {
    let parenDepth = 0;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      sigLines.push(line);
      for (const ch of line) {
        if (ch === '(' || ch === '[' || ch === '{') parenDepth++;
        else if (ch === ')' || ch === ']' || ch === '}') parenDepth--;
      }
      const trimmed = line.trim();
      if (parenDepth <= 0 && trimmed.endsWith(':')) break;
      if (i - startIdx >= 15) break;
    }
    const res = [...commentLines, ...sigLines];
    const lastIdx = res.length - 1;
    if (lastIdx >= 0) {
      res[lastIdx] = res[lastIdx].replace(/[ \t]+$/, '') + ' ...';
    }
    return res.join('\n');
  }

  // Go / TS / Rust / C / Java 等类 C 语言
  const firstLine = lines[startIdx].trim();
  const isTypeDecl =
    firstLine.startsWith('type ') ||
    firstLine.startsWith('interface ') ||
    firstLine.includes('struct {') ||
    firstLine.includes('interface {') ||
    firstLine.startsWith('export interface ') ||
    firstLine.startsWith('export type ');

  let braceDepth = 0;
  let openedBrace = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    sigLines.push(line);
    for (const ch of line) {
      if (ch === '{') {
        braceDepth++;
        openedBrace = true;
      } else if (ch === '}') {
        braceDepth--;
      }
    }

    if (isTypeDecl) {
      // 类型定义：捕获至匹配闭合括号 }
      if (openedBrace && braceDepth <= 0) break;
    } else if (openedBrace) {
      // 函数/方法签名：捕获到首个开括号 '{'，截断为 `... { ... }`
      const last = sigLines[sigLines.length - 1];
      const bracePos = last.indexOf('{');
      if (bracePos >= 0) {
        sigLines[sigLines.length - 1] = last.slice(0, bracePos).replace(/[ \t]+$/, '') + ' { ... }';
      }
      break;
    }

    if (i - startIdx >= 30) {
      sigLines.push('// ... [contract truncated]');
      break;
    }
  }

  return [...commentLines, ...sigLines].join('\n');
}

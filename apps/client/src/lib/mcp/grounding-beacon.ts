/**
 * apps/client/src/lib/mcp/grounding-beacon.ts
 *
 * MCP 读端溯源信标投影器 (Zero-Materialization Provenance Beacon Projector)。
 *
 * 346 准则执行层：
 * 1. 零物化模式 (Zero-Materialization Pattern)：读端纯函数投影，零写端持久化与零 DB 突变。
 * 2. 两级真实性层级 (Two-Tier Truth Hierarchy)：明确 L1 教学文摘与 L2 物理 AST/源码事实的边界。
 * 3. 认知预算 (Cognitive Budget & CDC)：信标严格控制在 80 tokens 内，输出高密度、可直接执行的工具模板。
 * 4. Chomsky 边界与 AST 优先：基于 mdast 结构化遍历 Markdown 节点，严禁跨多行正则提取语法符号。
 * 5. 集中注册表 (SSOT)：扩展名与源码模式优先复用 MODULE_ROLE_PATTERNS。
 */

import { parseMarkdownAst, walkMarkdownAst } from '@/engine/markdown/mdast-ast';
import { estimateTokens } from '@/lib/token-counter';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';

/** 额外源码/样式/契约扩展名白名单（与 MODULE_ROLE_PATTERNS.allowedFileExtensions 联合） */
const EXTRA_SOURCE_EXTENSIONS = new Set([
  '.proto', '.sql', '.vue', '.svelte', '.css', '.scss', '.html',
]);

function isSourceCodeExtension(ext: string): boolean {
  if (ext === '.md' || ext === '.mdx' || ext === '.txt' || ext === '.csv') return false;
  return EXTRA_SOURCE_EXTENSIONS.has(ext) || MODULE_ROLE_PATTERNS.allowedFileExtensions.test(ext);
}

/** 常见语法保留字与非符号噪音词，提取符号时跳过 */
const STOP_WORDS = new Set([
  'true', 'false', 'null', 'undefined',
  'string', 'number', 'boolean', 'any', 'void', 'unknown', 'never', 'object',
  'return', 'export', 'import', 'from', 'default', 'const', 'let', 'var',
  'function', 'class', 'interface', 'type', 'enum', 'package', 'func', 'def',
  'struct', 'impl', 'pub', 'fn', 'async', 'await', 'new', 'this', 'self',
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'curl', 'bash', 'zsh', 'sh', 'docker',
  'json', 'yaml', 'toml', 'html', 'css', 'http', 'https',
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head',
  'target', 'repository', 'path', 'symbol', 'aspect', 'query', 'filter', 'mode',
  'section', 'heading', 'address', 'locator', 'summary', 'full', 'contract',
  'architecture', 'implementation', 'stdout', 'stderr', 'stdin', 'err', 'error',
  'ok', 'id', 'url', 'uri',
  'todo', 'note', 'tip', 'warning', 'info',
]);

/** 标识符模式：支持驼峰、下划线、点号命名空间与 C++ 命名空间 */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.:-]*[A-Za-z0-9_]$/;

export interface CleanedPathFact {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** 常见无扩展名构建与源码文件名白名单 */
const COMMON_EXTENSIONLESS_FILES = new Set([
  'dockerfile',
  'makefile',
  'containerfile',
  'procfile',
  'jenkinsfile',
  'brewfile',
  'gemfile',
  'rakefile',
  'caddyfile',
  'vagrantfile',
]);

export function cleanPathToken(token: string): string | null {
  if (!token || typeof token !== 'string') return null;
  // 1. 剥离外围包裹符号（引号、括号、书名号、反引号及尾随标点）
  let cleaned = token.replace(/^[('"`\[<]+|[)'"`\]>,;:]+$/g, '').trim();
  if (!cleaned || cleaned.includes(' ') || cleaned.length > 200) return null;

  // 2. 拒绝包含属性赋值或内部引号的噪音 token（如 title="...", key=value）
  if (cleaned.includes('=') || cleaned.includes('"') || cleaned.includes("'")) return null;

  // 3. 剥离行号与锚点后缀（如 :42, :42-50, #L10, ?query）
  cleaned = cleaned.replace(/(?::\d+(?:-\d+)?|[#?].*)$/, '');

  // 4. Windows 反斜杠归一化为 POSIX
  cleaned = cleaned.replace(/\\/g, '/');

  // 5. 剥离相对路径前缀 ./ 或 /
  if (cleaned.startsWith('./')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }

  // 6. 拒绝包含目录穿越 .. 的非法路径
  if (!cleaned || cleaned.includes('..')) return null;

  // 7. 校验扩展名或无扩展名的常见文件名（如 Dockerfile, Makefile）
  const baseName = cleaned.split('/').pop()?.toLowerCase() || '';
  if (COMMON_EXTENSIONLESS_FILES.has(baseName)) {
    return cleaned;
  }

  const lastDot = cleaned.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const ext = cleaned.slice(lastDot).toLowerCase();
  if (!isSourceCodeExtension(ext)) return null;

  return cleaned;
}

/**
 * 解析带可选物理行号区间的源码事实 token。
 * 支持：
 * - `src/foo.ts (L10-L45)` / `src/foo.ts (10-45)` / `src/foo.ts (L10)`
 * - `src/foo.ts:10-45` / `src/foo.ts:10` / `src/foo.ts#L10-L45` / `src/foo.ts#L10`
 * - `src/foo.ts`
 */
export function parsePathFactToken(rawToken: string): CleanedPathFact | null {
  if (!rawToken || typeof rawToken !== 'string') return null;
  let raw = rawToken.trim();
  if (!raw || raw.length > 200) return null;

  // 剥离外层包裹引号/书名号/反引号
  raw = raw.replace(/^[`"'<]+|[`"'>]+$/g, '').trim();
  raw = raw.replace(/^(?:code|file|path|filepath):\s*/i, '').trim();

  // 1. 尝试匹配括号行号，如 "src/foo.ts (L10-L45)" 或 "src/foo.ts (10-45)" 或 "src/foo.ts (L10)"
  const parenMatch = /^([^\s()]+)[ \t]+\((?:L)?(\d+)(?:-(?:L)?(\d+))?\)/i.exec(raw);
  if (parenMatch) {
    const p = cleanPathToken(parenMatch[1]);
    if (!p) return null;
    const l1 = parseInt(parenMatch[2], 10);
    const l2 = parenMatch[3] ? parseInt(parenMatch[3], 10) : l1;
    if (l1 > 0 && l2 > 0) {
      return {
        path: p,
        startLine: Math.min(l1, l2),
        endLine: Math.max(l1, l2),
      };
    }
    return { path: p };
  }

  // 2. 尝试匹配冒号或井号行号，如 "src/foo.ts:10-45", "src/foo.ts:10", "src/foo.ts#L10-L45", "src/foo.ts#L10"
  const colonHashMatch = /^([^\s#:]+)[:#](?:L)?(\d+)(?:-(?:L)?(\d+))?/i.exec(raw);
  if (colonHashMatch) {
    const p = cleanPathToken(colonHashMatch[1]);
    if (!p) return null;
    const l1 = parseInt(colonHashMatch[2], 10);
    const l2 = colonHashMatch[3] ? parseInt(colonHashMatch[3], 10) : l1;
    if (l1 > 0 && l2 > 0) {
      return {
        path: p,
        startLine: Math.min(l1, l2),
        endLine: Math.max(l1, l2),
      };
    }
    return { path: p };
  }

  // 3. 裸路径
  const p = cleanPathToken(raw.split(/\s+/)[0]);
  if (!p) return null;
  return { path: p };
}

export function isValidSymbol(val: string): boolean {
  if (val.length < 2 || val.length > 60) return false;
  if (/\s/.test(val)) return false;
  if (/["'()[\]{}<>/\\|]/.test(val)) return false;
  if (!IDENTIFIER_PATTERN.test(val)) return false;
  if (STOP_WORDS.has(val.toLowerCase())) return false;
  return true;
}

export interface GroundingFacts {
  symbols: string[];
  sourceFiles: string[];
  sourceFacts?: CleanedPathFact[];
}

/**
 * 从 Markdown 文本的 AST 中提取提及的物理代码事实（符号与源码路径）。
 * 严格遵循 Chomsky 边界：围栏元数据、HTML 路径注释、链接与行内代码经 mdast 树形解析。
 */
export function extractGroundingFacts(content: string): GroundingFacts {
  if (!content || typeof content !== 'string' || !content.trim()) {
    return { symbols: [], sourceFiles: [], sourceFacts: [] };
  }

  const symbols = new Set<string>();
  const sourceFiles = new Set<string>();
  const sourceFactsMap = new Map<string, CleanedPathFact>();

  const registerFact = (fact: CleanedPathFact | null) => {
    if (!fact) return;
    sourceFiles.add(fact.path);
    const existing = sourceFactsMap.get(fact.path);
    if (!existing || (!existing.startLine && fact.startLine)) {
      sourceFactsMap.set(fact.path, fact);
    }
  };

  try {
    const root = parseMarkdownAst(content);
    walkMarkdownAst(root, (node) => {
      // 1. 代码块围栏：检查 meta 中的文件声明（如 `// src/foo.ts (L10-L45)` 或 `path="src/foo.ts"`）
      if (node.type === 'code') {
        const codeNode = node as { meta?: string | null; value?: string };
        const meta = (codeNode.meta ?? '').trim();
        if (meta) {
          // 结构化属性声明 (path, file, filename, title)
          const attrMatch = /(?:path|file|filename|title)=["']?([^"'\s>]+)["']?/.exec(meta);
          if (attrMatch?.[1]) {
            registerFact(parsePathFactToken(attrMatch[1]));
          }
          // 围栏头注释风格 (//, #, --)
          for (const prefix of ['//', '#', '--'] as const) {
            if (meta.startsWith(prefix)) {
              const candidate = meta.slice(prefix.length).trim();
              registerFact(parsePathFactToken(candidate));
              break;
            }
          }
          // 裸路径标识（不包含 = 赋值且非注释，如 ```typescript src/app.ts）
          if (!meta.includes('=')) {
            registerFact(parsePathFactToken(meta));
          }
        }

        // 检查代码前 3 个非空行中的注释文件路径
        if (codeNode.value) {
          const lines = codeNode.value.split('\n');
          let scannedCount = 0;
          for (let i = 0; i < lines.length && scannedCount < 3; i++) {
            const line = lines[i]?.trim();
            if (!line) continue;
            scannedCount++;
            let recognized = false;
            for (const prefix of ['//', '#', '--'] as const) {
              if (line.startsWith(prefix)) {
                const candidate = line.slice(prefix.length).trim();
                const fact = parsePathFactToken(candidate);
                if (fact) {
                  registerFact(fact);
                  recognized = true;
                }
                break;
              }
            }
            if (!recognized && line.startsWith('/*')) {
              const candidate = line.slice(2).replace(/\*\/.*$/, '').trim();
              const fact = parsePathFactToken(candidate);
              if (fact) {
                registerFact(fact);
                recognized = true;
              }
            }
            if (recognized) {
              break;
            }
          }
        }
      }

      // 2. HTML 节点：检查 `<!-- path: X -->`
      if (node.type === 'html') {
        const htmlVal = (node as { value?: string }).value ?? '';
        for (const match of htmlVal.matchAll(/<!--\s*path:\s*([^>]+?)\s*-->/g)) {
          if (match[1]) {
            registerFact(parsePathFactToken(match[1].trim()));
          }
        }
      }

      // 3. 行内代码节点：判定是源码路径还是代码符号
      if (node.type === 'inlineCode') {
        const rawVal = ((node as { value?: string }).value ?? '').trim();
        if (rawVal) {
          // 优先判定是否为源码路径（如 `src/app.ts:10-40` 或根目录 `main.go`）
          const fact = parsePathFactToken(rawVal);
          if (fact) {
            registerFact(fact);
          } else {
            // 若不是源码路径，支持函数调用剥离（如 `startWorker()` -> `startWorker`）
            const candidateSymbol = rawVal.endsWith('()') ? rawVal.slice(0, -2).trim() : rawVal;
            if (isValidSymbol(candidateSymbol)) {
              symbols.add(candidateSymbol);
            }
          }
        }
      }

      // 4. 链接节点：检查 href 是否是指向仓库代码文件的相对路径或 code: 链接
      if (node.type === 'link') {
        const linkNode = node as { url?: string };
        const url = (linkNode.url ?? '').trim();
        if (url && !url.startsWith('http:') && !url.startsWith('https:') && !url.startsWith('#') && !url.startsWith('mailto:')) {
          registerFact(parsePathFactToken(url));
        }
      }
    });
  } catch {
    // AST 解析异常防御性降级
  }

  return {
    symbols: Array.from(symbols),
    sourceFiles: Array.from(sourceFiles),
    sourceFacts: Array.from(sourceFactsMap.values()),
  };
}

export interface ProvenanceBeaconOptions {
  /** 当前读取的 Markdown 正文（章节内容或文档全文） */
  content?: string | null;
  /** 教程文档路径（如 "docs/getting-started.md"） */
  docPath?: string;
  /** 仓库标识（"owner/repo"） */
  repository?: string;
  /** 仓库冻结 Git SHA 快照或分支标识 */
  gitSha?: string | null;
  /** 是否处于多仓 Hub 模式 */
  isMultiRepo?: boolean;
}

/** 格式化信标输出行，确保可执行性与 token 预算严格收敛 */
function renderBeaconLines(opts: {
  primarySymbol?: string;
  secondarySymbol?: string;
  primarySource?: CleanedPathFact;
  secondaryFile?: string;
  symbolRepoParam?: string;
  fileRepoParam?: string;
  gitSha?: string | null;
  includePreface?: boolean;
}): string {
  const {
    primarySymbol,
    secondarySymbol,
    primarySource,
    secondaryFile,
    symbolRepoParam = '',
    fileRepoParam = '',
    gitSha,
    includePreface = true,
  } = opts;

  let symbolLine: string;
  if (primarySymbol) {
    const alsoPart = secondarySymbol ? ` (also: \`${secondarySymbol}\`)` : '';
    symbolLine = `- Symbol: \`read_symbol(symbol="${primarySymbol}"${symbolRepoParam})\`${alsoPart}`;
  } else {
    symbolLine = `- Symbol: \`read_symbol(symbol="<symbol_name>"${symbolRepoParam})\``;
  }

  let sourceLine: string;
  if (primarySource) {
    const alsoPart = secondaryFile ? ` (also: \`${secondaryFile}\`)` : '';
    const lineParams = primarySource.startLine
      ? `, start_line=${primarySource.startLine}${primarySource.endLine && primarySource.endLine !== primarySource.startLine ? `, end_line=${primarySource.endLine}` : ''}`
      : '';
    sourceLine = `- Source: \`read_source_file(path="${primarySource.path}"${lineParams}${fileRepoParam})\`${alsoPart}`;
  } else {
    sourceLine = `- Source: \`read_source_file(path="<file_path>"${fileRepoParam})\``;
  }

  const promptLine = includePreface
    ? 'Tutorial may simplify code. Drill down into physical AST/source facts:'
    : 'Drill down into physical AST/source facts:';

  const shortSha = gitSha && typeof gitSha === 'string' && gitSha.trim()
    ? gitSha.trim().slice(0, 7)
    : null;
  const titleBadge = shortSha
    ? `🔍 **Provenance Beacon (L2 Ground Truth · ${shortSha})**`
    : '🔍 **Provenance Beacon (L2 Ground Truth)**';

  return [
    '---',
    titleBadge,
    promptLine,
    symbolLine,
    sourceLine,
  ].join('\n');
}

/**
 * 投影溯源信标（纯函数，零 DB I/O，微秒级执行）。
 * 输出严格控制在 80 tokens 内，提供可执行的 read_symbol / read_source_file 调用模板。
 */
export function projectProvenanceBeacon(opts: ProvenanceBeaconOptions = {}): string {
  const content = opts.content || '';
  const facts = extractGroundingFacts(content);

  const isMultiRepo = opts.isMultiRepo ?? false;
  const repoParam = isMultiRepo
    ? opts.repository
      ? `, repository="${opts.repository}"`
      : ', repository="<owner/repo>"'
    : '';

  const primarySymbol = facts.symbols[0];
  const secondarySymbol = facts.symbols[1];
  const primarySource = facts.sourceFacts?.[0] || (facts.sourceFiles[0] ? { path: facts.sourceFiles[0] } : undefined);
  const secondaryFile = facts.sourceFiles[1];

  // 1. 尝试全量渲染（含二级符号/文件、精确行号与完整提示）
  let beacon = renderBeaconLines({
    primarySymbol,
    secondarySymbol,
    primarySource,
    secondaryFile,
    symbolRepoParam: repoParam,
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: true,
  });
  if (estimateTokens(beacon) < 80) return beacon;

  // 2. 超预算时：丢弃二级符号/文件（保留主文件行号）
  beacon = renderBeaconLines({
    primarySymbol,
    primarySource,
    symbolRepoParam: repoParam,
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: true,
  });
  if (estimateTokens(beacon) < 80) return beacon;

  // 3. 仍超预算时（超长仓名或超长文件路径）：缩减引导句
  beacon = renderBeaconLines({
    primarySymbol,
    primarySource,
    symbolRepoParam: repoParam,
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: false,
  });
  if (estimateTokens(beacon) < 80) return beacon;

  // 4. 极端超长：如果带行号仍超预算，剥离行号只留裸路径
  if (primarySource && primarySource.startLine) {
    beacon = renderBeaconLines({
      primarySymbol,
      primarySource: { path: primarySource.path },
      symbolRepoParam: repoParam,
      fileRepoParam: repoParam,
      gitSha: opts.gitSha,
      includePreface: false,
    });
    if (estimateTokens(beacon) < 80) return beacon;
  }

  // 5. 极端超长仓名：read_symbol 的 repository 在 Hub schema 下属可选参数，省去符号行的 repo 参数
  beacon = renderBeaconLines({
    primarySymbol,
    primarySource: primarySource ? { path: primarySource.path } : undefined,
    symbolRepoParam: '',
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: false,
  });
  if (estimateTokens(beacon) < 80) return beacon;

  // 6. 极端超长文件路径：退回泛型占位符以确保绝对不突破 80 tokens 红线
  beacon = renderBeaconLines({
    symbolRepoParam: repoParam,
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: false,
  });
  if (estimateTokens(beacon) < 80) return beacon;

  // 7. 终极兜底：无仓名紧凑占位模板（~35 tokens）
  return renderBeaconLines({
    includePreface: false,
  });
}

/** 别名导出，保证直觉一致性 */
export const buildProvenanceBeacon = projectProvenanceBeacon;

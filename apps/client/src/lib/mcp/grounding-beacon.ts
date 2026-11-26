import { parseMarkdownAst, walkMarkdownAst } from '@/engine/markdown/mdast-ast';
import { ignoreBestEffort } from '@/lib/best-effort';
import { estimateTokens } from '@/lib/token-counter';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';

const EXTRA_SOURCE_EXTENSIONS = new Set([
  '.proto', '.sql', '.vue', '.svelte', '.css', '.scss', '.html',
]);

function isSourceCodeExtension(ext: string): boolean {
  if (ext === '.md' || ext === '.mdx' || ext === '.txt' || ext === '.csv') return false;
  return EXTRA_SOURCE_EXTENSIONS.has(ext) || MODULE_ROLE_PATTERNS.allowedFileExtensions.test(ext);
}

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

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.:-]*[A-Za-z0-9_]$/;

export interface CleanedPathFact {
  path: string;
  startLine?: number;
  endLine?: number;
}

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
  let cleaned = token.replace(/^[('"`\[<]+|[)'"`\]>,;:]+$/g, '').trim();
  if (!cleaned || cleaned.includes(' ') || cleaned.length > 200) return null;

  if (cleaned.includes('=') || cleaned.includes('"') || cleaned.includes("'")) return null;

  cleaned = cleaned.replace(/(?::\d+(?:-\d+)?|[#?].*)$/, '');

  cleaned = cleaned.replace(/\\/g, '/');

  if (cleaned.startsWith('./')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }

  if (!cleaned || cleaned.includes('..')) return null;

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

export function parsePathFactToken(rawToken: string): CleanedPathFact | null {
  if (!rawToken || typeof rawToken !== 'string') return null;
  let raw = rawToken.trim();
  if (!raw || raw.length > 200) return null;

  raw = raw.replace(/^[`"'<]+|[`"'>]+$/g, '').trim();
  raw = raw.replace(/^(?:code|file|path|filepath):\s*/i, '').trim();

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
      if (node.type === 'code') {
        const codeNode = node as { meta?: string | null; value?: string };
        const meta = (codeNode.meta ?? '').trim();
        if (meta) {
          const attrMatch = /(?:path|file|filename|title)=["']?([^"'\s>]+)["']?/.exec(meta);
          if (attrMatch?.[1]) {
            registerFact(parsePathFactToken(attrMatch[1]));
          }
          for (const prefix of ['//', '#', '--'] as const) {
            if (meta.startsWith(prefix)) {
              const candidate = meta.slice(prefix.length).trim();
              registerFact(parsePathFactToken(candidate));
              break;
            }
          }
          if (!meta.includes('=')) {
            registerFact(parsePathFactToken(meta));
          }
        }

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

      if (node.type === 'html') {
        const htmlVal = (node as { value?: string }).value ?? '';
        for (const match of htmlVal.matchAll(/<!--\s*path:\s*([^>]+?)\s*-->/g)) {
          if (match[1]) {
            registerFact(parsePathFactToken(match[1].trim()));
          }
        }
      }

      if (node.type === 'inlineCode') {
        const rawVal = ((node as { value?: string }).value ?? '').trim();
        if (rawVal) {
          const fact = parsePathFactToken(rawVal);
          if (fact) {
            registerFact(fact);
          } else {
            const candidateSymbol = rawVal.endsWith('()') ? rawVal.slice(0, -2).trim() : rawVal;
            if (isValidSymbol(candidateSymbol)) {
              symbols.add(candidateSymbol);
            }
          }
        }
      }

      if (node.type === 'link') {
        const linkNode = node as { url?: string };
        const url = (linkNode.url ?? '').trim();
        if (url && !url.startsWith('http:') && !url.startsWith('https:') && !url.startsWith('#') && !url.startsWith('mailto:')) {
          registerFact(parsePathFactToken(url));
        }
      }
    });
  } catch {
    ignoreBestEffort();
  }

  return {
    symbols: Array.from(symbols),
    sourceFiles: Array.from(sourceFiles),
    sourceFacts: Array.from(sourceFactsMap.values()),
  };
}

export interface ProvenanceBeaconOptions {
  content?: string | null;
  docPath?: string;
  repository?: string;
  gitSha?: string | null;
  isMultiRepo?: boolean;
}

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

// Progressive degradation ladder guarantees output stays within the 80-token beacon budget.
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

  beacon = renderBeaconLines({
    primarySymbol,
    primarySource,
    symbolRepoParam: repoParam,
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: true,
  });
  if (estimateTokens(beacon) < 80) return beacon;

  beacon = renderBeaconLines({
    primarySymbol,
    primarySource,
    symbolRepoParam: repoParam,
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: false,
  });
  if (estimateTokens(beacon) < 80) return beacon;

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

  beacon = renderBeaconLines({
    primarySymbol,
    primarySource: primarySource ? { path: primarySource.path } : undefined,
    symbolRepoParam: '',
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: false,
  });
  if (estimateTokens(beacon) < 80) return beacon;

  beacon = renderBeaconLines({
    symbolRepoParam: repoParam,
    fileRepoParam: repoParam,
    gitSha: opts.gitSha,
    includePreface: false,
  });
  if (estimateTokens(beacon) < 80) return beacon;

  return renderBeaconLines({
    includePreface: false,
  });
}

export const buildProvenanceBeacon = projectProvenanceBeacon;

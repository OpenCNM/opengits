import { normalizeLocale, detectLangFromPath, langDisplayName } from './languages';
import { isCodeFile, detectLanguage } from '@/engine/languages';
import type { GitHubNode } from '@/engine/repo-sniffer';

export interface DirCandidate {
  dir: string;
  lang: string | null;
  role: 'primary' | 'translation' | 'auxiliary';
  confidence: number;
  reason?: string;
}

export interface DirVerdict {
  primaryRoot: string;
  candidates: DirCandidate[];
}

const DIR_CAP = 1500;
const SAMPLE_CHILDREN_LIMIT = 10;

interface CodeCandidate {
  filename: string;
  isDirect: boolean;
  isTest: boolean;
  isBoilerplate: boolean;
  lang: string;
}

interface DirStats {
  mdCount: number;
  codeCount: number;
  langCounts: Map<string, number>;
  codeFiles: CodeCandidate[];
  children: string[];
}

function isTestFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    lower.startsWith('test_') ||
    lower.startsWith('test-') ||
    lower.endsWith('_test.go') ||
    lower.endsWith('_test.py') ||
    lower.endsWith('-test.py') ||
    lower.endsWith('.test.ts') ||
    lower.endsWith('.test.tsx') ||
    lower.endsWith('.test.js') ||
    lower.endsWith('.test.jsx') ||
    lower.endsWith('.spec.ts') ||
    lower.endsWith('.spec.tsx') ||
    lower.endsWith('.spec.js') ||
    lower.endsWith('.spec.jsx') ||
    lower.endsWith('_test.rs') ||
    lower.endsWith('-test.rs') ||
    lower === 'test.py' ||
    lower === 'tests.py' ||
    lower === 'test.ts' ||
    lower === 'test.js' ||
    lower === 'test.go'
  );
}

function isBoilerplateFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    lower === '__init__.py' ||
    lower === 'index.ts' ||
    lower === 'index.js' ||
    lower === 'index.tsx' ||
    lower === 'index.jsx'
  );
}

function computePrimaryLang(langCounts: Map<string, number>): string {
  let bestLang = '';
  let bestCount = -1;
  for (const [lang, count] of langCounts.entries()) {
    if (count > bestCount || (count === bestCount && (bestLang === '' || lang < bestLang))) {
      bestCount = count;
      bestLang = lang;
    }
  }
  return bestLang;
}

function selectKeyFiles(candidates: CodeCandidate[], primaryLang: string): string[] {
  if (!candidates || candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => {
    if (a.isTest !== b.isTest) return a.isTest ? 1 : -1;
    if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
    if (a.isBoilerplate !== b.isBoilerplate) return a.isBoilerplate ? 1 : -1;
    const matchA = a.lang === primaryLang;
    const matchB = b.lang === primaryLang;
    if (matchA !== matchB) return matchA ? -1 : 1;
    return a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
  });

  const result: string[] = [];
  const seen = new Set<string>();
  for (const c of sorted) {
    if (seen.has(c.filename)) continue;
    seen.add(c.filename);
    result.push(c.filename);
    if (result.length >= 3) break;
  }
  return result;
}

function collectDirStats(nodes: GitHubNode[]): Map<string, DirStats> {
  const stats = new Map<string, DirStats>();
  const ensure = (dir: string): DirStats => {
    let s = stats.get(dir);
    if (!s) {
      s = {
        mdCount: 0,
        codeCount: 0,
        langCounts: new Map<string, number>(),
        codeFiles: [],
        children: [],
      };
      stats.set(dir, s);
    }
    return s;
  };

  for (const node of nodes) {
    if (node.type === 'tree') {
      const selfDir = node.path.endsWith('/') ? node.path : node.path + '/';
      ensure(selfDir);
      const parent = node.path.includes('/') ? node.path.substring(0, node.path.lastIndexOf('/')) + '/' : '';
      if (parent) ensure(parent).children.push(node.path.split('/').pop() || '');
    } else if (node.type === 'blob') {
      const isMd = node.path.endsWith('.md') || node.path.endsWith('.mdx');
      const parts = node.path.split('/');
      const filename = parts[parts.length - 1];

      let isCode = !filename.startsWith('.') && isCodeFile(node.path);
      const langEntry = isCode ? detectLanguage(node.path) : null;
      const lang = langEntry ? langEntry.name : '';
      if (!lang) isCode = false;

      const isTest = isCode && isTestFile(filename);
      const isBoilerplate = isCode && isBoilerplateFile(filename);

      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        const s = ensure(acc + '/');
        if (isMd) s.mdCount += 1;
        if (isCode) {
          s.codeCount += 1;
          s.langCounts.set(lang, (s.langCounts.get(lang) || 0) + 1);
          s.codeFiles.push({
            filename,
            isDirect: i === parts.length - 2,
            isTest,
            isBoilerplate,
            lang,
          });
        }
      }
    }
  }
  return stats;
}

export interface DirTreeNode {
  path: string;
  name: string;
  depth: number;
  mdCount: number;
  codeCount?: number;
  primaryLang?: string;
  keyFiles?: string[];
  totalFiles: number;
  children: DirTreeNode[];
}

export interface DirInventory {
  lines: string[];
  totalDirs: number;
  truncated: boolean;
}

const DIR_TREE_MAX_DEPTH = 8;
export const DIR_TREE_MAX_NODES = 2000;

const naturalDirOrder = (a: DirTreeNode, b: DirTreeNode): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function sortTreeLevels(nodes: DirTreeNode[]): void {
  nodes.sort(naturalDirOrder);
  for (const n of nodes) sortTreeLevels(n.children);
}

function countSubtreeNodes(node: DirTreeNode): number {
  return 1 + node.children.reduce((acc, c) => acc + countSubtreeNodes(c), 0);
}

function pruneToBudget(
  nodes: DirTreeNode[],
  budget: number,
  subtreeSize: (n: DirTreeNode) => number,
): DirTreeNode[] {
  const ordered = [...nodes].sort((a, b) => {
    if (a.mdCount !== b.mdCount) return b.mdCount - a.mdCount;
    return (b.codeCount ?? 0) - (a.codeCount ?? 0);
  });
  const kept: DirTreeNode[] = [];
  let remaining = budget;
  for (const node of ordered) {
    if (remaining <= 0) break;
    const size = subtreeSize(node);
    if (size <= remaining) {
      kept.push(node);
      remaining -= size;
    } else {
      const descended = pruneToBudget(node.children, remaining - 1, subtreeSize);
      if (descended.length > 0) {
        kept.push({ ...node, children: descended });
        remaining -= 1 + descended.reduce((acc, n) => acc + subtreeSize(n), 0);
      }
    }
  }
  return kept;
}

export function buildDirTree(nodes: GitHubNode[]): DirTreeNode[] {
  const stats = collectDirStats(nodes);
  const rootChildren: DirTreeNode[] = [];
  const map = new Map<string, DirTreeNode>();

  const entries = [...stats.entries()]
    .map(([dir, s]) => {
      const parts = dir.split('/').filter(Boolean);
      return { dir, parts, depth: parts.length, ...s };
    })
    .filter((e) => e.depth >= 1 && e.depth <= DIR_TREE_MAX_DEPTH)
    .sort((a, b) => a.depth - b.depth || a.dir.localeCompare(b.dir));

  for (const e of entries) {
    const primaryLang = computePrimaryLang(e.langCounts);
    const keyFiles = selectKeyFiles(e.codeFiles, primaryLang);
    const node: DirTreeNode = {
      path: e.dir,
      name: e.parts[e.parts.length - 1],
      depth: e.depth,
      mdCount: e.mdCount,
      codeCount: e.codeCount,
      primaryLang: primaryLang || undefined,
      keyFiles: keyFiles.length > 0 ? keyFiles : undefined,
      totalFiles: e.children.length,
      children: [],
    };
    map.set(e.dir, node);

    if (e.depth === 1) {
      rootChildren.push(node);
    } else {
      const parentDir = e.parts.slice(0, e.parts.length - 1).join('/') + '/';
      const parentNode = map.get(parentDir);
      if (parentNode) {
        parentNode.children.push(node);
      } else {
        rootChildren.push(node);
      }
    }
  }

  const total = rootChildren.reduce((acc, n) => acc + countSubtreeNodes(n), 0);
  let result = rootChildren;
  if (total > DIR_TREE_MAX_NODES) {
    const sizeMemo = new Map<DirTreeNode, number>();
    const memoSize = (n: DirTreeNode): number => {
      let s = sizeMemo.get(n);
      if (s === undefined) {
        s = 1 + n.children.reduce((acc, c) => acc + memoSize(c), 0);
        sizeMemo.set(n, s);
      }
      return s;
    };
    result = pruneToBudget(rootChildren, DIR_TREE_MAX_NODES, memoSize);
  }

  sortTreeLevels(result);
  return result;
}

export function buildDirInventory(nodes: GitHubNode[], cap: number = DIR_CAP): DirInventory {
  const stats = collectDirStats(nodes);
  const entries = [...stats.entries()].map(([dir, s]) => {
    const depth = dir.split('/').filter(Boolean).length;
    return { dir, ...s, depth };
  });

  const visible = entries.filter((e) => e.depth <= 2 && (e.depth === 1 || e.mdCount >= 3));
  visible.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (b.mdCount !== a.mdCount) return b.mdCount - a.mdCount;
    return a.dir.localeCompare(b.dir);
  });

  const truncated = visible.length > cap;
  const lines = visible.slice(0, cap).map((e) => {
    let line = `${e.dir} (${e.mdCount} md)`;
    if (e.mdCount >= 3) {
      const samples = e.children.slice(0, SAMPLE_CHILDREN_LIMIT).join(', ');
      if (samples) line += ` | children: ${samples}`;
    }
    return line;
  });

  return { lines, totalDirs: visible.length, truncated };
}

export function validateVerdict(raw: { primaryRoot: string; candidates?: DirCandidate[] }, nodes: GitHubNode[]): DirVerdict | null {
  const stats = collectDirStats(nodes);
  const exists = new Set(stats.keys());

  const normDir = (d: string): string => {
    let dir = d.trim();
    if (!dir) return '';
    if (!dir.endsWith('/')) dir += '/';
    return dir;
  };

  const seen = new Set<string>();
  const candidates: DirCandidate[] = [];
  let primaryDir = '';
  if (raw.primaryRoot !== undefined && raw.primaryRoot !== null) {
    primaryDir = normDir(String(raw.primaryRoot));
  }
  const rootIsPrimary = primaryDir === '';
  for (const c of raw.candidates ?? []) {
    const dir = normDir(c.dir);
    if (!dir || seen.has(dir) || !exists.has(dir)) continue;
    if (rootIsPrimary && c.role === 'primary') continue;
    const mdCount = stats.get(dir)?.mdCount ?? 0;
    if (c.role === 'primary' && mdCount < 3) continue;
    if (c.role !== 'primary' && mdCount < 1) continue;
    seen.add(dir);
    candidates.push({
      dir,
      lang: normalizeLocale(c.lang) ?? detectLangFromPath(dir),
      role: c.role,
      confidence: c.confidence,
      reason: c.reason,
    });
  }

  if (primaryDir !== '') {
    const mdCount = stats.get(primaryDir)?.mdCount ?? 0;
    if (mdCount >= 3 && !seen.has(primaryDir)) {
      seen.add(primaryDir);
      candidates.push({ dir: primaryDir, lang: null, role: 'primary', confidence: 1 });
    }
  }

  if (candidates.length === 0) return null;
  return { primaryRoot: primaryDir, candidates };
}

export interface VersionEntry {
  name: string;
  prefix: string;
  lang?: string | null;
  role?: string;
  confidence?: number;
}

export function mergeVerdictIntoVersions(heuristicVersions: VersionEntry[], verdict: DirVerdict | null): VersionEntry[] {
  const merged = heuristicVersions.map((v) => ({ ...v }));
  if (!verdict) return merged;

  const index = new Map(merged.map((v, i) => [v.prefix.replace(/\/$/, '') || '', i]));

  for (const c of verdict.candidates) {
    if (c.role === 'auxiliary') continue;
    const key = c.dir.replace(/\/$/, '') || '';
    const name = c.role === 'primary'
      ? (c.dir === '' ? 'Root / Main Content' : `正文内容 (${c.dir})`)
      : c.lang
        ? `${langDisplayName(c.lang)} (${c.dir})`
        : `Translation (${c.dir})`;
    const entry: VersionEntry = {
      name,
      prefix: c.dir,
      lang: c.lang,
      role: c.role,
      confidence: c.confidence,
    };
    const existingIdx = index.get(key);
    if (existingIdx !== undefined) {
      merged[existingIdx] = entry;
    } else {
      index.set(key, merged.length);
      merged.push(entry);
    }
  }
  return merged;
}

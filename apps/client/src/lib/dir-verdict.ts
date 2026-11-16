// 目录裁决工具库：仓库目录树的确定性构建/统计/校验。
//
// 历史注记：LLM 裁决入口 runDirVerdict（90s 超时的 BYOK 小任务）已由第一性
// 原理架构层的 aiSniffRepo 单次闭环取代并物理删除（零调用方）。本文件保留
// 的是确定性工具：buildDirTree（前端树状选择器）、buildDirInventory /
// validateVerdict（裁决校验门，供测试与未来 sniffer 复用）、
// mergeVerdictIntoVersions（版本合并）。
//
// 设计要点：
// - 输入不是整棵 tree（大仓库几万节点会爆上下文），而是"目录名 + 每目录 md 数 + 内容密集目录的子目录样例"
// - 校验门：LLM 可能编造路径 / 语言码，必须回校真实 tree 后才可使用

import { normalizeLocale, detectLangFromPath, langDisplayName } from './languages';
import { isCodeFile, detectLanguage } from '@/engine/languages';
import type { GitHubNode } from '@/engine/repo-sniffer';

/** 单个目录裁决结果 */
export interface DirCandidate {
  /** 目录路径，含尾斜杠；'' 表示仓库根 */
  dir: string;
  /** 规范化语言码（zh-CN / ja / en...），无法识别为 null */
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
  /** 子树内 markdown 文件总数（含深层） */
  mdCount: number;
  /** 子树内代码文件总数（含深层） */
  codeCount: number;
  /** 各编程语言计数 */
  langCounts: Map<string, number>;
  /** 候选源码文件 */
  codeFiles: CodeCandidate[];
  /** 直接子目录名（tree 节点，用于镜像结构证据） */
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

/** 统计每个目录的 md 数、代码数与直接子目录 */
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
      // 登记目录自身（即使 0 md / 无子目录，顶层布局信息对 LLM 也有用）
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

      // 每个祖先目录都计入统计（子树口径）
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

/** 目录树深度上限:防无意义超深嵌套 */
const DIR_TREE_MAX_DEPTH = 8;
/**
 * 目录树节点上限:防巨型仓(数万目录)把 dirTree 撑爆 API payload。
 * 量级依据:多语言教程仓(如 for-beginners 系列,40+ 语言 × ~19 章节)约 800~1000 目录,
 * 节点元数据 ~150B/个,2000 节点 ≈ 300KB,足够覆盖人类规模仓库;
 * 超限执行"完整子树整枝裁剪"(pruneToBudget),不再做全局平铺截断——
 * 平铺截断按 mdCount 交错砍目录,会把翻译目录(如 translations/zh-CN/)的章节子目录砍缺
 */
export const DIR_TREE_MAX_NODES = 2000;

/** 同级目录排序:文件名自然序(数字感知,00 → 01 → 02 → 10),与 GitHub 目录展示一致 */
const naturalDirOrder = (a: DirTreeNode, b: DirTreeNode): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function sortTreeLevels(nodes: DirTreeNode[]): void {
  nodes.sort(naturalDirOrder);
  for (const n of nodes) sortTreeLevels(n.children);
}

function countSubtreeNodes(node: DirTreeNode): number {
  return 1 + node.children.reduce((acc, c) => acc + countSubtreeNodes(c), 0);
}

/**
 * 预算裁剪:总量超 DIR_TREE_MAX_NODES 时按子树 md 密度(mdCount 降序)整枝保留。
 * 保留的每一枝都是完整子树——不会出现"父目录在、部分子目录被砍"的交错缺失;
 * 单枝自身超预算时下钻其子目录继续分配(同样整枝口径)。
 */
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
      // 下钻预算先扣除父节点自身占的 1 个名额,保证总量不超上限
      const descended = pruneToBudget(node.children, remaining - 1, subtreeSize);
      if (descended.length > 0) {
        kept.push({ ...node, children: descended });
        remaining -= 1 + descended.reduce((acc, n) => acc + subtreeSize(n), 0);
      }
    }
  }
  return kept;
}

/**
 * 把仓库目录构建为全深度树(供前端树状目录选择器使用)。
 * 与旧 build3LevelDirTree 的区别:
 * - 不限于 3 级(上限 DIR_TREE_MAX_DEPTH),用户可展开深入
 * - 包含 0-md 目录(真实项目树可导航;mdCount 作徽标展示,非过滤条件)
 * - 同级按文件名自然序(数字感知),章节顺序与 GitHub 一致
 * - 超节点上限时整枝裁剪(完整子树),不做全局平铺截断
 */
export function buildDirTree(nodes: GitHubNode[]): DirTreeNode[] {
  const stats = collectDirStats(nodes);
  const rootChildren: DirTreeNode[] = [];
  const map = new Map<string, DirTreeNode>();

  // 深度优先排序保证父目录先于子目录建节点;同级稳定序避免依赖 Map 迭代顺序
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
        // 父目录无 tree 节点(仅由 blob 路径推导而来)时挂到根,保证节点不丢
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

/**
 * 把 tree 压成紧凑前2级目录清单：`dir (N md)`。
 * - 2 级已覆盖 LLM 裁决所需的全部关键信息：正文根 / 语言目录 / 内容块都在 1-2 级，
 *   更深结构由 children（直接子目录名，最多 SAMPLE_CHILDREN_LIMIT 个）补偿
 *   （如 `i18n/ (N md) | children: zh-CN, en`），实测 3 级清单中 ≤2 级目录零丢失；
 *   减少输入 token 可降低模型延迟（实测 40~90s）与输出漂移
 */
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

/** 校验裁决（LLM 或嗅探产物共用）：目录必须真实存在且满足最低 md 数，语言码规范化 */
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
  // 模型矛盾输出清理：primaryRoot=''（正文在根）却把顶层目录也判为 primary，
  // 自相矛盾（根是主内容根时顶层目录只是它的子内容，不应是独立 primary）。
  // 先解析 primaryRoot 再过滤，避免矛盾条目污染版本合并。
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
    // 主内容根需要 ≥3 篇 md；翻译/辅助目录至少 1 篇
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

  // primaryRoot 单独校验（可能不在 candidates 里；'' 表示仓库根，是合法值）
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

/** 版本条目（scout versions 的结构化子集） */
export interface VersionEntry {
  name: string;
  prefix: string;
  lang?: string | null;
  role?: string;
  confidence?: number;
}

/**
 * 把 LLM 裁决合并进启发式版本列表：
 * - 同 prefix 条目：AI 裁决覆盖启发式（AI 带规范语言名，如 "简体中文 (translations/zh-CN/)"）
 * - 新目录：追加；auxiliary 一律不收录
 */
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

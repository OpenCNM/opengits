import { DocumentItem, NavNodeItem } from './types';
import { formatHumanReadableTitle, multiLevelNumericPrefixPattern } from '@/engine/structurizer/prefix-cleaner';

/**
 * 独立的 Web 文档目录树重构器：
 * 将扁平的文档集合递归转换为树状结构 (NavNodeItem[])
 *
 * @param orderUrls 顺序信号（导航区链接出现顺序 = 作者意图的主线顺序）：
 *   提供时以它为主序（目录节点取子树最小信号序），无信号的文件回退
 *   数字前缀/字典序——排序器永不凭空制造顺序（与 GitHub 侧大纲编排同哲学）
 */
export function buildWebNavTree(
  documents: DocumentItem[],
  options: { baseUrl?: string; orderUrls?: string[] } = {}
): NavNodeItem[] {
  const root: NavNodeItem[] = [];

  for (const doc of documents) {
    if (!doc || !doc.path) continue;
    // 去除 .md 或 .mdx 后缀进行目录切分
    const cleanPath = doc.path.replace(/\.mdx?$/, '').replace(/^\//, '');
    const segments = cleanPath.split('/').filter(Boolean);

    if (segments.length === 0) continue;

    let currentLevel = root;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isFile = i === segments.length - 1;
      if (!Array.isArray(currentLevel)) {
        currentLevel = root;
      }
      let node = currentLevel.find((n) => n && n.name === segment);

      if (!node) {
        const rawNodePath = segments.slice(0, i + 1).join('/');
        node = {
          name: segment,
          title: isFile ? (doc.title || formatTitleFromSegment(segment)) : formatTitleFromSegment(segment),
          type: isFile ? 'file' : 'directory',
          path: isFile ? doc.path : rawNodePath,
          sourceUrl: isFile ? doc.url : undefined,
          ...(isFile ? {} : { children: [] }),
        };
        currentLevel.push(node);
      } else if (isFile) {
        // 先有子路径后到同名页（如先见 chat-sdk/reference.md 后见 chat-sdk.md）：
        // 在目录节点挂载自身索引文档字段，绝不丢弃父页正文
        node.indexPath = doc.path;
        node.indexTitle = doc.title || node.title;
        node.indexUrl = doc.url;
        if (doc.title) node.title = doc.title;
        if (doc.url && !node.sourceUrl) node.sourceUrl = doc.url;
      }

      if (!isFile) {
        // 同名段冲突晋升：裸索引页（如 /docs 或 chat-sdk.md）先以文件节点落地（无 children），
        // 后续更深路径（/docs/installation 或 chat-sdk/reference.md）需经它下沉——
        // 保存自身索引文档后补挂 children 并晋升为目录，绝不吞掉父页也绝不让 currentLevel 变 undefined
        if (!node.children || !Array.isArray(node.children)) {
          if (node.type === 'file' && node.path) {
            node.indexPath = node.indexPath || node.path;
            node.indexTitle = node.indexTitle || node.title;
            node.indexUrl = node.indexUrl || node.sourceUrl;
          }
          node.children = [];
          node.type = 'directory';
        }
        currentLevel = node.children;
      }
    }
  }

  sortNavTree(root, buildOrderIndex(options.orderUrls));
  return root;
}

/** url → 主线顺序索引（重复 url 取首次出现——导航里首次即作者意图位次） */
function buildOrderIndex(orderUrls?: string[]): Map<string, number> | undefined {
  if (!orderUrls || orderUrls.length === 0) return undefined;
  const idx = new Map<string, number>();
  for (const u of orderUrls) {
    if (!idx.has(u)) idx.set(u, idx.size);
  }
  return idx;
}

/** 节点的信号序：文件节点查 sourceUrl / url；目录节点取自身索引页与子树最小信号序（无信号 Infinity） */
function orderOfNode(node: NavNodeItem, orderIdx: Map<string, number>): number {
  if (node.type === 'file') {
    const targetUrl = node.sourceUrl || node.url;
    return targetUrl ? orderIdx.get(targetUrl) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  }
  const selfUrl = node.indexUrl || node.sourceUrl || node.url;
  let min = selfUrl ? orderIdx.get(selfUrl) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const walk = (children: NavNodeItem[] | undefined) => {
    for (const c of children || []) {
      min = Math.min(min, orderOfNode(c, orderIdx));
    }
  };
  walk(node.children);
  return min;
}

/**
 * 将文件名转换为格式化标题 (如 '01-quick-start' -> 'Quick Start', 'api-reference' -> 'API Reference')
 * 统一委托给 prefix-cleaner 的 formatHumanReadableTitle，保持专有名词与多级编号逻辑一致。
 */
export function formatTitleFromSegment(segment: string): string {
  return formatHumanReadableTitle(segment);
}

/**
 * 递归排序目录树：主线顺序信号（导航区出现顺序，物理事实优先）→
 * 开篇核心文档启发式置顶 → 数字前缀 → 保持初始物理顺序（严禁粗暴字母字典序颠倒作者教学心智）
 */
function sortNavTree(nodes: NavNodeItem[], orderIdx?: Map<string, number>) {
  if (!Array.isArray(nodes)) return;
  const isPriorityDoc = (name: string) => {
    const lower = name.toLowerCase();
    return (
      lower === 'index' ||
      lower === 'readme' ||
      lower === 'getting-started' ||
      lower === 'get-started' ||
      lower === 'quickstart' ||
      lower === 'quick-start' ||
      lower === 'intro' ||
      lower === 'introduction'
    );
  };

  nodes.sort((a, b) => {
    // 1. 主线顺序信号（导航区出现顺序）优先于一切启发式（物理事实优先）
    if (orderIdx) {
      const ordA = orderOfNode(a, orderIdx);
      const ordB = orderOfNode(b, orderIdx);
      if (ordA !== ordB) {
        if (ordA === Number.MAX_SAFE_INTEGER) return 1;
        if (ordB === Number.MAX_SAFE_INTEGER) return -1;
        return ordA - ordB;
      }
    }

    // 2. 启发式顺序：开篇核心文档置顶（仅在无顺序信号或双方信号相同/缺失时生效）
    const isPriorityA = isPriorityDoc(a.name);
    const isPriorityB = isPriorityDoc(b.name);
    if (isPriorityA && !isPriorityB) return -1;
    if (isPriorityB && !isPriorityA) return 1;

    // 3. 检查数字前缀（支持单级 01- 或多级 1.1-、1.2-）
    const hasPrefixA = multiLevelNumericPrefixPattern.test(a.name);
    const hasPrefixB = multiLevelNumericPrefixPattern.test(b.name);

    if (hasPrefixA && hasPrefixB) {
      // 自然数字序对比，精准支持多级编号递进（如 1.1 < 1.2 < 1.10）
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    }
    if (hasPrefixA) return -1;
    if (hasPrefixB) return 1;

    // 4. 目录优先保持平稳，无明确信号时不以字母字典序打乱
    return 0;
  });

  for (const node of nodes) {
    if (Array.isArray(node.children) && node.children.length > 0) {
      sortNavTree(node.children, orderIdx);
    }
  }
}

import { DocumentItem, NavNodeItem } from './types';
import { formatHumanReadableTitle, multiLevelNumericPrefixPattern } from '@/engine/structurizer/prefix-cleaner';

export function buildWebNavTree(
  documents: DocumentItem[],
  options: { baseUrl?: string; orderUrls?: string[] } = {}
): NavNodeItem[] {
  const root: NavNodeItem[] = [];

  for (const doc of documents) {
    if (!doc || !doc.path) continue;
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
        // Attach index fields to existing directory node so sibling index pages (e.g. chat-sdk.md + chat-sdk/ref.md) keep their content.
        node.indexPath = doc.path;
        node.indexTitle = doc.title || node.title;
        node.indexUrl = doc.url;
        if (doc.title) node.title = doc.title;
        if (doc.url && !node.sourceUrl) node.sourceUrl = doc.url;
      }

      if (!isFile) {
        // Promote an already-created file node into a directory while preserving its own index document fields.
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

function buildOrderIndex(orderUrls?: string[]): Map<string, number> | undefined {
  if (!orderUrls || orderUrls.length === 0) return undefined;
  const idx = new Map<string, number>();
  for (const u of orderUrls) {
    if (!idx.has(u)) idx.set(u, idx.size);
  }
  return idx;
}

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

export function formatTitleFromSegment(segment: string): string {
  return formatHumanReadableTitle(segment);
}

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

  // Order by navigation orderUrls first, then priority landing docs and natural numeric prefixes; never force alphabetical sorting.
  nodes.sort((a, b) => {
    if (orderIdx) {
      const ordA = orderOfNode(a, orderIdx);
      const ordB = orderOfNode(b, orderIdx);
      if (ordA !== ordB) {
        if (ordA === Number.MAX_SAFE_INTEGER) return 1;
        if (ordB === Number.MAX_SAFE_INTEGER) return -1;
        return ordA - ordB;
      }
    }

    const isPriorityA = isPriorityDoc(a.name);
    const isPriorityB = isPriorityDoc(b.name);
    if (isPriorityA && !isPriorityB) return -1;
    if (isPriorityB && !isPriorityA) return 1;

    const hasPrefixA = multiLevelNumericPrefixPattern.test(a.name);
    const hasPrefixB = multiLevelNumericPrefixPattern.test(b.name);

    if (hasPrefixA && hasPrefixB) {
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    }
    if (hasPrefixA) return -1;
    if (hasPrefixB) return 1;

    return 0;
  });

  for (const node of nodes) {
    if (Array.isArray(node.children) && node.children.length > 0) {
      sortNavTree(node.children, orderIdx);
    }
  }
}

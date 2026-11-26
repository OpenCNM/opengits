import { OutlineDraft } from './ingest-orchestrator';

export interface OutlineNavNode {
  name?: string;
  title?: string;
  shortTitle?: string;
  type: 'file' | 'directory';
  path: string;
  url?: string;
  sourceUrl?: string;
  indexPath?: string;
  indexTitle?: string;
  children?: OutlineNavNode[];
}

function nodeTitle(node: OutlineNavNode): string {
  return node.shortTitle || node.title || node.path.split('/').pop() || node.path;
}

// Deterministic 1:1 navTree -> TutorialOutline projection with zero LLM calls and full file coverage.

function collectFiles(node: OutlineNavNode): OutlineDraft['chapters'][number]['nodes'] {
  if (node.type === 'file') {
    return [{ sourcePath: node.path, title: nodeTitle(node), nodeType: 'doc' }];
  }
  const out: OutlineDraft['chapters'][number]['nodes'] = [];
  const selfIndexPath = node.indexPath || (/\.(md|mdx|markdown)$/i.test(node.path) ? node.path : '');
  if (selfIndexPath) {
    out.push({
      sourcePath: selfIndexPath,
      title: node.indexTitle || nodeTitle(node),
      nodeType: 'doc',
    });
  }
  for (const child of node.children ?? []) {
    out.push(...collectFiles(child));
  }
  return out;
}

export function outlineFromNavTree(navTree: OutlineNavNode[]): OutlineDraft {
  const chapters: OutlineDraft['chapters'] = [];
  const parts: OutlineDraft['parts'] = [];
  let order = 0;

  const pushChapter = (
    title: string,
    nodes: OutlineDraft['chapters'][number]['nodes'],
    partTitle?: string,
  ) => {
    if (nodes.length === 0) return;
    order += 1;
    chapters.push({
      title,
      chapterType: 'doc',
      teachingOrder: order,
      nodes,
      ...(partTitle ? { partTitle } : {}),
    });
  };

  for (const top of navTree) {
    if (top.type === 'file') {
      pushChapter(nodeTitle(top), collectFiles(top));
    } else {
      const partTitle = nodeTitle(top);
      parts.push({ title: partTitle, teachingOrder: order + 1 });
      for (const child of top.children ?? []) {
        pushChapter(nodeTitle(child), collectFiles(child), partTitle);
      }
    }
  }

  return { parts, chapters };
}

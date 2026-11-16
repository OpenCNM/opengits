import { OutlineDraft } from './ingest-orchestrator';

/**
 * navTree 节点的最小结构契约：engine/structurizer 的 NavNode、
 * engine/web-doc 的 NavNodeItem 与 code-ingest 的本地 NavNode 均满足
 * （name/title/url 等渲染字段可缺省，此处只消费 type/path/shortTitle/title）。
 */
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

/** 节点显示名：shortTitle → title → 路径末段兜底 */
function nodeTitle(node: OutlineNavNode): string {
  return node.shortTitle || node.title || node.path.split('/').pop() || node.path;
}

/**
 * ─────────────────────────────────────────────────────────────
 * navTree → TutorialOutline 确定性派生（零 LLM）
 *
 * 单一事实源 = navTree：大纲是它的 1:1 投影，导入期零 LLM、零幻觉、
 * 绝不漏文件（对照 LLM 编排器需要 pruneHallucinatedPaths/ensureFullCoverage
 * 兜底的宿疾）。派生映射：
 *   顶层文件            → 章（单节）
 *   顶层目录            → 大类（part）
 *   目录下一级子项       → 章；子目录整棵子树的全部文件收进该章
 *
 * sourcePath 取 navTree 节点 path，与 Document.path 同源，保证
 * storeOutlineDraft 的 documentId 映射全命中。派生失败仅影响增强读路径
 * （prev/next、教学顺序），渲染仍可回退 navTree，调用方须 try/catch 不阻断导入。
 * ─────────────────────────────────────────────────────────────
 */

/** 递归收集节点子树内的全部文件（navTree 由 markdown 构成，nodeType 恒 doc）；目录若含同名索引页一并保底收集 */
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

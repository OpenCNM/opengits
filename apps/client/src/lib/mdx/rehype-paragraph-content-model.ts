import { visit } from 'unist-util-visit';
import type { Root } from 'hast';

/**
 * W3C HTML5 规范中禁止出现在 <p> 内部的块级元素集合。
 * 根据 HTML5 内容模型（Content Model），<p> 只能包含行内流内容（Phrasing Content）。
 * 若嵌套以下块级元素，浏览器的容错解析器会在块级元素出现时强行插入 </p> 闭合外层，
 * 破坏 SSR Virtual DOM 结构，导致 React 客户端注水（Hydration）红屏报错。
 */
export const HTML_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'div', 'table', 'ul', 'ol', 'pre', 'blockquote',
  'form', 'section', 'article', 'aside', 'header',
  'footer', 'nav', 'main', 'figure', 'figcaption',
  'details', 'dialog', 'fieldset', 'menu', 'hr',
]);

function isTag(node: unknown, name: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (n.type === 'element' && typeof n.tagName === 'string') {
    return n.tagName.toLowerCase() === name;
  }
  if ((n.type === 'mdxJsxFlowElement' || n.type === 'mdxJsxTextElement') && typeof n.name === 'string') {
    return n.name.toLowerCase() === name;
  }
  return false;
}

function hasBlockDescendant(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (!Array.isArray(n.children)) return false;

  for (const child of n.children) {
    if (!child || typeof child !== 'object') continue;
    const c = child as Record<string, unknown>;
    const tagName =
      (c.type === 'element' && typeof c.tagName === 'string' && c.tagName.toLowerCase()) ||
      ((c.type === 'mdxJsxFlowElement' || c.type === 'mdxJsxTextElement') &&
        typeof c.name === 'string' &&
        c.name.toLowerCase());
    if (tagName && HTML_BLOCK_TAGS.has(tagName)) {
      return true;
    }
    if (hasBlockDescendant(c)) {
      return true;
    }
  }
  return false;
}

/**
 * Rehype AST HTML5 内容模型规范化插件 (HTML5 Content Model Normalizer)
 *
 * 遵循 346 准则：能力不倒退、效果不劣化、失效封闭高于伪弹性。
 * 根治 CommonMark 与 MDX 在处理开源 README / Raw HTML 块时的 DOM 内容模型阻抗失配：
 *
 * 1. 段落内容模型规范化（Paragraph Normalization）：
 *    - 单子段落：解包内层 Markdown 隐式生成的 <p>，提升至外层 <p>，100% 保留原生属性与排版；
 *    - 多段落 / 块级后代：将外层容器规范化为 <div>，杜绝段落粘连与 <p> 嵌套块级元素的水合报错。
 *
 * 2. 表格内容模型规范化（Table Normalization）：
 *    - 补齐 tbody：当 <table> 的直接子节点含有 <tr> 时，自动包裹入 <tbody>，与浏览器 DOM 解析算法对齐；
 *    - 补齐 tr：当 <tbody> / <thead> / <tfoot> / <table> 的直接子节点含有 <td> / <th> 时，自动包裹入 <tr>，杜绝 <td> 直接作为 <tbody> 子节点。
 */
export function rehypeHtmlContentModel() {
  return (tree: Root) => {
    visit(tree, (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const el = node as Record<string, unknown>;

      // ── 0. 图片 JSX 规范化（将 Raw HTML 中 <img ... /> JSX 节点规范化为 HAST element）──
      // 抹平 Raw HTML 中 <img ...> 绕过 React components.img 自定义映射的缺陷，
      // 确保相对路径能被平台自定义组件（WhiteboardImage）统一拦截并重定向至 GitHub Raw / CDN，
      // 彻底根治 404 Not Found 图片加载失败。
      if ((el.type === 'mdxJsxFlowElement' || el.type === 'mdxJsxTextElement') && el.name === 'img') {
        el.type = 'element';
        el.tagName = 'img';
        const properties: Record<string, unknown> = {};
        if (Array.isArray(el.attributes)) {
          for (const attr of el.attributes as Array<Record<string, unknown>>) {
            if (attr && typeof attr === 'object' && attr.type === 'mdxJsxAttribute' && typeof attr.name === 'string') {
              if (typeof attr.value === 'string' || typeof attr.value === 'number' || typeof attr.value === 'boolean') {
                properties[attr.name] = attr.value;
              }
            }
          }
        }
        el.properties = properties;
        delete el.name;
        delete el.attributes;
        delete el.data;
        return;
      }

      if (!Array.isArray(el.children) || el.children.length === 0) return;
      const getChildren = (): unknown[] => (Array.isArray(el.children) ? (el.children as unknown[]) : []);

      // ── 1. 段落规范化（消除 <p> 嵌套 <p> 及 <p> 嵌套块级标签）──
      if (isTag(el, 'p')) {
        const currentChildren = getChildren();
        const pChildren = currentChildren.filter((c: unknown) => isTag(c, 'p'));

        if (pChildren.length > 1 || hasBlockDescendant(el)) {
          if (el.type === 'mdxJsxFlowElement' || el.type === 'mdxJsxTextElement') {
            el.name = 'div';
          } else {
            el.tagName = 'div';
          }
          return;
        }

        if (pChildren.length === 1) {
          const newChildren: unknown[] = [];
          for (const child of currentChildren) {
            if (isTag(child, 'p')) {
              const childNode = child as Record<string, unknown>;
              if (Array.isArray(childNode.children)) {
                newChildren.push(...childNode.children);
              }
            } else {
              newChildren.push(child);
            }
          }
          el.children = newChildren;
        }
      }

      // ── 2. 表格 tbody 缺失补齐（修复 In HTML, <tr> cannot be a child of <table>）──
      if (isTag(el, 'table')) {
        const tableChildren = getChildren();
        const hasDirectTr = tableChildren.some((c: unknown) => isTag(c, 'tr'));
        if (hasDirectTr) {
          const newChildren: unknown[] = [];
          let currentTrGroup: unknown[] = [];
          for (const child of tableChildren) {
            if (isTag(child, 'tr')) {
              currentTrGroup.push(child);
            } else {
              if (currentTrGroup.length > 0) {
                newChildren.push({
                  type: 'mdxJsxFlowElement',
                  name: 'tbody',
                  attributes: [],
                  children: currentTrGroup,
                });
                currentTrGroup = [];
              }
              newChildren.push(child);
            }
          }
          if (currentTrGroup.length > 0) {
            newChildren.push({
              type: 'mdxJsxFlowElement',
              name: 'tbody',
              attributes: [],
              children: currentTrGroup,
            });
          }
          el.children = newChildren;
        }
      }

      // ── 3. 表格 tr 缺失补齐（修复 In HTML, <td> cannot be a child of <tbody>）──
      if (isTag(el, 'tbody') || isTag(el, 'thead') || isTag(el, 'tfoot') || isTag(el, 'table')) {
        const cellContainerChildren = getChildren();
        const hasDirectCell = cellContainerChildren.some((c: unknown) => isTag(c, 'td') || isTag(c, 'th'));
        if (hasDirectCell) {
          const newChildren: unknown[] = [];
          let currentCellGroup: unknown[] = [];
          for (const child of cellContainerChildren) {
            if (isTag(child, 'td') || isTag(child, 'th')) {
              currentCellGroup.push(child);
            } else {
              if (currentCellGroup.length > 0) {
                newChildren.push({
                  type: 'mdxJsxFlowElement',
                  name: 'tr',
                  attributes: [],
                  children: currentCellGroup,
                });
                currentCellGroup = [];
              }
              newChildren.push(child);
            }
          }
          if (currentCellGroup.length > 0) {
            newChildren.push({
              type: 'mdxJsxFlowElement',
              name: 'tr',
              attributes: [],
              children: currentCellGroup,
            });
          }
          el.children = newChildren;
        }
      }
    });
  };
}

export const rehypeParagraphContentModel = rehypeHtmlContentModel;

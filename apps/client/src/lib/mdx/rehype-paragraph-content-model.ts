import { visit } from 'unist-util-visit';
import type { Root } from 'hast';

// Block elements inside <p> cause browser parsers to auto-close </p> prematurely and break React hydration.
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

export function rehypeHtmlContentModel() {
  return (tree: Root) => {
    visit(tree, (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const el = node as Record<string, unknown>;

      // Normalize raw JSX <img> to HAST element so React components.img intercepts relative paths cleanly.
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

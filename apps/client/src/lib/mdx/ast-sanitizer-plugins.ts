import { visit, SKIP } from 'unist-util-visit';
import type { Root, Parent, Node } from 'mdast';
import type { Element, Root as HastRoot } from 'hast';
import { sanitize, type Schema } from 'hast-util-sanitize';
import { isUnknownComponentName } from './known-mdx-components';

/**
 * Tag name mapping registry for docs-platform/Custom component aliases.
 * Maps legacy/kebab-case/lowercase tag names to standard PascalCase JSX components.
 */
const TAG_ALIASES: Record<string, string> = {
  'codeblock': 'CodeGroup',
  'code-block': 'CodeGroup',
  'codeblockitem': 'CodeGroupItem',
  'code-block-item': 'CodeGroupItem',
  'codegroup.item': 'CodeGroupItem',
  'cardgroup': 'CardGroup',
  'card-group': 'CardGroup',
  'card.group': 'CardGroup',
  'card': 'Card',
  'accordiongroup': 'AccordionGroup',
  'accordion-group': 'AccordionGroup',
  'accordion.group': 'AccordionGroup',
  'accordion': 'Accordion',
};

const JS_RESERVED_KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'this']);

/**
 * Remark Plugin: Strips ESM import statements from MDX AST while keeping valid export statements intact.
 */
export function remarkStripEsm() {
  return (tree: Root) => {
    visit(tree, 'mdxjsEsm', (node: any, index: number | undefined, parent: Parent | undefined) => {
      if (parent && Array.isArray(parent.children) && typeof index === 'number') {
        const val = typeof node.value === 'string' ? node.value.trim() : '';
        // Only strip import statements (which fail in remote compilation), keep export statements
        if (val.startsWith('import') || /\bimport\s*[({\w'"*]/.test(val)) {
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
      }
    });
  };
}

/**
 * Remark Plugin: Normalizes custom component tag names in MDX AST.
 */
export function remarkTagNormalizer() {
  return (tree: Root) => {
    visit(tree, ['mdxJsxFlowElement', 'mdxJsxTextElement'], (node: any) => {
      if (!node.name || typeof node.name !== 'string') return;
      const lowerName = node.name.toLowerCase();
      if (TAG_ALIASES[lowerName]) {
        node.name = TAG_ALIASES[lowerName];
      }
    });
  };
}

/**
 * Remark Plugin: Safely handles MDX expressions in curly braces.
 * - MDX comments (e.g. {/* comment *\/}) -> stripped from AST
 * - Single JS identifiers (e.g. {now}) -> converted to <DynamicVar name="now" />
 * - Plain text curly expressions (e.g. {Context Engineering}) -> converted to safe text nodes
 * - Valid JS expressions (starts with quotes, props, math, etc.) -> preserved
 */
export function remarkSafeBraces() {
  return (tree: Root) => {
    visit(tree, ['mdxTextExpression', 'mdxFlowExpression'], (node: any, index: number | undefined, parent: any) => {
      if (!node.value) return;
      const val = node.value.trim();

      // Case 0: MDX comment syntax {/* comment */} -> remove from AST
      if (val.startsWith('/*') && val.endsWith('*/')) {
        if (parent && Array.isArray(parent.children) && typeof index === 'number') {
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
        node.type = 'text';
        node.value = '';
        return;
      }

      // Case 1: Single JS identifier (docs-platform variable syntax like {now} or {API_URL})
      if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(val) && !JS_RESERVED_KEYWORDS.has(val)) {
        node.type = 'mdxJsxTextElement';
        node.name = 'DynamicVar';
        node.attributes = [
          {
            type: 'mdxJsxAttribute',
            name: 'name',
            value: val,
          },
        ];
        node.children = [];
        return;
      }

      // Default: All other expression nodes (e.g. {user.name}, {foo()}, {a ? b : c}, {Context Engineering})
      // Convert to safe text node so no uncompiled JS expression reaches MDX runtime evaluation
      node.type = 'text';
      node.value = `{${node.value}}`;
    });
  };
}

/**
 * Rehype Plugin: Strips inline `style` string attributes from HAST elements.
 */
export function rehypeStripStyle() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element) => {
      if (node.properties && node.properties.style !== undefined) {
        delete node.properties.style;
      }
    });
  };
}

// ─────────────────────────────────────────────────────────────
// sanitize 时的 MDX 节点占位保护（审计矩阵 2.3 T1 裁定的修复）。
//
// 缺陷背景：hast-util-sanitize 对不认识的节点类型（MDX 的 mdxJsx*/mdx*Expression/
// mdxjsEsm）一律整节点丢弃——<Card>/<Steps>/<Callout> 等组件连同全部子内容被
// 静默删除（编译成功、无任何报错），而转录提示词恰恰在大量产出这些组件。
//
// 修复：sanitize 前把受保护节点摘进 vault、原位换成私有区字符占位文本（纯文本
// 节点 sanitize 不会动），sanitize 后按占位序号原位还原。还原阶段同时：
//   1. 对 mdxJsx 字符串属性做轻过滤（剥 on* 事件与 javascript:/vbscript: 伪协议；
//      表达式属性保留——渲染走 React 转义 + 平台注册组件清单兜底）；
//   2. 未注册组件名改写为 UnknownMdxComponent（运行时注册了渲染 children 的
//      fallback，防 React "Element type is invalid" 毁掉整页）。
// ─────────────────────────────────────────────────────────────

const MDX_PROTECTED_TYPES = new Set([
  'mdxjsEsm',
  'mdxFlowExpression',
  'mdxTextExpression',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
]);

// 私用区字符作占位定界符：正常文档内容不可能包含
const MDX_VAULT_OPEN = 'MDX_VAULT_';
const MDX_VAULT_CLOSE = 'MDX_VAULT_END';
const MDX_VAULT_PATTERN = new RegExp(`${MDX_VAULT_OPEN}(\\d+)${MDX_VAULT_CLOSE}`);

interface HastLikeNode {
  type: string;
  children?: HastLikeNode[];
  attributes?: Array<{ type?: string; name?: string; value?: unknown }>;
  name?: string;
  value?: string;
  [key: string]: unknown;
}

function isProtectedMdxNode(node: any): boolean {
  return MDX_PROTECTED_TYPES.has(node.type);
}

function filterMdxJsxAttributes(node: any): void {
  if (!Array.isArray(node.attributes)) return;
  node.attributes = node.attributes.filter((attr: any) => {
    if (!attr || attr.type !== 'mdxJsxAttribute' || typeof attr.name !== 'string') return true;
    if (/^on[a-z]+$/i.test(attr.name)) return false; // 事件属性
    if (typeof attr.value === 'string' && (attr.name === 'href' || attr.name === 'src' || attr.name === 'data' || attr.name === 'xlinkHref')) {
      const normalized = attr.value.replace(/[\s ]/g, '').toLowerCase();
      if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:') || normalized.startsWith('data:text/html')) return false;
    }
    return true;
  });
  if (Array.isArray(node.children)) node.children.forEach(filterMdxJsxAttributes);
}

const FORBIDDEN_JSX_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'style']);

function collectIntoVault(node: any, vault: any[]): any {
  if (!node || !Array.isArray(node.children)) return node;
  node.children = node.children.map((child: any) => {
    if (!child) return child;
    if (isProtectedMdxNode(child)) {
      if (child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') {
        const lowerName = typeof child.name === 'string' ? child.name.toLowerCase() : '';
        if (FORBIDDEN_JSX_TAGS.has(lowerName)) {
          return { type: 'text', value: '' };
        }
        filterMdxJsxAttributes(child);
      }
      if (typeof child.name === 'string' && isUnknownComponentName(child.name)) {
        child.name = 'UnknownMdxComponent';
      }
      const idx = vault.length;
      vault.push(child);
      return { type: 'text', value: `${MDX_VAULT_OPEN}${idx}${MDX_VAULT_CLOSE}` };
    }
    collectIntoVault(child, vault);
    return child;
  });
  return node;
}

function restoreFromVault(node: any, vault: any[]): void {
  if (!node || !Array.isArray(node.children)) return;
  const newChildren: any[] = [];
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === 'text' && typeof child.value === 'string' && child.value.includes(MDX_VAULT_OPEN)) {
      // Split text node in case adjacent text or multiple vault tokens are present
      const tokens = child.value.split(new RegExp(`(${MDX_VAULT_OPEN}\\d+${MDX_VAULT_CLOSE})`));
      for (const token of tokens) {
        if (!token) continue;
        const m = token.match(MDX_VAULT_PATTERN);
        if (m) {
          const original = vault[Number(m[1])];
          if (original) {
            restoreFromVault(original, vault);
            newChildren.push(original);
            continue;
          }
        }
        newChildren.push({ type: 'text', value: token });
      }
      continue;
    }
    restoreFromVault(child, vault);
    newChildren.push(child);
  }
  node.children = newChildren;
}

/**
 * Rehype: sanitize 白名单过滤时保护 MDX 语法节点。
 * 替代裸 [rehypeSanitize, schema]——行为对原生 HTML 完全一致（同一 schema），
 * 差异仅在于 MDX JSX 节点被占位保护而非删除。
 */
export function rehypeSanitizePreservingMdx(schema: Schema) {
  return (tree: HastRoot) => {
    const vault: HastLikeNode[] = [];
    const guarded = collectIntoVault(tree as unknown as HastLikeNode, vault) as unknown as HastRoot;
    sanitize(guarded, schema);
    restoreFromVault(guarded, vault);
    return guarded;
  };
}

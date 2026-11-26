import { visit, SKIP } from 'unist-util-visit';
import type { Root, Parent, Node } from 'mdast';
import type { Element, Root as HastRoot } from 'hast';
import { sanitize, type Schema } from 'hast-util-sanitize';
import { isUnknownComponentName } from './known-mdx-components';

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

export function remarkStripEsm() {
  return (tree: Root) => {
    visit(tree, 'mdxjsEsm', (node: any, index: number | undefined, parent: Parent | undefined) => {
      if (parent && Array.isArray(parent.children) && typeof index === 'number') {
        const val = typeof node.value === 'string' ? node.value.trim() : '';
        if (val.startsWith('import') || /\bimport\s*[({\w'"*]/.test(val)) {
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
      }
    });
  };
}

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

export function remarkSafeBraces() {
  return (tree: Root) => {
    visit(tree, ['mdxTextExpression', 'mdxFlowExpression'], (node: any, index: number | undefined, parent: any) => {
      if (!node.value) return;
      const val = node.value.trim();

      if (val.startsWith('/*') && val.endsWith('*/')) {
        if (parent && Array.isArray(parent.children) && typeof index === 'number') {
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
        node.type = 'text';
        node.value = '';
        return;
      }

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

      node.type = 'text';
      node.value = `{${node.value}}`;
    });
  };
}

export function rehypeStripStyle() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node: Element) => {
      if (node.properties && node.properties.style !== undefined) {
        delete node.properties.style;
      }
    });
  };
}

// Vault-protects MDX JSX/expression nodes across hast-util-sanitize (which otherwise drops unknown node types), then filters on* / pseudo-protocols and rewrites unknown components.

const MDX_PROTECTED_TYPES = new Set([
  'mdxjsEsm',
  'mdxFlowExpression',
  'mdxTextExpression',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
]);

// Private-use Unicode delimiters cannot appear in normal markdown content.
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
    if (/^on[a-z]+$/i.test(attr.name)) return false;
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

export function rehypeSanitizePreservingMdx(schema: Schema) {
  return (tree: HastRoot) => {
    const vault: HastLikeNode[] = [];
    const guarded = collectIntoVault(tree as unknown as HastLikeNode, vault) as unknown as HastRoot;
    sanitize(guarded, schema);
    restoreFromVault(guarded, vault);
    return guarded;
  };
}

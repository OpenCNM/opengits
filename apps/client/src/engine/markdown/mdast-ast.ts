import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';

// Structural Markdown AST boundary: never parse fenced blocks or headings with multiline regex.
const processor = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdownAst(content: string): Root {
  return processor.parse(content) as Root;
}

interface NodeLike {
  type?: string;
  children?: NodeLike[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

const MARKUP_TAG_WHITELIST = new Set([
  'code', 'span', 'a', 'b', 'i', 'strong', 'em', 'badge', 'kbd', 'sub', 'sup',
]);

// Strip known markup or attributed tags while preserving bare generics like <T> literally.
function isMarkupTagHtml(value: string): boolean {
  if (!value.startsWith('<')) return false;
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(value);
  if (!tag) return true;
  if (MARKUP_TAG_WHITELIST.has(tag[1].toLowerCase())) return true;
  const rest = value.slice(tag[0].length).trimEnd();
  return !/^\/?>$/.test(rest);
}

function extractHeadingInlineText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'html') {
    const value = typeof n.value === 'string' ? n.value : '';
    return isMarkupTagHtml(value) ? '' : value;
  }
  // Preserve backticks on inlineCode so heading text matches golden anchor contracts.
  if (n.type === 'inlineCode' && typeof n.value === 'string') return `\`${n.value}\``;
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) {
    return n.children.map(extractHeadingInlineText).join('');
  }
  return '';
}

export function walkMarkdownAst(node: NodeLike, visitor: (n: NodeLike) => boolean | void): void {
  if (!node || typeof node !== 'object') return;
  if (visitor(node) === false) return;
  for (const child of node.children ?? []) walkMarkdownAst(child, visitor);
}

function walk(node: NodeLike, visitor: (n: NodeLike) => boolean | void): void {
  walkMarkdownAst(node, visitor);
}

interface CodeBlockFact {
  lang: string | null;
  meta: string | null;
  startOffset: number;
  endOffset: number;
}

export function collectCodeFacts(tree: Root | NodeLike): CodeBlockFact[] {
  const facts: CodeBlockFact[] = [];
  walk(tree, (n) => {
    if (n.type === 'code') {
      const code = n as NodeLike & { lang?: string | null; meta?: string | null };
      facts.push({
        lang: code.lang ?? null,
        meta: code.meta ?? null,
        startOffset: n.position?.start?.offset ?? 0,
        endOffset: n.position?.end?.offset ?? 0,
      });
      return false;
    }
  });
  return facts;
}

interface HeadingFact {
  depth: number;
  text: string;
  raw: string;
}

export function collectHeadings(content: string, tree?: Root): HeadingFact[] {
  const root = tree ?? parseMarkdownAst(content);
  const headings: HeadingFact[] = [];
  walk(root, (n) => {
    if (n.type === 'heading') {
      const depth = (n as NodeLike & { depth?: number }).depth ?? 0;
      const start = n.position?.start?.offset ?? 0;
      const end = n.position?.end?.offset ?? content.length;
      headings.push({
        depth,
        text: extractHeadingInlineText(n).trim(),
        raw: content.slice(start, end),
      });
      return false;
    }
  });
  return headings;
}

function frontmatterRange(content: string): [number, number, number] | null {
  if (!content.startsWith('---')) return null;
  const firstLineEnd = content.indexOf('\n');
  if (firstLineEnd === -1 || content.slice(0, firstLineEnd).trim() !== '---') return null;
  const closeIdx = content.indexOf('\n---', firstLineEnd);
  if (closeIdx === -1) return null;
  const afterClose = content.slice(closeIdx + 4);
  if (afterClose !== '' && !afterClose.startsWith('\n') && !afterClose.startsWith('\r')) return null;
  return [firstLineEnd + 1, closeIdx, closeIdx + 4];
}

export function stripFrontmatterBlock(content: string): string {
  const range = frontmatterRange(content);
  if (!range) return content;
  return content.slice(range[2]).replace(/^\r?\n/, '');
}

export function hasNodeType(tree: Root | NodeLike, type: string): boolean {
  let found = false;
  walk(tree, (n) => {
    if (n.type === type) {
      found = true;
      return false;
    }
  });
  return found;
}

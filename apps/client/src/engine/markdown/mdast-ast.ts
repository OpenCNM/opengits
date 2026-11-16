/**
 * apps/client/src/engine/markdown/mdast-ast.ts
 *
 * Markdown 结构化 AST 共享工具 (Chomsky Boundary 执行层)。
 *
 * 346 准则红线：围栏代码块、标题层级、表格、HTML 标签等嵌套/成对结构
 * 必须经结构化 AST 解析（unified + remark-parse），严禁跨多行正则
 * （如 `(?s)```.*?``` `）。本模块是 engine 内所有 Markdown 结构感知
 * 的唯一入口；行内纯文本标记（如 `{#anchor}` 单 token 剥离）仍属
 * 正则安全区，不在此收敛。
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';

const processor = unified().use(remarkParse).use(remarkGfm);

/** 解析 Markdown 为 mdast（GFM 扩展：表格/删除线/任务列表/自动链接） */
export function parseMarkdownAst(content: string): Root {
  return processor.parse(content) as Root;
}

interface NodeLike {
  type?: string;
  children?: NodeLike[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/** 标题清洗契约中的标记标签白名单（AST 节点级分类，替代历史上的行内标签正则） */
const MARKUP_TAG_WHITELIST = new Set([
  'code', 'span', 'a', 'b', 'i', 'strong', 'em', 'badge', 'kbd', 'sub', 'sup',
]);

/**
 * 单个 html 节点 token 的标记/字面二分（1D 有界 token，正则安全区）：
 * 白名单标记标签与携带属性的标签视为语法噪音；裸短标签（泛型 `<T>` 等）
 * 按字面文本保留（与历史清洗契约及黄金夹具锁步一致）。
 */
function isMarkupTagHtml(value: string): boolean {
  if (!value.startsWith('<')) return false;
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(value);
  if (!tag) return true; // <!-- 注释 --> / <!DOCTYPE> 等非标签形态 → 剥离
  if (MARKUP_TAG_WHITELIST.has(tag[1].toLowerCase())) return true;
  const rest = value.slice(tag[0].length).trimEnd();
  return !/^\/?>$/.test(rest); // 裸开/闭标签 → 字面保留
}

/**
 * 标题行内文本归并：inlineCode 节点回填反引号（黄金夹具契约：标题中的
 * 行内代码保留 `` ` `` 标记）；html 节点按标记/字面二分处置；图片丢弃、
 * 链接保锚文本、强调归并为内部文本。
 */
function extractHeadingInlineText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'html') {
    const value = typeof n.value === 'string' ? n.value : '';
    return isMarkupTagHtml(value) ? '' : value;
  }
  if (n.type === 'inlineCode' && typeof n.value === 'string') return `\`${n.value}\``;
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) {
    return n.children.map(extractHeadingInlineText).join('');
  }
  return '';
}

/** 深度优先遍历，visitor 返回 false 时跳过该节点子树 */
export function walkMarkdownAst(node: NodeLike, visitor: (n: NodeLike) => boolean | void): void {
  if (!node || typeof node !== 'object') return;
  if (visitor(node) === false) return;
  for (const child of node.children ?? []) walkMarkdownAst(child, visitor);
}

function walk(node: NodeLike, visitor: (n: NodeLike) => boolean | void): void {
  walkMarkdownAst(node, visitor);
}

interface CodeBlockFact {
  /** 围栏语言标识（无语言为 null） */
  lang: string | null;
  /** 围栏头语言之后的元信息串（如 `// src/foo.ts`），无则 null */
  meta: string | null;
  startOffset: number;
  endOffset: number;
}

/** 采集全部围栏/缩进代码块事实（语言、meta、源文本偏移跨度） */
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
  /** 行内节点归并后的纯文本 */
  text: string;
  /** 源文本原始片段（区分 ATX `#` 前缀与 Setext 下划线形态） */
  raw: string;
}

/** 采集全部标题（ATX 与 Setext 统一为 heading 节点，depth 1-6） */
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

/** ATX 形态判定已随 doc-title-miner 退役移除；frontmatter 边界扫描器保留供 stripFrontmatterBlock 消费 */
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

/**
 * 剥离文档首部 frontmatter 块（无 frontmatter 时原样返回），供标题提取等消费方隔离 frontmatter 内的伪标题
 */
export function stripFrontmatterBlock(content: string): string {
  const range = frontmatterRange(content);
  if (!range) return content;
  return content.slice(range[2]).replace(/^\r?\n/, '');
}

/** 树中是否存在指定类型节点（如 GFM 'table'） */
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

import { cleanMarkdownHeading } from '@/engine/structurizer/prefix-cleaner';
import { collectHeadings, stripFrontmatterBlock } from '@/engine/markdown/mdast-ast';

/**
 * Extracts a clean context snippet around a query keyword from markdown/text.
 * Safely ignores frontmatter and code blocks, without stripping internal horizontal rules.
 */
export function extractContextSnippet(text?: string | null, query = '', maxLen = 100): string {
  if (!text) return '';

  // 1. Strip YAML frontmatter (--- ... ---) only when anchored at document start
  let cleanText = text.trimStart();
  if (cleanText.startsWith('---')) {
    const endIdx = cleanText.indexOf('\n---', 3);
    if (endIdx !== -1) {
      let after = cleanText.slice(endIdx + 4);
      if (after.startsWith('\n')) after = after.slice(1);
      cleanText = after.trimStart();
    }
  }

  // 2. Clean markdown syntax, code blocks (both ``` and ~~~), headings, links.
  // 围栏剥离先行、HTML 注释剥离随后：顺序颠倒时，讲解 HTML 注释的文档中
  // 跨围栏的 <!-- ... --> 会被错配吞掉围栏间正文（与 Go ogis/snippet.go 锁步）。
  // 二次 tick 配对限定单行（无 [\s\S]）：跨行非贪婪会把两个未闭合围栏的
  // 残余 ``` 错配成一对，吞掉中间正文；残留反引号由标点剥离规则清理。
  cleanText = cleanText
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[\s\S]*?^[ \t]{0,3}\1\s*$/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```.*?```/g, ' ')
    .replace(/~~~.*?~~~/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[.*?\]\(.*?\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[#\s\-*>`~]+/gm, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?:^|\s)_([^_]+)_(?:\s|$)/g, ' $1 ')
    .replace(/[|\\`~#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanText) return '';

  const q = query.trim().toLowerCase();
  if (!q) {
    const startSnippet = cleanText.substring(0, maxLen).trim();
    return startSnippet.length < cleanText.length ? `${startSnippet}...` : startSnippet;
  }

  // 3. Find keyword position
  const matchIndex = cleanText.toLowerCase().indexOf(q);
  if (matchIndex === -1) {
    const startSnippet = cleanText.substring(0, maxLen).trim();
    return startSnippet.length < cleanText.length ? `${startSnippet}...` : startSnippet;
  }

  // 4. Center snippet around the keyword
  const leadChars = 28;
  let start = Math.max(0, matchIndex - leadChars);
  if (start > 0) {
    const prevSpace = cleanText.lastIndexOf(' ', start);
    if (prevSpace !== -1 && start - prevSpace <= 10) {
      start = prevSpace + 1;
    }
  }
  const end = Math.min(cleanText.length, start + maxLen);

  let snippet = cleanText.substring(start, end).trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < cleanText.length) snippet = `${snippet}...`;

  return snippet;
}

/**
 * Resolves document title cleanly from title field, H1 markdown heading, or file path.
 * Ignores YAML frontmatter comments and code blocks (e.g. Python `# import foo`).
 */
export function resolveDocTitle(title?: string | null, path?: string | null, content?: string | null): string {
  if (title && title.trim() && title.trim().toLowerCase() !== 'untitled') {
    return cleanMarkdownHeading(title.trim()) || title.trim();
  }
  if (content) {
    // mdast AST 提取首个 H1：frontmatter 块先行隔离（块内 yaml 注释标题不参与）、
    // 代码块内容不会产生 heading 节点，Python/Bash 代码块内的 `# comment`
    // 不再被误认为文档标题
    const h1 = collectHeadings(stripFrontmatterBlock(content)).find((h) => h.depth === 1 && h.text);
    if (h1) {
      const clean = cleanMarkdownHeading(h1.raw);
      if (clean && clean.toLowerCase() !== 'untitled') {
        return clean;
      }
    }
  }
  if (path) {
    const basename = path.split('/').pop() || path;
    const cleanName = basename.replace(/\.(mdx?|markdown|html)$/i, '').replace(/[-_]/g, ' ');
    if (cleanName) {
      return cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
    }
  }
  return '未命名文档';
}

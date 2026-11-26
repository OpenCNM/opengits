import { cleanMarkdownHeading } from '@/engine/structurizer/prefix-cleaner';
import { collectHeadings, stripFrontmatterBlock } from '@/engine/markdown/mdast-ast';

export function extractContextSnippet(text?: string | null, query = '', maxLen = 100): string {
  if (!text) return '';

  let cleanText = text.trimStart();
  if (cleanText.startsWith('---')) {
    const endIdx = cleanText.indexOf('\n---', 3);
    if (endIdx !== -1) {
      let after = cleanText.slice(endIdx + 4);
      if (after.startsWith('\n')) after = after.slice(1);
      cleanText = after.trimStart();
    }
  }

  // Strip fenced code blocks before HTML comments so comment examples inside fences never swallow surrounding prose (synced with Go ogis/snippet.go).
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

  const matchIndex = cleanText.toLowerCase().indexOf(q);
  if (matchIndex === -1) {
    const startSnippet = cleanText.substring(0, maxLen).trim();
    return startSnippet.length < cleanText.length ? `${startSnippet}...` : startSnippet;
  }

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

export function resolveDocTitle(title?: string | null, path?: string | null, content?: string | null): string {
  if (title && title.trim() && title.trim().toLowerCase() !== 'untitled') {
    return cleanMarkdownHeading(title.trim()) || title.trim();
  }
  if (content) {
    // Strip frontmatter and parse headings via AST so Python/Bash `#` comments inside code never become titles.
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

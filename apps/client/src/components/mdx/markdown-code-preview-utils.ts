const MARKDOWN_LANGUAGES = new Set(['markdown', 'md', 'mdx']);
const TEXT_OR_UNSET_LANGUAGES = new Set(['', 'text', 'txt', 'plain', 'code']);
const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx'] as const;

const HTML_OMISSION_LINE_RE = /^<!--\s*\.\.\.\s*\[([^\]]*omitted for pedagogy[^\]]*)\]\s*-->$/i;
const LEGACY_COMMENT_OMISSION_LINE_RE = /^\/\/\s*\.\.\.\s*\[([^\]]*omitted for pedagogy[^\]]*)\]$/i;

export interface MarkdownPreviewSplit {
  markdown: string;
  omissionNotice: string | null;
}

export function isMarkdownCodeBlock(lang?: string, filePath?: string): boolean {
  const normalizedLang = (lang ?? '').trim().toLowerCase().replace(/^language-/, '');
  if (MARKDOWN_LANGUAGES.has(normalizedLang)) {
    return true;
  }

  const cleanPath = (filePath ?? '').trim().toLowerCase();
  if (!cleanPath || !MARKDOWN_EXTENSIONS.some((ext) => cleanPath.endsWith(ext))) {
    return false;
  }

  return TEXT_OR_UNSET_LANGUAGES.has(normalizedLang);
}

export function splitMarkdownPreviewOmission(code: string): MarkdownPreviewSplit {
  if (!code) {
    return { markdown: '', omissionNotice: null };
  }

  const lines = code.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    return { markdown: code, omissionNotice: null };
  }

  const lastTrimmed = lines[lines.length - 1].trim();
  const matched =
    HTML_OMISSION_LINE_RE.exec(lastTrimmed) ||
    LEGACY_COMMENT_OMISSION_LINE_RE.exec(lastTrimmed);

  if (!matched) {
    return { markdown: code, omissionNotice: null };
  }

  lines.pop();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return {
    markdown: lines.join('\n'),
    omissionNotice: matched[1].trim(),
  };
}

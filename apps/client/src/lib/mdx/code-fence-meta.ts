import { visit } from 'unist-util-visit';

export interface CodeFenceMetaInfo {
  filePath: string | null;
  hasSymbolAnchor: boolean;
}

const MARKDOWN_FILE_EXT_RE = /\.(?:md|markdown|mdx)$/i;
const PATH_LIKE_TOKEN_RE = /^(?:.*\/.*|.*\.[a-zA-Z0-9]{1,10})$/;

export function extractCodeFenceMeta(meta?: string | null): CodeFenceMetaInfo {
  if (!meta) {
    return { filePath: null, hasSymbolAnchor: false };
  }

  let s = meta.trim();
  if (!s) {
    return { filePath: null, hasSymbolAnchor: false };
  }

  if (s.startsWith('//') || s.startsWith('--')) {
    s = s.slice(2).trimStart();
  } else if (s.startsWith('#')) {
    s = s.slice(1).trimStart();
  }

  if (!s) {
    return { filePath: null, hasSymbolAnchor: false };
  }

  const firstWs = s.search(/\s/);
  let token = firstWs >= 0 ? s.slice(0, firstWs) : s;

  const keyMatch = /^(?:title|file|filename)=(.+)$/i.exec(token);
  if (keyMatch) {
    token = keyMatch[1];
  }

  token = token.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!token || token.includes('[') || token.includes(']')) {
    return { filePath: null, hasSymbolAnchor: false };
  }

  let hasSymbolAnchor = false;
  const hashIdx = token.indexOf('#');
  if (hashIdx >= 0) {
    if (hashIdx > 0 && hashIdx < token.length - 1) {
      hasSymbolAnchor = true;
    }
    token = token.slice(0, hashIdx);
  }

  token = token.replace(/:L?\d+(?:-L?\d+)?$/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();

  if (!token || !PATH_LIKE_TOKEN_RE.test(token)) {
    return { filePath: null, hasSymbolAnchor: false };
  }

  return { filePath: token, hasSymbolAnchor };
}

export function isMarkdownFilePath(filePath?: string | null): boolean {
  if (!filePath) return false;
  return MARKDOWN_FILE_EXT_RE.test(filePath.trim());
}

// Projects fence file/symbol metadata to hProperties for zero-materialization language correction.
export function remarkCodeFenceMeta() {
  return (tree: unknown) => {
    visit(tree as Parameters<typeof visit>[0], 'code', (node: { meta?: string | null; data?: { hProperties?: Record<string, unknown> } }) => {
      const { filePath, hasSymbolAnchor } = extractCodeFenceMeta(node.meta);
      if (!filePath) return;

      if (!node.data) node.data = {};
      const existing = node.data.hProperties ?? {};
      node.data.hProperties = {
        ...existing,
        'data-file': filePath,
        ...(hasSymbolAnchor ? { 'data-has-symbol': '1' } : {}),
      };
    });
  };
}

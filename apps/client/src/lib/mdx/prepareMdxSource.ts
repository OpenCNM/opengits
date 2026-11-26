import {
  normalizeDeepDiveBlocks,
  stripDeepDiveBlocks,
  scanFallbackTocAndDeepDives,
  type FallbackTocEntry,
} from './deep-dive-scanner';

export {
  normalizeDeepDiveBlocks,
  stripDeepDiveBlocks,
  scanFallbackTocAndDeepDives,
  type FallbackTocEntry,
};

export function normalizeVoidTags(content: string): string {
  if (!content || !/<(?:br|hr|img|wbr|input)\b/i.test(content)) {
    return content;
  }

  const lines = content.split('\n');
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (!inFence) {
      if (fenceMatch) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        continue;
      }
    } else {
      if (fenceMatch && fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }

    if (!/<(?:br|hr|img|wbr|input)\b/i.test(line)) {
      continue;
    }

    const parts = line.split(/(`+[^`]+`+)/g);
    for (let p = 0; p < parts.length; p++) {
      if (parts[p].startsWith('`') && parts[p].endsWith('`')) {
        continue;
      }
      // Lowercase void tags so JSX never treats <BR /> as an unregistered React component.
      parts[p] = parts[p].replace(/<(br|hr|wbr)\s*>/gi, (_, tag: string) => `<${tag.toLowerCase()} />`);
      parts[p] = parts[p].replace(/<(img|input)(\s+[^>]*?[^\/>])\s*>/gi, (_, tag: string, rest: string) => `<${tag.toLowerCase()}${rest} />`);
    }
    lines[l] = parts.join('');
  }

  return lines.join('\n');
}

// Single source of pre-AST normalization (sentinels, Pandoc image attrs, concept_manifest tags).
export function prepareMdxSource(raw: string): string {
  if (!raw) return '';
  const s = raw
    .replace(/===CONTENT_BEGIN===/g, '')
    .replace(/===CONTENT_END===/g, '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)\s*\{[^}]*\}/g, '![$1]($2)')
    .replace(/<concept_manifest[^>]*>[\s\S]*?(?:<\/concept_manifest>|$)/gi, '');

  return normalizeDeepDiveBlocks(normalizeVoidTags(s));
}

// Strips executable HTML/event/pseudo-protocol payloads before loose/antiscript Mermaid rendering and auto-quotes special labels.

export const DIAGRAM_HEAD_PATTERN =
  /(?:^|\n)\s*((?:graph(?:\s+[A-Za-z]{2})?|flowchart(?:\s+[A-Za-z]{2})?|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|pie(?:\s+title[^\n]*)?|gitGraph|mindmap|timeline|quadrantChart|architecture-beta|packet-beta|block-beta|sankey-beta|zenuml|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)(?!\s*[:：])[\s\S]*)/i;

export function stripMermaidDangerousHtml(input: string): string {
  if (!input) return input;
  return input
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)|<script\b[^>]*\/>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<(iframe|object|embed)\b[^>]*\/>/gi, '')
    .replace(/\b(on[a-zA-Z]+)\s*=\s*(\\"|['"])[\s\S]*?\2/gi, '')
    .replace(/\b(on[a-zA-Z]+)\s*=\s*[^'">\s]+/gi, '')
    .replace(/(\b(?:href|src|xlink:href|data)\s*=\s*)(\\"|['"])\s*(?:javascript|vbscript|data\s*:\s*text\/html)[\s\S]*?\2/gi, '$1$2$2')
    .replace(/(\b(?:href|src|xlink:href|data)\s*=\s*)(?:javascript|vbscript|data\s*:\s*text\/html)[^'">\s]*/gi, '$1""');
}

export function sanitizeMermaid(rawText: string): string {
  if (!rawText) return '';
  let cleaned = rawText.trim();

  cleaned = cleaned.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();

  cleaned = cleaned.replace(/^```(?:mermaid)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');

  const match = cleaned.match(DIAGRAM_HEAD_PATTERN);
  if (match) {
    cleaned = match[1];
  }

  cleaned = cleaned.replace(/\s*```$/, '');

  cleaned = cleaned
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(/[“”]/g, '"');

  return stripMermaidDangerousHtml(cleaned.trim());
}

interface DelimPair {
  open: string;
  close: string;
}

const MERMAID_DELIM_PAIRS: DelimPair[] = [
  { open: '(((', close: ')))' },
  { open: '[(', close: ')]' },
  { open: '([', close: '])' },
  { open: '[[', close: ']]' },
  { open: '{{', close: '}}' },
  { open: '((', close: '))' },
  { open: '[/', close: '/]' },
  { open: '[\\', close: '\\]' },
  { open: '[/', close: '\\]' },
  { open: '[\\', close: '/]' },
  { open: '[', close: ']' },
  { open: '(', close: ')' },
  { open: '{', close: '}' },
];

function findClosingDelimiter(str: string, start: number, closeDelim: string): number {
  let cur = start;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  while (cur < str.length) {
    if (str[cur] === '\\') {
      cur += 2;
      continue;
    }

    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (str.startsWith(closeDelim, cur)) {
        return cur;
      }
    }

    const ch = str[cur];
    if (ch === '(') parenDepth++;
    else if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
    } else if (ch === '[') bracketDepth++;
    else if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--;
    } else if (ch === '{') braceDepth++;
    else if (ch === '}') {
      if (braceDepth > 0) braceDepth--;
    }

    cur++;
  }

  return -1;
}

export function ensureQuotedMermaidLabels(code: string): string {
  if (!code) return '';
  const lines = code.split('\n');
  const processedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%%')) return line;
    if (
      /^(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline|direction|style|classDef|class|linkStyle|click|end)\b/i.test(
        trimmed
      )
    ) {
      return line;
    }

    let modified = line;

    if (/^(\s*subgraph\s+[A-Za-z0-9_-]+\s*\[)\s*([^"\]]+?)\s*(\])/i.test(modified)) {
      modified = modified.replace(
        /^(\s*subgraph\s+[A-Za-z0-9_-]+\s*\[)\s*([^"\]]+?)\s*(\])/i,
        (_, p1, p2, p3) => {
          const content = p2.trim();
          if (/[:\(\)\[\]{}"',]/.test(content)) {
            return `${p1}"${content.replace(/"/g, '\\"')}"${p3}`;
          }
          return `${p1}${p2}${p3}`;
        }
      );
    }

    modified = modified.replace(/(\|)\s*([^"\|\r\n]+?)\s*(\|)/g, (match, p1, content, p3) => {
      const trimmedContent = content.trim();
      if (trimmedContent.startsWith('"') && trimmedContent.endsWith('"')) return match;
      if (/[:\(\)\[\]{}"',]/.test(trimmedContent)) {
        return `${p1}"${trimmedContent.replace(/"/g, '\\"')}"${p3}`;
      }
      return match;
    });

    let result = '';
    let i = 0;
    while (i < modified.length) {
      const idMatch = modified.slice(i).match(/^([A-Za-z0-9_.-]+)\s*/);
      if (idMatch && (i === 0 || /[\s\-\->=~;&|]/.test(modified[i - 1]))) {
        const idStr = idMatch[1];
        if (idStr.toLowerCase() !== 'subgraph') {
          const afterIdIdx = i + idMatch[0].length;
          let matchedPair: DelimPair | null = null;
          for (const pair of MERMAID_DELIM_PAIRS) {
            if (modified.startsWith(pair.open, afterIdIdx)) {
              matchedPair = pair;
              break;
            }
          }

          if (matchedPair) {
            const contentStart = afterIdIdx + matchedPair.open.length;
            let closeIdx = -1;

            if (modified[contentStart] === '"') {
              let q = contentStart + 1;
              while (q < modified.length) {
                if (modified[q] === '\\') {
                  q += 2;
                  continue;
                }
                if (modified[q] === '"') break;
                q++;
              }
              if (q < modified.length) {
                const afterQuote = modified.indexOf(matchedPair.close, q + 1);
                if (afterQuote !== -1) {
                  closeIdx = afterQuote;
                }
              }
            }

            if (closeIdx === -1) {
              closeIdx = findClosingDelimiter(modified, contentStart, matchedPair.close);
            }

            if (closeIdx !== -1) {
              const rawContent = modified.slice(contentStart, closeIdx);
              const trimmedContent = rawContent.trim();
              let quotedContent = rawContent;
              if (!trimmedContent.startsWith('"') || !trimmedContent.endsWith('"')) {
                if (/[:\(\)\[\]{}"',]/.test(trimmedContent)) {
                  quotedContent = `"${trimmedContent.replace(/"/g, '\\"')}"`;
                }
              }
              result += idMatch[0] + matchedPair.open + quotedContent + matchedPair.close;
              i = closeIdx + matchedPair.close.length;
              continue;
            }
          }
        }
      }

      result += modified[i];
      i++;
    }

    return result;
  });

  return processedLines.join('\n');
}


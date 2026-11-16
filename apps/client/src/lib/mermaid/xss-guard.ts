/**
 * Mermaid 图表输入的危险 HTML 剥离与语法自愈规整（零依赖，可同时用于服务端与客户端）。
 *
 * 背景：mermaid 以 securityLevel='loose' 或 'antiscript' 渲染时，节点标签中的 HTML 会透传进最终
 * SVG。仓库 MDX 中的 mermaid 代码块与 LLM 生成的图表均不可信，必须在渲染前剥离可执行内容，
 * 并且对未包裹引号的特殊字符节点（如 fn[init()]、A[count < 5]）进行确定性自动加引号自愈，
 * 避免 Mermaid 语法解析器在客户端抛出致命异常。
 */

export const DIAGRAM_HEAD_PATTERN =
  /(?:^|\n)\s*((?:graph(?:\s+[A-Za-z]{2})?|flowchart(?:\s+[A-Za-z]{2})?|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|pie(?:\s+title[^\n]*)?|gitGraph|mindmap|timeline|quadrantChart|architecture-beta|packet-beta|block-beta|sankey-beta|zenuml|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)(?!\s*[:：])[\s\S]*)/i;


export function stripMermaidDangerousHtml(input: string): string {
  if (!input) return input;
  return input
    // 1) 剥除 <script>...</script> 以及单标签/自闭合 <script ... />
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)|<script\b[^>]*\/>/gi, '')
    // 2) 剥除内嵌执行容器 <iframe>, <object>, <embed>
    .replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<(iframe|object|embed)\b[^>]*\/>/gi, '')
    // 3) 剥除任意标签上的事件属性 on*="..." / on*='...' / 无引号值（支持转义引号、嵌套异种引号与无空格如 <svg/onload=alert(1)>）
    .replace(/\b(on[a-zA-Z]+)\s*=\s*(\\"|['"])[\s\S]*?\2/gi, '')
    .replace(/\b(on[a-zA-Z]+)\s*=\s*[^'">\s]+/gi, '')
    // 4) 剥除 javascript:, vbscript:, data:text/html 危险伪协议（成对引号匹配，严格保留原引号形态包括 \\"）
    .replace(/(\b(?:href|src|xlink:href|data)\s*=\s*)(\\"|['"])\s*(?:javascript|vbscript|data\s*:\s*text\/html)[\s\S]*?\2/gi, '$1$2$2')
    .replace(/(\b(?:href|src|xlink:href|data)\s*=\s*)(?:javascript|vbscript|data\s*:\s*text\/html)[^'">\s]*/gi, '$1""');
}

export function sanitizeMermaid(rawText: string): string {
  if (!rawText) return '';
  let cleaned = rawText.trim();

  // 1. 剥除思考块（<think>...</think> / <thought>...</thought>）
  cleaned = cleaned.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();

  // 2. 剥除最外层 Markdown 代码围栏
  cleaned = cleaned.replace(/^```(?:mermaid)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');

  // 3. 剥离前置客套寒暄与无关引言，提取真正图表开头
  const match = cleaned.match(DIAGRAM_HEAD_PATTERN);
  if (match) {
    cleaned = match[1];
  }

  // 4. 清洗尾部剩余的围栏
  cleaned = cleaned.replace(/\s*```$/, '');

  // 5. 中文常见全角括号与引号规整
  cleaned = cleaned
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(/[“”]/g, '"');

  // 7. XSS 防线：剥离 <script>/on*/javascript: 后才允许落库/渲染（服务端防线）
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

/**
 * 确保所有包含括号、冒号、方括号或引号的 Mermaid 节点标签被正确双引号包裹，
 * 避免 Mermaid 词法解析器崩溃（语法自愈门禁）。
 * 遵循 346 准则，使用确定性单遍扫描器替代脆弱的多道正则级联。
 */
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

    // 1. 针对带方括号的 subgraph 标题：subgraph ID [Title: Detail] -> subgraph ID ["Title: Detail"]
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

    // 2. 连线标签：| ... |
    modified = modified.replace(/(\|)\s*([^"\|\r\n]+?)\s*(\|)/g, (match, p1, content, p3) => {
      const trimmedContent = content.trim();
      if (trimmedContent.startsWith('"') && trimmedContent.endsWith('"')) return match;
      if (/[:\(\)\[\]{}"',]/.test(trimmedContent)) {
        return `${p1}"${trimmedContent.replace(/"/g, '\\"')}"${p3}`;
      }
      return match;
    });

    // 3. 确定性单遍词法扫描器：处理节点形状包裹
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

            // 若已经以双引号包裹，跳过内部转义引号寻找闭合标签
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


/**
 * 规范化 HTML Void 标签（如 <br>, <hr>, <img ...>），转换为合法的 JSX 自闭合标签（<br />, <hr />, <img ... />），
 * 严格保护围栏代码块（``` / ~~~）与行内反引号代码（`...`）不受误伤。
 * 从第一性原理抹平 CommonMark 宽松 HTML5 空标签与 MDX JSX XML 严格自闭合语法间的阻抗失配。
 */
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

    // 按行内代码反引号切片，保护行内代码片段不受正则替换
    const parts = line.split(/(`+[^`]+`+)/g);
    for (let p = 0; p < parts.length; p++) {
      if (parts[p].startsWith('`') && parts[p].endsWith('`')) {
        continue;
      }
      // 标签名归一小写：JSX 语义中大写标签 = 组件引用（<BR /> 会撞组件查找），
      // 与 Go mdpat 侧生产口径对齐（双轨对拍：mdx-prepare.golden.json）
      parts[p] = parts[p].replace(/<(br|hr|wbr)\s*>/gi, (_, tag: string) => `<${tag.toLowerCase()} />`);
      parts[p] = parts[p].replace(/<(img|input)(\s+[^>]*?[^\/>])\s*>/gi, (_, tag: string, rest: string) => `<${tag.toLowerCase()}${rest} />`);
    }
    lines[l] = parts.join('');
  }

  return lines.join('\n');
}

/**
 * MDX 源码预处理器。
 * 在进入 AST 编译之前，清理所有非 Markdown 标准的标记（如哨兵标记、Pandoc 图片尺寸扩展等）。
 * 全局唯一入口——禁止在其他文件中重复编写这些预处理正则。
 */
export function prepareMdxSource(raw: string): string {
  if (!raw) return '';
  const s = raw
    // 1. 哨兵标记：AI Structurizer 的输出分隔符
    .replace(/===CONTENT_BEGIN===/g, '')
    .replace(/===CONTENT_END===/g, '')
    // 2. Pandoc 图片属性扩展：![alt](url){height=55%} -> ![alt](url)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)\s*\{[^}]*\}/g, '![$1]($2)')
    // 3. 伴生概念清单标签（防止未剥离时误入 AST 编译器被当做 JSX 标签报错）
    .replace(/<concept_manifest[^>]*>[\s\S]*?(?:<\/concept_manifest>|$)/gi, '');

  return normalizeVoidTags(s);
}


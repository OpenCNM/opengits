import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';

// ─────────────────────────────────────────────────────────────
// 读侧文档卫生插件（Read-Side Doc Hygiene Projection）。
//
// 面向「已入库成品内容」的零物化治愈层：不重写 DB，只在编译读侧以
// mdast 纯函数投影修复生成契约历史遗留的两类排版缺陷：
//   1. GFM alert（> [!IMPORTANT] ...）在 MDX 管线中无对应解析器
//      （remark-gfm 不认 blockquote alert），标记以字面文本泄漏到页面；
//   2. 正文首个 H1 与页面外壳标题（frontmatter.title / doc.title）
//      重复渲染成「连体双标题」。
// 两者均按 Chomsky 边界在 AST 层操作，禁字符串手术。
// ─────────────────────────────────────────────────────────────

// 行首容错一个包裹引号：转录模型偶发把整个 alert 包在全角引号里（“[!IMPORTANT] …”）
const GFM_ALERT_MARKER_RE = /^[“”"'‘’]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]?([^\n]*)/i;

/** GFM alert 类型 → CalloutType 语义映射（CAUTION 落 danger，IMPORTANT 用独立强调类型） */
const GFM_ALERT_TYPE_MAP: Record<string, string> = {
  note: 'note',
  tip: 'tip',
  important: 'important',
  warning: 'warning',
  caution: 'danger',
};

/** 剥掉成对包裹引号（全角/半角/中文字书名引号），不成对时原样保留 */
function stripWrappingQuotes(s: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ['“', '”'],
    ["'", "'"],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
  ];
  for (const [open, close] of pairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

/** alert 标题清洗：成对引号剥壳 + 孤立尾引号清理（“[!X] …”形态的引号开在标记前） */
function cleanAlertTitle(raw: string): string {
  let t = stripWrappingQuotes(raw.trim());
  if (!/^["“”'‘’]/.test(t)) {
    t = t.replace(/["“”'‘’]+$/, '');
  }
  return t.trim();
}

/**
 * 标题匹配归一化：剥引号与 markdown 强调/标题残迹、去全部空白（CJK 排版
 * 空格差异免疫）、casefold。供「正文首个 H1 与页面标题重复」门控比对使用。
 */
export function normalizeTitleForMatch(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/["“”‘’'「」『』]/g, '')
    .replace(/[*_~`#]+/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * Remark Plugin: Converts GitHub-style alert blockquotes (> [!NOTE] Title …)
 * into <Callout type="…" title="…"> JSX flow elements.
 *
 * The transcription prompt contract explicitly asks the LLM to emit
 * `> [!IMPORTANT] Design Decision: …`; remark-gfm does not parse these
 * markers, so they previously leaked as literal text inside plain
 * blockquotes. Non-alert blockquotes are left untouched.
 */
export function remarkGfmAlerts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: any) => {
      const first: any = node.children?.[0];
      if (!first || first.type !== 'paragraph') return;

      const firstText: any = first.children?.[0];
      if (!firstText || firstText.type !== 'text' || typeof firstText.value !== 'string') return;

      const marker = GFM_ALERT_MARKER_RE.exec(firstText.value);
      if (!marker) return;

      const alertType = GFM_ALERT_TYPE_MAP[marker[1].toLowerCase()];
      if (!alertType) return;

      const title = cleanAlertTitle(marker[2]);
      // 标记行之后的剩余文本（软换行归一为空格）保留为正文首段
      const rest = firstText.value
        .slice(marker[0].length)
        .replace(/^\n+/, ' ');

      if (rest.trim()) {
        firstText.value = rest;
      } else {
        first.children.shift();
        if (first.children.length === 0) {
          node.children.shift();
        }
      }

      node.type = 'mdxJsxFlowElement';
      node.name = 'Callout';
      node.attributes = [
        { type: 'mdxJsxAttribute', name: 'type', value: alertType },
        ...(title ? [{ type: 'mdxJsxAttribute' as const, name: 'title', value: title }] : []),
      ];
    });
  };
}

/**
 * Remark Plugin: plain-markdown variant of remarkGfmAlerts for the
 * react-markdown fallback pipeline (Layer 3), where JSX flow elements
 * cannot render. Strips the marker text, promotes the title to a leading
 * <strong>, and tags the blockquote via data.hProperties className.
 */
export function remarkGfmAlertsPlain() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: any) => {
      const first: any = node.children?.[0];
      if (!first || first.type !== 'paragraph') return;

      const firstText: any = first.children?.[0];
      if (!firstText || firstText.type !== 'text' || typeof firstText.value !== 'string') return;

      const marker = GFM_ALERT_MARKER_RE.exec(firstText.value);
      if (!marker) return;

      const alertType = GFM_ALERT_TYPE_MAP[marker[1].toLowerCase()];
      if (!alertType) return;

      const title = cleanAlertTitle(marker[2]);
      const rest = firstText.value
        .slice(marker[0].length)
        .replace(/^\n+/, ' ');

      if (rest.trim()) {
        firstText.value = rest;
      } else {
        first.children.shift();
        if (first.children.length === 0) {
          node.children.shift();
        }
      }

      if (title) {
        first.children.unshift({ type: 'strong', children: [{ type: 'text', value: title }] });
      }
      node.data = { ...(node.data ?? {}), hProperties: { className: ['gfm-alert', `gfm-alert-${alertType}`] } };
    });
  };
}

/**
 * Remark Plugin: Removes the document's leading level-1 heading.
 *
 * Whether stripping is enabled is gated upstream (compileDocMdx compares
 * the compiled TOC's first entry against the page title); this plugin
 * only performs the AST-level removal when invoked on the :h1s variant.
 * Frontmatter nodes (yaml/toml) at the root are skipped, and only the
 * first content node is considered — H1s elsewhere are preserved.
 */
export function remarkStripLeadingTitle() {
  return (tree: Root) => {
    const children = tree.children as any[];
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.type === 'yaml' || node.type === 'toml') continue;
      if (node.type === 'heading' && node.depth === 1) {
        children.splice(i, 1);
      }
      return;
    }
  };
}

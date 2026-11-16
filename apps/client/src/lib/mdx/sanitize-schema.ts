import { defaultSchema, type Schema } from 'hast-util-sanitize';

/**
 * MDX 渲染管线的 sanitize 白名单 schema（与 rehypeSanitizePreservingMdx 配套）。
 *
 * 设计约束（2026-09-02 修订）：
 * - 本 schema 只作用于**原生 HTML element** 节点（rehypeRaw 从 markdown 源解出的部分）。
 * - MDX JSX 节点（mdxJsxFlowElement/mdxJsxTextElement/表达式）曾因 hast-util-sanitize
 *   丢弃未知节点类型而整段静默消失（Card/Steps/Callout 连同子内容）——现已由
 *   rehypeSanitizePreservingMdx 占位保护保留；其安全性由三层保障：
 *   ① mdxJsx 字符串属性轻过滤（剥 on* 事件与 javascript:/vbscript: 伪协议）；
 *   ② 渲染走 React 转义（表达式属性值不产生 HTML 注入）；
 *   ③ 未注册组件名在编译期改写为 UnknownMdxComponent（渲染 children 的兜底组件）。
 * - 既有防线：sanitizer.ts（AST 级，剥事件属性与 javascript 伪协议与 script 标签）+
 *   Mermaid antiscript；本层是渲染前的最后一道白名单（纵深防御，防未来防线旁路）。
 * - 必须放行 fumadocs/MDX 运行时依赖的属性（className、data-*）与常见文档元素，
 *   否则表格/代码高亮/Mermaid 检测（language-mermaid className）会被剥坏。
 *
 * 注意：hast-util-sanitize 的数组字段是整体替换语义——必须显式合并 defaultSchema，
 * 只写补充项会把默认的 table/img/code 等全部顶掉（初版踩过此坑）。
 */

// defaultSchema 之上的补充标签（常见文档元素）
const EXTRA_TAG_NAMES = [
  'figure', 'figcaption', 'picture', 'source', 'details', 'summary', 'kbd', 'mark', 'abbr',
  'del', 'ins', 'video', 'audio', 'iframe',
];

function mergeAttributes(
  base: Schema['attributes'],
  extra: Schema['attributes']
): Schema['attributes'] {
  const merged: Record<string, Array<string | [string, RegExp]>> = {};
  const baseMap = (base || {}) as Record<string, Array<string | [string, RegExp]>>;
  const extraMap = (extra || {}) as Record<string, Array<string | [string, RegExp]>>;
  const keys = new Set([...Object.keys(baseMap), ...Object.keys(extraMap)]);
  for (const key of keys) {
    const baseList = baseMap[key] ?? [];
    const extraList = extraMap[key] ?? [];
    merged[key] = [...baseList, ...extraList];
  }
  return merged as Schema['attributes'];
}

export const mdxSanitizeSchema: Schema = {
  tagNames: [...(defaultSchema.tagNames ?? []), ...EXTRA_TAG_NAMES],
  attributes: mergeAttributes(defaultSchema.attributes, {
    '*': [
      'className',
      'id',
      // data-* 全放行：前缀条目名必须是 'data*'（hast-util-sanitize 的约定），
      // fumadocs（data-code 存原始代码文本）、遥测（data-telemetry-event）均依赖；值不约束（序列化层已转义）
      ['data*', /.*/],
      'ariaLabel', 'ariaHidden', 'ariaDescribedby', 'ariaLabelledby', 'role',
    ],
    a: ['target', 'rel', 'download'],
    img: ['loading', 'crossOrigin', 'srcSet', 'sizes'],
    code: ['language'], // 部分仓库用自定义 language 属性
    input: ['disabled'], // GFM 任务列表 checkbox
    th: ['align'],
    td: ['align'],
    ol: ['start'],
    table: ['align'],
    video: ['controls', 'poster', 'muted', 'loop', 'preload'],
    audio: ['controls', 'preload'],
    iframe: ['title', 'allow', 'allowFullScreen', 'loading'],
  }),
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
    // code:<path>[:L<start>-L<end>] 站内代码锚点协议（装甲句柄还原产物）：
    // docs-mdx-runtime 的 a 拦截器将其转 CodeAnchor（页内滚动/CodeDrawer），
    // 不放行则 href 被剥、锚点退化为死文本
    href: [...(defaultSchema.protocols?.href ?? []), 'code'],
  },
};

/**
 * 平台已注册 MDX 组件名注册表 + HTML 内在元素清单。
 *
 * 用途：sanitize 占位保护插件（ast-sanitizer-plugins 的 rehypeSanitizePreservingMdx）
 * 在还原 MDX JSX 节点时，需要区分三类标签：
 *   1. 平台已注册组件（docs-mdx-runtime 的 buildDocCustomComponents 键）——保留原名；
 *   2. HTML/SVG 内在元素（div/span/section…）——MDX 按字符串标签渲染，保留原名；
 *   3. 其余（未注册的 PascalCase 组件名）——改写为 `UnknownMdxComponent`，
 *      由运行时提供的 fallback 组件渲染 children，避免 React 因组件 undefined
 *      抛 "Element type is invalid" 毁掉整页。
 *
 * 维护约定：docs-mdx-runtime 新注册组件时，同步在 KNOWN_MDX_COMPONENT_NAMES 加名
 * （两侧靠注释联动，新增漏登记的后果只是该组件被 fallback 渲染 children，内容不丢）。
 */

/** 平台已注册组件名（buildDocCustomComponents 的全部键 + 兜底组件自身） */
export const KNOWN_MDX_COMPONENT_NAMES: ReadonlySet<string> = new Set([
  // 兜底组件（见 docs-mdx-runtime 的 components 映射）
  'UnknownMdxComponent',
  // 平台自定义组件（含大小写别名键）
  'YouTube',
  'DynamicVar',
  'Jargon',
  'WhiteboardImage',
  'MicroQuiz',
  'Callout',
  'callout',
  'Summary',
  'summary',
  'CodeGroup',
  'CodeGroupItem',
  'CodeBlock',
  'codeblock',
  'code-block',
  'codeblockitem',
  'code-block-item',
  'Steps',
  'steps',
  'Step',
  'step',
  'CardGroup',
  'cardgroup',
  'Card',
  'card',
  'AccordionGroup',
  'accordiongroup',
  'Accordion',
  'accordion',
  'Expandable',
  'expandable',
  'InterleafAnswer',
  'SmartTable',
  'smarttable',
  'smart-table',
  'table',
  'CodeAnchor',
  'codeanchor',
  'code-anchor',
  // 常见别名（TAG_ALIASES 同源的额外宽容形态）
  'codegroup',
  'card-group',
  'accordion-group',
]);

/** HTML/SVG 内在元素：MDX 按字符串标签渲染（不查 components），永不改写 */
export const HTML_INTRINSIC_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'acronym', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'img', 'input', 'ins',
  'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav',
  'noframes', 'noscript', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture',
  'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'search', 'section', 'select',
  'slot', 'small', 'source', 'span', 'strong', 'sub', 'summary', 'sup', 'svg', 'table',
  'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track',
  'u', 'ul', 'var', 'video', 'wbr',
  // 常见 SVG 子元素
  'circle', 'clipPath', 'defs', 'ellipse', 'g', 'line', 'linearGradient', 'mask', 'path', 'pattern',
  'polygon', 'polyline', 'radialGradient', 'rect', 'stop', 'text', 'tspan', 'use',
]);

/** 组件名改写判定：平台未注册且非 HTML 内在元素的标签一律改写为兜底组件。
 *  红队 GAP-2：此前仅匹配 ASCII 标识符——<架构视图> 等合法 Unicode 标识符名会被
 *  漏判保留，运行时组件查找 undefined 抛 "Element type is invalid" 整页崩溃。
 *  现在凡非已知/非内在/非连字符名的标签（含 Unicode）都改写为 UnknownMdxComponent，
 *  由兜底组件渲染 children 保内容。 */
export function isUnknownComponentName(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (KNOWN_MDX_COMPONENT_NAMES.has(name)) return false;
  if (HTML_INTRINSIC_TAGS.has(name)) return false;
  // 含连字符 = MDX 内在字符串标签（自定义元素），React 原样渲染 children，无需改写
  if (name.includes('-')) return false;
  return true;
}

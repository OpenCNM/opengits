export const KNOWN_MDX_COMPONENT_NAMES: ReadonlySet<string> = new Set([
  'UnknownMdxComponent',
  'YouTube',
  'DynamicVar',
  'Jargon',
  'WhiteboardImage',
  'MicroQuiz',
  'Callout',
  'callout',
  'Summary',
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
  'codegroup',
  'card-group',
  'accordion-group',
]);

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
  'circle', 'clipPath', 'defs', 'ellipse', 'g', 'line', 'linearGradient', 'mask', 'path', 'pattern',
  'polygon', 'polyline', 'radialGradient', 'rect', 'stop', 'text', 'tspan', 'use',
]);

// Rewrite unregistered non-intrinsic tags (including Unicode names) to UnknownMdxComponent so React never throws on undefined component types.
export function isUnknownComponentName(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (KNOWN_MDX_COMPONENT_NAMES.has(name)) return false;
  if (HTML_INTRINSIC_TAGS.has(name)) return false;
  // Hyphenated names are valid custom elements rendered by React as string tags.
  if (name.includes('-')) return false;
  return true;
}

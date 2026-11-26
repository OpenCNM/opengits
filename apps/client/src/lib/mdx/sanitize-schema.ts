import { defaultSchema, type Schema } from 'hast-util-sanitize';

// Defense-in-depth HTML whitelist (paired with rehypeSanitizePreservingMdx); must merge defaultSchema because hast-util-sanitize replaces array fields whole.

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
      // Permit data-* attributes required by fumadocs (data-code) and telemetry.
      ['data*', /.*/],
      'ariaLabel', 'ariaHidden', 'ariaDescribedby', 'ariaLabelledby', 'role',
    ],
    a: ['target', 'rel', 'download'],
    img: ['loading', 'crossOrigin', 'srcSet', 'sizes'],
    code: ['language'],
    input: ['disabled'],
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
    // Allow code: protocol so code-anchor hrefs survive sanitization.
    href: [...(defaultSchema.protocols?.href ?? []), 'code'],
  },
};

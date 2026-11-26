import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, Properties } from 'hast';
import { cn } from '@/lib/utils';
import { KNOWN_MDX_COMPONENT_NAMES, HTML_INTRINSIC_TAGS } from './known-mdx-components';

export interface RehypePolymorphicDemotionOptions {
  forbiddenTags?: ReadonlySet<string> | string[];
  knownComponents?: ReadonlySet<string> | string[];
  intrinsicTags?: ReadonlySet<string> | string[];
}

export const FORBIDDEN_DEMOTION_TAGS: ReadonlySet<string> = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'style',
  'base',
  'meta',
]);

// Demotes unknown pseudo-HTML tags (<T>, <target_dir>) to <span> while stripping forbidden injection tags and style/on* attributes.
export function rehypePolymorphicDemotion(options?: RehypePolymorphicDemotionOptions) {
  const forbidden = options?.forbiddenTags
    ? new Set(options.forbiddenTags)
    : FORBIDDEN_DEMOTION_TAGS;
  const known = options?.knownComponents
    ? new Set(options.knownComponents)
    : KNOWN_MDX_COMPONENT_NAMES;
  const intrinsic = options?.intrinsicTags
    ? new Set(options.intrinsicTags)
    : HTML_INTRINSIC_TAGS;

  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index: number | undefined, parent: any) => {
      if (!node || typeof node.tagName !== 'string') return;

      const lowerTagName = node.tagName.toLowerCase();

      if (forbidden.has(lowerTagName)) {
        if (parent && Array.isArray(parent.children) && typeof index === 'number') {
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
        node.type = 'text' as any;
        (node as any).value = '';
        delete (node as any).tagName;
        delete (node as any).properties;
        delete (node as any).children;
        return;
      }

      if (intrinsic.has(lowerTagName)) {
        return;
      }

      if (known.has(node.tagName) || known.has(lowerTagName)) {
        return;
      }

      const hasMeaningfulChildren =
        Array.isArray(node.children) &&
        node.children.some((child: any) => {
          if (!child) return false;
          if (child.type === 'comment') return false;
          if (child.type === 'text') {
            return typeof child.value === 'string' && child.value.trim().length > 0;
          }
          return true;
        });

      // Empty/self-closing hyphenated tags (<repo-url />) are CLI placeholders, not web components, and must demote to preserve text.
      if (node.tagName.includes('-') && hasMeaningfulChildren) {
        return;
      }

      const originalTagName = node.tagName;
      node.tagName = 'span';

      const cleanProperties: Properties = {
        'data-syntax-role': 'placeholder-token',
        className: cn(
          'syntax-placeholder-token font-mono text-xs px-1.5 py-0.5 rounded bg-theme-muted/15 text-theme-foreground border border-theme-border/60 inline-block align-baseline mx-0.5 select-all',
          node.properties?.className as string | string[] | undefined
        ).split(' ').filter(Boolean),
      };

      if (node.properties) {
        for (const [key, value] of Object.entries(node.properties)) {
          if (key === 'className' || key === 'data-syntax-role') continue;
          if (/^on[a-z]+/i.test(key)) continue;
          if (key === 'style') continue;
          if (
            key === 'id' ||
            key === 'title' ||
            key === 'role' ||
            key.startsWith('data') ||
            key.startsWith('aria')
          ) {
            cleanProperties[key] = value;
          }
        }
      }

      node.properties = cleanProperties;

      if (!hasMeaningfulChildren) {
        node.children = [{ type: 'text', value: `<${originalTagName}>` }];
      }
    });
  };
}

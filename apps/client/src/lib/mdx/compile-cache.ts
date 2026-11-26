import { createHash } from 'node:crypto';
import { ignoreBestEffort } from '@/lib/best-effort';
import { unstable_cache } from 'next/cache';
import { createCompiler } from '@fumadocs/mdx-remote';
import rehypeRaw from 'rehype-raw';
import remarkUnwrapImages from 'remark-unwrap-images';
import { visit } from 'unist-util-visit';
import { mdxSanitizeSchema } from '@/lib/mdx/sanitize-schema';
import {
  remarkStripEsm,
  remarkTagNormalizer,
  remarkSafeBraces,
  rehypeStripStyle,
  rehypeSanitizePreservingMdx,
} from '@/lib/mdx/ast-sanitizer-plugins';
import { rehypePolymorphicDemotion } from '@/lib/mdx/rehype-polymorphic-demotion';
import { rehypeParagraphContentModel } from '@/lib/mdx/rehype-paragraph-content-model';
import { remarkGfmAlerts, remarkStripLeadingTitle, remarkDeepDiveHygiene } from '@/lib/mdx/remark-doc-hygiene';
import { remarkCodeFenceMeta, isMarkdownFilePath } from '@/lib/mdx/code-fence-meta';

import { highlightCodeWasm } from '@/lib/wasm/syntax-highlighter-wasm';

// Caches serializable compiled JS + TOC + frontmatter (not React FC body) keyed by sha256(variant + source); skips cache on fallback paths.

function extractLanguageFromHast(node: any): string {
  if (!node || !node.properties) return '';
  const classNames = node.properties.className;
  if (Array.isArray(classNames)) {
    for (const cls of classNames) {
      if (typeof cls === 'string' && cls.startsWith('language-')) {
        return cls.replace(/^language-/, '');
      }
    }
  } else if (typeof classNames === 'string' && classNames.startsWith('language-')) {
    return classNames.replace(/^language-/, '');
  }
  return (node.properties['data-language'] as string) || '';
}

function rehypePreserveRawCode() {
  return async (tree: any) => {
    const preElements: any[] = [];
    visit(tree, 'element', (node: any) => {
      if (node.tagName === 'pre') {
        preElements.push(node);
      }
    });

    for (const preNode of preElements) {
      const childCode = preNode.children?.find((c: any) => c.tagName === 'code');
      const rawText = hastNodeToString(childCode || preNode);
      if (!rawText || !rawText.trim()) continue;

      // Strip trailing newline added by CommonMark so Shiki does not render an extra blank line.
      const normalizedCode = rawText.replace(/\r?\n$/, '');

      if (!preNode.properties) preNode.properties = {};
      preNode.properties['data-code'] = normalizedCode;

      const filePath =
        (preNode.properties['data-file'] as string) ||
        (preNode.properties['dataFile'] as string) ||
        (childCode?.properties?.['data-file'] as string) ||
        (childCode?.properties?.['dataFile'] as string) ||
        '';
      const hasSymbol = Boolean(
        preNode.properties['data-has-symbol'] ||
        preNode.properties['dataHasSymbol'] ||
        childCode?.properties?.['data-has-symbol'] ||
        childCode?.properties?.['dataHasSymbol']
      );
      if (filePath) {
        preNode.properties['data-file'] = filePath;
      }
      for (const propKey of ['data-has-symbol', 'dataHasSymbol'] as const) {
        if (preNode.properties[propKey] !== undefined) {
          delete preNode.properties[propKey];
        }
        if (childCode?.properties && childCode.properties[propKey] !== undefined) {
          delete childCode.properties[propKey];
        }
      }

      let lang = extractLanguageFromHast(preNode) || extractLanguageFromHast(childCode);
      // Re-tag fences pointing to .md/.mdx files as markdown unless a #symbol anchor is present.
      if (filePath && isMarkdownFilePath(filePath) && !hasSymbol) {
        lang = 'markdown';
        if (childCode) {
          if (!childCode.properties) childCode.properties = {};
          childCode.properties.className = ['language-markdown'];
        }
      }

      if (lang) {
        preNode.properties['data-language'] = lang;
        if (childCode) {
          if (!childCode.properties) childCode.properties = {};
          childCode.properties['data-language'] = lang;
          childCode.properties['data-code'] = normalizedCode;
          if (Array.isArray(childCode.children)) {
            for (const child of childCode.children) {
              if (child.type === 'text' && typeof child.value === 'string') {
                child.value = child.value.replace(/\r?\n$/, '');
              }
            }
          }
        }
      }

      try {
        const html = await highlightCodeWasm(normalizedCode, { lang });
        if (html) {
          preNode.properties['data-highlighted-html'] = html;
        }
      } catch {
        ignoreBestEffort();
      }
    }
  };
}

function hastNodeToString(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (node.children) return node.children.map(hastNodeToString).join('');
  return '';
}

// Register hygiene plugins before TOC extraction so demoted headings stay out of TOC.
function createDocCompiler(extraRemark: Array<() => any> = []) {
  return createCompiler({
    remarkPlugins: (v) => [
      remarkUnwrapImages,
      remarkStripEsm,
      remarkTagNormalizer,
      remarkSafeBraces,
      remarkCodeFenceMeta,
      remarkGfmAlerts,
      remarkDeepDiveHygiene,
      ...extraRemark,
      ...v,
    ],
    rehypePlugins: (v) => [
      [rehypeRaw, { passThrough: ['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression', 'mdxJsxFlowElement', 'mdxJsxTextElement'] }],
      rehypePreserveRawCode,
      rehypeStripStyle,
      rehypeParagraphContentModel,
      rehypePolymorphicDemotion,
      // Final defense-in-depth HTML/attribute whitelist; preserves vaulted MDX JSX nodes.
      [rehypeSanitizePreservingMdx, mdxSanitizeSchema],
      ...v,
    ],
    remarkImageOptions: false,
    rehypeCodeOptions: false,
  });
}

export const mdxCompiler = createDocCompiler();

const mdxCompilerStripTitle = createDocCompiler([remarkStripLeadingTitle]);

function compilerForVariant(variant: string) {
  return variant.endsWith(':h1s') ? mdxCompilerStripTitle : mdxCompiler;
}

interface CachedCompileEntry {
  compiled: string;
  toc: unknown[];
  frontmatter: Record<string, unknown>;
  deepDiveCount: number;
}

export interface CachedCompileResult {
  body: Awaited<ReturnType<typeof mdxCompiler.compile>>['body'];
  toc: unknown[];
  frontmatter: Record<string, unknown>;
  deepDiveCount: number;
}

export function readDeepDiveCount(vfile: unknown): number {
  const data = (vfile as { data?: Record<string, unknown> } | null | undefined)?.data;
  return typeof data?.deepDiveCount === 'number' ? data.deepDiveCount : 0;
}

const COMPILE_CACHE_REVALIDATE_SECONDS = 24 * 60 * 60;

// Distinguishes bad MDX source (rethrow) from cache backend errors (fallback to direct compile).
class MDXSourceCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MDXSourceCompileError';
  }
}

export function stringifyTocTitle(title: unknown): string {
  if (title === null || title === undefined) return '';
  if (typeof title === 'string') return title;
  if (typeof title === 'number' || typeof title === 'boolean') return String(title);
  if (Array.isArray(title)) {
    return title.map(stringifyTocTitle).join('');
  }
  if (typeof title === 'object' && title !== null) {
    const obj = title as Record<string, unknown>;
    if (obj.props && typeof obj.props === 'object' && obj.props !== null) {
      return stringifyTocTitle((obj.props as Record<string, unknown>).children);
    }
    if (obj.children) {
      return stringifyTocTitle(obj.children);
    }
    if (typeof obj.value === 'string') {
      return obj.value;
    }
  }
  return '';
}

export interface SanitizedTocItem {
  title: string;
  url: string;
  depth: number;
}

export function sanitizeTocItems(rawToc: unknown): SanitizedTocItem[] {
  if (!Array.isArray(rawToc)) return [];
  return rawToc
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const depth = typeof item.depth === 'number' ? item.depth : 2;
      const url = typeof item.url === 'string' ? item.url : '';
      const title = stringifyTocTitle(item.title).trim();
      return { depth, url, title };
    })
    .filter((item): item is SanitizedTocItem => item !== null && item.title.length > 0);
}

export async function cachedCompileMdx(
  source: string,
  variant = 'primary',
): Promise<CachedCompileResult> {
  const compiler = compilerForVariant(variant);
  const digest = createHash('sha256').update(`${variant}\u0000${source}`).digest('hex');

  // In-process LRU caches evaluated React FC body per content digest to skip repeat eval on hot reads.
  const renderHit = renderResultCache.get(digest);
  if (renderHit) {
    renderResultCache.delete(digest);
    renderResultCache.set(digest, renderHit);
    return renderHit;
  }

  let entry: CachedCompileEntry | null | undefined;
  try {
      const readEntry = unstable_cache(
      async (): Promise<CachedCompileEntry> => {
        try {
          const c = await compiler.compile({ source });
          const cleanToc = sanitizeTocItems(c.toc);
          return { compiled: c.compiled, toc: cleanToc, frontmatter: c.frontmatter, deepDiveCount: readDeepDiveCount(c.vfile) };
        } catch (err) {
          throw new MDXSourceCompileError(err instanceof Error ? err.message : String(err));
        }
      },
      // Bump 'v9' when compiler output shape or hygiene normalization changes.
      ['mdx-compile', 'v9', variant, digest],
      { revalidate: COMPILE_CACHE_REVALIDATE_SECONDS },
    );
    entry = await readEntry();
  } catch (err) {
    if (err instanceof MDXSourceCompileError) throw err;
    console.warn('[MDXCache] cache read failed, compiling directly:', err instanceof Error ? err.message : err);
  }

  if (!entry?.compiled) {
    const fresh = await compiler.compile({ source });
    return {
      body: fresh.body,
      toc: sanitizeTocItems(fresh.toc),
      frontmatter: fresh.frontmatter,
      deepDiveCount: readDeepDiveCount(fresh.vfile),
    };
  }

  const rendered = await compiler.render(entry.compiled);
  const result: CachedCompileResult = {
    body: rendered.default,
    toc: sanitizeTocItems(entry.toc),
    frontmatter: entry.frontmatter,
    deepDiveCount: typeof entry.deepDiveCount === 'number' ? entry.deepDiveCount : 0,
  };

  if (renderResultCache.size >= RENDER_CACHE_LIMIT) {
    const oldest = renderResultCache.keys().next().value;
    if (oldest !== undefined) renderResultCache.delete(oldest);
  }
  renderResultCache.set(digest, result);
  return result;
}

const RENDER_CACHE_LIMIT = 128;
const renderResultCache = new Map<string, CachedCompileResult>();

export function __resetRenderCacheForTests(): void {
  renderResultCache.clear();
}

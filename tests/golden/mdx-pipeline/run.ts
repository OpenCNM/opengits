/**
 * Golden Diff runner for the MDX & Remark/Rehype pipeline.
 *
 * - `.mdx` / `.md` inputs compile through `mdxCompiler.compile` (and optionally
 *   `cachedCompileMdx(..., 'primary:h1s')` when `:h1s` is requested by case name)
 *   and emit deterministic META + COMPILED JS output for line-by-line diffing.
 * - `.json` inputs dispatch structured AST / utility transforms:
 *   `remark-hygiene-ast`, `rehype-content-model-and-demotion`,
 *   `markdown-preview-and-fence-meta`.
 */
import Module from 'node:module';
import { tsImport } from 'tsx/esm/api';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toHtml } from 'hast-util-to-html';
import { h } from 'hastscript';
import {
  remarkGfmAlerts,
  remarkGfmAlertsPlain,
  remarkStripLeadingTitle,
  normalizeTitleForMatch,
} from '@/lib/mdx/remark-doc-hygiene';
import { remarkSafeBraces } from '@/lib/mdx/ast-sanitizer-plugins';
import { rehypeParagraphContentModel } from '@/lib/mdx/rehype-paragraph-content-model';
import { rehypePolymorphicDemotion } from '@/lib/mdx/rehype-polymorphic-demotion';
import {
  extractCodeFenceMeta,
  isMarkdownFilePath,
} from '@/lib/mdx/code-fence-meta';
import {
  isMarkdownCodeBlock,
  splitMarkdownPreviewOmission,
} from '@/components/mdx/markdown-code-preview-utils';

export const defaultExt = '.txt';

interface GoldenCaseContext {
  suite: string;
  caseName: string;
  caseDir: string;
  inputPath: string;
  inputExt: string;
  expectedPath: string | null;
  expectedExt: string | null;
}

type CompileCacheModule = typeof import('@/lib/mdx/compile-cache');

let compileCachePromise: Promise<CompileCacheModule> | null = null;
let moduleBridgeInstalled = false;

async function getCompileCacheModule(): Promise<CompileCacheModule> {
  if (!compileCachePromise) {
    compileCachePromise = (async () => {
      if (!moduleBridgeInstalled) {
        moduleBridgeInstalled = true;
        // Outside Next.js server runtime, bridge next/cache passthrough and ESM-only @fumadocs/mdx-remote
        // so tsx CJS transpilation of compile-cache.ts resolves without modifying production source.
        const fumadocsEsm = await import('@fumadocs/mdx-remote');
        const modInternal = Module as unknown as {
          _load: (request: string, parent: unknown, isMain: boolean) => unknown;
          _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
        };
        const origLoad = modInternal._load;
        const origResolve = modInternal._resolveFilename;
        modInternal._resolveFilename = function (request, parent, isMain, options) {
          if (request === 'next/cache') return 'next/cache';
          if (request === '@fumadocs/mdx-remote') return '@fumadocs/mdx-remote';
          return origResolve.call(this, request, parent, isMain, options);
        };
        modInternal._load = function (request, parent, isMain) {
          if (request === 'next/cache') {
            return { unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn };
          }
          if (request === '@fumadocs/mdx-remote') {
            return fumadocsEsm;
          }
          return origLoad.call(this, request, parent, isMain);
        };
      }
      return tsImport('../../../apps/client/src/lib/mdx/compile-cache.ts', import.meta.url);
    })();
  }
  return compileCachePromise;
}

function runRemarkPlugin(md: string, plugin: () => (tree: unknown) => void) {
  const tree = unified().use(remarkParse).parse(md);
  plugin()(tree);
  return tree;
}

function summarizeMdastNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = { type: n.type };
  if (typeof n.name === 'string') out.name = n.name;
  if (typeof n.depth === 'number') out.depth = n.depth;
  if (typeof n.value === 'string') out.value = n.value;
  if (typeof n.lang === 'string') out.lang = n.lang;
  if (Array.isArray(n.attributes)) {
    out.attributes = n.attributes.map((a: Record<string, unknown>) => ({
      name: a.name,
      value: a.value,
    }));
  }
  if (n.data && typeof n.data === 'object') {
    out.data = n.data;
  }
  if (Array.isArray(n.children)) {
    out.children = n.children.map(summarizeMdastNode);
  }
  return out;
}

function buildHastNode(spec: unknown): unknown {
  if (typeof spec === 'string') return spec;
  if (!spec || typeof spec !== 'object') return spec;
  const s = spec as Record<string, unknown>;
  if (s.rawType === 'mdxJsxFlowElement') {
    return {
      type: 'mdxJsxFlowElement',
      name: s.name,
      attributes: s.attributes ?? [],
      children: Array.isArray(s.children) ? s.children.map(buildHastNode) : [],
    };
  }
  if (s.rawType === 'element') {
    return {
      type: 'element',
      tagName: s.tagName,
      properties: s.properties ?? {},
      children: Array.isArray(s.children) ? s.children.map(buildHastNode) : [],
    };
  }
  if (s.rawType === 'comment') {
    return { type: 'comment', value: s.value ?? '' };
  }
  const tag = String(s.tag);
  const props = (s.props as Record<string, unknown> | undefined) ?? {};
  const children = Array.isArray(s.children) ? s.children.map(buildHastNode) : [];
  return h(tag, props as Parameters<typeof h>[1], children as Parameters<typeof h>[2]);
}

function handleRemarkHygieneAst(payload: Record<string, unknown>) {
  const gfmAlerts = (payload.gfmAlerts as Array<{ name: string; md: string }>).map((c) => {
    const tree = runRemarkPlugin(c.md, remarkGfmAlerts as () => (tree: unknown) => void);
    return { name: c.name, children: (tree.children as unknown[]).map(summarizeMdastNode) };
  });

  const gfmAlertsPlain = (payload.gfmAlertsPlain as Array<{ name: string; md: string }>).map((c) => {
    const tree = runRemarkPlugin(c.md, remarkGfmAlertsPlain as () => (tree: unknown) => void);
    return { name: c.name, children: (tree.children as unknown[]).map(summarizeMdastNode) };
  });

  const stripLeadingTitle = (payload.stripLeadingTitle as Array<{ name: string; md: string }>).map((c) => {
    const tree = runRemarkPlugin(c.md, remarkStripLeadingTitle as () => (tree: unknown) => void);
    return { name: c.name, children: (tree.children as unknown[]).map(summarizeMdastNode) };
  });

  const normalizeTitle = (payload.normalizeTitle as Array<string | null>).map((raw) => ({
    input: raw,
    normalized: normalizeTitleForMatch(raw),
  }));

  const safeBraces = (payload.safeBraces as Array<{ name: string; expressions: string[] }>).map((c) => {
    const children = c.expressions.map((expr) => ({ type: 'mdxTextExpression', value: expr }));
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [...children, { type: 'text', value: 'tail' }] }],
    };
    (remarkSafeBraces as unknown as () => (t: unknown) => void)()(tree);
    return { name: c.name, result: summarizeMdastNode(tree.children[0]) };
  });

  return { gfmAlerts, gfmAlertsPlain, stripLeadingTitle, normalizeTitle, safeBraces };
}

function handleRehypeContentAndDemotion(payload: Record<string, unknown>) {
  const paragraphContentModel = (
    payload.paragraphContentModel as Array<{ name: string; nodes: unknown[]; assertAstOnly?: boolean }>
  ).map((c) => {
    const tree = { type: 'root', children: c.nodes.map(buildHastNode) };
    rehypeParagraphContentModel()(tree as Parameters<ReturnType<typeof rehypeParagraphContentModel>>[0]);
    if (c.assertAstOnly) {
      return { name: c.name, ast: tree.children };
    }
    return { name: c.name, html: toHtml(tree as Parameters<typeof toHtml>[0]) };
  });

  const polymorphicDemotion = (
    payload.polymorphicDemotion as Array<{ name: string; nodes: unknown[] }>
  ).map((c) => {
    const tree = { type: 'root', children: c.nodes.map(buildHastNode) };
    rehypePolymorphicDemotion()(tree as Parameters<ReturnType<typeof rehypePolymorphicDemotion>>[0]);
    return { name: c.name, html: toHtml(tree as Parameters<typeof toHtml>[0]) };
  });

  return { paragraphContentModel, polymorphicDemotion };
}

async function handleMarkdownPreviewAndMeta(payload: Record<string, unknown>) {
  const { stringifyTocTitle, sanitizeTocItems } = await getCompileCacheModule();

  const isMarkdownCodeBlockCases = (
    payload.isMarkdownCodeBlock as Array<{ lang?: string; filePath?: string }>
  ).map((c) => ({
    lang: c.lang ?? null,
    filePath: c.filePath ?? null,
    result: isMarkdownCodeBlock(c.lang, c.filePath),
  }));

  const splitOmissionCases = (payload.splitMarkdownPreviewOmission as Array<{ name: string; code: string }>).map(
    (c) => ({
      name: c.name,
      result: splitMarkdownPreviewOmission(c.code),
    }),
  );

  const extractMetaCases = (payload.extractCodeFenceMeta as Array<string | null>).map((meta) => ({
    meta,
    result: extractCodeFenceMeta(meta),
  }));

  const isMarkdownPathCases = (payload.isMarkdownFilePath as Array<string | null>).map((p) => ({
    filePath: p,
    result: isMarkdownFilePath(p),
  }));

  const tocCases = (payload.tocSanitize as Array<{ name: string; rawToc: unknown }>).map((c) => ({
    name: c.name,
    stringifyFirst: Array.isArray(c.rawToc) && c.rawToc[0]
      ? stringifyTocTitle((c.rawToc[0] as { title?: unknown }).title)
      : null,
    sanitized: sanitizeTocItems(c.rawToc),
  }));

  return {
    isMarkdownCodeBlockCases,
    splitOmissionCases,
    extractMetaCases,
    isMarkdownPathCases,
    tocCases,
  };
}

export async function run(input: string, ctx: GoldenCaseContext): Promise<string> {
  if (ctx.inputExt === '.mdx' || ctx.inputExt === '.md') {
    const { mdxCompiler, cachedCompileMdx, readDeepDiveCount, sanitizeTocItems } =
      await getCompileCacheModule();
    const compiled = await mdxCompiler.compile({ source: input, filePath: `${ctx.caseName}${ctx.inputExt}` });
    const meta: Record<string, unknown> = {
      toc: sanitizeTocItems(compiled.toc),
      frontmatter: compiled.frontmatter,
      deepDiveCount: readDeepDiveCount(compiled.vfile),
    };

    if (ctx.caseName === 'compile-deep-dive-and-alerts') {
      const h1s = await cachedCompileMdx(input, 'primary:h1s');
      meta.h1sToc = h1s.toc;
      meta.h1sDeepDiveCount = h1s.deepDiveCount;
    }

    return [
      '=== META ===',
      JSON.stringify(meta, null, 2),
      '=== COMPILED ===',
      String(compiled.compiled ?? ''),
      '',
    ].join('\n');
  }

  if (ctx.inputExt === '.json') {
    const payload = JSON.parse(input) as { op: string } & Record<string, unknown>;
    let output: unknown;
    switch (payload.op) {
      case 'remark-hygiene-ast':
        output = handleRemarkHygieneAst(payload);
        break;
      case 'rehype-content-model-and-demotion':
        output = handleRehypeContentAndDemotion(payload);
        break;
      case 'markdown-preview-and-fence-meta':
        output = await handleMarkdownPreviewAndMeta(payload);
        break;
      default:
        throw new Error(`Unknown mdx-pipeline JSON op: ${payload.op}`);
    }
    return `${JSON.stringify(output, null, 2)}\n`;
  }

  throw new Error(`Unsupported input extension "${ctx.inputExt}" in ${ctx.caseName}`);
}

/**
 * Golden Diff runner for pure deterministic text/AST/search/normalizer transforms:
 * - `outline-plan-normalizer`: `normalizeOutlinePlan`, `cleanChapterName`, `outline_plan_v1` / `outline_map_v1`
 * - `prepare-mdx-and-sanitizers`: `prepareMdxSource`, `normalizeVoidTags`, `normalizeDeepDiveBlocks`,
 *   `stripDeepDiveBlocks`, `remarkStripEsm`, `remarkTagNormalizer`, `remarkSafeBraces`, `rehypeStripStyle`, `mdxSanitizeSchema`
 * - `search-and-snippet-pure`: `dissectSearchQuery`, `matchRepoWithSmartQuery`, `calculateSourceTypeCounts`,
 *   `extractContextSnippet`, `resolveDocTitle`, `rerankChunkResults`, `buildLocatorSnippet`
 * - `code-viewport-and-explain`: `serializeExplainCodePayload`, `parseExplainCodePayload`,
 *   `buildExplainCodeSearchQuery`, `extractCodeExplainContext`, `wrapCodeAsMdx`
 */
import { unified } from 'unified';
import { toHtml } from 'hast-util-to-html';
import { h } from 'hastscript';
import * as remarkParseNs from 'remark-parse';
import * as remarkStringifyNs from 'remark-stringify';
import * as remarkMdxNs from 'remark-mdx';
import { defaultSchema } from 'hast-util-sanitize';
import { normalizeOutlinePlan, cleanChapterName } from '@/lib/llm-gateway/normalizers';
import { lookupLlmPurpose } from '@/lib/llm-gateway/registry';
import {
  prepareMdxSource,
  normalizeVoidTags,
  normalizeDeepDiveBlocks,
  stripDeepDiveBlocks,
  scanFallbackTocAndDeepDives,
} from '@/lib/mdx/prepareMdxSource';
import { remarkDeepDiveHygiene } from '@/lib/mdx/remark-doc-hygiene';
import {
  remarkStripEsm,
  remarkTagNormalizer,
  remarkSafeBraces,
  rehypeStripStyle,
} from '@/lib/mdx/ast-sanitizer-plugins';
import { mdxSanitizeSchema } from '@/lib/mdx/sanitize-schema';
import {
  dissectSearchQuery,
  matchRepoWithSmartQuery,
  calculateSourceTypeCounts,
} from '@/lib/search/smart-repo-search';
import type { DisplayRepo } from '@/lib/home-data';
import { extractContextSnippet, resolveDocTitle } from '@/lib/search/snippet';
import { rerankChunkResults, buildLocatorSnippet } from '@/lib/mcp/doc-search';
import {
  parseExplainCodePayload,
  serializeExplainCodePayload,
  buildExplainCodeSearchQuery,
  extractCodeExplainContext,
} from '@/lib/code-viewport/explain-context';
import { wrapCodeAsMdx } from '@/engine/code-to-mdx';

export const defaultExt = '.json';

function resolvePlugin(ns: Record<string, unknown>, named: string): unknown {
  return ns?.[named] ?? ns?.default ?? ns;
}

const remarkParse = resolvePlugin(remarkParseNs as unknown as Record<string, unknown>, 'remarkParse');
const remarkStringify = resolvePlugin(remarkStringifyNs as unknown as Record<string, unknown>, 'remarkStringify');
const remarkMdx = resolvePlugin(remarkMdxNs as unknown as Record<string, unknown>, 'remarkMdx');

async function runRemarkFile(source: string, plugins: Array<() => unknown>) {
  const processor = unified();
  processor.use(remarkParse as Parameters<typeof processor.use>[0]);
  processor.use(remarkMdx as Parameters<typeof processor.use>[0]);
  for (const p of plugins) {
    processor.use(p as Parameters<typeof processor.use>[0]);
  }
  processor.use(remarkStringify as Parameters<typeof processor.use>[0]);
  return processor.process(source);
}

async function runRemark(source: string, plugins: Array<() => unknown>): Promise<string> {
  return String(await runRemarkFile(source, plugins));
}

function handleOutlinePlanNormalizer(payload: Record<string, unknown>) {
  const planPurpose = lookupLlmPurpose('outline_plan_v1')!;
  const mapPurpose = lookupLlmPurpose('outline_map_v1')!;

  const planPurposeCases = (payload.planPurposeCases as Array<{ name: string; raw: Record<string, unknown> }>).map(
    (c) => {
      const raw = { ...c.raw };
      if (raw._repeatSummary && Array.isArray(raw.chapters)) {
        raw.chapters = (raw.chapters as Array<Record<string, unknown>>).map((ch) =>
          ch.summaryRepeat ? { ...ch, summary: 'A'.repeat(Number(ch.summaryRepeat)) } : ch,
        );
      }
      if (raw._generateChapters) {
        const count = Number(raw._generateChapters);
        raw.chapters = Array.from({ length: count }, (_, i) => ({
          moduleTitle: `模块 ${Math.floor(i / 5) + 1}: 主题`,
          name: `第 ${i + 1} 章: 章节内容`,
          summary: `摘要 ${i + 1}`,
          targetPaths: ['src'],
          phase: '进阶',
        }));
      }
      const normalized = planPurpose.normalizeOutput!(raw);
      const parsed = planPurpose.schema!.safeParse(normalized);
      return {
        name: c.name,
        success: parsed.success,
        data: parsed.success ? parsed.data : null,
      };
    },
  );

  const cleanChapterNames = (payload.cleanChapterNames as string[]).map((raw) => ({
    input: raw,
    cleaned: cleanChapterName(raw),
  }));

  const mapPurposeCases = (payload.mapPurposeCases as Array<{ name: string; raw: Record<string, unknown> }>).map(
    (c) => ({
      name: c.name,
      normalized: mapPurpose.normalizeOutput!(c.raw),
    }),
  );

  const normalizeOutlinePlanCases = (
    payload.normalizeOutlinePlanCases as Array<{ name: string; raw: Record<string, unknown> }>
  ).map((c) => ({
    name: c.name,
    normalized: normalizeOutlinePlan(c.raw),
  }));

  return {
    planPurposeCases,
    cleanChapterNames,
    mapPurposeCases,
    normalizeOutlinePlanCases,
  };
}

async function handlePrepareMdxAndSanitizers(payload: Record<string, unknown>) {
  const voidTagCases = (payload.normalizeVoidTags as Array<{ name: string; input: string }>).map((c) => ({
    name: c.name,
    output: normalizeVoidTags(c.input),
  }));

  const prepareCases = (payload.prepareMdxSource as Array<{ name: string; input: string }>).map((c) => ({
    name: c.name,
    output: prepareMdxSource(c.input),
  }));

  const normalizeDeepDiveCases = (payload.normalizeDeepDiveBlocks as Array<{ name: string; input: string }>).map(
    (c) => {
      const first = normalizeDeepDiveBlocks(c.input);
      const second = normalizeDeepDiveBlocks(first);
      return { name: c.name, output: first, idempotent: first === second };
    },
  );

  const stripDeepDiveCases = (payload.stripDeepDiveBlocks as Array<{ name: string; input: string }>).map((c) => ({
    name: c.name,
    output: stripDeepDiveBlocks(c.input),
  }));

  const scanFallbackTocCases = (payload.scanFallbackTocAndDeepDives as Array<{ name: string; input: string }>).map(
    (c) => ({
      name: c.name,
      result: scanFallbackTocAndDeepDives(c.input),
    }),
  );

  const deepDiveHygieneCases = await Promise.all(
    (payload.remarkDeepDiveHygiene as Array<{ name: string; source: string }>).map(async (c) => {
      const file = await runRemarkFile(c.source, [remarkDeepDiveHygiene as unknown as () => unknown]);
      return {
        name: c.name,
        output: String(file),
        deepDiveCount: (file.data as Record<string, unknown>).deepDiveCount ?? 0,
      };
    }),
  );

  const pluginMap: Record<string, () => unknown> = {
    remarkStripEsm: remarkStripEsm as unknown as () => unknown,
    remarkTagNormalizer: remarkTagNormalizer as unknown as () => unknown,
    remarkSafeBraces: remarkSafeBraces as unknown as () => unknown,
  };

  const remarkCases = await Promise.all(
    (payload.remarkPlugins as Array<{ name: string; plugin: string; source: string }>).map(async (c) => ({
      name: c.name,
      output: await runRemark(c.source, [pluginMap[c.plugin]]),
    })),
  );

  const safeBracesAst = (payload.safeBracesAst as Array<{ name: string; value: string }>).map((c) => {
    const node = { type: 'mdxTextExpression', value: c.value };
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [node] }] };
    (remarkSafeBraces as unknown as () => (t: unknown) => void)()(tree);
    return { name: c.name, node };
  });

  const stripStyleHtml = (() => {
    const tree = h('div', { style: 'color:red', className: ['keep'] }, [h('span', 'text')]);
    (rehypeStripStyle as unknown as () => (t: unknown) => void)()(tree);
    return toHtml(tree as Parameters<typeof toHtml>[0]);
  })();

  const sanitizeSchemaChecks = {
    extraTagsPresent: ['figure', 'figcaption', 'details', 'summary', 'kbd', 'mark', 'iframe'].every((t) =>
      mdxSanitizeSchema.tagNames?.includes(t),
    ),
    defaultTagsPreserved: ['table', 'thead', 'tbody', 'tr', 'td', 'img', 'code', 'pre', 'blockquote'].every(
      (t) => mdxSanitizeSchema.tagNames?.includes(t),
    ),
    tagCountGreaterThanDefault:
      (mdxSanitizeSchema.tagNames?.length ?? 0) > (defaultSchema.tagNames?.length ?? 0),
    wildcardAttrs: (mdxSanitizeSchema.attributes as Record<string, unknown>)['*'],
    aAttrs: (mdxSanitizeSchema.attributes as Record<string, unknown>)['a'],
    srcProtocols: (mdxSanitizeSchema.protocols as Record<string, unknown>)?.src,
    inputAttrs: (mdxSanitizeSchema.attributes as Record<string, unknown>)['input'],
    codeAttrs: (mdxSanitizeSchema.attributes as Record<string, unknown>)['code'],
  };

  return {
    voidTagCases,
    prepareCases,
    normalizeDeepDiveCases,
    stripDeepDiveCases,
    scanFallbackTocCases,
    deepDiveHygieneCases,
    remarkCases,
    safeBracesAst,
    stripStyleHtml,
    sanitizeSchemaChecks,
  };
}

function handleSearchAndSnippetPure(payload: Record<string, unknown>) {
  const repos = payload.repos as DisplayRepo[];
  const dissectCases = (payload.dissectQueries as string[]).map((q) => ({
    query: q,
    result: dissectSearchQuery(q),
  }));

  const smartMatchCases = (
    payload.smartMatchCases as Array<{
      name: string;
      repoOverride?: DisplayRepo;
      query: string;
      sourceType?: 'all' | 'github' | 'webdoc';
      category?: string;
    }>
  ).map((c) => {
    if (c.repoOverride) {
      return {
        name: c.name,
        matchedIds: matchRepoWithSmartQuery(
          c.repoOverride,
          c.query,
          c.sourceType,
          c.category,
        ),
      };
    }
    return {
      name: c.name,
      matchedIds: repos
        .filter((r) => matchRepoWithSmartQuery(r, c.query, c.sourceType, c.category))
        .map((r) => r.id),
    };
  });

  const sourceTypeCounts = calculateSourceTypeCounts(repos);

  const snippetCases = (
    payload.snippetCases as Array<{ name: string; text: string; query: string; maxLen?: number; repeatA?: number }>
  ).map((c) => {
    const text = c.repeatA ? `${'A'.repeat(c.repeatA)}${c.text}${'B'.repeat(c.repeatA)}` : c.text;
    return {
      name: c.name,
      snippet: extractContextSnippet(text, c.query, c.maxLen),
    };
  });

  const titleCases = (
    payload.titleCases as Array<{ name: string; title?: string | null; path?: string | null; content?: string | null }>
  ).map((c) => ({
    name: c.name,
    resolved: resolveDocTitle(c.title, c.path, c.content),
  }));

  const rerankCases = (
    payload.rerankCases as Array<{ name: string; chunks: Array<Record<string, unknown>>; query: string }>
  ).map((c) => ({
    name: c.name,
    rankedPaths: rerankChunkResults(c.chunks as never, c.query).map((r) => r.path),
  }));

  const locatorSnippetCases = (
    payload.locatorSnippetCases as Array<{ name: string; content: string; repeatPad?: number; keywords: string[] }>
  ).map((c) => {
    const content = c.repeatPad ? `${'x'.repeat(c.repeatPad)}${c.content}${'y'.repeat(c.repeatPad)}` : c.content;
    return {
      name: c.name,
      snippet: buildLocatorSnippet(content, c.keywords),
    };
  });

  return {
    dissectCases,
    smartMatchCases,
    sourceTypeCounts,
    snippetCases,
    titleCases,
    rerankCases,
    locatorSnippetCases,
  };
}

function handleCodeViewportAndExplain(payload: Record<string, unknown>) {
  const explainRoundTrip = (() => {
    const input = payload.explainRoundTrip as Parameters<typeof serializeExplainCodePayload>[0];
    const serialized = serializeExplainCodePayload(input);
    return { serialized, parsed: parseExplainCodePayload(serialized) };
  })();

  const invalidPayloads = (payload.invalidExplainPayloads as string[]).map((raw) => ({
    raw,
    parsed: parseExplainCodePayload(raw),
  }));

  const searchQuery = buildExplainCodeSearchQuery(
    payload.searchQueryInput as Parameters<typeof buildExplainCodeSearchQuery>[0],
  );

  const oversizedContext = (() => {
    const cfg = payload.oversizedContext as { totalLines: number; language: string; filePath: string };
    const lines = Array.from({ length: cfg.totalLines }, (_, i) => `line_${i + 1} = ${i + 1}`);
    const ctx = extractCodeExplainContext({
      element: null,
      code: lines.join('\n'),
      language: cfg.language,
      filePath: cfg.filePath,
      lineCount: cfg.totalLines,
    });
    return {
      filePath: ctx.filePath,
      language: ctx.language,
      lineCount: ctx.lineCount,
      hasLine1: ctx.code.includes('line_1 = 1'),
      hasTruncatedMarker: ctx.code.includes(`truncated (${cfg.totalLines} total lines)`),
      codeLength: ctx.code.length,
    };
  })();

  const wrapCases = (payload.wrapCodeCases as Array<{ name: string; filePath: string; code: string }>).map(
    (c) => ({
      name: c.name,
      mdx: wrapCodeAsMdx(c.filePath, c.code),
    }),
  );

  return {
    explainRoundTrip,
    invalidPayloads,
    searchQuery,
    oversizedContext,
    wrapCases,
  };
}

export async function run(input: string): Promise<string> {
  const payload = JSON.parse(input) as { op: string } & Record<string, unknown>;
  let result: unknown;
  switch (payload.op) {
    case 'outline-plan-normalizer':
      result = handleOutlinePlanNormalizer(payload);
      break;
    case 'prepare-mdx-and-sanitizers':
      result = await handlePrepareMdxAndSanitizers(payload);
      break;
    case 'search-and-snippet-pure':
      result = handleSearchAndSnippetPure(payload);
      break;
    case 'code-viewport-and-explain':
      result = handleCodeViewportAndExplain(payload);
      break;
    default:
      throw new Error(`Unknown text-transforms op: ${payload.op}`);
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

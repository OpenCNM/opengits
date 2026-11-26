/**
 * Golden Diff runner for deterministic formatters, anchors, Mermaid pipelines,
 * and course-map / cross-repo formatters.
 */
import {
  buildSectionAddress,
  parseSectionAddress,
  buildCleanSectionAddress,
} from '@/lib/mcp/section-address';
import {
  parseLineAnchor,
  formatLineAnchor,
  isLineInRange,
  parseCodeAnchor,
  formatCodeAnchor,
  isCodeAnchorFileMatch,
} from '@/lib/code-viewport/line-anchor';
import {
  buildModuleArchitectureMermaidSkeleton,
  type CognitiveMetaForSkeleton,
  type GoldenSymbolForSkeleton,
} from '@/lib/mermaid/architecture-skeleton';
import { ensureQuotedMermaidLabels, sanitizeMermaid } from '@/lib/mermaid/resilience';
import { parseMermaidToGraph, parseNodeDef } from '@/lib/mermaid/mermaidParser';
import { stripMermaidDangerousHtml } from '@/lib/mermaid/xss-guard';
import { formatCourseMap } from '@/lib/mcp/course-map';
import {
  extractKeywords,
  formatCrossRepoConceptSearch,
  formatRecommendTutorial,
  formatSkillCoverage,
  type CrossRepoConceptHit,
  type RepoCoverageScore,
  type SkillCoverageHit,
} from '@/lib/mcp/cross-repo-tools';
import {
  formatCompactNumber,
  formatProgressPercent,
  formatCompactTokens,
  formatEditionRelativeTime,
  formatWordCount,
  formatChapterCount,
  formatRelativeTime,
} from '@/lib/format';

export const defaultExt = '.json';

function withPinnedNow<T>(nowIso: string | undefined, fn: () => T): T {
  if (!nowIso) return fn();
  const fixedMs = new Date(nowIso).getTime();
  const origNow = Date.now;
  Date.now = () => fixedMs;
  try {
    return fn();
  } finally {
    Date.now = origNow;
  }
}

function handleSectionAddress(payload: Record<string, unknown>) {
  const roundTrips = (
    payload.roundTrips as Array<{ docPath: string; headingPath: string; parseInput?: string }>
  ).map((c) => {
    const built = buildSectionAddress(c.docPath, c.headingPath);
    const parsed = parseSectionAddress(c.parseInput ?? built);
    return { docPath: c.docPath, headingPath: c.headingPath, built, parsed };
  });

  const cleanAddresses = (payload.cleanAddresses as Array<{ docPath: string; headingPath: string }>).map(
    (c) => ({
      docPath: c.docPath,
      headingPath: c.headingPath,
      clean: buildCleanSectionAddress(c.docPath, c.headingPath),
    }),
  );

  return { roundTrips, cleanAddresses };
}

function handleCodeAnchor(payload: Record<string, unknown>) {
  const lineAnchors = (payload.parseLineAnchor as Array<string | null>).map((raw) => ({
    input: raw,
    parsed: parseLineAnchor(raw),
  }));

  const formattedLineAnchors = (
    payload.formatLineAnchor as Array<{ startLine: number; endLine?: number }>
  ).map((c) => ({
    ...c,
    formatted: formatLineAnchor(c.startLine, c.endLine),
  }));

  const rangeChecks = (
    payload.isLineInRange as Array<{ line: number; range: { startLine: number; endLine: number } }>
  ).map((c) => ({
    ...c,
    inRange: isLineInRange(c.line, c.range),
  }));

  const codeAnchors = (payload.parseCodeAnchor as Array<string | null>).map((raw) => ({
    input: raw,
    parsed: parseCodeAnchor(raw),
  }));

  const formattedCodeAnchors = (
    payload.formatCodeAnchor as Array<{ filePath?: string; startLine: number; endLine?: number }>
  ).map((c) => ({
    ...c,
    formatted: formatCodeAnchor(c),
  }));

  const fileMatches = (
    (payload.isCodeAnchorFileMatch as Array<{ target?: string | null; block?: string | null }> | undefined) ?? []
  ).map((c) => ({
    target: c.target ?? null,
    block: c.block ?? null,
    match: isCodeAnchorFileMatch(
      c.target === '__undefined__' ? undefined : c.target,
      c.block === '__undefined__' ? undefined : c.block,
    ),
  }));

  return {
    lineAnchors,
    formattedLineAnchors,
    rangeChecks,
    codeAnchors,
    formattedCodeAnchors,
    fileMatches,
  };
}

function handleArchitectureSkeleton(payload: Record<string, unknown>): string {
  const cases = payload.cases as Array<{
    name: string;
    moduleTitle: string;
    cognitive: CognitiveMetaForSkeleton | null;
    goldenSymbols?: GoldenSymbolForSkeleton[] | null;
    options?: { includeExternal?: boolean };
  }>;

  return (
    cases
      .map(
        (c) =>
          `=== ${c.name} ===\n${buildModuleArchitectureMermaidSkeleton(
            c.moduleTitle,
            c.cognitive,
            c.goldenSymbols,
            c.options,
          )}`,
      )
      .join('\n\n') + '\n'
  );
}

function handleMermaidResilienceAndXss(payload: Record<string, unknown>) {
  const ensureQuoted = (payload.ensureQuotedMermaidLabels as Array<{ name: string; code: string | null }>).map(
    (c) => ({
      name: c.name,
      output: ensureQuotedMermaidLabels(c.code as string),
    }),
  );

  const sanitized = (payload.sanitizeMermaid as Array<{ name: string; raw: string }>).map((c) => ({
    name: c.name,
    output: sanitizeMermaid(c.raw),
  }));

  const xss = (payload.stripMermaidDangerousHtml as Array<{ name: string; raw: string }>).map((c) => ({
    name: c.name,
    output: stripMermaidDangerousHtml(c.raw),
  }));

  return { ensureQuoted, sanitized, xss };
}

function handleMermaidParser(payload: Record<string, unknown>) {
  const nodeDefs = (payload.parseNodeDef as Array<string>).map((raw) => ({
    input: raw,
    node: parseNodeDef(raw),
  }));

  const graphs = (payload.parseMermaidToGraph as Array<{ name: string; code: string }>).map((c) => ({
    name: c.name,
    graph: parseMermaidToGraph(c.code),
  }));

  return { nodeDefs, graphs };
}

function handleCourseMapAndCrossRepo(payload: Record<string, unknown>) {
  const courseMaps = (
    payload.courseMaps as Array<{
      name: string;
      repoProfile: Record<string, unknown>;
      navTree?: unknown[];
    }>
  ).map((c) => ({
    name: c.name,
    output: formatCourseMap(c.repoProfile, c.navTree as Parameters<typeof formatCourseMap>[1]),
  }));

  const keywords = (payload.extractKeywords as Array<string>).map((text) => ({
    input: text,
    keywords: extractKeywords(text),
  }));

  const crossRepoConcepts = (
    payload.crossRepoConcepts as Array<{
      name: string;
      query: string;
      hits: CrossRepoConceptHit[];
      globalConcepts: Array<[string, { canonicalName: string; aliases: string[] }]>;
    }>
  ).map((c) => ({
    name: c.name,
    output: formatCrossRepoConceptSearch(c.query, c.hits, new Map(c.globalConcepts)),
  }));

  const recommendTutorial = (
    payload.recommendTutorial as Array<{ query: string; ranked: RepoCoverageScore[] }>
  ).map((c) => ({
    query: c.query,
    output: formatRecommendTutorial(c.query, c.ranked),
  }));

  const skillCoverage = (
    payload.skillCoverage as Array<{ skill: string; hits: SkillCoverageHit[] }>
  ).map((c) => ({
    skill: c.skill,
    output: formatSkillCoverage(c.skill, c.hits),
  }));

  return {
    courseMaps,
    keywords,
    crossRepoConcepts,
    recommendTutorial,
    skillCoverage,
  };
}

function handleFormatNumbersTokensAndTime(payload: Record<string, unknown>) {
  const nowIso = payload.now as string;
  const nowMs = new Date(nowIso).getTime();

  const compactNumbers = (payload.compactNumbers as Array<number | string>).map((v) => {
    const num = v === 'NaN' ? Number.NaN : v === 'Infinity' ? Number.POSITIVE_INFINITY : Number(v);
    return { input: v, output: formatCompactNumber(num) };
  });

  const progressPercent = (payload.progressPercent as Array<{ done: number | string; total: number }>).map(
    (c) => ({
      done: c.done,
      total: c.total,
      output: formatProgressPercent(c.done === 'NaN' ? Number.NaN : Number(c.done), c.total),
    }),
  );

  const compactTokens = (payload.compactTokens as Array<number | string | null | undefined>).map((v) => {
    const arg = v === 'NaN' ? Number.NaN : v === '__undefined__' ? undefined : (v as number | null);
    return { input: v ?? null, output: formatCompactTokens(arg) };
  });

  const editionRelativeTime = withPinnedNow(nowIso, () =>
    (
      payload.editionRelativeTime as Array<{
        offsetMs?: number;
        raw?: string | null;
        locale?: 'en' | 'zh-CN';
      }>
    ).map((c) => {
      const input =
        typeof c.offsetMs === 'number'
          ? new Date(nowMs + c.offsetMs)
          : c.raw === '__undefined__'
            ? undefined
            : c.raw;
      return {
        ...c,
        output: formatEditionRelativeTime(input, c.locale),
      };
    }),
  );

  const relativeTime = withPinnedNow(nowIso, () =>
    (
      payload.relativeTime as Array<{
        offsetMs?: number;
        iso?: string | null;
      }>
    ).map((c) => {
      const input =
        typeof c.offsetMs === 'number'
          ? new Date(nowMs + c.offsetMs)
          : c.iso === '__undefined__'
            ? undefined
            : c.iso === '__invalid_date__'
              ? new Date('invalid')
              : c.iso;
      return {
        ...c,
        output: formatRelativeTime(input),
      };
    }),
  );

  const wordCounts = (
    payload.wordCounts as Array<{ count: number | string | null; locale?: 'en' | 'zh-CN' }>
  ).map((c) => {
    const count =
      c.count === 'NaN'
        ? Number.NaN
        : c.count === '__undefined__'
          ? undefined
          : (c.count as number | null);
    return {
      ...c,
      output: formatWordCount(count, c.locale),
    };
  });

  const chapterCounts = (
    payload.chapterCounts as Array<{ count: number | null; locale?: 'en' | 'zh-CN' }>
  ).map((c) => ({
    ...c,
    output: formatChapterCount(c.count === ('__undefined__' as unknown) ? undefined : c.count, c.locale),
  }));

  return {
    compactNumbers,
    progressPercent,
    compactTokens,
    editionRelativeTime,
    relativeTime,
    wordCounts,
    chapterCounts,
  };
}

export async function run(input: string): Promise<string> {
  const payload = JSON.parse(input) as { op: string } & Record<string, unknown>;
  switch (payload.op) {
    case 'section-address':
      return `${JSON.stringify(handleSectionAddress(payload), null, 2)}\n`;
    case 'code-anchor':
      return `${JSON.stringify(handleCodeAnchor(payload), null, 2)}\n`;
    case 'architecture-skeleton':
      return handleArchitectureSkeleton(payload);
    case 'mermaid-resilience-and-xss':
      return `${JSON.stringify(handleMermaidResilienceAndXss(payload), null, 2)}\n`;
    case 'mermaid-parser':
      return `${JSON.stringify(handleMermaidParser(payload), null, 2)}\n`;
    case 'course-map-and-cross-repo':
      return `${JSON.stringify(handleCourseMapAndCrossRepo(payload), null, 2)}\n`;
    case 'format-numbers-tokens-and-time':
      return `${JSON.stringify(handleFormatNumbersTokensAndTime(payload), null, 2)}\n`;
    default:
      throw new Error(`Unknown format-and-anchor op: ${payload.op}`);
  }
}

import { DEFAULT_TOKEN_BUDGET } from '@/lib/constants';
import { ignoreBestEffort } from '@/lib/best-effort';
import { prisma } from '@/lib/db';
import { buildCleanSectionAddress } from '@/lib/mcp/section-address';
import {
  getConceptDependencies,
  formatDependencyHintText,
  CONCEPT_DEPENDENCY_HINT_HEADER,
  getConceptGrounding,
} from '@/lib/mcp/concept-graph';
import { executeSidecarSearch } from '@/engine/search-driver';

export interface ChunkSearchResult {
  id: string;
  heading: string | null;
  headingPath: string | null;
  content: string;
  snippet?: string;
  title: string | null;
  path: string;
  similarity: number;
  matchCount?: number;
  ftsRank?: number;
  editionLabel?: string;
}

export interface LocatorHit {
  id: string;
  path: string;
  title: string | null;
  heading: string | null;
  headingPath: string | null;
  snippet: string;
  similarity: number;
  editionLabel?: string;
}

export interface SearchRepositoryDocsOptions {
  includeContent?: boolean;
}

// Fail-closed on backend outage so infrastructure failures never pollute BLIND_SPOT metrics.
export class DocSearchUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(`Search backend unavailable: ${(cause as Error | undefined)?.message ?? 'sidecar unreachable'}`);
    this.name = 'DocSearchUnavailableError';
  }
}

// Use query (with expansions) for FTS and rawQuery for ILIKE fallback so synonym/CJK punctuation expansions do not break substring matching.
export async function searchRepositoryDocs(
  repositoryId: string,
  query: string,
  limit: number = 5,
  version?: string,
  contentTypes?: string[],
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
  locale?: string,
  rawQuery?: string,
  userId?: string | null,
  options?: SearchRepositoryDocsOptions
): Promise<ChunkSearchResult[]> {
  try {
    if (!repositoryId || typeof repositoryId !== 'string' || !query || typeof query !== 'string' || !query.trim()) {
      return [];
    }
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 5)));
    const includeContent = options?.includeContent ?? true;
    const hits = await executeSidecarSearch({
      repositoryId,
      query,
      rawQuery,
      limit: safeLimit,
      userId,
      locale,
      version,
      contentTypes: contentTypes as string[] | undefined,
      includeContent,
      tokenBudget,
    });

    return hits.map((h) => ({
      id: h.chunkId,
      heading: h.heading ?? null,
      headingPath: h.headingPath ?? null,
      content: h.content ?? '',
      snippet: h.snippet,
      title: h.title || null,
      path: h.path,
      similarity: h.similarity,
      matchCount: h.matchCount,
      ftsRank: h.ftsRank,
      editionLabel: h.editionLabel,
    }));
  } catch (error) {
    console.error('Error in searchRepositoryDocs:', error);
    throw new DocSearchUnavailableError(error);
  }
}

export interface GlobalDocHit {
  chunkId: string;
  heading: string | null;
  headingPath: string | null;
  content: string;
  title: string | null;
  path: string;
  owner: string;
  repo: string;
  similarity: number;
}

export async function searchGlobalDocs(
  query: string,
  limit: number = 15,
  locale?: string,
  userId?: string | null
): Promise<GlobalDocHit[]> {
  try {
    if (!query || typeof query !== 'string' || !query.trim()) return [];
    const safeLimit = Math.max(1, Math.min(60, Math.floor(Number(limit) || 15)));

    const hits = await executeSidecarSearch({
      query,
      limit: safeLimit,
      locale,
      userId,
      isGlobal: true,
      includeContent: true,
    });

    return hits.map((h) => ({
      chunkId: h.chunkId,
      heading: h.heading ?? null,
      headingPath: h.headingPath ?? null,
      content: h.content ?? '',
      title: h.title || null,
      path: h.path,
      owner: h.owner ?? '',
      repo: h.repo ?? '',
      similarity: h.similarity,
    }));
  } catch (error) {
    console.error('Error in searchGlobalDocs:', error);
    throw new DocSearchUnavailableError(error);
  }
}

const LOCATOR_SNIPPET_RADIUS = 120;
const LOCATOR_CANDIDATE_LIMIT = 30;

function locatorKeywords(rawQuery: string): string[] {
  if (!rawQuery || typeof rawQuery !== 'string') return [];
  // CJK script range synced with Go mdpat.CJKScriptClass.
  const tokens = rawQuery.match(/[\w.-]+|[\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]+/g) || [];
  const keywords: string[] = [];
  for (const token of tokens) {
    if (/[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]/.test(token) && !keywords.includes(token)) {
      keywords.push(token);
    }
  }
  return keywords;
}

export function buildLocatorSnippet(content: string, keywords: string[]): string {
  if (!content) return '';
  const lowered = content.toLowerCase();
  let bestIndex = -1;
  let bestLength = 0;
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    const idx = lowered.indexOf(kwLower);
    if (idx >= 0 && kw.length > bestLength) {
      bestLength = kw.length;
      bestIndex = idx;
    }
  }
  if (bestIndex < 0) bestIndex = 0;
  const start = Math.max(0, bestIndex - LOCATOR_SNIPPET_RADIUS);
  const end = Math.min(content.length, bestIndex + Math.max(bestLength, 1) + LOCATOR_SNIPPET_RADIUS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function locatorScore(r: ChunkSearchResult, keywords: string[], rawQuery: string): number {
  let score = Number.isFinite(r.similarity) ? r.similarity : 0.5;
  const heading = (r.heading || '').toLowerCase();
  const title = (r.title || '').toLowerCase();
  const content = (r.snippet || r.content || '').toLowerCase();
  const raw = (rawQuery || '').toLowerCase().trim();

  if (raw && (heading.includes(raw) || title.includes(raw))) {
    score += 0.3;
  } else if (raw && content.includes(raw)) {
    score += 0.15;
  }
  const headingMatches = keywords.filter(
    (kw) => kw && (heading.includes(kw.toLowerCase()) || title.includes(kw.toLowerCase()))
  );
  if (headingMatches.length > 0) {
    score += 0.1 * Math.min(2, headingMatches.length);
  }
  return score;
}

// Re-rank title/heading hits ahead of high-frequency summary chunks.
export function rerankChunkResults(results: ChunkSearchResult[], rawQuery: string): ChunkSearchResult[] {
  if (results.length <= 1 || !rawQuery || !rawQuery.trim()) return results;
  const keywords = locatorKeywords(rawQuery);
  if (keywords.length === 0) return results;
  return results
    .map((r) => ({ r, score: locatorScore(r, keywords, rawQuery) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.r.path.localeCompare(b.r.path);
    })
    .map(({ r }) => r);
}

export async function locateRepositorySections(
  repositoryId: string,
  query: string,
  limit: number = 15,
  version?: string,
  contentTypes?: string[],
  locale?: string,
  rawQuery?: string,
  userId?: string | null
): Promise<LocatorHit[]> {
  try {
    if (!repositoryId || typeof repositoryId !== 'string' || !query || typeof query !== 'string' || !query.trim()) {
      return [];
    }
    const safeLimit = Math.max(1, Math.min(LOCATOR_CANDIDATE_LIMIT, Math.floor(Number(limit) || 15)));
    const fallbackQuery = rawQuery ?? query;

    const candidates = await searchRepositoryDocs(
      repositoryId,
      query,
      LOCATOR_CANDIDATE_LIMIT,
      version,
      contentTypes,
      1_000_000,
      locale,
      fallbackQuery,
      userId,
      { includeContent: false }
    );
    if (candidates.length === 0) return [];

    const keywords = locatorKeywords(fallbackQuery);
    const fallbackKeywords = keywords.length > 0 ? keywords : [fallbackQuery];
    const seen = new Set<string>();
    const hits: LocatorHit[] = [];

    const scored = candidates
      .map((hit) => ({ hit, score: locatorScore(hit, keywords, fallbackQuery) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.hit.path.localeCompare(b.hit.path);
      });

    for (const { hit, score } of scored) {
      const dedupeKey = hit.id || `${hit.path}::${hit.headingPath || hit.heading || ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      hits.push({
        id: hit.id,
        path: hit.path,
        title: hit.title,
        heading: hit.heading,
        headingPath: hit.headingPath,
        snippet: buildLocatorSnippet(hit.snippet || hit.content, fallbackKeywords),
        similarity: Math.min(1, Math.max(0, score)),
        editionLabel: hit.editionLabel,
      });
      if (hits.length >= safeLimit) break;
    }
    return hits;
  } catch (error) {
    if (error instanceof DocSearchUnavailableError) throw error;
    console.error('Error in locateRepositorySections:', error);
    return [];
  }
}

export const CONCEPT_MENTOR_CARD_HEADER = '🧠 导师设计思考与原理卡片 (Author Reflections & Principles)';

export async function matchConceptNode(repositoryId: string, query: string) {
  const rawTokens = query.match(/[\w.-]+|[\u4e00-\u9fa5]+/g) || [];
  const keywords = rawTokens.filter((k) => k.length >= 2);
  if (keywords.length === 0) return null;

  const nameConditions = keywords.flatMap((kw) => [
    { conceptName: { contains: kw, mode: 'insensitive' as const } },
    { canonicalName: { contains: kw, mode: 'insensitive' as const } },
  ]);
  const bodyConditions = keywords.flatMap((kw) => [
    { principlesText: { contains: kw, mode: 'insensitive' as const } },
    { authorReflections: { contains: kw, mode: 'insensitive' as const } },
    { summary: { contains: kw, mode: 'insensitive' as const } },
  ]);

  // Require all keywords in conceptName before falling back to any-keyword or CJK bigram matching.
  const nameAllNode = await prisma.tutorialConceptNode.findFirst({
    where: { repositoryId, AND: nameConditions },
    include: { document: { select: { path: true, title: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (nameAllNode) return nameAllNode;

  const nameNode = await prisma.tutorialConceptNode.findFirst({
    where: { repositoryId, OR: nameConditions },
    include: { document: { select: { path: true, title: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (nameNode) return nameNode;

  const bodyNode = await prisma.tutorialConceptNode.findFirst({
    where: { repositoryId, OR: bodyConditions },
    include: { document: { select: { path: true, title: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (bodyNode) return bodyNode;

  const cjkBigrams = new Set<string>();
  for (const kw of keywords) {
    const cjk = kw.replace(/[^\u4e00-\u9fa5]/g, '');
    if (cjk.length >= 2) {
      for (let i = 0; i + 1 < cjk.length; i++) cjkBigrams.add(cjk.slice(i, i + 2));
    }
  }
  if (cjkBigrams.size > 0) {
    const grams = Array.from(cjkBigrams).slice(0, 8);
    const gramCandidates = await prisma.tutorialConceptNode.findMany({
      where: {
        repositoryId,
        OR: grams.map((g) => ({ conceptName: { contains: g } })),
      },
      select: { id: true, conceptName: true, updatedAt: true },
      take: 40,
    });
    if (gramCandidates.length > 0) {
      let best: typeof gramCandidates[number] | null = null;
      let bestCoverage = 0;
      for (const c of gramCandidates) {
        const coverage = grams.filter((g) => c.conceptName.includes(g)).length;
        if (coverage > bestCoverage || (coverage === bestCoverage && (!best || c.updatedAt > best.updatedAt))) {
          best = c;
          bestCoverage = coverage;
        }
      }
      if (best && bestCoverage >= 2) {
        return prisma.tutorialConceptNode.findUnique({
          where: { id: best.id },
          include: { document: { select: { path: true, title: true } } },
        });
      }
    }
  }

  return null;
}

type MatchedConcept = Awaited<ReturnType<typeof matchConceptNode>>;

export async function injectConceptMentorCard(
  repositoryId: string,
  query: string,
  baseText: string,
  resolvedConcept?: MatchedConcept
): Promise<string> {
  try {
    if (!repositoryId || !query || !query.trim()) return baseText;

    const conceptNode = resolvedConcept !== undefined ? resolvedConcept : await matchConceptNode(repositoryId, query);
    if (!conceptNode) return baseText;

    let card = `\n\n${CONCEPT_MENTOR_CARD_HEADER}\n`;
    card += `- **核心概念**: ${conceptNode.conceptName} (${conceptNode.category})\n`;

    const docPath = conceptNode.document?.path;
    if (docPath) {
      card += `- **来源**: ${docPath}`;
      if (conceptNode.headingPath) {
        card += ` [Address: ${buildCleanSectionAddress(docPath, conceptNode.headingPath)}]`;
      }
      card += `\n`;
    }

    if (conceptNode.authorReflections) {
      card += `- **作者思考与 Trade-off 权衡**:\n  > ${conceptNode.authorReflections.replace(/\n/g, '\n  > ')}\n`;
    }

    if (conceptNode.sopSteps && conceptNode.sopSteps.length > 0) {
      card += `- **核心 SOP 开发步骤**:\n`;
      conceptNode.sopSteps.forEach((step, idx) => {
        card += `  ${idx + 1}. ${step}\n`;
      });
    }

    if (conceptNode.summary) {
      card += `- **设计摘要**: ${conceptNode.summary}\n`;
    }

    const grounding = await getConceptGrounding(repositoryId, conceptNode.conceptName, docPath).catch(() => { ignoreBestEffort(); return null; });
    if (grounding) {
      if (grounding.goldenSymbols && grounding.goldenSymbols.length > 0) {
        card += `- **核心代码符号 (AST Golden Symbols)**:\n`;
        for (const sym of grounding.goldenSymbols.slice(0, 4)) {
          card += `  - \`${sym.name}\` (${sym.kind}) in \`${sym.file}\` [PR: ${sym.score.toFixed(2)}]\n`;
        }
      }
      if (grounding.backboneFiles && grounding.backboneFiles.length > 0) {
        card += `- **主干实现文件**:\n`;
        for (const f of grounding.backboneFiles.slice(0, 3)) {
          card += `  - \`${f.path}\` (${f.role})\n`;
        }
      }
    }

    card += `\n(Use explore_concept (concept: "${conceptNode.conceptName}", action: "details") for the full concept package, or read with the Address above to read the source section.)`;

    return `${baseText}${card}`;
  } catch (error) {
    console.error('Error injecting concept mentor card:', error);
    return baseText;
  }
}

export async function injectConceptDependencyHint(
  repositoryId: string,
  query: string,
  baseText: string,
  sourceLabel?: string,
  resolvedConcept?: MatchedConcept
): Promise<string> {
  try {
    if (!repositoryId || !query || !query.trim()) return baseText;
    const conceptNode = resolvedConcept !== undefined ? resolvedConcept : await matchConceptNode(repositoryId, query);
    if (!conceptNode) return baseText;
    const deps = await getConceptDependencies(repositoryId, conceptNode.id);
    if (deps.length === 0) return baseText;
    return `${baseText}${formatDependencyHintText(conceptNode.conceptName, deps, sourceLabel)}`;
  } catch (error) {
    console.error('Error injecting concept dependency hint:', error);
    return baseText;
  }
}

// Single matchConceptNode lookup shared by mentor card and dependency hint to halve queries during fan-out.
export async function injectConceptEnrichments(
  repositoryId: string,
  query: string,
  baseText: string,
  opts?: { sourceLabel?: string }
): Promise<string> {
  try {
    if (!repositoryId || !query || !query.trim()) return baseText;
    const conceptNode = await matchConceptNode(repositoryId, query);
    if (!conceptNode) return baseText;
    let text = await injectConceptMentorCard(repositoryId, query, baseText, conceptNode);
    text = await injectConceptDependencyHint(repositoryId, query, text, opts?.sourceLabel, conceptNode);
    return text;
  } catch (error) {
    console.error('Error injecting concept enrichments:', error);
    return baseText;
  }
}

import { DEFAULT_TOKEN_BUDGET } from '@/lib/constants';
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
  /** 关键词兜底路径的 gram 命中数（FTS 路径为 undefined）——降级判定的判别信号 */
  matchCount?: number;
  /** FTS 路径的 ts_rank 原始值（兜底路径为 undefined）——评测降级分布的判别信号 */
  ftsRank?: number;
  /** 归属讲法显示名（Repository 行 edition≠'' 时；结果归因 [讲法: xx] 消费） */
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
  /** 归属讲法显示名（讲法行才有值） */
  editionLabel?: string;
}

export interface SearchRepositoryDocsOptions {
  includeContent?: boolean;
}

/**
 * 检索后端（sidecar）不可用：fail-closed 显式上抛。
 * 区别于「真盲区」（查询无命中返回空数组）——基础设施故障必须以 ERROR 遥测
 * 与 isError 工具结果呈现，禁止伪装成空结果污染 BLIND_SPOT 指标（失效封闭高于伪弹性）。
 */
export class DocSearchUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(`Search backend unavailable: ${(cause as Error | undefined)?.message ?? 'sidecar unreachable'}`);
    this.name = 'DocSearchUnavailableError';
  }
}

/**
 * Perform FTS-first + pg_trgm search across chunks of a specific repository.
 * @param rawQuery 原始用户输入（未经查询扩展）。FTS 阶段使用 query（含扩展词，保留同义词召回）；
 *                 ILIKE 关键词兜底阶段使用 rawQuery，避免扩展词/全角标点污染子串匹配。
 *                 缺省时回退为 query，保证既有调用方兼容。
 * @param userId 真冻结过滤：仅检索"该用户的私有副本 + 共享文档"；缺省仅共享文档。
 */
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

// ---------------------------------------------------------------------------
// 跨仓全局 chunk 检索（/api/search Mode B 消费）：
// 与 searchRepositoryDocs 同一套 FTS + 子串兜底管线，去掉 repositoryId 定位、
// 增加 "Repository"."isPublic" 公开面谓词。输出携带 owner/repo 供结果映射。
// 全文不再进入 Node——snippet 直接取 chunk content（有界切片）。
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Locator mode: deterministic "where is it" retrieval.
// Returns compact section addresses + snippets instead of full chunk content.
// The client agent decides which sections to read via read_section.
// ---------------------------------------------------------------------------

const LOCATOR_SNIPPET_RADIUS = 120;
const LOCATOR_CANDIDATE_LIMIT = 30;

/**
 * Derives deterministic locator keywords from the raw user query.
 * Extracts alphanumeric and CJK terms, ignoring pure punctuation.
 */
function locatorKeywords(rawQuery: string): string[] {
  if (!rawQuery || typeof rawQuery !== 'string') return [];
  // CJK 宽字符类（汉 + 假名 + 谚文 + 扩展区），与 Go mcp/search_engine.mdpat.CJKScriptClass 锁步
  const tokens = rawQuery.match(/[\w.-]+|[\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]+/g) || [];
  const keywords: string[] = [];
  for (const token of tokens) {
    if (/[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]/.test(token) && !keywords.includes(token)) {
      keywords.push(token);
    }
  }
  return keywords;
}

/**
 * Builds a short deterministic snippet around the first (longest) keyword hit.
 */
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

/**
 * Locator re-ranking: boosts exact phrase hits and heading/title keyword hits
 * so overview-y chunks do not dominate (the high-frequency-term failure mode).
 */
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

/**
 * Full/summary 模式输出重排：query 关键词命中 heading/title 的 chunk 优先。
 * FTS ts_rank 会偏爱「全书小结」类高频词 chunk，重排保证最相关内容出现在输出前部
 * （Agent 上下文与 LLM 裁判预览均以输出前部为准）。与 locator 模式的 locatorScore 同哲学。
 */
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

/**
 * Locator-mode retrieval for MCP search tools.
 * Runs the existing deterministic search pipeline with a wider candidate set,
 * re-ranks in TS, dedupes by chunk id and returns compact hits.
 * userId 透传给底层检索（真冻结：私有讲法文档仅归属者可搜）。
 */
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

/**
 * 导师卡片头部常量（eval 断言 hasMentorCardInjected 与其保持一致，禁止内联）
 */
export const CONCEPT_MENTOR_CARD_HEADER = '🧠 导师设计思考与原理卡片 (Author Reflections & Principles)';

/**
 * 概念匹配（共享）：按 query 关键词命中概念节点。
 * 匹配优先级：conceptName 关键词命中（最精准）→ principlesText/authorReflections/summary 关键词命中。
 * 供导师卡片与依赖提示注入共用，保证两处命中同一概念。
 */
export async function matchConceptNode(repositoryId: string, query: string) {
  const rawTokens = query.match(/[\w.-]+|[\u4e00-\u9fa5]+/g) || [];
  const keywords = rawTokens.filter((k) => k.length >= 2);
  if (keywords.length === 0) return null;

  // 名称匹配维度：conceptName + 归并代表名（canonicalName）——查询「事件循环(下)」
  // 或「事件循环」都能命中其归并组的成员节点
  const nameConditions = keywords.flatMap((kw) => [
    { conceptName: { contains: kw, mode: 'insensitive' as const } },
    { canonicalName: { contains: kw, mode: 'insensitive' as const } },
  ]);
  const bodyConditions = keywords.flatMap((kw) => [
    { principlesText: { contains: kw, mode: 'insensitive' as const } },
    { authorReflections: { contains: kw, mode: 'insensitive' as const } },
    { summary: { contains: kw, mode: 'insensitive' as const } },
  ]);

  // 1a) conceptName 包含【全部】关键词（最精准：多词查询不再被单字命中带偏，
  //     如 "context window design" 不再误中只含 "design" 的概念）
  const nameAllNode = await prisma.tutorialConceptNode.findFirst({
    where: { repositoryId, AND: nameConditions },
    include: { document: { select: { path: true, title: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (nameAllNode) return nameAllNode;

  // 1b) 退到 conceptName 包含【任一】关键词（单字宽匹配，保留旧兜底语义）
  const nameNode = await prisma.tutorialConceptNode.findFirst({
    where: { repositoryId, OR: nameConditions },
    include: { document: { select: { path: true, title: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (nameNode) return nameNode;

  // 2) 退而求其次：概念正文/摘要关键词命中
  const bodyNode = await prisma.tutorialConceptNode.findFirst({
    where: { repositoryId, OR: bodyConditions },
    include: { document: { select: { path: true, title: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (bodyNode) return bodyNode;

  // 3) CJK 2-gram 兜底：长中文查询词（如"上下文设计"）与概念名（如"上下文：Agent 的眼睛"）
  //    无子串包含关系时，按概念名对查询 2-gram 的覆盖数选最接近概念（确定性匹配，无 LLM）
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

/**
 * 静默融合导师设计思考与原理卡片 (Author Reflections & Principles Mentor Card)
 * 图谱节点命中时，把作者思考、SOP 步骤与实战经验打包呈现在输出顶部。
 * 匹配优先级：conceptName 关键词命中（最精准）→ principlesText/authorReflections/summary 关键词命中。
 * 卡片携带「来源 + Address」溯源锚点，Agent 可按图索骥用 read_section 穿透精读原文。
 */
/** matchConceptNode 的返回类型别名（供注入器复用已解析概念，避免重复查询） */
type MatchedConcept = Awaited<ReturnType<typeof matchConceptNode>>;

export async function injectConceptMentorCard(
  repositoryId: string,
  query: string,
  baseText: string,
  resolvedConcept?: MatchedConcept
): Promise<string> {
  try {
    if (!repositoryId || !query || !query.trim()) return baseText;

    // 复用外层已解析的概念（resolvedConcept 非 undefined 时），避免每次注入都重复 matchConceptNode
    const conceptNode = resolvedConcept !== undefined ? resolvedConcept : await matchConceptNode(repositoryId, query);
    if (!conceptNode) return baseText;

    let card = `\n\n${CONCEPT_MENTOR_CARD_HEADER}\n`;
    card += `- **核心概念**: ${conceptNode.conceptName} (${conceptNode.category})\n`;

    // 溯源行：文档路径 + 归一化 Address（headingPath 存在时才给 Address；read_section 可直接消费）
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

    // 认知图谱与物理代码语义图（RSG）跨图穿透：挂载 AST 黄金符号与主干文件（为 Agent 提供确定性代码锚点）
    const grounding = await getConceptGrounding(repositoryId, conceptNode.conceptName, docPath).catch(() => null);
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

/**
 * 依赖提示注入：匹配概念后取其前置知识（prerequisite/successor 入边），
 * 在输出尾部追加「⚡ 依赖提示」。sourceLabel 用于 Hub fan-out 的 [Source: owner/repo] 归因。
 * 无概念命中 / 无前置边 / 异常时原样返回（静默，保持输出零变化）。
 */
export async function injectConceptDependencyHint(
  repositoryId: string,
  query: string,
  baseText: string,
  sourceLabel?: string,
  resolvedConcept?: MatchedConcept
): Promise<string> {
  try {
    if (!repositoryId || !query || !query.trim()) return baseText;
    // 复用外层已解析的概念，避免与 injectConceptMentorCard 重复 matchConceptNode（search 热路径）
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

/**
 * 概念增强一站式注入：单次 matchConceptNode 解析后合并「导师卡片 + 依赖提示」。
 * 避免两条独立注入各调一次 matchConceptNode 造成重复查询（每次最多 3 条 DB 查询 ×2），
 * 在 Hub fan-out 多仓场景下重复查询会倍增。无概念命中 / 异常时原样返回。
 */
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
    // 同一 conceptNode 复用给两个注入器，省去重复解析
    let text = await injectConceptMentorCard(repositoryId, query, baseText, conceptNode);
    text = await injectConceptDependencyHint(repositoryId, query, text, opts?.sourceLabel, conceptNode);
    return text;
  } catch (error) {
    console.error('Error injecting concept enrichments:', error);
    return baseText;
  }
}

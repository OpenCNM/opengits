import { prisma } from '@/lib/db';
import { buildCleanSectionAddress } from '@/lib/mcp/section-address';
import { resolveConceptNode, getConceptDependencies } from '@/lib/mcp/concept-graph';

// ─────────────────────────────────────────────────────────────
// 跨仓（书架）fan-out 工具库（Stage 0/1 跨仓能力共用）
//
// 书架 = user.savedRepositories。所有跨仓工具在此 fan-out：p-limit 并发遍历书架，
// 每仓复用单仓图谱查询（resolveConceptNode / 概念 FTS / 覆盖度打分），合并 + 按
// globalConceptId 跨仓归并（Stage 1）。无 embedding——纯 FTS + 名称归一化。
// ─────────────────────────────────────────────────────────────

const FANOUT_CONCURRENCY = 4;
/** 单次跨仓检索的最大仓库扫描上限（防大书架下数据库连接池被瞬间打满） */
const MAX_FANOUT_REPOS = 10;

/** 书架仓库最小标识（供 [Source: owner/repo] 归因） */
export interface BookshelfRepo {
  id: string;
  owner: string;
  repo: string;
}

/**
 * 书架 fan-out：p-limit 并发遍历 user.savedRepositories，对每仓执行 handler，收集结果。
 * handler 抛错时该仓结果为 null（不中断其它仓）。
 */
export async function forEachBookshelfRepo<T>(
  userId: string,
  handler: (repo: BookshelfRepo) => Promise<T>
): Promise<{ repo: BookshelfRepo; result: T | null }[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { savedRepos: { select: { repository: { select: { id: true, owner: true, repo: true } } } } },
  });
  const allRepos: BookshelfRepo[] = (user?.savedRepos || []).map((sr) => ({ id: sr.repository.id, owner: sr.repository.owner, repo: sr.repository.repo }));
  if (allRepos.length === 0) return [];

  const repos = allRepos.slice(0, MAX_FANOUT_REPOS);

  const pLimitModule = await import('p-limit');
  const pLimit = pLimitModule.default || pLimitModule;
  const rawLimit = (typeof pLimit === 'function') ? pLimit(FANOUT_CONCURRENCY) : null;
  const limit = <U>(fn: () => Promise<U>): Promise<U> => (rawLimit ? rawLimit(fn) : fn());

  return Promise.all(
    repos.map(async (repo) => {
      try {
        const result = await limit(() => handler(repo));
        return { repo, result };
      } catch (err) {
        console.warn(`[cross-repo] fan-out failed for ${repo.owner}/${repo.repo}:`, err);
        return { repo, result: null };
      }
    })
  );
}

/** 跨仓概念检索单条命中 */
export interface CrossRepoConceptHit {
  conceptId: string;
  conceptName: string;
  category: string;
  globalConceptId: string | null;
  repoId: string;
  repoOwner: string;
  repoName: string;
  docPath: string | null;
  address: string | null;
}

/**
 * 跨仓概念检索：fan-out 每仓 FTS over conceptName/principlesText/summary，合并命中。
 * 返回扁平命中列表（每条带 repo 归属 + globalConceptId），由 formatCrossRepoConceptSearch 分组渲染。
 */
export async function findConceptAcrossBookshelf(
  userId: string,
  query: string,
  opts: { perRepo?: number; maxTotal?: number } = {}
): Promise<CrossRepoConceptHit[]> {
  const perRepo = opts.perRepo ?? 5;
  const maxTotal = opts.maxTotal ?? 30;
  const trimmed = query.trim();
  if (!trimmed) return [];

  const results = await forEachBookshelfRepo(userId, async (r) => {
    const nodes = await prisma.tutorialConceptNode.findMany({
      where: {
        repositoryId: r.id,
        OR: [
          { conceptName: { contains: trimmed, mode: 'insensitive' } },
          { principlesText: { contains: trimmed, mode: 'insensitive' } },
          { summary: { contains: trimmed, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true, conceptName: true, category: true, globalConceptId: true,
        headingPath: true, document: { select: { path: true } },
      },
      take: perRepo,
    });
    return nodes.map<CrossRepoConceptHit>((n) => ({
      conceptId: n.id,
      conceptName: n.conceptName,
      category: n.category,
      globalConceptId: n.globalConceptId,
      repoId: r.id, repoOwner: r.owner, repoName: r.repo,
      docPath: n.document?.path || null,
      address: n.document?.path && n.headingPath
        ? buildCleanSectionAddress(n.document.path, n.headingPath)
        : null,
    }));
  });

  return results.flatMap((r) => r.result || []).slice(0, maxTotal);
}

/**
 * 渲染跨仓概念检索结果（纯函数）：按 globalConceptId 跨仓归并 + 未归并单仓列出。
 * grouped: 已对齐的全局概念（canonical 来自 globalConceptsById 查表）
 */
export function formatCrossRepoConceptSearch(
  query: string,
  hits: CrossRepoConceptHit[],
  globalConceptsById: Map<string, { canonicalName: string; aliases: string[] }>
): string {
  if (hits.length === 0) {
    return `🔍 跨仓概念检索 "${query}"：书架内无匹配概念。可尝试 list_resources 查看可用教程，或用 search(mode='concept') 做全文检索。`;
  }

  // 1. 按 globalConceptId 分组（有 id 的归并；无 id 的按 (repoId,conceptId) 单列）
  const grouped = new Map<string, CrossRepoConceptHit[]>();
  const ungrouped: CrossRepoConceptHit[] = [];
  for (const h of hits) {
    if (h.globalConceptId) {
      const arr = grouped.get(h.globalConceptId) || [];
      arr.push(h);
      grouped.set(h.globalConceptId, arr);
    } else {
      ungrouped.push(h);
    }
  }

  let text = `🔍 跨仓概念检索 "${query}"（${hits.length} 命中 / ${grouped.size} 全局概念 / ${ungrouped.length} 单仓）\n\n`;

  if (grouped.size > 0) {
    text += `🌐 跨仓归并概念（同义，多仓讲解）：\n`;
    for (const [gcId, groupHits] of grouped) {
      const gc = globalConceptsById.get(gcId);
      const canonical = gc?.canonicalName || groupHits[0].conceptName;
      const aliasNote = gc && gc.aliases.length > 0 ? `（别名: ${gc.aliases.join('、')}）` : '';
      text += `- **${canonical}**${aliasNote} — 覆盖 ${groupHits.length} 仓:\n`;
      for (const h of groupHits) {
        text += `  • ${h.repoOwner}/${h.repoName}: ${h.conceptName}`;
        if (h.address) text += ` [Address: ${h.address}]`;
        text += `\n`;
      }
    }
    text += `\n`;
  }

  if (ungrouped.length > 0) {
    text += `📚 单仓概念（未跨仓归并，仅出现在一个仓或尚未对齐）：\n`;
    for (const h of ungrouped) {
      text += `- ${h.repoOwner}/${h.repoName}: ${h.conceptName} (${h.category})`;
      if (h.address) text += ` [Address: ${h.address}]`;
      text += `\n`;
    }
  }

  text += `\n(对任一命中调用 explore_concept(action='details', concept=..., repository=...) 深入，read_document(section=Address) 精读原文)`;
  return text;
}

// -------------------------------------------------------------
// recommend_tutorial：按概念覆盖度给书架教程打分
// -------------------------------------------------------------

/** 按类别加权（architecture/workflow 主题性概念权重高于 reflection） */
const CATEGORY_WEIGHT: Record<string, number> = {
  architecture: 1.0,
  workflow: 1.0,
  principle: 0.8,
  reflection: 0.4,
};

/** 从项目描述抽关键词（去停用词、长度≥2、去重） */
export function extractKeywords(description: string, max = 8): string[] {
  const stop = new Set(['the', 'a', 'an', 'for', 'and', 'with', 'using', 'use', 'to', 'of', 'in', 'on', '我', '要', '想', '一个', '项目', '应用']);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of description.toLowerCase().split(/[\/\s,.;，。；、]+/)) {
    const k = raw.trim();
    if (k.length < 2 || stop.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

export interface RepoCoverageScore {
  repo: BookshelfRepo;
  totalConcepts: number;
  matchedConcepts: { conceptName: string; category: string; docPath: string | null; address: string | null }[];
  /** 加权覆盖分：Σ(匹配概念 category 权重) / max(总概念数,1) */
  score: number;
}

/**
 * 跨仓教程推荐：fan-out 每仓按关键词算概念覆盖度，返回 Top N。
 * 跨仓同义概念经 globalConceptId 去重（同一全局概念在多仓只计一次权重，避免同名刷分）。
 */
export async function recommendTutorials(
  userId: string,
  description: string,
  opts: { topN?: number } = {}
): Promise<RepoCoverageScore[]> {
  const topN = opts.topN ?? 3;
  const keywords = extractKeywords(description);
  if (keywords.length === 0) return [];

  const results = await forEachBookshelfRepo(userId, async (r) => {
    // 该仓命中关键词的概念（conceptName contains 任一关键词）
    const matched = await prisma.tutorialConceptNode.findMany({
      where: {
        repositoryId: r.id,
        OR: keywords.map((kw) => ({ conceptName: { contains: kw, mode: 'insensitive' as const } })),
      },
      select: { conceptName: true, category: true, globalConceptId: true, headingPath: true, document: { select: { path: true } } },
    });
    const totalConcepts = await prisma.tutorialConceptNode.count({ where: { repositoryId: r.id } });
    // 跨仓同义概念去重（按 globalConceptId；无 id 的按 conceptName 去重）
    const dedupKey = (m: typeof matched[number]) => m.globalConceptId || m.conceptName.toLowerCase();
    const seen = new Set<string>();
    const unique: typeof matched = [];
    for (const m of matched) {
      const k = dedupKey(m);
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(m);
    }
    const score = unique.reduce((s, m) => s + (CATEGORY_WEIGHT[m.category] ?? 0.5), 0) / Math.max(totalConcepts, 1);
    return {
      repo: r,
      totalConcepts,
      matchedConcepts: unique.map((m) => ({
        conceptName: m.conceptName,
        category: m.category,
        docPath: m.document?.path || null,
        address: m.document?.path && m.headingPath ? buildCleanSectionAddress(m.document.path, m.headingPath) : null,
      })),
      score,
    } satisfies RepoCoverageScore;
  });

  return results
    .map((r) => r.result)
    .filter((x): x is RepoCoverageScore => x !== null && x.matchedConcepts.length > 0)
    .sort((a, b) => b.score - a.score || b.matchedConcepts.length - a.matchedConcepts.length)
    .slice(0, topN);
}

/** 渲染教程推荐（纯函数） */
export function formatRecommendTutorial(description: string, ranked: RepoCoverageScore[]): string {
  if (ranked.length === 0) {
    return `🎓 教程推荐：书架内无教程覆盖项目描述「${description}」中的概念。可尝试 list_resources 查看可用教程，或用更通用的技术词重试。`;
  }
  let text = `🎓 教程推荐（按概念覆盖度排序，项目描述: "${description}"）\n\n`;
  ranked.forEach((r, i) => {
    text += `### ${i + 1}. ${r.repo.owner}/${r.repo.repo}（覆盖分 ${(r.score * 100).toFixed(0)}%，命中 ${r.matchedConcepts.length}/${r.totalConcepts} 概念）\n`;
    text += `覆盖概念:\n`;
    for (const m of r.matchedConcepts.slice(0, 12)) {
      text += `- ${m.conceptName} (${m.category})`;
      if (m.address) text += ` [Address: ${m.address}]`;
      text += `\n`;
    }
    if (r.matchedConcepts.length > 12) text += `...（另有 ${r.matchedConcepts.length - 12} 个）\n`;
    text += `\n`;
  });
  text += `(对推荐教程调用 explore_concept(action='course_map') 看结构，read_document(section=Address) 精读覆盖概念)`;
  return text;
}

// -------------------------------------------------------------
// skill_coverage：技能/概念在书架的覆盖深度
// -------------------------------------------------------------

export interface SkillCoverageHit {
  repo: BookshelfRepo;
  conceptName: string;
  category: string;
  address: string | null;
  /** 直接前置概念数（越多=该仓讲得越深/越靠后） */
  prereqCount: number;
  globalConceptId: string | null;
}

/** 跨仓技能覆盖：fan-out 每仓 resolveConceptNode，命中则取直接前置数作覆盖深度代理 */
export async function findSkillCoverageAcrossBookshelf(userId: string, skill: string): Promise<SkillCoverageHit[]> {
  const trimmed = skill.trim();
  if (!trimmed) return [];
  const results = await forEachBookshelfRepo(userId, async (r) => {
    const node = await resolveConceptNode(r.id, trimmed);
    if (!node) return null;
    const deps = await getConceptDependencies(r.id, node.id, 50);
    return {
      repo: r,
      conceptName: node.conceptName,
      category: node.category,
      address: node.document?.path && node.headingPath ? buildCleanSectionAddress(node.document.path, node.headingPath) : null,
      prereqCount: deps.length,
      globalConceptId: node.globalConceptId,
    } satisfies SkillCoverageHit;
  });
  return results.map((r) => r.result).filter((x): x is SkillCoverageHit => x !== null);
}

/** 渲染技能覆盖（纯函数） */
export function formatSkillCoverage(skill: string, hits: SkillCoverageHit[]): string {
  if (hits.length === 0) {
    return `📊 技能覆盖「${skill}」：书架内无教程覆盖该技能。可尝试 search(mode='concept') 查相关概念，或 list_resources 看可用教程。`;
  }
  const sorted = hits.slice().sort((a, b) => b.prereqCount - a.prereqCount);
  let text = `📊 技能覆盖「${skill}」（${hits.length} 仓覆盖）\n\n`;
  for (const h of sorted) {
    const depthLabel = h.prereqCount === 0 ? '入门级（无前置）' : `${h.prereqCount} 个前置概念`;
    text += `- ${h.repo.owner}/${h.repo.repo}: ${h.conceptName} (${h.category}) — 深度: ${depthLabel}`;
    if (h.address) text += ` [Address: ${h.address}]`;
    text += `\n`;
  }
  text += `\n(对覆盖仓调用 explore_concept(action='path') 看完整前置链，read_document(section=Address) 精读)`;
  return text;
}

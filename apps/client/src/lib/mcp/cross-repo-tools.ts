import { prisma } from '@/lib/db';
import { buildCleanSectionAddress } from '@/lib/mcp/section-address';
import { resolveConceptNode, getConceptDependencies } from '@/lib/mcp/concept-graph';

const FANOUT_CONCURRENCY = 4;
const MAX_FANOUT_REPOS = 10;

export interface BookshelfRepo {
  id: string;
  owner: string;
  repo: string;
}

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

export function formatCrossRepoConceptSearch(
  query: string,
  hits: CrossRepoConceptHit[],
  globalConceptsById: Map<string, { canonicalName: string; aliases: string[] }>
): string {
  if (hits.length === 0) {
    return `🔍 跨仓概念检索 "${query}"：书架内无匹配概念。可尝试 list_resources 查看可用教程，或用 search(mode='concept') 做全文检索。`;
  }

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

  text += `\n(对任一命中调用 explore_concept(action='details', concept=..., repository=...) 深入，read(target=Address, repository=...) 精读原文)`;
  return text;
}

const CATEGORY_WEIGHT: Record<string, number> = {
  architecture: 1.0,
  workflow: 1.0,
  principle: 0.8,
  reflection: 0.4,
};

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
  score: number;
}

export async function recommendTutorials(
  userId: string,
  description: string,
  opts: { topN?: number } = {}
): Promise<RepoCoverageScore[]> {
  const topN = opts.topN ?? 3;
  const keywords = extractKeywords(description);
  if (keywords.length === 0) return [];

  const results = await forEachBookshelfRepo(userId, async (r) => {
    const matched = await prisma.tutorialConceptNode.findMany({
      where: {
        repositoryId: r.id,
        OR: keywords.map((kw) => ({ conceptName: { contains: kw, mode: 'insensitive' as const } })),
      },
      select: { conceptName: true, category: true, globalConceptId: true, headingPath: true, document: { select: { path: true } } },
    });
    const totalConcepts = await prisma.tutorialConceptNode.count({ where: { repositoryId: r.id } });
    // Deduplicate across repos by globalConceptId so shared concepts are not double-counted.
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
  text += `(对推荐教程调用 explore_concept(action='course_map') 看结构，read(target=Address, repository=...) 精读覆盖概念)`;
  return text;
}

export interface SkillCoverageHit {
  repo: BookshelfRepo;
  conceptName: string;
  category: string;
  address: string | null;
  prereqCount: number;
  globalConceptId: string | null;
}

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
  text += `\n(对覆盖仓调用 explore_concept(action='path') 看完整前置链，read(target=Address, repository=...) 精读)`;
  return text;
}

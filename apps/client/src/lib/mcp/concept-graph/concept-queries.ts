import { prisma } from '@/lib/db';
import { REPO_PROFILE_CLUSTERS_KEY } from '../../constants';
import { buildCleanSectionAddress } from '@/lib/mcp/section-address';
import { normalizeHeadingKey } from '@/lib/mcp/concept-extractor';
import { resolveCanonicalMemberIds } from '@/lib/mcp/concept-canonical';
import {
  computeNeighborMap,
  computeLearningPathChain,
  computeConceptDepths,
  MAX_NEIGHBOR_SHOW,
  MAX_COLOCATED_SHOW,
  COLOCATED_WEIGHT,
  MAX_LEARNING_PATH_DEPTH,
  type EdgeRef,
} from '@/lib/mcp/concept-graph-pure';
import { neighborRelationTag } from '@/lib/mcp/concept-graph-formatter';

// Exact matches (slug/name/canonical) precede startsWith fallback to avoid broad substring misrouting.
export async function resolveConceptNode(repositoryId: string, concept: string) {
  const trimmed = (concept || '').trim();
  if (!trimmed) return null;
  const include = { document: { select: { path: true, title: true } } };

  // Append canonicalKey condition only when non-empty because an empty OR branch matches every row.
  const canonicalKey = normalizeHeadingKey(trimmed);
  const exact = await prisma.tutorialConceptNode.findFirst({
    where: {
      repositoryId,
      OR: [
        { slug: { equals: trimmed, mode: 'insensitive' } },
        { conceptName: { equals: trimmed, mode: 'insensitive' } },
        { canonicalName: { equals: trimmed, mode: 'insensitive' } },
        ...(canonicalKey ? [{ canonicalKey }] : []),
      ],
    },
    include,
    orderBy: { updatedAt: 'desc' },
  });
  if (exact) return exact;

  return prisma.tutorialConceptNode.findFirst({
    where: {
      repositoryId,
      conceptName: { startsWith: trimmed, mode: 'insensitive' },
    },
    include,
    orderBy: { updatedAt: 'desc' },
  });
}

export interface ConceptNeighborItem {
  conceptId: string;
  conceptName: string;
  canonicalKey: string | null;
  canonicalName: string | null;
  category: string;
  docPath: string | null;
  headingPath: string | null;
  address: string | null;
  relation: { direction: 'incoming' | 'outgoing' | 'undirected'; type: string; weight: number; source: string };
  edgeCount: number;
}

export async function getConceptNeighbors(repositoryId: string, conceptId: string): Promise<ConceptNeighborItem[]> {
  // Expand across canonicalKey group members so variants inherit group edges, skipping intra-group self-edges.
  const memberIds = await resolveCanonicalMemberIds(repositoryId, conceptId);
  const memberSet = new Set(memberIds);

  const edges = await prisma.tutorialConceptEdge.findMany({
    where: { repositoryId, OR: [{ sourceId: { in: memberIds } }, { targetId: { in: memberIds } }] },
    select: { sourceId: true, targetId: true, type: true, weight: true, source: true },
  });
  const map = computeNeighborMap(edges);

  const neighborIds = new Set<string>();
  const byId = new Map<string, { direction: 'incoming' | 'outgoing'; type: string; weight: number; source: string }[]>();
  for (const memberId of memberIds) {
    const { incoming = [], outgoing = [] } = map.get(memberId) || {};
    for (const e of incoming) {
      if (memberSet.has(e.sourceId)) continue;
      neighborIds.add(e.sourceId);
      const arr = byId.get(e.sourceId) || [];
      arr.push({ direction: 'incoming', type: e.type, weight: e.weight, source: e.source ?? 'cooccurrence' });
      byId.set(e.sourceId, arr);
    }
    for (const e of outgoing) {
      if (memberSet.has(e.targetId)) continue;
      neighborIds.add(e.targetId);
      const arr = byId.get(e.targetId) || [];
      arr.push({ direction: 'outgoing', type: e.type, weight: e.weight, source: e.source ?? 'cooccurrence' });
      byId.set(e.targetId, arr);
    }
  }

  if (neighborIds.size === 0) return [];

  const nodes = await prisma.tutorialConceptNode.findMany({
    where: { id: { in: Array.from(neighborIds) }, repositoryId },
    select: {
      id: true,
      conceptName: true,
      slug: true,
      canonicalKey: true,
      canonicalName: true,
      category: true,
      headingPath: true,
      document: { select: { path: true, title: true } },
    },
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const edgeNeighbors = Array.from(byId.entries())
    .map(([id, rels]) => {
      const node = nodeById.get(id);
      if (!node) return null;
      const bestRel = rels.sort((a, b) => b.weight - a.weight)[0];
      return {
        conceptId: id,
        conceptName: node.conceptName,
        canonicalKey: node.canonicalKey,
        canonicalName: node.canonicalName,
        category: node.category,
        docPath: node.document?.path || null,
        headingPath: node.headingPath,
        address: node.document?.path && node.headingPath
          ? buildCleanSectionAddress(node.document.path, node.headingPath)
          : null,
        relation: { direction: bestRel.direction, type: bestRel.type, weight: bestRel.weight, source: bestRel.source },
        edgeCount: rels.length,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null)
    .sort((a, b) => {
      const scoreSource = (src: string) =>
        src === 'code_dep' ? 3 : src === 'curriculum_order' || src === 'manual' ? 2 : src === 'cooccurrence' ? 0 : 1;
      const diff = scoreSource(b.relation.source) - scoreSource(a.relation.source);
      return diff !== 0 ? diff : b.relation.weight - a.relation.weight;
    })
    .filter((n, _idx, arr) => {
      if (!n.canonicalKey) return true;
      const first = arr.find((m) => m.canonicalKey === n.canonicalKey);
      return first === n || first === undefined;
    })
    .slice(0, MAX_NEIGHBOR_SHOW);

  const coLocated = await loadCoLocatedNeighbors(repositoryId, conceptId, memberIds, edgeNeighbors);
  return [...edgeNeighbors, ...coLocated];
}

async function loadCoLocatedNeighbors(
  repositoryId: string,
  conceptId: string,
  memberIds: string[],
  existing: { conceptId: string; canonicalKey: string | null }[]
): Promise<ConceptNeighborItem[]> {
  try {
    const target = await prisma.tutorialConceptNode.findUnique({
      where: { id: conceptId },
      select: { documentId: true },
    });
    if (!target?.documentId) return [];

    const excludeIds = new Set([...memberIds, ...existing.map((n) => n.conceptId)]);
    const shownKeys = new Set(existing.map((n) => n.canonicalKey).filter((k): k is string => Boolean(k)));

    // Over-fetch 3x and deduplicate in JS because SQL NOT IN mishandles nullable canonicalKey.
    const rows = await prisma.tutorialConceptNode.findMany({
      where: {
        repositoryId,
        documentId: target.documentId,
        id: { notIn: Array.from(excludeIds) },
      },
      select: {
        id: true,
        conceptName: true,
        slug: true,
        canonicalKey: true,
        canonicalName: true,
        category: true,
        headingPath: true,
        document: { select: { path: true, title: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_COLOCATED_SHOW * 3,
    });

    return rows
      .filter((node) => !node.canonicalKey || !shownKeys.has(node.canonicalKey))
      .slice(0, MAX_COLOCATED_SHOW)
      .map((node) => ({
        conceptId: node.id,
        conceptName: node.conceptName,
        canonicalKey: node.canonicalKey,
        canonicalName: node.canonicalName,
        category: node.category,
        docPath: node.document?.path || null,
        headingPath: node.headingPath,
        address: node.document?.path && node.headingPath
          ? buildCleanSectionAddress(node.document.path, node.headingPath)
          : null,
        relation: { direction: 'undirected' as const, type: 'co_located', weight: COLOCATED_WEIGHT, source: 'cooccurrence' },
        edgeCount: 0,
      }));
  } catch (err) {
    console.warn('[concept-graph] loadCoLocatedNeighbors failed:', err);
    return [];
  }
}

export async function getLearningPathConcepts(repositoryId: string, targetId: string) {
  // Load only prerequisite/successor edges to skip bulk cooccurrence rows on large repos.
  const edges = await prisma.tutorialConceptEdge.findMany({
    where: { repositoryId, type: { in: ['prerequisite', 'successor'] } },
    select: { sourceId: true, targetId: true, type: true, weight: true },
  });
  const memberIds = await resolveCanonicalMemberIds(repositoryId, targetId);
  const chain = computeLearningPathChain(targetId, edges, MAX_LEARNING_PATH_DEPTH, memberIds);
  if (chain.length === 0) return [];

  const ids = chain.map((c) => c.conceptId);
  const nodes = await prisma.tutorialConceptNode.findMany({
    where: { id: { in: ids }, repositoryId },
    select: {
      id: true,
      conceptName: true,
      canonicalKey: true,
      canonicalName: true,
      category: true,
      headingPath: true,
      document: { select: { path: true, title: true } },
    },
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const seenKeys = new Set<string>();
  return chain
    .map((c) => {
      const node = nodeById.get(c.conceptId);
      if (!node) return null;
      return {
        conceptId: c.conceptId,
        conceptName: node.conceptName,
        canonicalKey: node.canonicalKey,
        canonicalName: node.canonicalName,
        category: node.category,
        depth: c.depth,
        docPath: node.document?.path || null,
        headingPath: node.headingPath,
        address: node.document?.path && node.headingPath
          ? buildCleanSectionAddress(node.document.path, node.headingPath)
          : null,
      };
    })
    .filter((n): n is NonNullable<typeof n> => {
      if (!n) return false;
      if (!n.canonicalKey) return true;
      if (seenKeys.has(n.canonicalKey)) return false;
      seenKeys.add(n.canonicalKey);
      return true;
    });
}

export async function getConceptDependencies(
  repositoryId: string,
  conceptId: string,
  max: number = 5
): Promise<{ conceptId: string; conceptName: string; category: string; docPath: string | null; address: string | null; source: string; weight: number }[]> {
  if (!repositoryId || !conceptId) return [];
  const memberIds = await resolveCanonicalMemberIds(repositoryId, conceptId);
  const edges = await prisma.tutorialConceptEdge.findMany({
    where: { repositoryId, targetId: { in: memberIds }, type: { in: ['prerequisite', 'successor'] } },
    select: { sourceId: true, weight: true, source: true },
    orderBy: { weight: 'desc' },
  });
  if (edges.length === 0) return [];

  const seenSources = new Set<string>();
  const dedupedEdges = edges.filter((e) => {
    if (seenSources.has(e.sourceId)) return false;
    seenSources.add(e.sourceId);
    return true;
  });
  const topEdges = dedupedEdges.slice(0, max);
  if (topEdges.length === 0) return [];

  const nodes = await prisma.tutorialConceptNode.findMany({
    where: { id: { in: topEdges.map((e) => e.sourceId) }, repositoryId },
    select: {
      id: true,
      conceptName: true,
      category: true,
      headingPath: true,
      document: { select: { path: true, title: true } },
    },
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  return topEdges
    .map((e) => {
      const node = nodeById.get(e.sourceId);
      if (!node) return null;
      return {
        conceptId: node.id,
        conceptName: node.conceptName,
        category: node.category,
        docPath: node.document?.path || null,
        address: node.document?.path && node.headingPath
          ? buildCleanSectionAddress(node.document.path, node.headingPath)
          : null,
        source: e.source ?? 'cooccurrence',
        weight: e.weight,
      };
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
}

export async function getConceptCodeContext(
  repositoryId: string,
  documentPath: string
): Promise<{ title: string; directories: string[]; files: string[] } | null> {
  const { isCodeChapterPath } = await import('@/engine/update-candidate-set');
  if (!isCodeChapterPath(documentPath)) return null;
  const order = parseInt(documentPath.split('/').pop()?.replace(/\D/g, '') || '', 10);
  if (Number.isNaN(order)) return null;
  try {
    const repo = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { repoProfile: true },
    });
    const clusters = (((repo?.repoProfile as Record<string, unknown> | null)?.[
      REPO_PROFILE_CLUSTERS_KEY
    ] ?? []) as Array<{ teachingOrder: number; title?: string; directories?: string[]; files?: string[] }>);
    const cluster = clusters.find((c) => c.teachingOrder === order);
    if (!cluster) return null;
    return {
      title: cluster.title || `Chapter ${order}`,
      directories: cluster.directories || [],
      files: cluster.files || [],
    };
  } catch (err) {
    console.warn('[concept-graph] getConceptCodeContext failed:', err);
    return null;
  }
}

export interface GroundedSymbolInfo {
  name: string;
  kind: 'function' | 'type';
  file: string;
  score: number;
}

export interface ConceptGrounding {
  backboneFiles: { path: string; role: string; pageRank: number }[];
  goldenSymbols: GroundedSymbolInfo[];
}

export async function getConceptGrounding(
  repositoryId: string,
  conceptName: string,
  documentPath?: string | null
): Promise<ConceptGrounding | null> {
  try {
    const repo = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { owner: true, repo: true, gitSha: true },
    });
    if (!repo || !repo.gitSha) return null;

    let scopeFilesArr: string[] | null = null;
    if (documentPath) {
      const codeCtx = await getConceptCodeContext(repositoryId, documentPath);
      if (codeCtx && codeCtx.files.length > 0) {
        scopeFilesArr = codeCtx.files;
      }
    }

    try {
      const { executeSidecarConceptGrounding } = await import('@/engine/symbols-driver');
      const sidecarRes = await executeSidecarConceptGrounding({
        owner: repo.owner,
        repo: repo.repo,
        sha: repo.gitSha,
        conceptName,
        scopeFiles: scopeFilesArr ?? undefined,
      });
      if (sidecarRes.goldenSymbols.length === 0 && sidecarRes.backboneFiles.length === 0) {
        return null;
      }
      return sidecarRes;
    } catch (sidecarErr) {
      console.warn('[concept-graph] sidecar concept-grounding failed, falling back to local artifact:', sidecarErr);
    }

    const { loadSemanticGraphArtifact } = await import('@/engine/ingest/graph-store');
    const artifact = await loadSemanticGraphArtifact(repo.owner, repo.repo, repo.gitSha);
    if (!artifact) return null;

    const scopeFiles = scopeFilesArr ? new Set(scopeFilesArr) : null;

    const backboneFiles: { path: string; role: string; pageRank: number }[] = [];
    if (Array.isArray(artifact.nodes)) {
      const candidateNodes = artifact.nodes
        .filter((n) => (scopeFiles ? scopeFiles.has(n.path) : n.isBackbone || n.role === 'core_contract' || n.role === 'entry_point'))
        .sort((a, b) => (b.pageRank || 0) - (a.pageRank || 0));

      for (const node of candidateNodes.slice(0, 4)) {
        backboneFiles.push({
          path: node.path,
          role: node.role,
          pageRank: Math.round((node.pageRank || 0) * 1000) / 1000,
        });
      }
    }

    const backboneFileSet = new Set(backboneFiles.map((b) => b.path));

    const normConcept = (conceptName || '').toLowerCase().trim();
    const goldenSymbols: GroundedSymbolInfo[] = [];
    const seenSymbols = new Set<string>();

    if (Array.isArray(artifact.goldenSymbols)) {
      for (const sym of artifact.goldenSymbols) {
        const inScope = scopeFiles ? scopeFiles.has(sym.file) : backboneFileSet.has(sym.file);
        const normSym = (sym.name || '').toLowerCase().trim();
        const nameMatch = normConcept.length > 0 && (normConcept.includes(normSym) || normSym.includes(normConcept));
        if (inScope || nameMatch) {
          const key = `${sym.file}::${sym.name}`;
          if (!seenSymbols.has(key)) {
            seenSymbols.add(key);
            goldenSymbols.push({
              name: sym.name,
              kind: sym.kind,
              file: sym.file,
              score: sym.score,
            });
          }
        }
        if (goldenSymbols.length >= 6) break;
      }
    }

    if (goldenSymbols.length === 0 && backboneFiles.length === 0) return null;

    return {
      backboneFiles,
      goldenSymbols,
    };
  } catch (err) {
    console.warn('[concept-graph] getConceptGrounding failed:', err);
    return null;
  }
}

export async function findConceptForDocument(
  repositoryId: string,
  documentId: string,
  headingPath?: string | null
) {
  if (!repositoryId || !documentId) return null;
  // When headingPath is specified, return null on miss rather than attributing an unrelated doc concept.
  if (headingPath) {
    return prisma.tutorialConceptNode.findFirst({
      where: {
        repositoryId,
        documentId,
        OR: [
          { headingPath: { equals: headingPath } },
          { headingPath: { contains: headingPath } },
        ],
      },
      include: { document: { select: { path: true, title: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }
  return prisma.tutorialConceptNode.findFirst({
    where: { repositoryId, documentId },
    include: { document: { select: { path: true, title: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function buildGraphPositionText(
  repositoryId: string,
  documentId: string,
  headingPath?: string | null
): Promise<string> {
  try {
    const concept = await findConceptForDocument(repositoryId, documentId, headingPath);
    if (!concept) return '';
    const neighbors = await getConceptNeighbors(repositoryId, concept.id);
    if (neighbors.length === 0) return '';

    let text = `🧭 图位置 (Graph Position): 本节属于「${concept.conceptName}」(${concept.category})\n`;
    text += `- 直接邻居: `;
    text += neighbors
      .slice(0, 4)
      .map((n) => `${neighborRelationTag(n.relation)}${n.conceptName}`)
      .join('、');
    text += ` (⇠=我依赖它 ⇢=它依赖我 ⇋=无向关联)`;
    text += `\n\n`;
    return text;
  } catch (err) {
    console.error('[concept-graph] buildGraphPositionText failed:', err);
    return '';
  }
}

export async function buildRepositoryConceptTaxonomy(repositoryId: string, take: number = 50) {
  const rawTake = Math.min(take * 4, 200);
  const [concepts, edges, groupCounts] = await Promise.all([
    prisma.tutorialConceptNode.findMany({
      where: { repositoryId },
      select: {
        id: true,
        conceptName: true,
        slug: true,
        canonicalKey: true,
        canonicalName: true,
        category: true,
        headingPath: true,
        document: { select: { path: true, title: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: rawTake,
    }),
    prisma.tutorialConceptEdge.findMany({
      where: { repositoryId, type: { in: ['prerequisite', 'successor'] } },
      select: { sourceId: true, targetId: true, type: true, weight: true },
    }),
    prisma.tutorialConceptNode.groupBy({
      by: ['canonicalKey'],
      where: { repositoryId, canonicalKey: { not: null } },
      _count: { _all: true },
    }).catch(() => [] as { canonicalKey: string | null; _count: { _all: number } }[]),
  ]);
  const countByKey = new Map(
    groupCounts.map((g) => [g.canonicalKey as string, g._count._all])
  );

  const depths = computeConceptDepths(concepts.map((c) => c.id), edges as EdgeRef[]);

  const seenKeys = new Set<string>();
  const deduped = [];
  for (const c of concepts) {
    const key = c.canonicalKey || `raw:${c.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const representative =
      (c.canonicalName && concepts.find((m) => m.canonicalKey === c.canonicalKey && m.conceptName === c.canonicalName)) || c;
    deduped.push({
      conceptName: representative.conceptName,
      category: representative.category,
      slug: representative.slug,
      docPath: representative.document?.path || null,
      address: representative.document?.path && representative.headingPath
        ? buildCleanSectionAddress(representative.document.path, representative.headingPath)
        : null,
      depth: depths.get(representative.id) ?? depths.get(c.id) ?? 0,
      canonicalName: c.canonicalName,
      mergedVariants: (c.canonicalKey && countByKey.get(c.canonicalKey)) || 1,
    });
    if (deduped.length >= take) break;
  }
  return deduped;
}

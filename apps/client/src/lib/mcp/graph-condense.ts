import { z } from 'zod';
import { prisma } from '@/lib/db';
import { REPO_PROFILE_SUPERTOPICS_KEY } from '@/lib/constants';
import { conceptSuperTopicsBlockSchema } from '@/lib/mcp/concept-schemas';

export interface GraphStats {
  conceptNodes: number;
  canonicalGroups: number;
  conceptEdges: number;
  edgesPerNode: number;
  mergeCoverage: number;
  supertopicCount: number;
}

export interface RawConceptGraphNode {
  id: string;
  name?: string;
  score?: number;
  depth?: number;
}

export interface RawConceptGraphEdge {
  sourceId: string;
  targetId: string;
  weight?: number;
}

export interface ConceptGraph {
  nodes: RawConceptGraphNode[];
  edges: RawConceptGraphEdge[];
}

export interface CompactGraph {
  nodes: RawConceptGraphNode[];
  edges: RawConceptGraphEdge[];
}

// Light mode skips groupBy and super-topic parsing during N-repo bookshelf fan-outs.
export async function computeGraphStats(
  repositoryId: string,
  repoProfile?: unknown,
  opts?: { light?: boolean }
): Promise<GraphStats> {
  const light = opts?.light === true;
  if (light) {
    const [conceptNodes, conceptEdges] = await Promise.all([
      prisma.tutorialConceptNode.count({ where: { repositoryId } }),
      prisma.tutorialConceptEdge.count({ where: { repositoryId } }),
    ]);
    return {
      conceptNodes,
      canonicalGroups: 0,
      conceptEdges,
      edgesPerNode: conceptNodes > 0 ? Math.round((conceptEdges / conceptNodes) * 100) / 100 : 0,
      mergeCoverage: 0,
      supertopicCount: 0,
    };
  }

  const [conceptNodes, conceptEdges, keyGroups, mergedNodes] = await Promise.all([
    prisma.tutorialConceptNode.count({ where: { repositoryId } }),
    prisma.tutorialConceptEdge.count({ where: { repositoryId } }),
    prisma.tutorialConceptNode
      .groupBy({ by: ['canonicalKey'], where: { repositoryId, canonicalKey: { not: null } }, _count: { _all: true } })
      .catch(() => []),
    prisma.tutorialConceptNode.count({ where: { repositoryId, canonicalKey: { not: null } } }),
  ]);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    conceptNodes,
    canonicalGroups: keyGroups.length,
    conceptEdges,
    edgesPerNode: conceptNodes > 0 ? round2(conceptEdges / conceptNodes) : 0,
    mergeCoverage: conceptNodes > 0 ? round2(mergedNodes / conceptNodes) : 0,
    supertopicCount: repoProfile !== undefined ? (parseSuperTopicsBlock(repoProfile)?.topics.length ?? 0) : 0,
  };
}

export function parseSuperTopicsBlock(
  repoProfile: unknown
): z.infer<typeof conceptSuperTopicsBlockSchema> | null {
  if (!repoProfile || typeof repoProfile !== 'object') return null;
  const raw = (repoProfile as Record<string, unknown>)[REPO_PROFILE_SUPERTOPICS_KEY];
  const parsed = conceptSuperTopicsBlockSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

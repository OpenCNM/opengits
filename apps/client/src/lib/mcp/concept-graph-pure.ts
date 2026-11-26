import type { ConceptEdgeType, ConceptEdgeSource } from '@/lib/mcp/concept-schemas';

export const COOCCURRENCE_CHUNK_WEIGHT = 1.0;
export const CURRICULUM_EDGE_WEIGHT = 0.3;
export const MAX_LEARNING_PATH_DEPTH = 4;
export const MAX_LEARNING_PATH_NODES = 12;
export const MAX_NEIGHBOR_SHOW = 12;
export const MAX_COLOCATED_SHOW = 4;
export const COLOCATED_WEIGHT = 0.5;
export const MAX_EDGES_PER_REPO = 4000;
export const MIN_EDGES_PER_REPO = 500;
export const EDGE_CAP_PER_CONCEPT = 12;
export const EDGE_CAP_PER_DOCUMENT = 8;

// Concept count uses deduplicated canonical groups so variant fragments never inflate the edge budget.
export function computeRepoEdgeCap(conceptCount: number, documentCount: number): number {
  const dynamic = conceptCount * EDGE_CAP_PER_CONCEPT + documentCount * EDGE_CAP_PER_DOCUMENT;
  return Math.min(MAX_EDGES_PER_REPO, Math.max(MIN_EDGES_PER_REPO, dynamic));
}

// curriculum_order edges bypass trimming to preserve learning paths; remaining budget favors low-degree tail pairs.
export function prioritizeEdgesForBudget(
  curriculumEdges: DerivedEdge[],
  cooccurrenceEdges: DerivedEdge[],
  cap: number
): DerivedEdge[] {
  if (cap <= 0) return [];
  const remaining = Math.max(0, cap - curriculumEdges.length);
  if (remaining >= cooccurrenceEdges.length) return [...curriculumEdges, ...cooccurrenceEdges];

  const degree = new Map<string, number>();
  for (const e of cooccurrenceEdges) {
    degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
    degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
  }
  const scarcityOf = (e: DerivedEdge) => (degree.get(e.sourceId) ?? 0) + (degree.get(e.targetId) ?? 0);
  const sorted = cooccurrenceEdges
    .map((e, idx) => ({ e, idx, scarcity: scarcityOf(e) }))
    .sort(
      (a, b) =>
        a.scarcity - b.scarcity ||
        `${a.e.sourceId}${a.e.targetId}`.localeCompare(`${b.e.sourceId}${b.e.targetId}`) ||
        a.idx - b.idx
    )
    .slice(0, remaining)
    .map((x) => x.e);
  return [...curriculumEdges, ...sorted];
}

export interface ConceptSeed {
  id: string;
  documentId?: string | null;
  chunkId?: string | null;
}

export interface DerivedEdge {
  sourceId: string;
  targetId: string;
  type: ConceptEdgeType;
  weight: number;
  source: ConceptEdgeSource;
  meta?: Record<string, unknown>;
}

// Ordered sourceId < targetId prevents duplicate A->B / B->A cooccurrence edges; doc-level co-location stays unmaterialized.
export function deriveCooccurrenceEdges(concepts: ConceptSeed[]): DerivedEdge[] {
  const edges = new Map<string, DerivedEdge>();
  const byChunk = new Map<string, string[]>();

  for (const c of concepts) {
    if (c.chunkId) {
      const arr = byChunk.get(c.chunkId) || [];
      arr.push(c.id);
      byChunk.set(c.chunkId, arr);
    }
  }

  const addPair = (a: string, b: string, weight: number, chunkId: string) => {
    if (a === b) return;
    const [sourceId, targetId] = a < b ? [a, b] : [b, a];
    const key = `${sourceId}|${targetId}|related`;
    if (edges.has(key)) return;
    edges.set(key, {
      sourceId,
      targetId,
      type: 'related',
      weight,
      source: 'cooccurrence',
      meta: { chunkId },
    });
  };

  for (const [chunkId, list] of byChunk.entries()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addPair(list[i], list[j], COOCCURRENCE_CHUNK_WEIGHT, chunkId);
      }
    }
  }

  return Array.from(edges.values());
}

// Linearize curriculum order to one deterministic predecessor per target (O(N)) to avoid quadratic budget exhaustion.
export function deriveCurriculumOrderEdges(orderedConceptIds: string[][]): DerivedEdge[] {
  const edges: DerivedEdge[] = [];
  for (let i = 0; i + 1 < orderedConceptIds.length; i++) {
    const earlier = orderedConceptIds[i];
    const later = orderedConceptIds[i + 1];
    if (earlier.length === 0 || later.length === 0) continue;
    const representative = [...earlier].sort()[0];
    for (const tgt of later) {
      if (tgt === representative) continue;
      edges.push({
        sourceId: representative,
        targetId: tgt,
        type: 'successor',
        weight: CURRICULUM_EDGE_WEIGHT,
        source: 'curriculum_order',
        meta: { docGap: 1 },
      });
    }
  }
  return edges;
}

export interface EdgeRef {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
  source?: string;
}

export function computeNeighborMap(edges: EdgeRef[]): Map<string, { incoming: EdgeRef[]; outgoing: EdgeRef[] }> {
  const map = new Map<string, { incoming: EdgeRef[]; outgoing: EdgeRef[] }>();
  for (const e of edges) {
    const a = map.get(e.sourceId) || { incoming: [], outgoing: [] };
    a.outgoing.push(e);
    map.set(e.sourceId, a);
    const b = map.get(e.targetId) || { incoming: [], outgoing: [] };
    b.incoming.push(e);
    map.set(e.targetId, b);
  }
  return map;
}

export function computeLearningPathChain(
  targetId: string,
  edges: EdgeRef[],
  maxDepth: number = MAX_LEARNING_PATH_DEPTH,
  rootIds?: string[]
): { conceptId: string; depth: number }[] {
  const neighborMap = computeNeighborMap(edges);
  const roots = Array.from(new Set([targetId, ...(rootIds ?? [])]));
  const visited = new Set<string>(roots);
  const chain: { conceptId: string; depth: number }[] = [];
  let frontier = roots;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    const levelCandidates: { conceptId: string; weight: number }[] = [];

    for (const id of frontier) {
      for (const e of neighborMap.get(id)?.incoming || []) {
        if (e.type !== 'prerequisite' && e.type !== 'successor') continue;
        if (visited.has(e.sourceId)) continue;
        levelCandidates.push({ conceptId: e.sourceId, weight: e.weight });
      }
    }

    levelCandidates.sort((a, b) => b.weight - a.weight);
    for (const cand of levelCandidates) {
      if (visited.has(cand.conceptId)) continue;
      visited.add(cand.conceptId);
      chain.push({ conceptId: cand.conceptId, depth });
      next.push(cand.conceptId);
      if (chain.length >= MAX_LEARNING_PATH_NODES) return chain;
    }
    frontier = next;
  }

  return chain;
}

export function computeConceptDepths(
  conceptIds: string[],
  edges: EdgeRef[],
  maxDepth: number = 4
): Map<string, number> {
  const depths = new Map<string, number>(conceptIds.map((id) => [id, 0]));
  for (let iter = 0; iter < maxDepth; iter++) {
    let changed = false;
    for (const e of edges) {
      if (e.type !== 'prerequisite' && e.type !== 'successor') continue;
      const targetDepth = depths.get(e.targetId) ?? 0;
      const current = depths.get(e.sourceId) ?? 0;
      if (targetDepth + 1 > current) {
        depths.set(e.sourceId, targetDepth + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depths;
}

// Reject reversing or cyclic LLM prerequisite candidates before write; deterministic curriculum edges take precedence.
export function filterPrerequisiteCandidates(
  candidates: DerivedEdge[],
  established: EdgeRef[]
): { kept: DerivedEdge[]; dropped: number } {
  const forward = new Map<string, string[]>();
  const reversePairs = new Set<string>();
  for (const e of established) {
    if (e.type !== 'prerequisite' && e.type !== 'successor') continue;
    const arr = forward.get(e.sourceId);
    if (arr) arr.push(e.targetId);
    else forward.set(e.sourceId, [e.targetId]);
    reversePairs.add(`${e.sourceId}|${e.targetId}`);
  }

  const reaches = (from: string, to: string): boolean => {
    if (from === to) return true;
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of forward.get(cur) || []) {
        if (next === to) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  };

  const kept: DerivedEdge[] = [];
  let dropped = 0;
  for (const cand of candidates) {
    if (cand.type !== 'prerequisite') {
      kept.push(cand);
      continue;
    }
    if (reversePairs.has(`${cand.targetId}|${cand.sourceId}`)) {
      dropped++;
      continue;
    }
    if (reaches(cand.targetId, cand.sourceId)) {
      dropped++;
      continue;
    }
    kept.push(cand);
    const arr = forward.get(cand.sourceId);
    if (arr) arr.push(cand.targetId);
    else forward.set(cand.sourceId, [cand.targetId]);
  }
  return { kept, dropped };
}

export const CONCEPT_GRAPH_CONSTANTS = {
  MAX_LEARNING_PATH_DEPTH,
  MAX_LEARNING_PATH_NODES,
  MAX_NEIGHBOR_SHOW,
  MAX_COLOCATED_SHOW,
  COLOCATED_WEIGHT,
  MAX_EDGES_PER_REPO,
  MIN_EDGES_PER_REPO,
  EDGE_CAP_PER_CONCEPT,
  EDGE_CAP_PER_DOCUMENT,
  computeRepoEdgeCap,
  prioritizeEdgesForBudget,
} as const;

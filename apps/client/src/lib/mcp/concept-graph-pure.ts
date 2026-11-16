import type { ConceptEdgeType, ConceptEdgeSource } from '@/lib/mcp/concept-schemas';

/**
 * 概念图纯计算层（无 DB 依赖，可零 mock 单测）。
 * 从 concept-graph.ts 抽出：边预算/边推导/邻居与学习路径 BFS/概念深度。
 * DB 适配（查询与同步）留在 concept-graph.ts，通过本模块 re-export 保持对外路径不变。
 */

// 图谱参数（集中注册，禁止内联魔法数）
export const COOCCURRENCE_CHUNK_WEIGHT = 1.0; // 同 Chunk 共现 → 强相关
export const CURRICULUM_EDGE_WEIGHT = 0.3;    // 大纲教学顺序递进边
export const MAX_LEARNING_PATH_DEPTH = 4;     // 学习路径 BFS 最大深度
export const MAX_LEARNING_PATH_NODES = 12;    // 学习路径输出节点上限
export const MAX_NEIGHBOR_SHOW = 12;          // 邻居输出上限
export const MAX_COLOCATED_SHOW = 4;          // 同篇动态补充邻居上限（读侧 documentId 直查，不物化边）
export const COLOCATED_WEIGHT = 0.5;          // 同篇关系展示权重（弱相关，仅排序/展示用）
export const MAX_EDGES_PER_REPO = 4000;       // 单仓边数上限（防图谱膨胀）
export const MIN_EDGES_PER_REPO = 500;        // 小仓边数保底（防概念稀少时被截断饿死）
export const EDGE_CAP_PER_CONCEPT = 12;       // 每概念边预算（共现平方增长线性化）
export const EDGE_CAP_PER_DOCUMENT = 8;       // 每文档课程边余量（curriculum_order 为 O(docs)）

/**
 * 仓库共现边预算上限：随概念/文档规模线性增长，夹在 [500, 4000]。
 * 依据：共现边随概念数平方级增长（预算的真正约束对象）；curriculum_order 边
 * 线性化后无条件全保、不吃本预算。conceptCount 语义（归并层上线后）：传
 * 「仓内归并组数」（canonicalKey 去重数），预算与逻辑概念数线性挂钩，
 * 不随碎片变体虚增。
 */
export function computeRepoEdgeCap(conceptCount: number, documentCount: number): number {
  const dynamic = conceptCount * EDGE_CAP_PER_CONCEPT + documentCount * EDGE_CAP_PER_DOCUMENT;
  return Math.min(MAX_EDGES_PER_REPO, Math.max(MIN_EDGES_PER_REPO, dynamic));
}

/**
 * 边预算截断（纯函数，确定性幂等）：
 * 1. curriculum_order 边无条件全保（learning_path 的关键信号，绝不被共现边挤掉）。
 *    线性化改造后（每目标概念一条确定性前驱边）其规模为 O(概念数)，不构成膨胀风险；
 * 2. 共现边（平方级增长源）吃剩余预算，按「稀缺优先」排序截取——两端度数之和越低
 *    （越接近双长尾）的边先保留，枢纽概念的边靠后舍弃。修复大仓「边封顶后长尾概念
 *    沦为孤点」的稀疏化：裸 slice 按推导顺序截断时，先推导的头部概念边占满预算，
 *    长尾整组无邻居。
 * 排序 tie-break：两端度数之和 → 端点 id 拼接字典序 → 原始顺序，同输入重跑结果一致。
 */
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
  // 稀缺度 = 两端度数之和：双长尾边（1+1）最稀缺最优先；枢纽-叶子边（8+1）靠后——
  // 预算紧张时优先让「两个都快孤立的概念」保住邻居，而不是给已被枢纽照顾的概念锦上添花
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

// -------------------------------------------------------------
// 纯逻辑：边推导（无 DB 依赖）
// -------------------------------------------------------------

/**
 * 共现边推导（仅 Chunk 级强共现）：概念在同一 Chunk（同一微小段落）中出现 → related 边。
 * 文档级 O(N²) 两两配对已裁撤——「同篇概念」属于读侧事实，由 getConceptNeighbors
 * 按 documentId 索引动态补充（co_located），不再向边表物化数千条平凡 related 边。
 * 自环与重复（同 sourceId+targetId+type）会被剔除；方向按概念 id 字典序固定，
 * 保证幂等（避免 A→B 与 B→A 双写）。
 */
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

/**
 * 大纲教学顺序递进边：概念按文档教学顺序排序（orderedConceptIds 为逐文档概念 id 列表），
 * 相邻文档之间建立 successor 边（source 先于 target 学习）。
 *
 * 线性化（替代旧 |C_i|×|C_{i+1}| 笛卡尔积）：每个后置概念挂一条确定性代表前驱边
 * （前驱组取 id 最小者，重跑稳定）。语义不变量「后置组每个概念都有 ≥1 条来自前驱组
 * 的入边」保持——learning_path 反向 BFS 对每个概念仍可达；而规模从平方级降到
 * O(概念数)，大仓不再冲破边预算后被 slice 按推导顺序截断（那会静默掐断后期章节
 * 的整条学习路径）。
 */
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

// -------------------------------------------------------------
// 纯逻辑：路径与邻居计算（无 DB 依赖）
// -------------------------------------------------------------

export interface EdgeRef {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
  source?: string; // 边证据来源（cooccurrence/curriculum_order/code_dep/llm_extracted），可选——供邻居输出展示可信度
}

/**
 * 邻居索引：conceptId → { incoming, outgoing }。
 * 供邻居查询与学习路径 BFS 共用。
 */
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

/**
 * 学习路径链：从目标概念出发，沿「前置/递进」入边（prerequisite + successor）
 * 反向 BFS 回溯前置知识，每层按边权重降序取候选，输出 {conceptId, depth} 链。
 * 当前数据源为 curriculum_order 递进边（确定性教学顺序）；code_dep / llm_extracted
 * 就绪后自动纳入（同 type 语义，无需改动此处）。
 * rootIds（可选）：BFS 的深度 0 根集合（默认仅 targetId）——归并组把全部成员视为
 * 同一深度 0 超节点，任一成员的前置都算目标的前置；根自身不出现在输出链中。
 */
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

/**
 * 概念拓扑深度：沿前置/递进边迭代松弛，输出每个概念的分层深度。
 * depth 越大 = 越底层（越先学）。用于 list_documents 概念拓扑的分组排序与缩进。
 * 迭代至收敛或 MAX_DEPTH 上限（防环死循环）。
 */
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

/**
 * 前置候选边卫生检查（LLM prerequisite 候选 vs 已确立的前置图）。
 *
 * 背景：教学顺序边按文档序推导、构造上无环；LLM 边激活后 prerequisite 环第一次
 * 成为可能（"A 前置于 B"又"B 前置于 A"）——BFS visited 集合保证不死循环、输出链
 * 也不会显式成环，但矛盾边共存会让深度标注与可信度静默劣化。本函数在写入前把
 * 会成环/反向矛盾的候选拦下（候选是最新的最弱断言，既有的确定性/历史边优先）。
 *
 * 规则（仅约束 prerequisite 候选——学习路径只沿 prerequisite/successor 行走，
 * related/part_of 不参与）：
 * 1. 反向矛盾：已确立图中存在 B→A 时丢弃候选 A→B（确定性教学边永远优先）；
 * 2. 传递成环：B 已能沿既有前置边正向到达 A 时，A→B 会闭合成环 → 丢弃；
 *    已采纳的候选随即并入图，后续候选与前面被采纳的一起校验（候选链也防环）。
 */
export function filterPrerequisiteCandidates(
  candidates: DerivedEdge[],
  established: EdgeRef[]
): { kept: DerivedEdge[]; dropped: number } {
  // 既有前置图的正向邻接（sourceId → targetId[]）与反向对集合
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
    // 1) 反向矛盾：已确立 B→A 时，候选 A→B 丢弃
    if (reversePairs.has(`${cand.targetId}|${cand.sourceId}`)) {
      dropped++;
      continue;
    }
    // 2) 传递成环：target 已可达 source 时闭合
    if (reaches(cand.targetId, cand.sourceId)) {
      dropped++;
      continue;
    }
    kept.push(cand);
    // 已采纳候选并入图，后续候选与其联合校验（防候选链内部成环）
    const arr = forward.get(cand.sourceId);
    if (arr) arr.push(cand.targetId);
    else forward.set(cand.sourceId, [cand.targetId]);
  }
  return { kept, dropped };
}

// 导出常量供工具注册/文档引用（禁止内联魔法数）
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

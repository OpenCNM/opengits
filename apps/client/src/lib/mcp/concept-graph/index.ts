// ─────────────────────────────────────────────────────────────
// 概念图（TutorialConceptEdge）公共入口
//
// 分层：
//  - 纯逻辑（边预算/边推导/邻居与学习路径 BFS/概念深度）：concept-graph-pure.ts
//  - 读侧 DB 适配（概念解析/邻居/学习路径/拓扑）：concept-graph/concept-queries.ts
//  - 输出格式化：concept-graph-formatter.ts
// 本 index 只做聚合 re-export，保持 '@/lib/mcp/concept-graph' 对外路径不变。
// （2026-11 死代码清算：写侧 edge-sync.ts 已随图谱写尾收敛 Go /v1/concepts/edges/replace 摘除。）
// ─────────────────────────────────────────────────────────────

// 纯逻辑（无 DB 依赖）
export {
  computeRepoEdgeCap,
  prioritizeEdgesForBudget,
  deriveCooccurrenceEdges,
  deriveCurriculumOrderEdges,
  filterPrerequisiteCandidates,
  computeNeighborMap,
  computeLearningPathChain,
  computeConceptDepths,
  CONCEPT_GRAPH_CONSTANTS,
  type ConceptSeed,
  type DerivedEdge,
  type EdgeRef,
} from '@/lib/mcp/concept-graph-pure';

// 读侧：概念解析与图查询（MCP 工具使用）
export {
  resolveConceptNode,
  getConceptNeighbors,
  getLearningPathConcepts,
  getConceptDependencies,
  getConceptCodeContext,
  getConceptGrounding,
  type ConceptGrounding,
  type GroundedSymbolInfo,
  findConceptForDocument,
  buildGraphPositionText,
  buildRepositoryConceptTaxonomy,
} from './concept-queries';

// 输出格式化（MCP 工具文本）
export {
  CONCEPT_TAXONOMY_HEADER,
  CONCEPT_DEPENDENCY_HINT_HEADER,
  LEARNING_PATH_HEADER,
  EDGE_SOURCE_LABELS,
  neighborRelationTag,
  formatDependencyHintText,
  formatConceptTaxonomyGrouped,
  formatLearningPathOutput,
  formatNeighborsOutput,
} from '../concept-graph-formatter';
export type { DependencyHintItem } from '../concept-graph-formatter';

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

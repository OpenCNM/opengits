import type { SymbolEntry } from './symbol-extractor';

export type GraphNodeRole =
  | 'entry_point'
  | 'core_contract'
  | 'pipeline_flow'
  | 'leaf_utility';

export interface SemanticGraphNode {
  path: string;
  language: string;
  inDegree: number;
  outDegree: number;
  pageRank: number;
  role: GraphNodeRole;
  importedBy: string[];
  imports: string[];
  isBackbone: boolean;
  isEntryPoint: boolean;
  symbols: SymbolEntry[];
}

export interface SemanticGraphEdge {
  source: string;
  target: string;
}

export interface SoftGraphEdge extends SemanticGraphEdge {
  kind: 'symbol_reference';
}

export interface GoldenSymbol {
  file: string;
  name: string;
  kind: 'function' | 'type';
  score: number;
  importers: number;
}

export interface CallEdge {
  callerFile: string;
  callerSymbol: string;
  calleeFile: string;
  calleeSymbol: string;
  line: number;
}

export interface SemanticGraphMeta {
  totalFiles: number;
  astParsedFiles: number;
  registryFallbackFiles: number;
  skippedFiles: number;
  droppedTestEdges: number;
  unresolvedImportCount: number;
  softEdgeCount: number;
  ambiguousSoftReferenceCount: number;
  unresolvedCallSiteCount: number;
  grammarsUsed: string[];
}

export interface RepositorySemanticGraph {
  nodes: Record<string, SemanticGraphNode>;
  nodeList: SemanticGraphNode[];
  edges: SemanticGraphEdge[];
  /** Convention-derived edges; excluded from PageRank centrality. */
  softEdges: SoftGraphEdge[];
  goldenSymbols: GoldenSymbol[];
  callEdges: CallEdge[];
  entryPoints: string[];
  backboneNodes: string[];
  coreContractNodes: string[];
  pipelineNodes: string[];
  symbolsByFile: Record<string, SymbolEntry[]>;
  meta: SemanticGraphMeta;
  getNode(path: string): SemanticGraphNode | undefined;
}

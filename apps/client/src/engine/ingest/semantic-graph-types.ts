/**
 * src/engine/ingest/semantic-graph-types.ts
 *
 * Shared types and minimal deterministic utilities for Repository Semantic Graph (RSG).
 *
 * 架构不变式：
 * - 纯类型定义与极简纯函数映射，零 WASM/Tree-Sitter 运行时依赖；
 * - AST 符号提取与 PageRank 构建主权 100% 归 Go worker-sidecar（/v1/graph/* 原生接口，注册表见 internal/daemon/server.go）；
 * - 供 graph-store、cognitive-projector 共享。
 */

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

/** Convention-derived dependency (e.g. Ruby constant reverse match). Excluded from centrality. */
export interface SoftGraphEdge extends SemanticGraphEdge {
  kind: 'symbol_reference';
}

export interface GoldenSymbol {
  file: string;
  name: string;
  kind: 'function' | 'type';
  /** Σ PageRank of distinct importing files — importance weighted by importer weight. */
  score: number;
  importers: number;
}

/** High-confidence call edge: both endpoints verified against AST symbol tables. */
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
  /** Files excluded from parsing (over cap or oversized), still present as isolated nodes */
  skippedFiles: number;
  /** Import edges dropped because their source is a test file (centrality hygiene) */
  droppedTestEdges: number;
  unresolvedImportCount: number;
  /** Convention soft edges — isolated from centrality by design */
  softEdgeCount: number;
  ambiguousSoftReferenceCount: number;
  /** Call edges discarded because their endpoints could not be fully resolved */
  unresolvedCallSiteCount: number;
  grammarsUsed: string[];
}

export interface RepositorySemanticGraph {
  nodes: Record<string, SemanticGraphNode>;
  nodeList: SemanticGraphNode[];
  edges: SemanticGraphEdge[];
  /** Convention-derived edges; never feed centrality/roles — narrative connectivity only. */
  softEdges: SoftGraphEdge[];
  goldenSymbols: GoldenSymbol[];
  /** Both endpoints verified against symbol tables at build time. */
  callEdges: CallEdge[];
  entryPoints: string[];
  backboneNodes: string[];
  coreContractNodes: string[];
  pipelineNodes: string[];
  symbolsByFile: Record<string, SymbolEntry[]>;
  meta: SemanticGraphMeta;
  getNode(path: string): SemanticGraphNode | undefined;
}



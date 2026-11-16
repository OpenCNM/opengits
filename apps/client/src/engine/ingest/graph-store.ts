/**
 * src/engine/ingest/graph-store.ts
 *
 * Persists the compact Repository Semantic Graph (RSG) artifact to local
 * storage: {storeDir}/{owner}/{repo}/{sha}.json — same volume conventions as
 * the tarball archive cache (storage/repos/...).
 *
 * The artifact carries everything the read side needs (fact-grounding path
 * checks, symbol anchoring, cognitive phase of modules) but NOT the full edge
 * list: grounding needs the node path set + symbol tables, and module ordering
 * is computed at ingest time where the full graph is already in memory.
 */

import fs from 'fs-extra';
import path from 'node:path';
import { ENGINE_CONFIG } from '../../lib/config';
import { assertSafeSegments } from '../tarball/archive-store';
import type {
  GraphNodeRole,
  SemanticGraphMeta,
  SemanticGraphEdge,
  SoftGraphEdge,
  GoldenSymbol,
  CallEdge,
} from './semantic-graph-types';
import type { SymbolEntry } from './symbol-extractor';

const SEMANTIC_GRAPH_ARTIFACT_VERSION = 2 as const;

interface SemanticGraphArtifactNode {
  path: string;
  language: string;
  inDegree: number;
  outDegree: number;
  pageRank: number;
  role: GraphNodeRole;
  isBackbone: boolean;
  isEntryPoint: boolean;
}

interface SemanticGraphArtifact {
  version: typeof SEMANTIC_GRAPH_ARTIFACT_VERSION;
  generatedAt: string;
  gitSha: string;
  nodes: SemanticGraphArtifactNode[];
  entryPoints: string[];
  backboneNodes: string[];
  coreContractNodes: string[];
  pipelineNodes: string[];
  symbolsByFile: Record<string, SymbolEntry[]>;
  edges?: SemanticGraphEdge[];
  /** Convention-derived edges (excluded from centrality). */
  softEdges: SoftGraphEdge[];
  goldenSymbols: GoldenSymbol[];
  /** High-confidence call edges (both endpoints verified at build time). */
  callEdges: CallEdge[];
  meta: SemanticGraphMeta;
}

function semanticGraphPathFor(owner: string, repo: string, sha: string): string {
  assertSafeSegments(owner, repo, sha);
  return path.join(ENGINE_CONFIG.semanticGraph.storeDir, owner, repo, `${sha}.json`);
}

export async function loadSemanticGraphArtifact(
  owner: string,
  repo: string,
  sha: string
): Promise<SemanticGraphArtifact | null> {
  try {
    const file = semanticGraphPathFor(owner, repo, sha);
    if (!(await fs.pathExists(file))) return null;
    const artifact = await fs.readJson(file);
    if (artifact?.version !== SEMANTIC_GRAPH_ARTIFACT_VERSION) return null;
    return artifact as SemanticGraphArtifact;
  } catch (err) {
    console.warn(`[SemanticGraph] Failed to load artifact ${owner}/${repo}@${sha}`, err);
    return null;
  }
}

// ── 骨架漂移指数（Graph Drift Index）─────────────────────────────────────────

export interface BackboneDrift {
  /** |removed ∪ added| / |union| — 0 = 骨架稳定, 1 = 主干彻底换代 */
  index: number;
  addedBackbone: string[];
  removedBackbone: string[];
  unionSize: number;
}

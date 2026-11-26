import { MODULE_ROLE_PATTERNS } from './language-map';
import type { ArchiveDiff } from './repo-tarball';
import type { GitHubNode } from './fetcher';
import type { BackboneDrift } from './ingest/graph-store';

type FileChangeKind = 'added' | 'modified' | 'removed' | 'renamed';

export interface AffectedFile {
  path: string;
  change: FileChangeKind;
}

export interface UpdateCandidateChapter {
  path: string;
  title: string | null;
  oldSummary: string | null;
  change: 'content' | 'structural';
  affectedFiles: AffectedFile[];
  rename?: { from: string; to: string };
  // Deterministic infra-only edits bypass LLM planning and pre-fill keep.
  keepExemption?: { reason: string; evidence: string };
  surgicalAnchors?: Array<{
    symbolName: string;
    kind: string;
    file: string;
    change: string;
    exported: boolean;
    line: number;
    reason: string;
    diffSnippet?: string;
  }>;
  isBreaking?: boolean;
}

type NodeDriftStatus = 'stable' | 'modified' | 'breaking';
type EdgeDriftStatus = 'stable' | 'ripple' | 'broken';

interface NodeDriftInfo {
  nodeId: string;
  path: string;
  name: string;
  status: NodeDriftStatus;
  summary: string;
  changedFiles: string[];
  rippleFiles: string[];
}

interface EdgeDriftInfo {
  from: string;
  to: string;
  status: EdgeDriftStatus;
  reason?: string;
}

export interface ArchitectureDrift {
  hasDrift: boolean;
  isCrossBoundary: boolean;
  verdict: string;
  affectedNodes: NodeDriftInfo[];
  affectedEdges: EdgeDriftInfo[];
  driftMermaid: string;
}

export interface UpdateCandidateSet {
  chapters: UpdateCandidateChapter[];
  unmatchedFiles: AffectedFile[];
  structuralAdds: UpdateCandidateChapter[];
  structuralRemoves: UpdateCandidateChapter[];
  diffStats: { added: number; modified: number; removed: number; renamed: number };
  hasOldArchive: boolean;
  graphDrift?: BackboneDrift;
  architectureDrift?: ArchitectureDrift;
  suggestsNewEdition?: boolean;
  isBreaking?: boolean;
}

export interface BuildUpdateCandidateSetParams {
  owner: string;
  repo: string;
  branch: string;
  fromSha: string;
  toSha: string;
  repositoryId: string;
  docOwnerId?: string | null;
  repoProfile?: Record<string, unknown> | null;
  diff?: ArchiveDiff | null;
  newTree?: GitHubNode[] | null;
  documentsOverride?: Array<{ path: string; title: string | null; summary: string | null }>;
  token?: string;
}

export function codeChapterPath(teachingOrder: number): string {
  return `chapters/${String(teachingOrder).padStart(2, '0')}.mdx`;
}

// chapterNo binds virtual paths to initial import order so re-clustering never shifts existing chapter URLs.
export function clusterChapterNo(cluster: { chapterNo?: number; teachingOrder: number }): number {
  return cluster.chapterNo ?? cluster.teachingOrder;
}

export function isCodeChapterPath(p: string): boolean {
  return MODULE_ROLE_PATTERNS.virtualChapterPathPrefixes.some((prefix) => p.startsWith(prefix));
}

export async function buildUpdateCandidateSet(
  params: BuildUpdateCandidateSetParams
): Promise<UpdateCandidateSet> {
  const { executeSidecarCandidateSet } = await import('./update-candidate-driver');
  return await executeSidecarCandidateSet(params);
}

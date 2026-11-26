import type { ExclusionReport, GitHubNode } from '@/engine/fetcher';
import type { RepoProfile } from '@/engine/repo-sniffer';
import type { DedupResult } from '@/lib/repo-dedup';
import type { DirTreeNode, VersionEntry } from '@/lib/dir-verdict';
import type { ScopeVerdict } from './scope-verdict';

export type ScoutTree = GitHubNode[] & {
  truncated?: boolean;
  exclusionReport?: ExclusionReport;
};

export class ScoutPipelineError extends Error {
  readonly scoutStatus: string;
  readonly displayError: string;
  readonly diagnosticDescription?: string;
  readonly suggestedFormat?: string;
  readonly httpStatus: number;
  readonly extra?: Record<string, unknown>;

  constructor(fields: {
    status: string;
    error: string;
    httpStatus: number;
    diagnosticDescription?: string;
    suggestedFormat?: string;
    extra?: Record<string, unknown>;
  }) {
    super(fields.error);
    this.name = 'ScoutPipelineError';
    this.scoutStatus = fields.status;
    this.displayError = fields.error;
    this.httpStatus = fields.httpStatus;
    this.diagnosticDescription = fields.diagnosticDescription;
    this.suggestedFormat = fields.suggestedFormat;
    this.extra = fields.extra;
  }

  toJSON(): Record<string, unknown> {
    return {
      status: this.scoutStatus,
      error: this.displayError,
      ...(this.extra ?? {}),
      ...(this.diagnosticDescription !== undefined ? { diagnosticDescription: this.diagnosticDescription } : {}),
      ...(this.suggestedFormat !== undefined ? { suggestedFormat: this.suggestedFormat } : {}),
      httpStatus: this.httpStatus,
    };
  }
}

export function isScoutPipelineError(err: unknown): err is ScoutPipelineError {
  return err instanceof ScoutPipelineError;
}

export interface ScoutStepInfo {
  stage: string;
  tag: string;
  title: string;
  detail: string;
}

export type ScoutStepReporter = (step: ScoutStepInfo) => Promise<void>;

export interface ScoutVersionCandidate extends VersionEntry {
  totalFiles: number;
  totalBytes: number;
  sizeMb: string;
  estimatedTokens: number;
  isOversized: boolean;
}

export interface SameSourceSummary {
  owner: string;
  repo: string;
  similarity: number;
  method: string;
}

export interface ScoutDedupInfo extends DedupResult {
  currentSha: string | null;
  importedSha: string | null;
  hasUpdate: boolean;
}

export interface ScoutPipelineInput {
  owner: string;
  repo: string;
  userId: string;
  urlBranch?: string;
  customPrompt?: string;
  activeParadigm?: string;
  targetLanguage?: string;
  prefixFilter?: string;
  importScopeMode?: string;
  filePath?: string;
  inspectionFilePath?: string;
}

export interface ScoutPipelineResult {
  owner: string;
  repo: string;
  branch: string;
  currentSha: string | null;
  starCount: number;
  pushedAt: string | null;
  profile: RepoProfile;
  versions: ScoutVersionCandidate[];
  dirTree: DirTreeNode[];
  aiCategory: string;
  aiTags: string;
  paradigm: string;
  parallelTracks: string[];
  exclusionReport?: ExclusionReport;
  dedupInfo: ScoutDedupInfo;
  sameSource: SameSourceSummary | null;
  scopeVerdict: ScopeVerdict | null;
}

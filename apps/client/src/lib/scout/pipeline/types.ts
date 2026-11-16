import type { ExclusionReport, GitHubNode } from '@/engine/fetcher';
import type { RepoProfile } from '@/engine/repo-sniffer';
import type { DedupResult } from '@/lib/repo-dedup';
import type { DirTreeNode, VersionEntry } from '@/lib/dir-verdict';
import type { ScopeVerdict } from './scope-verdict';

/** scout 全树：API 路径附带截断标记与排除报告；归档路径为纯节点数组 */
export type ScoutTree = GitHubNode[] & {
  truncated?: boolean;
  exclusionReport?: ExclusionReport;
};

/**
 * scout 管道可预期失败。旧的匿名 throw 对象（{ status, error, ... }）收敛为本类型；
 * toJSON() 保证 SSE / 同步两条响应路径的线格式与重构前逐字段一致。
 */
export class ScoutPipelineError extends Error {
  /** 机器可读状态（如 NOT_FOUND / RATE_LIMITED），同时是线格式字段 */
  readonly scoutStatus: string;
  /** 展示给用户的一句话错误 */
  readonly displayError: string;
  readonly diagnosticDescription?: string;
  readonly suggestedFormat?: string;
  readonly httpStatus: number;
  /** 线格式附加快照（如 token 过期的 code 字段） */
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

  /** 与重构前匿名 throw 对象的 JSON 序列化结果逐字段一致 */
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

/** SSE 进度事件 */
export interface ScoutStepInfo {
  stage: string;
  tag: string;
  title: string;
  detail: string;
}

export type ScoutStepReporter = (step: ScoutStepInfo) => Promise<void>;

/** 带体积统计的候选目录（VersionEntry + scout 汇总字段） */
export interface ScoutVersionCandidate extends VersionEntry {
  totalFiles: number;
  totalBytes: number;
  sizeMb: string;
  estimatedTokens: number;
  isOversized: boolean;
}

/** 同源相似检测横幅数据（summarizeDetection 产物） */
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
  /** 用户显式指定的分支；空则跟随仓库默认分支 */
  urlBranch?: string;
  customPrompt?: string;
  activeParadigm?: string;
  targetLanguage?: string;
  prefixFilter?: string;
  importScopeMode?: string;
  filePath?: string;
  /** URL 命中的子路径前缀（resourceType=tree 时并入候选范围） */
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
  /** AI 目标目录裁决；null = 无模型/失败（无自动推荐，用户在确认页手选） */
  scopeVerdict: ScopeVerdict | null;
}

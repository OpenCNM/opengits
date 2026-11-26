import { callSidecar, type SidecarCallOptions } from '../lib/sidecar-client';
import type { GitHubNode, ExclusionReport } from './fetcher';
import type { RepoProfile, ScaleDecision } from './repo-sniffer';
import type { DirTreeNode } from '../lib/dir-verdict';

interface ScoutInspectParams {
  owner: string;
  repo: string;
  branch?: string;
  sha?: string | null;
  token?: string;
  prefixFilter?: string;
  filePath?: string;
  singleDocMode?: boolean;
  maxDepth?: number;
  stars?: number;
  forks?: number;
}

interface ScoutInspectResponse {
  ok: boolean;
  archiveUsed: boolean;
  totalNodeCount: number;
  markdownFiles: GitHubNode[];
  profile: RepoProfile;
  scale: ScaleDecision;
  dirTree: DirTreeNode[];
  exclusionReport: ExclusionReport;
  skeleton: string;
  skeletonHash: string;
  truncated: boolean;
  reputation?: {
    tier: 'high' | 'standard' | 'suspicious';
    reason: string;
    quotas: {
      maxUnpackCapBytes: number;
      maxFiles: number;
      allowGiantScope: boolean;
    };
    isClassic: boolean;
    isRejected: boolean;
  };
  readmeSnippet?: string;
}

interface ScoutDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function executeSidecarScoutInspect(
  params: ScoutInspectParams,
  options?: ScoutDriverOptions
): Promise<ScoutInspectResponse> {
  const payload = {
    owner: params.owner,
    repo: params.repo,
    branch: params.branch,
    sha: params.sha || undefined,
    token: params.token,
    prefixFilter: params.prefixFilter,
    filePath: params.filePath,
    singleDocMode: params.singleDocMode,
    maxDepth: params.maxDepth,
    stars: params.stars,
    forks: params.forks,
  };

  const res = await callSidecar<ScoutInspectResponse>(
    '/v1/scout/inspect',
    payload,
    {
      label: 'scout /v1/scout/inspect',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );

  if (!res.ok) {
    throw new Error('scout /v1/scout/inspect: response ok is false');
  }

  return res;
}

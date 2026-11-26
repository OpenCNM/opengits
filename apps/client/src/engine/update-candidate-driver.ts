import { callSidecar } from '../lib/sidecar-client';
import type { BuildUpdateCandidateSetParams, UpdateCandidateSet } from './update-candidate-set';
import type { ApplyUpdatePlanParams, ApplyUpdateResult } from './update-applier';

interface UpdateCandidateDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function executeSidecarCandidateSet(
  params: BuildUpdateCandidateSetParams,
  options?: UpdateCandidateDriverOptions
): Promise<UpdateCandidateSet> {
  const reqPayload = {
    owner: params.owner,
    repo: params.repo,
    branch: params.branch,
    fromSha: params.fromSha,
    toSha: params.toSha,
    repositoryId: params.repositoryId,
    docOwnerId: params.docOwnerId ?? null,
    repoProfile: params.repoProfile ?? null,
    diff: params.diff
      ? {
          added: Array.from(params.diff.added),
          modified: Array.from(params.diff.modified),
          removed: Array.from(params.diff.removed),
          renamed: params.diff.renamed,
        }
      : null,
    newTree: params.newTree ?? null,
    documents: params.documentsOverride ?? null,
  };

  const res = await callSidecar<UpdateCandidateSet>(
    '/v1/update/candidate-set',
    reqPayload,
    {
      label: 'update-candidate /v1/update/candidate-set',
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options?.signal,
    }
  );

  if (
    !Array.isArray(res.chapters) ||
    !Array.isArray(res.unmatchedFiles) ||
    !res.diffStats
  ) {
    throw new Error('update-candidate /v1/update/candidate-set: malformed candidate set payload');
  }

  return res;
}

const APPLY_DEFAULT_TIMEOUT_MS = 30_000;

export async function executeSidecarUpdateApply(
  params: ApplyUpdatePlanParams,
  options?: UpdateCandidateDriverOptions
): Promise<ApplyUpdateResult> {
  const reqPayload = {
    repositoryId: params.repositoryId,
    userId: params.userId,
    docOwnerId: params.docOwnerId ?? null,
    fromSha: params.fromSha,
    toSha: params.toSha,
    plan: params.plan,
    candidateSet: params.candidateSet,
    runId: params.runId ?? null,
  };

  const res = await callSidecar<{ ok: boolean; result: ApplyUpdateResult }>(
    '/v1/update/apply',
    reqPayload,
    {
      label: 'update-applier /v1/update/apply',
      timeoutMs: options?.timeoutMs ?? APPLY_DEFAULT_TIMEOUT_MS,
      signal: options?.signal,
    }
  );

  if (!res || !res.result) {
    throw new Error('update-applier /v1/update/apply: malformed response payload');
  }

  return res.result;
}

import { callSidecar } from '../lib/sidecar-client';

interface SidecarLlmsTxtRequest {
  repositoryId: string;
  owner: string;
  repo: string;
  version?: string;
  baseUrl: string;
  full?: boolean;
  budget?: number;
  topic?: string;
  mode?: 'strict' | 'balanced';
  userId?: string | null;
}

interface SidecarLlmsTxtResult {
  content: string;
  estimatedTokens: number;
  downgradedCount: number;
  targetVersion: string;
}

interface SidecarLlmsTxtDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function executeSidecarLlmsTxt(
  req: SidecarLlmsTxtRequest,
  options?: SidecarLlmsTxtDriverOptions
): Promise<SidecarLlmsTxtResult | null> {
  const payload = {
    repositoryId: req.repositoryId,
    owner: req.owner,
    repo: req.repo,
    version: req.version,
    baseUrl: req.baseUrl,
    full: req.full ?? false,
    budget: req.budget,
    topic: req.topic,
    mode: req.mode,
    userId: req.userId ?? undefined,
  };

  return await callSidecar<SidecarLlmsTxtResult>(
    '/v1/llms-txt/generate',
    payload,
    {
      label: 'llms-txt /v1/llms-txt/generate',
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    }
  );
}

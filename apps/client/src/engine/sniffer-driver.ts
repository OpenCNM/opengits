import { callSidecar, type SidecarCallOptions } from '../lib/sidecar-client';
import type { GitHubNode } from './fetcher';
import type { RepoProfile, ScaleDecision } from './repo-sniffer';

interface SidecarArchiveTreeResponse {
  ok: boolean;
  nodes: GitHubNode[];
}

interface SidecarSniffParams {
  owner?: string;
  repo?: string;
  sha?: string;
  nodes?: GitHubNode[];
  isTreeTruncated?: boolean;
}

interface SidecarSniffResponse {
  ok: boolean;
  profile: RepoProfile;
  scale: ScaleDecision;
}

interface SniffDriverResult {
  profile: RepoProfile;
  scale: ScaleDecision;
}

interface ArchiveDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function executeSidecarArchiveTree(
  owner: string,
  repo: string,
  sha: string,
  options?: ArchiveDriverOptions
): Promise<GitHubNode[]> {
  const res = await callSidecar<SidecarArchiveTreeResponse>(
    '/v1/archive/tree',
    { owner, repo, sha },
    { label: 'archive /v1/archive/tree', ...options }
  );

  if (!res.ok || !Array.isArray(res.nodes)) {
    throw new Error('sniffer /v1/archive/tree: malformed nodes payload');
  }

  return res.nodes.map((node) => {
    const raw = node as unknown as Record<string, unknown>;
    const path = typeof node.path === 'string' ? node.path : (typeof raw.Path === 'string' ? raw.Path : '');
    const typeStr = typeof node.type === 'string' ? node.type : (typeof raw.Type === 'string' ? raw.Type : 'blob');
    const type = typeStr === 'tree' ? 'tree' : 'blob';
    const size = typeof node.size === 'number' ? node.size : (typeof raw.Size === 'number' ? raw.Size : undefined);
    return {
      path,
      type,
      size,
      mode: node.mode || (type === 'tree' ? '040000' : '100644'),
      sha: node.sha || '',
      url: node.url || '',
    };
  });
}

export async function executeSidecarSniff(
  params: SidecarSniffParams,
  options?: ArchiveDriverOptions
): Promise<SniffDriverResult> {
  const payload: Record<string, unknown> = {};

  if (params.owner && params.repo && params.sha) {
    payload.owner = params.owner;
    payload.repo = params.repo;
    payload.sha = params.sha;
  } else if (params.nodes) {
    payload.nodes = params.nodes.map((n) => ({
      path: n.path,
      type: n.type,
      size: n.size,
    }));
  } else {
    throw new Error('sniffer /v1/archive/sniff: owner/repo/sha 或 nodes 至少提供其一');
  }

  if (params.isTreeTruncated !== undefined) {
    payload.isTreeTruncated = params.isTreeTruncated;
  }

  const res = await callSidecar<SidecarSniffResponse>(
    '/v1/archive/sniff',
    payload,
    { label: 'archive /v1/archive/sniff', ...options }
  );

  if (!res.ok || !res.profile || !res.scale) {
    throw new Error('sniffer /v1/archive/sniff: malformed profile payload');
  }

  const profile: RepoProfile = {
    ...res.profile,
    globalAssets: {
      pdfs: res.profile.globalAssets?.pdfs ?? [],
      translations: res.profile.globalAssets?.translations ?? [],
      buildScripts: res.profile.globalAssets?.buildScripts ?? [],
      misc: res.profile.globalAssets?.misc ?? [],
    },
    labRoots: res.profile.labRoots ?? [],
    translationRoots: res.profile.translationRoots ?? [],
    excludeFromNav: res.profile.excludeFromNav ?? [],
    semanticTags: res.profile.semanticTags ?? {},
  };

  return {
    profile,
    scale: res.scale,
  };
}

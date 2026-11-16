/**
 * apps/client/src/engine/sniffer-driver.ts
 *
 * 归档目录树提取与仓库拓扑画像嗅探引擎驱动（TypeScript 端向 Go worker-sidecar 发起调用）。
 *
 * 架构不变式：
 * 1. 优先调用 Go worker-sidecar 原生 HTTP 接口（/v1/archive/*），实现 Zero-Tree-Transport
 *    （零万级目录树 V8 跨进程搬运），彻底消除大量节点在 Node.js 与 Sidecar 间的序列化损耗；
 * 2. 透明容灾与 Fail-Open 优雅降级：若 worker-sidecar 未启动、不可达或返回非 2xx，
 *    ——2026-09-11 收刀：本地 treeFromArchive/sniffRepo 双轨已物理删除，
 *    sidecar 故障显式抛 SidecarError（修复动作在 Go 端），契约由冻结夹具锁定。
 */

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

/**
 * 从 Sidecar 解压归档直接读取文件树（Go worker-sidecar 单实现，Fail-Closed）。
 */
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

/**
 * 拓扑画像与规模判定嗅探（优先 Zero-Tree Mode A，次选 Nodes Mode B；Fail-Closed 单实现）。
 */
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

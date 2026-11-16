// 职责：tree 解析（repo-tarball 拆分模块之三）。
// - 经 Go worker-sidecar 从解压归档读取目录树节点（treeFromArchive，0 网络，
//   Fail-Closed 单实现——2026-09-11 收刀：本地 fs 遍历双轨已物理删除）
// - 仅提供 path/type/size；归档缺失由 sidecar 404 显式抛错（原 null 回退语义
//   收敛为故障可见）。

import type { GitHubNode } from '../fetcher';
import { executeSidecarArchiveTree } from '../sniffer-driver';

/**
 * 从归档推导 Git 目录树节点（Go worker-sidecar 单实现，Fail-Closed）。
 * 归档即唯一事实源——结构（tree）与内容（文件）全部来自挂载卷。
 * 下游分析（sniff/verdict/recon/ranker）只消费 path/type/size，url/sha/mode 留空安全。
 */
export async function treeFromArchive(
  owner: string,
  repo: string,
  sha: string
): Promise<GitHubNode[]> {
  return await executeSidecarArchiveTree(owner, repo, sha);
}

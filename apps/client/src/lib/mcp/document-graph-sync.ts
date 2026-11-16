import { executeSidecarDocStoreChunks } from '@/engine/doc-store-driver';

/**
 * 知识图谱后处理（共享，2026-10 收口为 Fail-Closed 单实现）：
 * FTS 切片 + 概念抽取 + 共现边 + 教学序边（+ LLM 概念边，经 Go 落库尾端钩子）
 * 一站式闭环于 Go /v1/doc/store-chunks——供入库侧原文素材（代码素材 / doc 附页，
 * PROCESSED 直存不进转录队列）与更新市场直换后重建共用。
 *
 * 公理5 收口：原「Sidecar 异常 Fail-Open 降级本地 Node 串行落库」双轨已退役
 * ——本地回退会产出与 Go 口径漂移的图谱数据，且掩盖 sidecar 故障。现为
 * Fail-Closed 显式抛错；调用方按「图谱=尽力而为增强」语义各自捕获吞错
 * （主流程不受阻，下次重开/更新自然重建）。
 */
export async function syncDocumentKnowledgeGraph(
  repositoryId: string,
  documentId: string,
  docPath: string,
  content: string,
  opts?: { skipLlmEdges?: boolean; moduleName?: string; sourceFiles?: string[] }
): Promise<void> {
  if (!content || content.trim() === '') return;
  void repositoryId; // 归属仓库由服务端按 docId 解析（请求体零冗余字段）

  const res = await executeSidecarDocStoreChunks({
    docId: documentId,
    content,
    moduleName: opts?.moduleName,
    sourceFiles: opts?.sourceFiles,
    options: { skipLlmEdges: opts?.skipLlmEdges },
  });
  if (!res.ok) {
    throw new Error(`knowledge graph sync failed for ${docPath}: ${res.message ?? 'unknown'}`);
  }
}

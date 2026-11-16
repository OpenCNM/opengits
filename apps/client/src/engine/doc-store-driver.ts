/**
 * apps/client/src/engine/doc-store-driver.ts
 *
 * 文档切片直写（POST /v1/doc/store-chunks）的 Go worker-sidecar TS 驱动层。
 * Fail-Closed 单实现：本地 Prisma 收尾管线已物理删除——sidecar 故障显式抛
 * SidecarError；转录收尾（finalize）全链闭环于 Go 进程内，不经本层。
 */

import { callSidecar } from '@/lib/sidecar-client';

interface DocStoreChunkItem {
  heading: string;
  content: string;
  headingPath?: string | null;
  contentType?: string;
}

interface DocStoreChunksOptions {
  targetLanguage?: string;
  customPrompt?: string;
  transcriptionPreset?: string;
  aiCondensation?: string;
  teachingDepth?: string;
  userId?: string | null;
  forceEnhance?: boolean;
  /** 原文素材（代码/附页）跳过 LLM 概念边：成本控制（Go 落库尾端钩子消费） */
  skipLlmEdges?: boolean;
  summary?: string;
  moduleName?: string;
  sourceFiles?: string[];
}

interface DocStoreChunksParams {
  docId: string;
  content: string;
  chunks?: DocStoreChunkItem[];
  chunksStored?: boolean;
  options?: DocStoreChunksOptions;
  moduleName?: string;
  sourceFiles?: string[];
}

interface DocStoreChunksResponse {
  ok: boolean;
  message?: string;
}

/**
 * 委托 worker-sidecar 执行文档切片批量直写、概念抽取、元数据、共现边与教学序边一站式闭环。
 */
export async function executeSidecarDocStoreChunks(
  params: DocStoreChunksParams
): Promise<DocStoreChunksResponse> {
  return await callSidecar<DocStoreChunksResponse>(
    '/v1/doc/store-chunks',
    params,
    {
      label: 'doc /v1/doc/store-chunks',
      timeoutMs: 15_000,
    }
  );
}

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

import { executeSidecarDocStoreChunks } from '@/engine/doc-store-driver';

// Fail-closed wrapper over Go /v1/doc/store-chunks; callers catch non-critical graph errors explicitly.
export async function syncDocumentKnowledgeGraph(
  repositoryId: string,
  documentId: string,
  docPath: string,
  content: string,
  opts?: { skipLlmEdges?: boolean; moduleName?: string; sourceFiles?: string[] }
): Promise<void> {
  if (!content || content.trim() === '') return;
  void repositoryId;

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

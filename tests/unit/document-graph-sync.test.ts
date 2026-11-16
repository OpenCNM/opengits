import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * syncDocumentKnowledgeGraph 单测（2026-10 Fail-Closed 收口）：
 * 单实现 = Go /v1/doc/store-chunks 一站式闭环（切片+概念+共现+课程边，
 * LLM 边经 Go 落库尾端钩子）；sidecar 故障显式抛错交调用方吞错——
 * 原「Fail-Open 本地串行回退」双轨已随公理5收口退役。
 */
const storeChunksMock = vi.fn();

vi.mock('@/engine/doc-store-driver', () => ({
  executeSidecarDocStoreChunks: (...args: unknown[]) => storeChunksMock(...args),
}));

import { syncDocumentKnowledgeGraph } from '@/lib/mcp/document-graph-sync';

describe('syncDocumentKnowledgeGraph (Go 单实现 Fail-Closed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空内容时不发起任何落库请求', async () => {
    await syncDocumentKnowledgeGraph('repo-1', 'doc-1', 'docs/a.md', '   ');
    expect(storeChunksMock).not.toHaveBeenCalled();
  });

  it('正常路径：一站式透传至 store-chunks（含 skipLlmEdges 选项）', async () => {
    storeChunksMock.mockResolvedValue({ ok: true });
    await syncDocumentKnowledgeGraph('repo-1', 'doc-1', 'docs/a.md', '# 内容', {
      skipLlmEdges: true,
      moduleName: 'M1',
      sourceFiles: ['src/a.ts'],
    });
    expect(storeChunksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: 'doc-1',
        content: '# 内容',
        moduleName: 'M1',
        sourceFiles: ['src/a.ts'],
        options: { skipLlmEdges: true },
      })
    );
  });

  it('sidecar 异常时显式抛错（Fail-Closed，不再回退本地双轨）', async () => {
    storeChunksMock.mockRejectedValue(new Error('sidecar unreachable'));
    await expect(
      syncDocumentKnowledgeGraph('repo-1', 'doc-1', 'docs/a.md', '# 内容')
    ).rejects.toThrow(/sidecar unreachable/);
  });

  it('sidecar 返回 ok: false 时抛错并透传原因（调用方按增强语义吞错）', async () => {
    storeChunksMock.mockResolvedValue({ ok: false, message: 'store metadata failed' });
    await expect(
      syncDocumentKnowledgeGraph('repo-1', 'doc-1', 'docs/a.md', '# 内容')
    ).rejects.toThrow(/store metadata failed/);
  });
});

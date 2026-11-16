import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useDocumentStore } from '@/lib/stores/document-store';
import { trackEvent } from '@/lib/telemetry/beacon';

describe('useDocumentStore（文档与仓库上下文状态）', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { pathname: '/docs/chapter-1' },
      dispatchEvent: () => true,
    });
    useDocumentStore.getState().clearDocumentContext();
  });

  it('初始状态 documentId 与 repositoryId 均为 null，isTranscribed 为 false', () => {
    const state = useDocumentStore.getState();
    expect(state.documentId).toBeNull();
    expect(state.repositoryId).toBeNull();
    expect(state.isTranscribed).toBe(false);
  });

  it('setDocumentContext 能够正确设置 documentId、repositoryId 与 isTranscribed', () => {
    useDocumentStore.getState().setDocumentContext({
      documentId: 'doc-123',
      repositoryId: 'repo-abc',
    });

    let state = useDocumentStore.getState();
    expect(state.documentId).toBe('doc-123');
    expect(state.repositoryId).toBe('repo-abc');
    expect(state.isTranscribed).toBe(true);

    useDocumentStore.getState().setDocumentContext({
      documentId: 'doc-456',
      repositoryId: 'repo-abc',
      isTranscribed: false,
    });

    state = useDocumentStore.getState();
    expect(state.documentId).toBe('doc-456');
    expect(state.isTranscribed).toBe(false);
  });

  it('clearDocumentContext 能够清空上下文，并支持 docId 防抖保护', () => {
    useDocumentStore.getState().setDocumentContext({
      documentId: 'doc-123',
      repositoryId: 'repo-abc',
      isTranscribed: true,
    });

    // 尝试清理不匹配的旧 docId：状态应当保留
    useDocumentStore.getState().clearDocumentContext('doc-old');
    let state = useDocumentStore.getState();
    expect(state.documentId).toBe('doc-123');
    expect(state.isTranscribed).toBe(true);

    // 清理当前 docId：正常清空
    useDocumentStore.getState().clearDocumentContext('doc-123');
    state = useDocumentStore.getState();
    expect(state.documentId).toBeNull();
    expect(state.repositoryId).toBeNull();
    expect(state.isTranscribed).toBe(false);
  });

  it('遥测 trackEvent 能够直接消费 useDocumentStore 中的 repositoryId', () => {
    useDocumentStore.getState().setDocumentContext({
      documentId: 'doc-chapter-1',
      repositoryId: 'repo-999',
    });

    const payload: any = { eventType: 'page_view' as any };
    trackEvent(payload);

    expect(payload.repositoryId).toBe('repo-999');
  });
});

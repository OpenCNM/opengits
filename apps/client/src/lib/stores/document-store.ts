import { create } from 'zustand';

interface DocumentStoreState {
  documentId: string | null;
  repositoryId: string | null;
  isTranscribed: boolean;

  // Actions
  setDocumentContext: (context: {
    documentId: string | null;
    repositoryId: string | null;
    isTranscribed?: boolean;
  }) => void;
  clearDocumentContext: (docIdToClear?: string) => void;
}

export const useDocumentStore = create<DocumentStoreState>((set) => ({
  documentId: null,
  repositoryId: null,
  isTranscribed: false,

  // 幂等：值未变时返回原 state 对象，zustand 跳过通知——
  // 允许 DocumentProvider 在 render 期反复调用而不触发订阅者风暴
  setDocumentContext: ({ documentId, repositoryId, isTranscribed = true }) =>
    set((s) =>
      s.documentId === documentId &&
      s.repositoryId === repositoryId &&
      s.isTranscribed === isTranscribed
        ? s
        : { documentId, repositoryId, isTranscribed }
    ),

  clearDocumentContext: (docIdToClear?: string) =>
    set((s) => {
      if (docIdToClear && s.documentId !== docIdToClear) {
        return s;
      }
      return {
        documentId: null,
        repositoryId: null,
        isTranscribed: false,
      };
    }),
}));

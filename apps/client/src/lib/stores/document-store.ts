import { create } from 'zustand';

interface DocumentStoreState {
  documentId: string | null;
  repositoryId: string | null;
  isTranscribed: boolean;

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

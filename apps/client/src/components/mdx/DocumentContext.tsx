'use client';

import React, { useEffect } from 'react';
import { useDocumentStore } from '@/lib/stores/document-store';

export function DocumentProvider({
  children,
  documentId,
  repositoryId,
}: {
  children: React.ReactNode;
  documentId: string;
  repositoryId: string;
}) {
  useEffect(() => {
    useDocumentStore.getState().setDocumentContext({ documentId, repositoryId, isTranscribed: true });
    return () => {
      useDocumentStore.getState().clearDocumentContext(documentId);
    };
  }, [documentId, repositoryId]);

  return <>{children}</>;
}


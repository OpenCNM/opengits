import { McpToolDefinition, DocumentStatus } from '@/lib/constants';

export interface McpConnectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  title?: string;
}

export interface ReadinessData {
  repositoryId: string;
  totalDocuments: number;
  processedDocuments: number;
  errorDocuments: number;
  documents: Array<{
    id: string;
    path: string;
    title: string | null;
    status: DocumentStatus;
    errorMessage?: string | null;
  }>;
  chunkStats: {
    total: number;
    byContentType: Record<string, number>;
  };
  gotchaCount: number;
  tools: McpToolDefinition[];
}

export interface NavNodeItem {
  name: string;
  title: string;
  shortTitle?: string;
  type: 'file' | 'directory';
  path: string;
  url?: string;
  sourceUrl?: string;
  indexPath?: string;
  indexTitle?: string;
  indexUrl?: string;
  children?: NavNodeItem[];
}

export interface HeadingItem {
  level: number;
  text: string;
  id: string;
}

export interface DocumentItem {
  path: string;
  title: string;
  markdown: string;
  url: string;
  contentHash: string;
  headings: HeadingItem[];
  metadata?: Record<string, unknown>;
}

export interface WebDocDiffResult {
  hasChanges: boolean;
  etag?: string;
  /** Must be persisted by the caller as next-sync baseline to avoid re-classifying unchanged pages as updates. */
  sitemapLastModMap?: Record<string, string>;
  totalPages?: number;
  pagesToAdd: string[];
  pagesToUpdate: string[];
  pagesToRemove: string[];
  totalChanged: number;
}

export type RepoScale = 'normal' | 'giant' | 'ambiguous';

export interface MonorepoVolume {
  name: string;
  prefix: string;
  fileCount: number;
  category: string;
  suggestedTitle: string;
}

export interface ScaleDecision {
  scale: RepoScale;
  confidence: 'high' | 'low';
  reason: string;
  totalFiles: number;
  maxDepth: number;
  volumes?: MonorepoVolume[];
}


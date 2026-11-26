export interface DetectionTreeNode {
  path: string;
  type: string;
}

export interface DetectionContext {
  owner: string;
  repo: string;
  branch: string;
  gitSha?: string | null;
  treeNodes?: DetectionTreeNode[] | null;
  forkUpstream?: { owner: string; repo: string } | null;
  existingSignature?: {
    skeleton?: string | null;
    skeletonHash?: string | null;
  };
}

export interface SkeletonFeature {
  detectorKey: 'skeleton-trgm';
  skeleton: string;
  skeletonHash: string;
}

export interface GitShaFeature {
  detectorKey: 'git-sha';
  gitSha: string;
}

export interface ForkMetaFeature {
  detectorKey: 'fork-meta';
  upstream: { owner: string; repo: string };
}

export type SignalFeature = SkeletonFeature | GitShaFeature | ForkMetaFeature;

export interface SignalMatch {
  detectorKey: string;
  repositoryId: string;
  owner: string;
  repo: string;
  similarity: number;
}

export interface MatchOptions {
  limit?: number;
  exclude?: { owner: string; repo: string };
}

export interface SourceDetectionResult {
  matches: SignalMatch[];
  best: SignalMatch | null;
  features: SignalFeature[];
}

export interface SourceSignalDetector {
  key: string;
  extract?(ctx: DetectionContext): Promise<SignalFeature | null>;
  match(feature: SignalFeature, opts?: MatchOptions): Promise<SignalMatch[]>;
}

export const SIGNAL_METHOD_LABELS: Record<string, string> = {
  'git-sha': '同一 commit',
  'fork-meta': 'Fork 派生',
  'skeleton-trgm': '目录结构',
};

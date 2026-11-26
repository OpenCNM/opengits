import type { SourceSignalDetector } from './types';
import { gitShaDetector } from './detectors/git-sha';
import { forkMetaDetector } from './detectors/fork-meta';
import { skeletonTrgmDetector } from './detectors/skeleton-trgm';

export const SOURCE_DETECTORS: readonly SourceSignalDetector[] = [
  gitShaDetector,
  forkMetaDetector,
  skeletonTrgmDetector,
];

import type { SourceSignalDetector } from './types';
import { gitShaDetector } from './detectors/git-sha';
import { forkMetaDetector } from './detectors/fork-meta';
import { skeletonTrgmDetector } from './detectors/skeleton-trgm';

/**
 * 信号检测器注册表：数组顺序 = 执行顺序（成本升序：列索引查询 → 元数据查库 → trgm）。
 * 新信号接入 = 新建 detectors/xx.ts + 此数组加一项，业务调用点零改动。
 */
export const SOURCE_DETECTORS: readonly SourceSignalDetector[] = [
  gitShaDetector,
  forkMetaDetector,
  skeletonTrgmDetector,
];

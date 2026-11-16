/**
 * src/engine/language-map.ts
 *
 * Backward-compatible facade:
 * 1. Repository and asset filtering rules (src/engine/scanner)
 * 2. Outline prefix and sidecar patterns (src/engine/structurizer)
 * （2026-11 清算：languages/prefix-cleaner 的 pass-through re-export 已移除——
 * 调用方均直连源模块 @/engine/languages 与 @/engine/structurizer/prefix-cleaner）
 */

import * as assetFilterModule from './scanner/asset-filter';
import * as repoPatternsModule from './scanner/repo-patterns';
import * as structurizerPatternsModule from './structurizer/prefix-cleaner';

export { isNonContentDir } from './scanner/asset-filter';

/**
 * Consolidated registry for architectural role classification,
 * asset pruning, and chapter normalization.
 * （2026-11 死代码清算：register-only 死键已随 Go patterns_native.go
 * 单写者收刀移除，仅保留仍有生产读取的活键。）
 */
export const MODULE_ROLE_PATTERNS = {
  // Repo & doc sniffing patterns
  markdownExtensions: repoPatternsModule.markdownExtensions,
  virtualChapterPathPrefixes: repoPatternsModule.virtualChapterPathPrefixes,
  conceptWorkflowTitlePatterns: repoPatternsModule.conceptWorkflowTitlePatterns,
  conceptPrincipleTitlePatterns: repoPatternsModule.conceptPrincipleTitlePatterns,
  conceptReflectionContentPatterns: repoPatternsModule.conceptReflectionContentPatterns,
  conceptTitleStopPatterns: repoPatternsModule.conceptTitleStopPatterns,
  topologyConfigPatterns: repoPatternsModule.topologyConfigPatterns,
  topologyCodeExtensions: repoPatternsModule.topologyCodeExtensions,
  subsystemDuties: repoPatternsModule.subsystemDuties,
  highPriorityMigrationPatterns: repoPatternsModule.highPriorityMigrationPatterns,

  // Structurizer & TOC patterns
  numericPrefixPattern: structurizerPatternsModule.numericPrefixPattern,

  // Asset filtering & pruning
  nonContentDirPatterns: assetFilterModule.nonContentDirPatterns,
  excludedFileCategories: assetFilterModule.excludedFileCategories,
  noisyPathPrefixes: assetFilterModule.noisyPathPrefixes,
  ignoredFilenames: assetFilterModule.ignoredFilenames,
  allowedFileExtensions: assetFilterModule.allowedFileExtensions,
};

import * as assetFilterModule from './scanner/asset-filter';
import * as repoPatternsModule from './scanner/repo-patterns';
import * as structurizerPatternsModule from './structurizer/prefix-cleaner';

export { isNonContentDir } from './scanner/asset-filter';

export const MODULE_ROLE_PATTERNS = {
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

  numericPrefixPattern: structurizerPatternsModule.numericPrefixPattern,

  nonContentDirPatterns: assetFilterModule.nonContentDirPatterns,
  excludedFileCategories: assetFilterModule.excludedFileCategories,
  noisyPathPrefixes: assetFilterModule.noisyPathPrefixes,
  ignoredFilenames: assetFilterModule.ignoredFilenames,
  allowedFileExtensions: assetFilterModule.allowedFileExtensions,
};

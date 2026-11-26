import { MODULE_ROLE_PATTERNS } from '../engine/language-map';

export const CACHE_CONTROL_STRATEGIES = {
  dynamicDocs: 'public, max-age=3600, stale-while-revalidate=86400',
  immutableAssets: 'public, max-age=31536000, immutable',
};

export const ENGINE_CONFIG = {
  defaultBranch: process.env.DEFAULT_BRANCH || 'main',
  userAgent: process.env.USER_AGENT || 'OpenGits-Engine/1.0',
  endpoints: {
    langfuse: process.env.LANGFUSE_BASEURL || 'http://localhost:3100',
    // Empty string disables Go SSE gateway and keeps local Node SSE.
    sseGateway: process.env.SSE_GATEWAY_URL || '',
    workerSidecar: process.env.WORKER_SIDECAR_URL || process.env.SSE_GATEWAY_URL || 'http://127.0.0.1:8082',
  },
  webCrawler: {
    defaultMaxPages: Number(process.env.WEB_CRAWLER_MAX_PAGES) || 1000,
  },
  fetcher: {
    // Counters remain exact while sample paths are bounded to prevent V8 heap blowup on million-file repos.
    exclusionDetailBudget: Number(process.env.EXCLUSION_DETAIL_BUDGET) || 200,
  },
  pagination: {
    adminDefault: 100,
    adminTelemetry: 200,
    searchFeaturedLimit: 3,
    homeReposLimit: 50,
    healthCheckTopReposLimit: 5,
    workingMemoryLimit: 50,
    homeMaxRepos: Number(process.env.HOME_MAX_REPOS) || 200,
    homeCacheTtlSeconds: Number(process.env.HOME_CACHE_TTL_SECONDS) || 60,
    // Bounds sibling-edition hydration on high-traffic repos.
    homeEditionHydrateMax: Number(process.env.HOME_EDITION_HYDRATE_MAX) || 50,
    adminMcpToolDistLimit: 12,
    adminMcpClientDistLimit: 10,
    adminReviewQueueLimit: 50,
  },
  recommendation: {
    communitySaveFactor: 6,
    communityMax: 30,
    mcpLifetimeMax: 20,
    mcpRecentMax: 10,
    mcpRecentWindowDays: 30,
    blindPenaltyFactor: 20,
    blindPenaltyMax: 10,
    pipelineWeight: 0.15,
    llmWeight: 0.1,
    legacyNeutralBaseline: 15,
    contentMax: 25,
    freshWindowDays: 90,
    staleWindowDays: 365,
    freshnessMax: 15,
  },

  timeouts: {
    // Synchronous publish gate: timeout fails closed to manual review so LLM latency cannot stall API handlers.
    platformReviewMs: Number(process.env.PLATFORM_REVIEW_TIMEOUT_MS) || 90000,
  },
  rateLimit: {
    quizMaxRequests: 10,
    quizWindowMs: 5 * 60 * 1000,
    // Threshold sits above fast human chapter navigation and below automated scripts (each prioritize queues an LLM job).
    docPrioritizeMaxRequests: Number(process.env.DOC_PRIORITIZE_RATE_MAX) || 60,
    docPrioritizeWindowMs: (Number(process.env.DOC_PRIORITIZE_RATE_WINDOW_MIN) || 10) * 60 * 1000,
    webDocIngestMaxRequests: Number(process.env.WEB_DOC_INGEST_RATE_MAX) || 5,
    webDocIngestWindowMs: (Number(process.env.WEB_DOC_INGEST_RATE_WINDOW_MIN) || 10) * 60 * 1000,
    webDocSyncMaxRequests: Number(process.env.WEB_DOC_SYNC_RATE_MAX) || 10,
    webDocSyncWindowMs: (Number(process.env.WEB_DOC_SYNC_RATE_WINDOW_MIN) || 10) * 60 * 1000,
    webDocScoutMaxRequests: Number(process.env.WEB_DOC_SCOUT_RATE_MAX) || 15,
    webDocScoutWindowMs: (Number(process.env.WEB_DOC_SCOUT_RATE_WINDOW_MIN) || 5) * 60 * 1000,
    ingestMaxRequests: Number(process.env.INGEST_RATE_MAX) || 5,
    ingestWindowMs: (Number(process.env.INGEST_RATE_WINDOW_MIN) || 10) * 60 * 1000,
    chatMaxRequests: Number(process.env.CHAT_RATE_MAX) || 30,
    chatWindowMs: (Number(process.env.CHAT_RATE_WINDOW_MIN) || 5) * 60 * 1000,
    diagramLensMaxRequests: Number(process.env.DIAGRAM_LENS_RATE_MAX) || 20,
    diagramLensWindowMs: (Number(process.env.DIAGRAM_LENS_RATE_WINDOW_MIN) || 5) * 60 * 1000,
    outlineExpandMaxRequests: Number(process.env.OUTLINE_EXPAND_RATE_MAX) || 30,
    outlineExpandWindowMs: (Number(process.env.OUTLINE_EXPAND_RATE_WINDOW_MIN) || 5) * 60 * 1000,
    // NAT-tolerant ceilings stop runaway scraping bots without throttling shared campus/corporate IPs.
    publicReadDocsMaxRequests: Number(process.env.PUBLIC_READ_DOCS_RATE_MAX) || 300,
    publicReadDocsWindowMs: 60 * 1000,
    publicReadAssetsMaxRequests: Number(process.env.PUBLIC_READ_ASSETS_RATE_MAX) || 1200,
    publicReadAssetsWindowMs: 60 * 1000,
    // Deduplicates repeat view increments (refreshes/remounts) within the window per user/IP.
  },
  storage: {
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL || '',
    s3: {
      endpoint: process.env.S3_ENDPOINT || '',
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
  },
  contentAddressing: {
    dualWrite: process.env.DOCUMENT_CONTENT_DUAL_WRITE === '1',
    reads: process.env.DOCUMENT_CONTENT_READS !== '0',
  },
  updateMarket: {
    claimTtlMin: Number(process.env.UPDATE_CLAIM_TTL_MIN) || 30,
    claimStaleHours: Number(process.env.UPDATE_CLAIM_STALE_HOURS) || 24,
    maintainerMonthlyCap: Number(process.env.UPDATE_MAINTAINER_MONTHLY_CAP) || 20,
    flipMargin: Math.max(1, Number(process.env.UPDATE_VERSION_FLIP_MARGIN) || 2),
    auditEveryNSwaps: Number(process.env.UPDATE_AUDIT_EVERY_N_SWAPS) || 10,
  },
  // Denominator is total existing chapters so small diffs removing 2/2 chapters never trigger a full-repo rebuild.
  updateEngine: {
    majorRebuildRemoveRatio: Number(process.env.UPDATE_MAJOR_REBUILD_RATIO ?? 0.5),
    // Shared canonical rebuilds overwrite all readers and consume quota, so explicit confirmation defaults on.
    majorRebuildConfirmShared: process.env.UPDATE_MAJOR_REBUILD_CONFIRM_SHARED !== '0',
  },
  serverTranscription: {
    orphanContentGraceDays: Number(process.env.ORPHAN_CONTENT_GRACE_DAYS) || 7,
    concurrency: Number(process.env.TRANSCRIPTION_CONCURRENCY) || 3,
  },
  // Outline queries join 5 nested tables; TTL cache trades up to 60s staleness on read paths.
  docsRead: {
    outlineCacheTtlSeconds: Number(process.env.OUTLINE_CACHE_TTL_SECONDS) || 60,
  },
  search: {
    binaryIndexRebuildDebounceMs: Number(process.env.SEARCH_INDEX_REBUILD_DEBOUNCE_MS) || 10_000,
    // Index is rebuildable derived data; gzip level 1 prioritizes event-loop latency over size.
    binaryIndexGzipLevel: Math.max(1, Math.min(9, Number(process.env.SEARCH_INDEX_GZIP_LEVEL) || 1)),
    binaryIndexBuilder: process.env.SEARCH_INDEX_GO_BUILDER !== '0' ? ('go' as const) : ('node' as const),
  },
  jobs: {
    finishedJobTtlDays: Number(process.env.IMPORT_JOB_TTL_DAYS) || 7,
  },
  sniffer: {
    // Gray-zone gate relies on code file count + byte volume (not file count alone) to tell codebases with manuals apart from books with examples.
    grayZoneMinCodeFiles: 20,
    grayZoneMinCodeBytes: 256 * 1024,
  },
  semanticGraph: {
    storeDir: process.env.SEMANTIC_GRAPH_DIR || (process.cwd() + '/storage/graphs'),
  },
  // ConversationMessage is intentionally excluded from retention auto-purge.
  retention: {
    episodicDays: Number(process.env.RETENTION_EPISODIC_DAYS) || 30,
    mcpCallLogDays: Number(process.env.RETENTION_MCP_CALL_LOG_DAYS) || 90,
    tokenUsageDays: Number(process.env.RETENTION_TOKEN_USAGE_DAYS) || 90,
    adminAuditDays: Number(process.env.RETENTION_ADMIN_AUDIT_DAYS) || 365,
    gatewayEventDays: Number(process.env.RETENTION_GATEWAY_EVENT_DAYS) || 14,
  },
};

export const IGNORED_FILENAMES = MODULE_ROLE_PATTERNS.ignoredFilenames;
export const NOISY_PATH_PREFIXES = MODULE_ROLE_PATTERNS.noisyPathPrefixes;
export const ALLOWED_FILE_EXTENSIONS = MODULE_ROLE_PATTERNS.allowedFileExtensions;

export const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.mp4', 
  '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot', 
  '.ico', '.webmanifest'
];

const FILE_SIZE_CAP_BYTES = 2 * 1024 * 1024;
export const SUBDIR_TEXT_CAP_BYTES = (Number(process.env.SUBDIR_TEXT_CAP_MB) || 200) * 1024 * 1024;

const EXCLUDED_FILE_CATEGORIES = MODULE_ROLE_PATTERNS.excludedFileCategories;

export type ExclusionCategoryKey = keyof typeof EXCLUDED_FILE_CATEGORIES | 'oversized';

export interface FileExclusionVerdict {
  isExcluded: boolean;
  category?: ExclusionCategoryKey;
  categoryLabel?: string;
  reason?: string;
}

export function classifyExcludedFile(filePath: string, size?: number): FileExclusionVerdict {
  const lowerPath = filePath.toLowerCase();

  for (const [catKey, meta] of Object.entries(EXCLUDED_FILE_CATEGORIES)) {
    if (meta.extensions.some(ext => lowerPath.endsWith(ext))) {
      return {
        isExcluded: true,
        category: catKey as ExclusionCategoryKey,
        categoryLabel: meta.label,
        reason: `文件格式属于【${meta.label}】`,
      };
    }
  }

  // Known source/doc extensions get a 5MB cap (vs 2MB generic) to avoid dropping large single-file headers or long markdown.
  const isKnownSourceOrDoc = ALLOWED_FILE_EXTENSIONS.test(filePath);
  const effectiveCapBytes = isKnownSourceOrDoc ? 5 * 1024 * 1024 : FILE_SIZE_CAP_BYTES;

  if (size && size > effectiveCapBytes) {
    const capMb = (effectiveCapBytes / 1024 / 1024).toFixed(0);
    return {
      isExcluded: true,
      category: 'oversized',
      categoryLabel: `超大文件 (>${capMb}MB)`,
      reason: `单文件体积 ${(size / 1024 / 1024).toFixed(1)}MB 超过 ${capMb}MB 限制`,
    };
  }

  return { isExcluded: false };
}

export const GITHUB_ENDPOINTS = {
  api: process.env.GITHUB_API_BASE || 'https://api.github.com',
  raw: process.env.GITHUB_RAW_BASE || 'https://raw.githubusercontent.com',
  web: process.env.GITHUB_WEB_BASE || 'https://github.com',
};

// Pure download deduplication cache decoupled from user snapshots; GC may evict entries at any time.
export const TARBALL_CACHE = {
  dir: process.env.TARBALL_CACHE_DIR || (process.cwd() + '/storage/repos'),
  entryCapBytes: (Number(process.env.TARBALL_CACHE_ENTRY_CAP_MB) || 1024) * 1024 * 1024,
};


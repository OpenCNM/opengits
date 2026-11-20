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
    /** 全站 SSE 实时长连接广播网关（Go 原生二进制，承接 persistent SSE 连接卸载）。
     *  空串 = 未启用，回落本地 Node 实现（渐进式迁移开关）。 */
    sseGateway: process.env.SSE_GATEWAY_URL || '',
    /** 工作协程 sidecar（Go 原生二进制，承接图谱语义 Diff、长连接网关与调度）。 */
    workerSidecar: process.env.WORKER_SIDECAR_URL || process.env.SSE_GATEWAY_URL || 'http://127.0.0.1:8082',
  },
  webCrawler: {
    /** 抓取执行参数（fast-path/并发/UA/robots/溢出系数等）由 Go worker-sidecar
     *  直读 WEB_CRAWLER_* env 承载；TS 侧仅保留向导提交面需要的默认页数上限。 */
    defaultMaxPages: Number(process.env.WEB_CRAWLER_MAX_PAGES) || 1000,
  },
  fetcher: {
    /** 排除明细认知预算硬顶：计数器（totalExcludedCount/byCategory）始终精确，
     *  明细数组只保留前 N 条——百万文件级大仓的 excluded 明细无界 push
     *  会在 V8 堆堆积数百 MB（CDC：下游决策只需计数 + 样本）。 */
    exclusionDetailBudget: Number(process.env.EXCLUSION_DETAIL_BUDGET) || 200,
  },
  pagination: {
    adminDefault: 100,
    adminTelemetry: 200,
    // 搜索框空态推荐位条数（热门公开教程，动态取数）
    searchFeaturedLimit: 3,
    homeReposLimit: 50,
    healthCheckTopReposLimit: 5,
    workingMemoryLimit: 50,
    // 首页公共仓查询上限（超过后首页只展示部分，完整列表走搜索/分类）
    homeMaxRepos: Number(process.env.HOME_MAX_REPOS) || 200,
    // 首页公共数据层缓存 TTL（秒）：匿名访客全命中；导入/发布/下架时按 tag 主动失效
    homeCacheTtlSeconds: Number(process.env.HOME_CACHE_TTL_SECONDS) || 60,
    // 兄弟讲法回填上限（BUG-03/05 缩放护栏）：超热仓被大量讲法导入时防止无界查询与缓存膨胀
    homeEditionHydrateMax: Number(process.env.HOME_EDITION_HYDRATE_MAX) || 50,
    // admin MCP 遥测分布图条目上限（工具分布 / 客户端分布）
    adminMcpToolDistLimit: 12,
    adminMcpClientDistLimit: 10,
    // admin 内容审核队列每 Tab 拉取条数（待审 / 自动过审校准 / 举报）
    adminReviewQueueLimit: 50,
  },
  // 推荐分权重（首页「推荐」排序；四组件合计 100，冷启动友好——绝对保存数与 MCP 调用优先于浏览量）
  recommendation: {
    // ① 社区认可：保存数 × 系数，封顶 communityMax
    communitySaveFactor: 6,
    communityMax: 30,
    // ② AI 客户价值：生命周期调用（封顶 mcpLifetimeMax）+ 近30天调用（封顶 mcpRecentMax）− 盲区惩罚
    mcpLifetimeMax: 20,
    mcpRecentMax: 10,
    mcpRecentWindowDays: 30,
    blindPenaltyFactor: 20,
    blindPenaltyMax: 10,
    // ③ 内容基线：双通道审核分加权；存量无审核分的公开仓给中性分（视同已过审不惩罚）
    pipelineWeight: 0.15,
    llmWeight: 0.1,
    legacyNeutralBaseline: 15,
    // ④ 新鲜度：freshWindowDays 内满分，至 staleWindowDays 线性衰减到 0
    contentMax: 25,
    freshWindowDays: 90,
    staleWindowDays: 365,
    freshnessMax: 15,
  },

  timeouts: {
    // 平台初审 LLM 调用上限：发布接口同步等待初审，超时 fail-closed 转人工，
    // 避免 LLM 延迟直接堆在用户发布请求上（大模型生成结构化 JSON 耗时约 30-60s，默认宽限至 90s）
    platformReviewMs: Number(process.env.PLATFORM_REVIEW_TIMEOUT_MS) || 90000,
  },
  rateLimit: {
    quizMaxRequests: 10,
    quizWindowMs: 5 * 60 * 1000,
    // JIT 插队限速（POST /documents/[id]/prioritize）：登录按 userId、匿名按 IP；
    // 阈值取「快速翻章的人类摸不到、失控脚本必超」的区间（每次插队=1 个 LLM 任务）
    docPrioritizeMaxRequests: Number(process.env.DOC_PRIORITIZE_RATE_MAX) || 60,
    docPrioritizeWindowMs: (Number(process.env.DOC_PRIORITIZE_RATE_WINDOW_MIN) || 10) * 60 * 1000,
    // 网页文档导入/同步（分钟级抓取 + 外部站点带宽，从严）
    webDocIngestMaxRequests: Number(process.env.WEB_DOC_INGEST_RATE_MAX) || 5,
    webDocIngestWindowMs: (Number(process.env.WEB_DOC_INGEST_RATE_WINDOW_MIN) || 10) * 60 * 1000,
    webDocSyncMaxRequests: Number(process.env.WEB_DOC_SYNC_RATE_MAX) || 10,
    webDocSyncWindowMs: (Number(process.env.WEB_DOC_SYNC_RATE_WINDOW_MIN) || 10) * 60 * 1000,
    // 拓扑探测（scout 触发外部抓取 + 单次 LLM 裁决，确认页挂载即调用）
    webDocScoutMaxRequests: Number(process.env.WEB_DOC_SCOUT_RATE_MAX) || 15,
    webDocScoutWindowMs: (Number(process.env.WEB_DOC_SCOUT_RATE_WINDOW_MIN) || 5) * 60 * 1000,
    // GitHub 仓库导入（转录长任务 + 平台算力/队列槽位；对齐 web-doc 从严）
    ingestMaxRequests: Number(process.env.INGEST_RATE_MAX) || 5,
    ingestWindowMs: (Number(process.env.INGEST_RATE_WINDOW_MIN) || 10) * 60 * 1000,
    // chat 对话（每用户滑动窗口）
    chatMaxRequests: Number(process.env.CHAT_RATE_MAX) || 30,
    chatWindowMs: (Number(process.env.CHAT_RATE_WINDOW_MIN) || 5) * 60 * 1000,
    // 流程图按需深度切换限流（POST /api/ai/diagram-lens）
    diagramLensMaxRequests: Number(process.env.DIAGRAM_LENS_RATE_MAX) || 20,
    diagramLensWindowMs: (Number(process.env.DIAGRAM_LENS_RATE_WINDOW_MIN) || 5) * 60 * 1000,
    // 大纲重排需求 AI 扩写限流（POST /api/ai/expand-outline-prompt）
    outlineExpandMaxRequests: Number(process.env.OUTLINE_EXPAND_RATE_MAX) || 30,
    outlineExpandWindowMs: (Number(process.env.OUTLINE_EXPAND_RATE_WINDOW_MIN) || 5) * 60 * 1000,
    // 公开读路径限流（公开仓匿名可读后的失控脚本兜底）
    // 维度：登录按 userId（CGNAT/校园网/企业出口共 IP 不连坐——session 为 JWT 校验零 DB 成本），
    // 匿名按 IP 且阈值按「NAT 聚合」口径放宽：目标是拦失控脚本（必然瞬间数千次/分），
    // 而非容量管理——阈值取「任何合理人类集体摸不到、任何脚本都一定超」的区间
    // docs 口径覆盖 docs-content / llms-txt（前端零调用、纯 Agent 流量）；assets 单页多图且有
    // 浏览器 immutable 缓存，故更宽。线上可用 PUBLIC_READ_* env 随时调整
    publicReadDocsMaxRequests: Number(process.env.PUBLIC_READ_DOCS_RATE_MAX) || 300,
    publicReadDocsWindowMs: 60 * 1000,
    publicReadAssetsMaxRequests: Number(process.env.PUBLIC_READ_ASSETS_RATE_MAX) || 1200,
    publicReadAssetsWindowMs: 60 * 1000,
    // 阅读量自增（POST /api/repos/[owner]/view）：目标是去重而非容量管理——
    // 同一用户/IP 对同一仓库在窗口内只计 1 次（F5 刷新与前端重复挂载不重复计数）
  },
  /**
   * 对象存储驱动（Phase 1）：assets 走 local 磁盘或 S3 兼容桶（MinIO/R2/AWS）。
   * - publicBaseUrl：CDN/桶公网域名；配置后 /api/assets 命中对象时 302 直出卸载 Next 流量
   */
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
  /**
   * 内容寻址层（Phase 2 / P-11，Phase 4 收官）：
   * - dualWrite：写路径同时落 legacy Document.content/chunks 与 DocumentContent 层
   * - reads：读路径切薄行→内容层 JOIN。**默认开（Phase 4 T2）**——灰度回归
   *   tests/integration/phase4-content-reads 已锁定「legacy 列为空的停写形态」
   *   正文/检索全链路；回滚置 DOCUMENT_CONTENT_READS=0 即回 legacy 直读。
   */
  contentAddressing: {
    dualWrite: process.env.DOCUMENT_CONTENT_DUAL_WRITE === '1',
    reads: process.env.DOCUMENT_CONTENT_READS !== '0',
  },
  /**
   * 章节级更新市场 v1（机检即入库 + 认领）：
   * 贡献者自付 BYOK 转录，机器门（L0 / 契约三件套）过检即直换入库为
   * ChapterVersion 正典版本，读者在正文详情页切换版本并点赞。
   * 旧的试读投票（voteWindowHours / voteQuorum）已随试读表决一并退役。
   * - claimTtlMin：认领租约，超时回池（转录端点超时的兜底）
   * - claimStaleHours：PENDING 超过该时长的 job 由维护者兜底认领
   * - maintainerMonthlyCap：维护者每月兜底转录章数上限
   * - auditEveryNSwaps：每 N 次换入跑一次零 LLM 管线分（qualityFloor 阈值由 Go 侧读取）
   */
  updateMarket: {
    claimTtlMin: Number(process.env.UPDATE_CLAIM_TTL_MIN) || 30,
    claimStaleHours: Number(process.env.UPDATE_CLAIM_STALE_HOURS) || 24,
    maintainerMonthlyCap: Number(process.env.UPDATE_MAINTAINER_MONTHLY_CAP) || 20,
    /** 版本夺位门槛：挑战者票数 ≥ 正典 + flipMargin 才翻正（在位者偏置防抖动） */
    flipMargin: Math.max(1, Number(process.env.UPDATE_VERSION_FLIP_MARGIN) || 2),
    auditEveryNSwaps: Number(process.env.UPDATE_AUDIT_EVERY_N_SWAPS) || 10,
  },
  /**
   * 增量更新引擎（plan-then-apply）：大版本智能路由。
   * 真实删除率 = Git 事实核验后的合法 remove 数 ÷ 归属全部现存章节数
   * （分母刻意取全量章节而非候选集——小 diff 删 2/2=100% 不该触发全仓冷重建）。
   */
  updateEngine: {
    /** 真实删除率超过该阈值 → MAJOR_VERSION_REBUILD（快照归档 + ImportJob 全量冷重建） */
    majorRebuildRemoveRatio: Number(process.env.UPDATE_MAJOR_REBUILD_RATIO ?? 0.5),
    /**
     * 共享正典（docOwnerId=null）的大版本重建是否要求触发者显式确认：
     * 重建重写全部共享章节且消耗触发者配额，影响所有读者——默认保留一道确认；
     * 私有副本（docOwnerId=userId）始终自动执行。
     */
    majorRebuildConfirmShared: process.env.UPDATE_MAJOR_REBUILD_CONFIRM_SHARED !== '0',
  },
  /**
   * 服务端共享转录（2026-10 收口）：消费端 100% 由 Go worker-sidecar 单写者
   * 承载，Node 同步执行器与内联 JIT 双轨已退役——入队恒为唯一路径
   * （旧的 SERVER_TRANSCRIPTION_ENABLED 回落开关随之消亡）。此处仅存
   * 读侧估算参数（排队 ETA 与孤儿内容层 GC 宽限）。
   */
  serverTranscription: {
    /** 孤儿内容层回收宽限期（天）：无薄行指针且超期才删 */
    orphanContentGraceDays: Number(process.env.ORPHAN_CONTENT_GRACE_DAYS) || 7,
    /** worker 转录并发槽位数（镜像 Go TRANSCRIPTION_CONCURRENCY 默认 3；仅用于排队 ETA 估算） */
    concurrency: Number(process.env.TRANSCRIPTION_CONCURRENCY) || 3,
  },
  /**
   * 文档页读侧缓存：大纲是 5 层嵌套 include 的重查询且消费方全是渲染读——
   * 跨请求 TTL 缓存（导入/重编排后最多 TTL 秒内旧大纲可见，写侧编排工具不经该入口）。
   */
  docsRead: {
    outlineCacheTtlSeconds: Number(process.env.OUTLINE_CACHE_TTL_SECONDS) || 60,
  },
  /**
   * 客户端二进制搜索索引（OGIS）
   */
  search: {
    /** 客户端二进制搜索索引（OGIS）：finalize 触发重建的合并去抖窗口——同仓批量导入只在末尾重建一次 */
    binaryIndexRebuildDebounceMs: Number(process.env.SEARCH_INDEX_REBUILD_DEBOUNCE_MS) || 10_000,
    /** 客户端二进制搜索索引（OGIS）：gzip 压缩级别（1=最快；索引是可重建的派生数据，不追求极限压缩率） */
    binaryIndexGzipLevel: Math.max(1, Math.min(9, Number(process.env.SEARCH_INDEX_GZIP_LEVEL) || 1)),
    /** 客户端二进制搜索索引（OGIS）：写权归属——默认由 Go sidecar 接管打包写入
     *  （SEARCH_INDEX_GO_BUILDER!==0：WORKER_GO_SEARCH_INDEX!=0），Node finalize 去抖变 no-op；
     *  JIT miss 优先委托 Go 端构建，并保留本地 generateRepoBinaryIndex 为 Fail-Open 自愈兜底 */
    binaryIndexBuilder: process.env.SEARCH_INDEX_GO_BUILDER !== '0' ? ('go' as const) : ('node' as const),
  },
  // 导入 Job 状态机（工作与连接解耦）：Node 执行器双轨已退役（2026-10 收口），
  // 心跳/事件/SSE 节奏与并发闸门（IMPORT_JOB_MAX_CONCURRENT）全部由 Go daemon 直读 env——
  // TS 侧仅存读侧惰性 GC 消费的一项
  jobs: {
    /** 完工 Job 的事件 TTL 清扫（读取时惰性 GC） */
    finishedJobTtlDays: Number(process.env.IMPORT_JOB_TTL_DAYS) || 7,
  },
  sniffer: {
    /** 灰区仲裁闸门：规则判 text_only 但代码物理质量达此线下限时移交 LLM 裁决。
     * 文件个数把一篇公告与一个引擎等权计数（形态误判之源）；书籍示例代码极少
     * 同时达到 20 文件 + 256KB 总量，产品代码库核心源码动辄数百 KB——质量才是
     * "产品带手册 vs 书籍带示例"判别的第一性证据。 */
    grayZoneMinCodeFiles: 20,
    grayZoneMinCodeBytes: 256 * 1024,
  },
  /**
   * Tier 2 语义图谱（RSG）产物落盘目录（与 docker-compose 挂载的 ./storage 卷对齐）
   */
  semanticGraph: {
    /** 图谱产物落盘目录（与 docker-compose 挂载的 ./storage 卷对齐） */
    storeDir: process.env.SEMANTIC_GRAPH_DIR || (process.cwd() + '/storage/graphs'),
  },
  /**
   * 流水表保留期（天）：遥测/审计类流水按期自动清理，防只写不删撑爆 DB。
   * 全部可用 env 覆盖；ConversationMessage（用户聊天数据）刻意不在此列，
   * 如需保留期另立产品决策。Session 过期为即时语义（expires < now 即回收）。
   */
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

/**
 * 仓库导入文件精细化剔除规则（4 大维度 + 单文件 2MB 体积上限兜底）
 */
const FILE_SIZE_CAP_BYTES = 2 * 1024 * 1024; // 2MB 单文件上限（仅本文件 classifyExcludedFile 消费）
export const SUBDIR_TEXT_CAP_BYTES = (Number(process.env.SUBDIR_TEXT_CAP_MB) || 200) * 1024 * 1024; // 200MB 选定目录有效文件总体积上限

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

  // 1. 优先判定 4 大维度显式黑名单（压缩包、二进制、办公文档、构建/缓存数据库）
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

  // 2. 差异化体积兜底：
  // - 已知合法源代码/Markdown文档 (.ts, .py, .go, .c, .md 等)：放宽至 5MB（防误删大型单头文件如 sqlite3.c 或长篇 MD）
  // - 未知/通用数据文件 (无后缀、数据 dump 等)：维持 2MB 严防死守
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

/**
 * Tarball 归档缓存（storage/repos/{owner}/{repo}/{sha}/）。
 * 纯下载去重缓存：同一 (repo, sha) 只从 GitHub 下载一次，用户课程快照与它完全解耦，
 * GC 可随时安全回收任意条目。
 * - entryCapBytes：单仓解压体积上限，超限不落盘（跳过缓存，走原有网络路径）
 */
export const TARBALL_CACHE = {
  dir: process.env.TARBALL_CACHE_DIR || (process.cwd() + '/storage/repos'),
  entryCapBytes: (Number(process.env.TARBALL_CACHE_ENTRY_CAP_MB) || 1024) * 1024 * 1024,
};


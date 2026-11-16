// Package main — worker sidecar：承接 Node worker 容器的后台调度任务与队列消费
// （prune-telemetry / search-sync / upstream-check / import-job / transcription /
// auto-update 时钟，Phase 3–4 + M 系列）。语义对齐 apps/client/src/lib/scheduler/*.ts
// 与 apps/worker；任务互斥沿用 SchedulerLease CAS 租约（与 Node 侧同表同 key，
// 两侧可混跑、单端生效）。auto-update 整轮经 web 内部端点执行（candidate-set
// 深绑引擎留 web）。
package daemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/market"
	"github.com/opengits/worker-sidecar/internal/platform/authtoken"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/opengits/worker-sidecar/internal/scheduler"
	"github.com/opengits/worker-sidecar/internal/scout"
	"github.com/opengits/worker-sidecar/internal/search"
	"github.com/opengits/worker-sidecar/internal/sse"
	"github.com/opengits/worker-sidecar/internal/transcription"
	"github.com/opengits/worker-sidecar/internal/update"
)

type Config struct {
	// Addr 监听地址（容器内网，不进 Caddy 公开路由）
	Addr string
	// McpAddr MCP 服务监听地址（Unified Sidecar Daemon 双活端口）
	McpAddr string
	// DatabaseURL Postgres 连接串（pgx 池）
	DatabaseURL string
	// InternalToken 内部令牌（手动触发端点 /v1/tasks/{name}/run 鉴权）
	InternalToken string
	// NodeInternalURL Node 应用内部基址（如 http://app:3000）：发布扇出对账任务
	// 周期 POST {NodeInternalURL}/api/tasks/publish-fanout-reconcile 用（INTERNAL_API_TOKEN
	// 双侧共享）。为空时该任务每轮跳过；Node 端点仍可手动触发。
	NodeInternalURL string
	// AppEnv 运行环境（APP_ENV 回退 NODE_ENV，默认 development）；
	// production 时拒绝 compose 默认令牌（对齐 Node internal-auth）
	AppEnv string
	// PoolMax pgx 连接池上限（调度任务串行，小池即可）
	PoolMax int

	// GitHubAPIBase 等价 GITHUB_ENDPOINTS.api（upstream-check 探测）
	GitHubAPIBase string
	GitHubToken   string
	UserAgent     string

	// 检索引擎（默认 pg 原生 FTS）
	SearchEngine string

	// storage（assets 孤儿清扫的 local 分支；非 local 驱动本轮跳过留 Node）
	StorageDriver        string
	StorageRoot          string
	AssetsRoot           string
	StoragePublicBaseURL string

	// 保留期（与 ENGINE_CONFIG.retention 同名 env 同默认值）
	RetentionEpisodicDays        int
	RetentionMonitorDays         int
	RetentionMcpCallLogDays      int
	RetentionTokenUsageDays      int
	RetentionAdminAuditDays      int
	RetentionGatewayEvDays       int
	RetentionDaemonTaskRunDays   int
	RetentionImportJobEventDays  int
	RetentionDissectionCacheDays int
	QuotaLogRetentionDays        int
	OrphanContentGraceDays       int
	VersionGcDays                int

	// 前端监控告警（monitor-alert ticker；webhook 未配置即禁用）
	MonitorAlertWebhookURL    string
	MonitorAlertErrorSessions int
	MonitorAlertCrashes       int
	// 转录盖章 CAS 未命中告警（transcription-cas-alert；复用 MonitorAlertWebhookURL）
	TranscriptionCasMissAlertThreshold int
	PrivateVersionGcDays               int
	OrphanGcBatch                      int
	OrphanGcMaxPerRun                  int
	PruneBatchSize                     int
	AssetsGcDryRun                     bool
	AssetsOrphanGraceDays              int
	UpstreamMaxReposPerCycle           int

	// ImportJob 队列壳（Slice B；与 ENGINE_CONFIG.jobs 同名 env 同默认值）
	ImportJobsEnabled  bool // WORKER_GO_IMPORT_JOBS=1 才接管队列闸门
	SchedulerTickMs    int
	MaxConcurrent      int
	MaxWallMs          int
	StaleAfterMs       int
	ReapIntervalMs     int
	FinishedJobTtlDays int
	HeartbeatMs        int
	EventFlushMs       int
	EventFlushCount    int
	MaxEventsPerJob    int

	// 内存准入闸门配置（方向1：两阶段加权弹性并发准入控制）
	MemoryReservedHeadroomMB int
	MemoryTokenUnitMB        int
	MemoryMinCapacityTokens  int
	MemoryMaxCapacityTokens  int
	MemoryHighWatermarkRatio float64
	MemoryStarvationSec      int

	// 转录队列壳（Slice C；与 Node 同名 env 同默认值）
	TranscriptionEnabled     bool // WORKER_GO_TRANSCRIPTION=1 才接管消费
	TranscriptionPollMs      int
	TranscriptionMaxPerCycle int
	TranscriptionConcurrency int
	// TranscriptionStaleMs RUNNING 孤儿回收阈值（TranscriptionJob.updatedAt，
	// 执行期间无 job 级心跳）。不变式：必须 > MaxWallMs——否则墙钟内活任务
	// 被回队再认领，同一文档双执行（双倍 LLM token + checkpoint 互覆）。
	TranscriptionStaleMs   int
	TranscriptionMaxWallMs int
	// TranscriptionJITPriority JIT 插队优先级服务端上限（批量导入基线 ~10000 的 2 倍，
	// 保证可立即抢占又可被老化 +1/分钟 在有限时间内追平）
	TranscriptionJITPriority int

	// auto-update 调度（Phase 4；整轮 autoUpdateOnce 经 web 内部端点执行）
	AutoUpdateEnabled   bool // WORKER_GO_AUTO_UPDATE=1
	AutoUpdateMaxWallMs int

	// 低谷调度器（McpCallLog 流量画像自动判窗，门控 auto-update 定时 tick）
	ValleyEnabled      bool   // VALLEY_ENABLED=1
	ValleyTZ           string // VALLEY_TZ（IANA 名，判窗目标时区）
	ValleyLookbackDays int    // VALLEY_LOOKBACK_DAYS
	ValleyMinHours     int    // VALLEY_MIN_HOURS（窗口最短时长）
	ValleyMaxHours     int    // VALLEY_MAX_HOURS（窗口最长时长）

	// LLM 网关（M1）：Go 执行体经 web 内部端点调用 LLM 编排
	LlmGatewayURL string
	// WebInternalURL Web 容器内网服务地址（优先 WEB_INTERNAL_URL，兼容 LLM_GATEWAY_URL）
	WebInternalURL string
	// FirecrawlAPIURL 自部署 Firecrawl 服务内网地址
	FirecrawlAPIURL string

	// 转录执行模式（M2c）：node=按需子进程（默认，回退零风险）；
	// go=Go 编排执行体（LLM 走网关、Node 锁死能力走 web 内部端点、
	// 空内容/虚拟章节自动回落 node 子进程——混合模式）
	TranscriptionExecutor string

	// 内容层停写开关（与 ENGINE_CONFIG.contentAddressing.dualWrite 同 env 同默认）
	ContentDualWrite bool

	// RSG 语义图谱存储目录（与 ENGINE_CONFIG.semanticGraph.storeDir 对齐）
	SemanticGraphDir string
	// 统一树算法:目录表文件数预算(A6——模型档位分档接线位,P2 接入消费)
	OutlineMapFileCap int
	// 统一树:目录表 SHA 缓存目录(A4;空=禁用)
	TreeMapCacheDir string

	// ImportJob 执行模式：node=按需子进程（默认）；go=Go 编排执行体（text_only 直跑、code/hybrid 构建 RSG 图谱并落盘后回落 Node）
	ImportJobExecutor        string
	ArchiveRoot              string
	EntryCapBytes            int64
	ArchiveDownloadTimeoutMs int

	// SSE 网关配置（Milestone 2）
	DefaultBranch       string
	SseHeartbeatMs      int
	SseProbeIntervalMs  int
	SseMaxLifetimeMs    int
	SseMaxConnsPerUser  int
	SseMaxConnsPerIP    int
	SseMaxGlobalConns   int
	SseJobMaxLifetimeMs int

	// S3/MinIO（OGIS 索引写入；env 与 Node driver-s3.ts 同名共享）
	S3Endpoint        string
	S3Bucket          string
	S3Region          string
	S3AccessKeyID     string
	S3SecretAccessKey string

	// OGIS 搜索索引 Go 打包（M5）：WORKER_GO_SEARCH_INDEX=1 且
	// STORAGE_DRIVER=s3 时接管写路径（local 模式留 Node）
	SearchIndexEnabled    bool
	SearchIndexGzipLevel  int // 与 Node 共享 env；Go 默认 6（不卡事件循环，恢复高压缩；Node 默认 1 仅 JIT 兜底）
	SearchIndexDebounceMs int // 与 Node scheduleRepoBinaryIndexRefresh 同窗口语义

	// Chunker 参数（prepare 下沉 D组端点3）：与 web ENGINE_CONFIG.chunker 同 env 同默认
	ChunkerMaxTokens int
	ChunkerOverlap   int
	// Chunker Go 原生化（Chunker Phase 2）：CHUNKER_EXECUTOR 默认 "go"——finalize 段
	// 进程内切片后随 store-chunks 载荷直传 web 持久化，消除 Go→web→Go 的 /v1/chunk/* HTTP 折返；
	// 若设为 "web" 则维持 web 端自行切片；Go 切片失败自动回落裸 content 路径（永不更糟）
	ChunkerExecutor string
	RawBase         string // GITHUB_ENDPOINTS.raw（与 Node 同 env）
	WebBase         string // GITHUB_ENDPOINTS.web（与 Node 同 env）
}

// ValidateStartup 校验核心配置，未配置 INTERNAL_API_TOKEN 或 DATABASE_URL 时拒绝启动
func (c Config) ValidateStartup() error {
	if c.InternalToken == "" {
		return errors.New("INTERNAL_API_TOKEN is not set — refusing to start")
	}
	if authtoken.RefuseInsecureDefault(c.InternalToken, c.AppEnv) {
		return errors.New("INTERNAL_API_TOKEN is the public compose default — refusing to start in production")
	}
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is not set — refusing to start")
	}
	// 转录单执行不变式：stale 回收阈值必须大于执行墙钟（失效封闭——
	// 违反组合会在墙钟内把 RUNNING 活任务回队，造成同文档双执行）。
	if c.TranscriptionEnabled && c.TranscriptionStaleMs > 0 && c.TranscriptionStaleMs <= c.TranscriptionMaxWallMs {
		return fmt.Errorf("TRANSCRIPTION_STALE_MS (%dms) must exceed TRANSCRIPTION_MAX_WALL_MS (%dms) — otherwise live jobs get re-queued and double-executed within the wall clock",
			c.TranscriptionStaleMs, c.TranscriptionMaxWallMs)
	}
	return nil
}

// resolveAppEnv 运行环境解析（APP_ENV 回退 NODE_ENV，默认 development）。
func resolveAppEnv() string {
	return envOr("APP_ENV", envOr("NODE_ENV", "development"))
}

// defaultWebInternalURL Node 网关回连地址默认值：compose 部署恒显式注入
// LLM_GATEWAY_URL/WEB_INTERNAL_URL（容器网络名 web:3000），不落此处；本地
// 裸进程（dev-worker-go）未设值时若仍默认 docker 主机名 web，sidecar 回调
// Node 网关（树大纲 outline_plan_v1 等 LLM 规划）会解析到无关主机 EOF
// Fail-Closed。生产环境保持旧默认（显式配置义务），仅 dev 回落本机端口。
func defaultWebInternalURL(appEnv string) string {
	if authtoken.IsProductionEnv(appEnv) {
		return "http://web:3000"
	}
	return "http://127.0.0.1:3000"
}

func loadConfigFromEnv() Config {
	return Config{
		Addr:            envOr("WORKER_SIDECAR_ADDR", ":8082"),
		McpAddr:         envOr("MCP_SIDECAR_ADDR", ":8081"),
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		InternalToken:   os.Getenv("INTERNAL_API_TOKEN"),
		NodeInternalURL: os.Getenv("NODE_INTERNAL_URL"),
		AppEnv:          resolveAppEnv(),
		// 池上限对齐真实并发需求：16 导入 job + 6 转录 + HTTP/MCP/SSE 突发余量。
		// 旧默认 6 源自"调度任务串行"时代，会让 DB 阶段被池硬序列化；env 仍可覆盖。
		PoolMax:                            envIntOr("WORKER_SIDECAR_POOL_MAX", envIntOr("MCP_SIDECAR_POOL_MAX", 32)),
		GitHubAPIBase:                      envOr("GITHUB_API_BASE", "https://api.github.com"),
		GitHubToken:                        envOr("GITHUB_TOKEN", os.Getenv("OCTOKIT_PERSONAL_ACCESS_TOKEN")),
		UserAgent:                          envOr("USER_AGENT", "OpenGits-Engine/1.0"),
		SearchEngine:                       envOr("SEARCH_ENGINE", "pg"),
		StorageDriver:                      envOr("STORAGE_DRIVER", "local"),
		StorageRoot:                        envOr("STORAGE_ROOT", filepath.Dir(envOr("ASSETS_ROOT", "storage/assets"))),
		AssetsRoot:                         envOr("ASSETS_ROOT", "storage/assets"),
		StoragePublicBaseURL:               envOr("STORAGE_PUBLIC_BASE_URL", ""),
		SemanticGraphDir:                   envOr("SEMANTIC_GRAPH_DIR", "storage/graphs"),
		OutlineMapFileCap:                  clampEnvInt("OUTLINE_MAP_FILE_CAP", 50, 4000, 400),
		TreeMapCacheDir:                    envOr("TREE_MAP_CACHE_DIR", "storage/treemaps"),
		RetentionEpisodicDays:              envIntOr("RETENTION_EPISODIC_DAYS", 30),
		RetentionMonitorDays:               envIntOr("RETENTION_MONITOR_DAYS", 30),
		RetentionMcpCallLogDays:            envIntOr("RETENTION_MCP_CALL_LOG_DAYS", 90),
		RetentionTokenUsageDays:            envIntOr("RETENTION_TOKEN_USAGE_DAYS", 90),
		RetentionAdminAuditDays:            envIntOr("RETENTION_ADMIN_AUDIT_DAYS", 365),
		RetentionGatewayEvDays:             envIntOr("RETENTION_GATEWAY_EVENT_DAYS", 14),
		RetentionDaemonTaskRunDays:         envIntOr("RETENTION_DAEMON_TASK_RUN_DAYS", 7),
		RetentionImportJobEventDays:        envIntOr("RETENTION_IMPORT_JOB_EVENT_DAYS", 14),
		RetentionDissectionCacheDays:       envIntOr("RETENTION_DISSECTION_CACHE_DAYS", 30),
		MonitorAlertWebhookURL:             envOr("MONITOR_ALERT_WEBHOOK_URL", ""),
		MonitorAlertErrorSessions:          envIntOr("MONITOR_ALERT_ERROR_SESSIONS", 10),
		MonitorAlertCrashes:                envIntOr("MONITOR_ALERT_CRASHES", 3),
		TranscriptionCasMissAlertThreshold: envIntOr("TRANSCRIPTION_CAS_MISS_ALERT_THRESHOLD", 3),
		QuotaLogRetentionDays:              7,
		OrphanContentGraceDays:             envIntOr("ORPHAN_CONTENT_GRACE_DAYS", 7),
		VersionGcDays:                      envIntOr("UPDATE_VERSION_GC_DAYS", 30),
		PrivateVersionGcDays:               envIntOr("UPDATE_PRIVATE_VERSION_GC_DAYS", 90),
		OrphanGcBatch:                      2000,
		OrphanGcMaxPerRun:                  50_000,
		PruneBatchSize:                     5000,
		AssetsGcDryRun:                     os.Getenv("ASSETS_GC_DRY_RUN") != "false",
		AssetsOrphanGraceDays:              envIntOr("ASSETS_ORPHAN_GRACE_DAYS", 7),
		UpstreamMaxReposPerCycle:           500,

		ImportJobsEnabled:  envGate("WORKER_GO_IMPORT_JOBS"),
		SchedulerTickMs:    envIntOr("IMPORT_JOB_SCHEDULER_TICK_MS", 3000),
		MaxConcurrent:      envIntOr("IMPORT_JOB_MAX_CONCURRENT", 16),
		MaxWallMs:          envIntOr("IMPORT_JOB_MAX_WALL_MS", 30*60*1000),
		StaleAfterMs:       envIntOr("IMPORT_JOB_STALE_AFTER_MS", 60_000),
		ReapIntervalMs:     envIntOr("IMPORT_JOB_REAP_INTERVAL_MS", 20_000),
		FinishedJobTtlDays: envIntOr("IMPORT_JOB_TTL_DAYS", 7),
		HeartbeatMs:        envIntOr("IMPORT_JOB_HEARTBEAT_MS", 10_000), // 对齐 Node 历史默认值 10s（TS 配置键已退役）
		EventFlushMs:       envIntOr("IMPORT_JOB_EVENT_FLUSH_MS", 300),
		EventFlushCount:    envIntOr("IMPORT_JOB_EVENT_FLUSH_COUNT", 50),
		MaxEventsPerJob:    envIntOr("IMPORT_JOB_MAX_EVENTS", 1000),

		MemoryReservedHeadroomMB: envIntOr("WORKER_MEMORY_RESERVED_MB", 512),
		MemoryTokenUnitMB:        envIntOr("WORKER_MEMORY_TOKEN_MB", 128),
		MemoryMinCapacityTokens:  envIntOr("WORKER_MEMORY_MIN_TOKENS", 4),
		MemoryMaxCapacityTokens:  envIntOr("WORKER_MEMORY_MAX_TOKENS", 32),
		MemoryHighWatermarkRatio: float64(clampEnvInt("WORKER_MEMORY_HIGH_WATERMARK_PCT", 50, 99, 85)) / 100.0,
		MemoryStarvationSec:      envIntOr("WORKER_MEMORY_STARVATION_SEC", 15),

		TranscriptionEnabled:     envGate("WORKER_GO_TRANSCRIPTION"),
		TranscriptionPollMs:      envIntOr("TRANSCRIPTION_POLL_MS", 5000),
		TranscriptionMaxPerCycle: envIntOr("TRANSCRIPTION_MAX_PER_CYCLE", 4),
		TranscriptionConcurrency: envIntOr("TRANSCRIPTION_CONCURRENCY", 3),
		TranscriptionStaleMs:     envIntOr("TRANSCRIPTION_STALE_MS", 35*60*1000), // 必须 > MaxWallMs(30min)：墙钟内活任务不得被回收
		TranscriptionMaxWallMs:   envIntOr("TRANSCRIPTION_MAX_WALL_MS", 30*60*1000),
		TranscriptionJITPriority: envIntOr("TRANSCRIPTION_JIT_PRIORITY", 20000),

		AutoUpdateEnabled:   envGate("WORKER_GO_AUTO_UPDATE"),
		AutoUpdateMaxWallMs: envIntOr("AUTO_UPDATE_MAX_WALL_MS", 60*60*1000),

		ValleyEnabled:      envGate("VALLEY_ENABLED"),
		ValleyTZ:           envOr("VALLEY_TZ", "Asia/Shanghai"),
		ValleyLookbackDays: envIntOr("VALLEY_LOOKBACK_DAYS", 14),
		ValleyMinHours:     envIntOr("VALLEY_MIN_HOURS", 2),
		ValleyMaxHours:     envIntOr("VALLEY_MAX_HOURS", 6),

		LlmGatewayURL:   envOr("LLM_GATEWAY_URL", defaultWebInternalURL(resolveAppEnv())),
		WebInternalURL:  envOr("WEB_INTERNAL_URL", envOr("LLM_GATEWAY_URL", defaultWebInternalURL(resolveAppEnv()))),
		FirecrawlAPIURL: envOr("FIRECRAWL_API_URL", "http://firecrawl-api:3002"),

		TranscriptionExecutor: envOr("TRANSCRIPTION_EXECUTOR", "go"),

		// 2026-09-17 Node 管线收刀：repo 摄取 Go 单一执行体，默认值由 node 翻转为 go
		ImportJobExecutor:        envOr("IMPORT_JOB_EXECUTOR", "go"),
		ArchiveRoot:              envOr("ARCHIVE_ROOT", "storage/repos"),
		EntryCapBytes:            int64(envIntOr("TARBALL_CACHE_ENTRY_CAP_MB", 1024)) * 1024 * 1024,
		ArchiveDownloadTimeoutMs: envIntOr("ARCHIVE_DOWNLOAD_TIMEOUT_MS", 300000),

		ContentDualWrite: os.Getenv("DOCUMENT_CONTENT_DUAL_WRITE") == "1",

		DefaultBranch:       envOr("DEFAULT_BRANCH", "main"),
		SseHeartbeatMs:      envIntOr("SSE_HEARTBEAT_MS", 15000),
		SseProbeIntervalMs:  envIntOr("SSE_PROBE_INTERVAL_MS", 10000),
		SseMaxLifetimeMs:    envIntOr("SSE_MAX_LIFETIME_MS", 600000),
		SseMaxConnsPerUser:  envIntOr("SSE_MAX_CONNS_PER_USER", 10),
		SseMaxConnsPerIP:    envIntOr("SSE_MAX_CONNS_PER_IP", 30),
		SseMaxGlobalConns:   envIntOr("SSE_MAX_GLOBAL_CONNS", 2048),
		SseJobMaxLifetimeMs: envIntOr("SSE_JOB_MAX_LIFETIME_MS", 900000),

		S3Endpoint:        os.Getenv("S3_ENDPOINT"),
		S3Bucket:          os.Getenv("S3_BUCKET"),
		S3Region:          envOr("S3_REGION", "us-east-1"),
		S3AccessKeyID:     os.Getenv("S3_ACCESS_KEY_ID"),
		S3SecretAccessKey: os.Getenv("S3_SECRET_ACCESS_KEY"),

		SearchIndexEnabled:    os.Getenv("WORKER_GO_SEARCH_INDEX") != "0",
		SearchIndexGzipLevel:  clampEnvInt("SEARCH_INDEX_GZIP_LEVEL", 1, 9, 6),
		SearchIndexDebounceMs: envIntOr("SEARCH_INDEX_REBUILD_DEBOUNCE_MS", 10_000),

		ChunkerMaxTokens: envIntOr("CHUNK_MAX_TOKENS", 800),
		ChunkerOverlap:   envIntOr("CHUNK_OVERLAP", 100),
		ChunkerExecutor:  envOr("CHUNKER_EXECUTOR", "go"),
		RawBase:          envOr("GITHUB_RAW_BASE", "https://raw.githubusercontent.com"),
		WebBase:          envOr("GITHUB_WEB_BASE", "https://github.com"),
	}
}

// clampEnvInt 带 min/max 收敛的整型 env（越界/非法回落默认值）。
func clampEnvInt(key string, min, max, fallback int) int {
	v := envIntOr(key, fallback)
	if v < min || v > max {
		return fallback
	}
	return v
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// envIntervalMinOr 分钟间隔 env（与 Node 侧调度器同名 env 同默认值）。
func envIntervalMinOr(key string, fallback int) int {
	return envIntOr(key, fallback)
}

// envGate 任务门控：env 显式 =1 才挂载（与 Node task-registry enabled() 逐字一致）。
func envGate(key string) bool {
	return os.Getenv(key) == "1"
}

// SSEConfig 将 worker sidecar 配置投影为 SSE 网关专用配置。
func (c Config) SSEConfig() sse.Config {
	return sse.Config{
		InternalToken:       c.InternalToken,
		AppEnv:              c.AppEnv,
		WebInternalURL:      c.WebInternalURL,
		LlmGatewayURL:       c.LlmGatewayURL,
		DefaultBranch:       c.DefaultBranch,
		SseHeartbeatMs:      c.SseHeartbeatMs,
		SseProbeIntervalMs:  c.SseProbeIntervalMs,
		SseMaxLifetimeMs:    c.SseMaxLifetimeMs,
		SseMaxConnsPerUser:  c.SseMaxConnsPerUser,
		SseMaxConnsPerIP:    c.SseMaxConnsPerIP,
		SseMaxGlobalConns:   c.SseMaxGlobalConns,
		SseJobMaxLifetimeMs: c.SseJobMaxLifetimeMs,
	}
}

// ArchiveConfig 将 worker sidecar 配置投影为归档与对象存储专用配置。
func (c Config) ArchiveConfig() archive.Config {
	return archive.Config{
		InternalToken:            c.InternalToken,
		DatabaseURL:              c.DatabaseURL,
		ArchiveRoot:              c.ArchiveRoot,
		AssetsRoot:               c.AssetsRoot,
		EntryCapBytes:            c.EntryCapBytes,
		ArchiveDownloadTimeoutMs: c.ArchiveDownloadTimeoutMs,
		GitHubAPIBase:            c.GitHubAPIBase,
		GitHubToken:              c.GitHubToken,
		UserAgent:                c.UserAgent,
		StorageDriver:            c.StorageDriver,
		StorageRoot:              c.StorageRoot,
		StoragePublicBaseURL:     c.StoragePublicBaseURL,
		DefaultBranch:            c.DefaultBranch,
		RawBase:                  c.RawBase,
		S3Endpoint:               c.S3Endpoint,
		S3Bucket:                 c.S3Bucket,
		S3Region:                 c.S3Region,
		S3AccessKeyID:            c.S3AccessKeyID,
		S3SecretAccessKey:        c.S3SecretAccessKey,
	}
}

// UpdateConfig 将 worker sidecar 配置投影为更新引擎专用配置。
func (c Config) UpdateConfig() update.Config {
	return update.Config{
		ArchiveRoot:         c.ArchiveRoot,
		GitHubToken:         c.GitHubToken,
		GitHubAPIBase:       c.GitHubAPIBase,
		UserAgent:           c.UserAgent,
		AutoUpdateMaxWallMs: c.AutoUpdateMaxWallMs,
		InternalToken:       c.InternalToken,
		ContentDualWrite:    c.ContentDualWrite,
		ChunkerMaxTokens:    c.ChunkerMaxTokens,
		ChunkerOverlap:      c.ChunkerOverlap,
	}
}

func (c Config) SearchConfig() search.Config {
	return search.Config{
		SearchIndexGzipLevel:  c.SearchIndexGzipLevel,
		SearchIndexDebounceMs: c.SearchIndexDebounceMs,
		SearchEngine:          c.SearchEngine,
	}
}

// ScoutConfig 将 worker sidecar 配置投影为 Scout 探测引擎专用配置。
func (c Config) ScoutConfig() scout.Config {
	return scout.Config{
		ArchiveRoot:   c.ArchiveRoot,
		GitHubAPIBase: c.GitHubAPIBase,
		GitHubToken:   c.GitHubToken,
		UserAgent:     c.UserAgent,
	}
}

// RSGConfig 将 worker sidecar 配置投影为 RSG 语义图谱引擎专用配置。
func (c Config) RSGConfig() rsg.Config {
	return rsg.Config{
		ArchiveRoot:      c.ArchiveRoot,
		SemanticGraphDir: c.SemanticGraphDir,
		InternalToken:    c.InternalToken,
	}
}

// DocConfig 将 worker sidecar 配置投影为 doc 领域专用配置。
func (c Config) DocConfig() doc.Config {
	return doc.Config{
		DefaultBranch:    c.DefaultBranch,
		ContentDualWrite: c.ContentDualWrite,
		ChunkerMaxTokens: c.ChunkerMaxTokens,
		ChunkerOverlap:   c.ChunkerOverlap,
	}
}

// TranscriptionConfig 将 worker sidecar 配置投影为转录领域专用配置。
func (c Config) TranscriptionConfig() transcription.Config {
	return transcription.Config{
		TranscriptionPollMs:      c.TranscriptionPollMs,
		TranscriptionMaxPerCycle: c.TranscriptionMaxPerCycle,
		TranscriptionConcurrency: c.TranscriptionConcurrency,
		TranscriptionStaleMs:     c.TranscriptionStaleMs,
		TranscriptionMaxWallMs:   c.TranscriptionMaxWallMs,
		TranscriptionExecutor:    c.TranscriptionExecutor,
		ArchiveRoot:              c.ArchiveRoot,
		SemanticGraphDir:         c.SemanticGraphDir,
		DefaultBranch:            c.DefaultBranch,
		ContentDualWrite:         c.ContentDualWrite,
		ChunkerMaxTokens:         c.ChunkerMaxTokens,
		ChunkerOverlap:           c.ChunkerOverlap,
	}
}

// JobsConfig 将 worker sidecar 配置投影为 jobs 领域专用配置。
func (c Config) JobsConfig() jobs.Config {
	return jobs.Config{
		ImportJobExecutor:  c.ImportJobExecutor,
		SchedulerTickMs:    c.SchedulerTickMs,
		MaxConcurrent:      c.MaxConcurrent,
		MaxWallMs:          c.MaxWallMs,
		StaleAfterMs:       c.StaleAfterMs,
		ReapIntervalMs:     c.ReapIntervalMs,
		FinishedJobTtlDays: c.FinishedJobTtlDays,
		HeartbeatMs:        c.HeartbeatMs,
		EventFlushMs:       c.EventFlushMs,
		EventFlushCount:    c.EventFlushCount,
		MaxEventsPerJob:    c.MaxEventsPerJob,
	}
}

// MemoryGateConfig 将 worker sidecar 配置投影为内存准入闸门专用配置。
func (c Config) MemoryGateConfig() jobs.MemoryGateConfig {
	return jobs.MemoryGateConfig{
		ReservedHeadroomBytes: uint64(c.MemoryReservedHeadroomMB) * 1024 * 1024,
		TokenUnitBytes:        uint64(c.MemoryTokenUnitMB) * 1024 * 1024,
		MinCapacityTokens:     c.MemoryMinCapacityTokens,
		MaxCapacityTokens:     c.MemoryMaxCapacityTokens,
		HighWatermarkRatio:    c.MemoryHighWatermarkRatio,
		StarvationThreshold:   time.Duration(c.MemoryStarvationSec) * time.Second,
	}
}

// SchedulerConfig 将 worker sidecar 配置投影为调度器专用配置。
func (c Config) SchedulerConfig() scheduler.Config {
	return scheduler.Config{
		RetentionEpisodicDays:        c.RetentionEpisodicDays,
		RetentionMonitorDays:         c.RetentionMonitorDays,
		RetentionMcpCallLogDays:      c.RetentionMcpCallLogDays,
		RetentionTokenUsageDays:      c.RetentionTokenUsageDays,
		RetentionAdminAuditDays:      c.RetentionAdminAuditDays,
		RetentionGatewayEvDays:       c.RetentionGatewayEvDays,
		RetentionDaemonTaskRunDays:   c.RetentionDaemonTaskRunDays,
		RetentionImportJobEventDays:  c.RetentionImportJobEventDays,
		RetentionDissectionCacheDays: c.RetentionDissectionCacheDays,
		PruneBatchSize:               c.PruneBatchSize,
		StorageDriver:                c.StorageDriver,
		AssetsGcDryRun:               c.AssetsGcDryRun,
		AssetsOrphanGraceDays:        c.AssetsOrphanGraceDays,
		AssetsRoot:                   c.AssetsRoot,
		OrphanContentGraceDays:       c.OrphanContentGraceDays,
		OrphanGcMaxPerRun:            c.OrphanGcMaxPerRun,
		OrphanGcBatch:                c.OrphanGcBatch,
		VersionGcDays:                c.VersionGcDays,
		PrivateVersionGcDays:         c.PrivateVersionGcDays,

		MonitorAlertWebhookURL:             c.MonitorAlertWebhookURL,
		MonitorAlertErrorSessions:          c.MonitorAlertErrorSessions,
		MonitorAlertCrashes:                c.MonitorAlertCrashes,
		TranscriptionCasMissAlertThreshold: c.TranscriptionCasMissAlertThreshold,

		StaleAfterMs:         c.StaleAfterMs,
		FinishedJobTtlDays:   c.FinishedJobTtlDays,
		TranscriptionStaleMs: c.TranscriptionStaleMs,
		Market:               c.MarketConfig(),

		GitHubAPIBase:            c.GitHubAPIBase,
		GitHubToken:              c.GitHubToken,
		UserAgent:                c.UserAgent,
		UpstreamMaxReposPerCycle: c.UpstreamMaxReposPerCycle,
	}
}

// MarketConfig 将 worker sidecar 配置投影为市场领域专用配置。
func (c Config) MarketConfig() market.Config {
	return market.Config{
		ContentDualWrite: c.ContentDualWrite,
		ChunkerMaxTokens: c.ChunkerMaxTokens,
		ChunkerOverlap:   c.ChunkerOverlap,
	}
}

// LoadConfigFromEnv 从环境变量中加载 sidecar 守护进程配置。
func LoadConfigFromEnv() Config {
	return loadConfigFromEnv()
}

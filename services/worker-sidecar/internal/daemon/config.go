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
	Addr            string
	McpAddr         string
	DatabaseURL     string
	InternalToken   string
	NodeInternalURL string
	AppEnv          string
	PoolMax         int

	GitHubAPIBase string
	GitHubToken   string
	UserAgent     string

	SearchEngine string

	StorageDriver        string
	StorageRoot          string
	AssetsRoot           string
	StoragePublicBaseURL string

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

	MonitorAlertWebhookURL             string
	MonitorAlertErrorSessions          int
	MonitorAlertCrashes                int
	TranscriptionCasMissAlertThreshold int
	PrivateVersionGcDays               int
	OrphanGcBatch                      int
	OrphanGcMaxPerRun                  int
	PruneBatchSize                     int
	AssetsGcDryRun                     bool
	AssetsOrphanGraceDays              int
	UpstreamMaxReposPerCycle           int

	ImportJobsEnabled  bool
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

	MemoryReservedHeadroomMB int
	MemoryTokenUnitMB        int
	MemoryMinCapacityTokens  int
	MemoryMaxCapacityTokens  int
	MemoryHighWatermarkRatio float64
	MemoryStarvationSec      int

	TranscriptionEnabled     bool
	TranscriptionPollMs      int
	TranscriptionMaxPerCycle int
	TranscriptionConcurrency int
	TranscriptionStaleMs     int
	TranscriptionMaxWallMs   int
	TranscriptionJITPriority int

	AutoUpdateEnabled   bool
	AutoUpdateMaxWallMs int

	ValleyEnabled      bool
	ValleyTZ           string
	ValleyLookbackDays int
	ValleyMinHours     int
	ValleyMaxHours     int

	LlmGatewayURL   string
	WebInternalURL  string
	FirecrawlAPIURL string

	TranscriptionExecutor string

	ContentDualWrite bool

	SemanticGraphDir  string
	OutlineMapFileCap int
	TreeMapCacheDir   string

	ImportJobExecutor        string
	ArchiveRoot              string
	EntryCapBytes            int64
	ArchiveDownloadTimeoutMs int

	DefaultBranch       string
	SseHeartbeatMs      int
	SseProbeIntervalMs  int
	SseMaxLifetimeMs    int
	SseMaxConnsPerUser  int
	SseMaxConnsPerIP    int
	SseMaxGlobalConns   int
	SseJobMaxLifetimeMs int

	S3Endpoint        string
	S3Bucket          string
	S3Region          string
	S3AccessKeyID     string
	S3SecretAccessKey string

	SearchIndexEnabled    bool
	SearchIndexGzipLevel  int
	SearchIndexDebounceMs int

	ChunkerMaxTokens int
	ChunkerOverlap   int
	ChunkerExecutor  string
	RawBase          string
	WebBase          string
}

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
	if c.TranscriptionEnabled && c.TranscriptionStaleMs > 0 && c.TranscriptionStaleMs <= c.TranscriptionMaxWallMs {
		return fmt.Errorf("TRANSCRIPTION_STALE_MS (%dms) must exceed TRANSCRIPTION_MAX_WALL_MS (%dms) — otherwise live jobs get re-queued and double-executed within the wall clock",
			c.TranscriptionStaleMs, c.TranscriptionMaxWallMs)
	}
	return nil
}

func resolveAppEnv() string {
	return envOr("APP_ENV", envOr("NODE_ENV", "development"))
}

func defaultWebInternalURL(appEnv string) string {
	if authtoken.IsProductionEnv(appEnv) {
		return "http://web:3000"
	}
	return "http://127.0.0.1:3000"
}

func loadConfigFromEnv() Config {
	return Config{
		Addr:                               envOr("WORKER_SIDECAR_ADDR", ":8082"),
		McpAddr:                            envOr("MCP_SIDECAR_ADDR", ":8081"),
		DatabaseURL:                        os.Getenv("DATABASE_URL"),
		InternalToken:                      os.Getenv("INTERNAL_API_TOKEN"),
		NodeInternalURL:                    os.Getenv("NODE_INTERNAL_URL"),
		AppEnv:                             resolveAppEnv(),
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
		HeartbeatMs:        envIntOr("IMPORT_JOB_HEARTBEAT_MS", 10_000),
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
		TranscriptionStaleMs:     envIntOr("TRANSCRIPTION_STALE_MS", 35*60*1000),
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

		ImportJobExecutor:        envOr("IMPORT_JOB_EXECUTOR", "go"),
		ArchiveRoot:              envOr("ARCHIVE_ROOT", envOr("TARBALL_CACHE_DIR", "storage/repos")),
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

func envIntervalMinOr(key string, fallback int) int {
	return envIntOr(key, fallback)
}

func envGate(key string) bool {
	return os.Getenv(key) == "1"
}

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

func (c Config) ScoutConfig() scout.Config {
	return scout.Config{
		ArchiveRoot:   c.ArchiveRoot,
		GitHubAPIBase: c.GitHubAPIBase,
		GitHubToken:   c.GitHubToken,
		UserAgent:     c.UserAgent,
	}
}

func (c Config) RSGConfig() rsg.Config {
	return rsg.Config{
		ArchiveRoot:      c.ArchiveRoot,
		SemanticGraphDir: c.SemanticGraphDir,
		InternalToken:    c.InternalToken,
	}
}

func (c Config) DocConfig() doc.Config {
	return doc.Config{
		DefaultBranch:    c.DefaultBranch,
		ContentDualWrite: c.ContentDualWrite,
		ChunkerMaxTokens: c.ChunkerMaxTokens,
		ChunkerOverlap:   c.ChunkerOverlap,
	}
}

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

func (c Config) MarketConfig() market.Config {
	return market.Config{
		ContentDualWrite: c.ContentDualWrite,
		ChunkerMaxTokens: c.ChunkerMaxTokens,
		ChunkerOverlap:   c.ChunkerOverlap,
	}
}

func LoadConfigFromEnv() Config {
	return loadConfigFromEnv()
}

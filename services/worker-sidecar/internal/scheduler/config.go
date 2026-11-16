package scheduler

import (
	"os"
	"strconv"

	"github.com/opengits/worker-sidecar/internal/market"
)

// Config 调度器运行时配置，聚合保留期 GC、孤儿清扫、上游检查及市场结算参数。
type Config struct {
	// 保留期与 GC 参数
	RetentionEpisodicDays        int
	RetentionMonitorDays         int
	RetentionMcpCallLogDays      int
	RetentionTokenUsageDays      int
	RetentionAdminAuditDays      int
	RetentionGatewayEvDays       int
	RetentionDaemonTaskRunDays   int
	RetentionImportJobEventDays  int
	RetentionDissectionCacheDays int
	PruneBatchSize               int
	StorageDriver                string
	AssetsGcDryRun               bool
	AssetsOrphanGraceDays        int
	AssetsRoot                   string
	OrphanContentGraceDays       int
	OrphanGcMaxPerRun            int
	OrphanGcBatch                int
	VersionGcDays                int
	PrivateVersionGcDays         int

	// 前端监控告警（monitor-alert）：滑动 1 小时双阈值 → webhook
	MonitorAlertWebhookURL    string
	MonitorAlertErrorSessions int
	MonitorAlertCrashes       int

	// 转录盖章 CAS 未命中告警（transcription-cas-alert ticker）：单窗口增量阈值，
	// 复用 MonitorAlertWebhookURL 通道——运维只配一个 webhook 即收全部告警
	TranscriptionCasMissAlertThreshold int

	// 孤儿任务与超时回收参数
	StaleAfterMs         int
	FinishedJobTtlDays   int
	TranscriptionStaleMs int
	Market               market.Config

	// 上游变更探测参数
	GitHubAPIBase            string
	GitHubToken              string
	UserAgent                string
	UpstreamMaxReposPerCycle int
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

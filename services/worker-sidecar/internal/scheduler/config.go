package scheduler

import (
	"os"
	"strconv"

	"github.com/opengits/worker-sidecar/internal/market"
)

type Config struct {
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

	MonitorAlertWebhookURL    string
	MonitorAlertErrorSessions int
	MonitorAlertCrashes       int

	TranscriptionCasMissAlertThreshold int

	StaleAfterMs         int
	FinishedJobTtlDays   int
	TranscriptionStaleMs int
	Market               market.Config

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

package scheduler

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

type TaskHealthStore interface {
	LatestDaemonTaskRuns(ctx context.Context, since time.Time, limit int) ([]TaskRunFact, error)
}

const (
	// Query a 7-day window so low-frequency (6h/24h) tasks can still accumulate 3 consecutive failures.
	taskHealthWindow       = 7 * 24 * time.Hour
	taskHealthPerTaskLimit = 10
	taskHealthThreshold    = 3
)

func ConsecutiveFailuresByTask(rows []TaskRunFact) map[string]int {
	out := make(map[string]int)
	counting := make(map[string]bool)
	for _, r := range rows {
		if done, seen := counting[r.Task]; seen {
			if done {
				continue
			}
		}
		if r.Status == "failed" {
			out[r.Task]++
		} else {
			counting[r.Task] = true
			if _, exists := out[r.Task]; !exists {
				out[r.Task] = 0
			}
		}
	}
	return out
}

func RunTaskHealthAlertOnce(ctx context.Context, cfg Config, store TaskHealthStore) {
	if cfg.MonitorAlertWebhookURL == "" {
		return
	}

	since := time.Now().UTC().Add(-taskHealthWindow)
	rows, err := store.LatestDaemonTaskRuns(ctx, since, taskHealthPerTaskLimit)
	if err != nil {
		log.Printf("[task-health-alert] ledger query failed: %v", err)
		return
	}

	failures := ConsecutiveFailuresByTask(rows)
	var unhealthy []string
	for task, n := range failures {
		if n >= taskHealthThreshold {
			unhealthy = append(unhealthy, fmt.Sprintf("%s（连续失败 %d 轮）", task, n))
		}
	}
	if len(unhealthy) == 0 {
		return
	}
	sortStrings(unhealthy)

	postMonitorAlert(ctx, cfg.MonitorAlertWebhookURL, map[string]any{
		"text":  "[后台任务告警] " + strings.Join(unhealthy, "、"),
		"scope": "daemon-task-health",
		"items": unhealthy,
	})
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func formatDuration(d time.Duration) string { return d.String() }

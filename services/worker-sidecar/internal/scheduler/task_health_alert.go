package scheduler

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────
// 后台任务健康告警（task-health-alert）：消费 DaemonTaskRun 台账，
// 判定「连续 failed ≥ 阈值」的无人值守回路并推送 webhook——
// 让自愈回路从「自愈」升级为「可被信任的自愈」（静默跳过/持续失败可见）。
// webhook 未配置整体禁用（与 monitor-alert 同约定：无状态优先，接收端限频）。
// ─────────────────────────────────────────────────────────────

// TaskHealthStore 告警判定所需的台账读取能力（PgxStore 实现）。
type TaskHealthStore interface {
	LatestDaemonTaskRuns(ctx context.Context, since time.Time, limit int) ([]TaskRunFact, error)
}

const (
	// taskHealthWindow 设为 7 天以覆盖低频任务（如 6h 的 publish-fanout-reconcile、24h 的 search-sync），
	// 配合按任务分区的最新 run 查询，避免在 2h 任意窗口下数学上无法累计达到连续失败阈值 (3 次)。
	taskHealthWindow       = 7 * 24 * time.Hour
	taskHealthPerTaskLimit = 10
	taskHealthThreshold    = 3
)

// ConsecutiveFailuresByTask 从 newest-first 台账行计算每任务的连续失败数。
// 纯函数：输入有序行（createdAt DESC），输出 task → 自最新一条起连续 failed 计数；
// 首条非 failed 即归零（恢复即解除，无需告警抑制状态）。
func ConsecutiveFailuresByTask(rows []TaskRunFact) map[string]int {
	out := make(map[string]int)
	counting := make(map[string]bool)
	for _, r := range rows {
		if done, seen := counting[r.Task]; seen {
			if done {
				continue // 已遇到非 failed，跳过更早的行
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

// RunTaskHealthAlertOnce 执行一轮后台任务健康检查，超阈值推送 webhook。
func RunTaskHealthAlertOnce(ctx context.Context, cfg Config, store TaskHealthStore) {
	if cfg.MonitorAlertWebhookURL == "" {
		return // 未配置即禁用（零成本心跳）
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

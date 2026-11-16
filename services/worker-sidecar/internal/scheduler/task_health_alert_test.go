package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// 🧪 ConsecutiveFailuresByTask：newest-first 行流的连续失败判定（表驱动）。
func TestConsecutiveFailuresByTask(t *testing.T) {
	t.Helper()
	now := time.Now()

	tests := []struct {
		name  string
		rows  []TaskRunFact
		want  map[string]int
	}{
		{
			name: "空台账零告警",
			rows: nil,
			want: map[string]int{},
		},
		{
			name: "连续 3 轮 failed 恰好达到阈值",
			rows: []TaskRunFact{
				{Task: "publish-fanout-reconcile", Status: "failed", CreatedAt: now},
				{Task: "publish-fanout-reconcile", Status: "failed", CreatedAt: now.Add(-time.Minute)},
				{Task: "publish-fanout-reconcile", Status: "failed", CreatedAt: now.Add(-2 * time.Minute)},
			},
			want: map[string]int{"publish-fanout-reconcile": 3},
		},
		{
			name: "最新一轮已恢复 → 连续计数归零（恢复即解除）",
			rows: []TaskRunFact{
				{Task: "orphan-sweeper", Status: "ok", CreatedAt: now},
				{Task: "orphan-sweeper", Status: "failed", CreatedAt: now.Add(-time.Minute)},
				{Task: "orphan-sweeper", Status: "failed", CreatedAt: now.Add(-2 * time.Minute)},
			},
			want: map[string]int{"orphan-sweeper": 0},
		},
		{
			name: "多任务独立计数（交错行序）",
			rows: []TaskRunFact{
				{Task: "a", Status: "failed", CreatedAt: now},
				{Task: "b", Status: "ok", CreatedAt: now.Add(-time.Second)},
				{Task: "a", Status: "failed", CreatedAt: now.Add(-time.Minute)},
				{Task: "b", Status: "failed", CreatedAt: now.Add(-2 * time.Minute)},
				{Task: "a", Status: "failed", CreatedAt: now.Add(-3 * time.Minute)},
			},
			want: map[string]int{"a": 3, "b": 0},
		},
		{
			name: "从未运行过的任务不出现在结果中",
			rows: []TaskRunFact{
				{Task: "a", Status: "failed", CreatedAt: now},
				{Task: "a", Status: "failed", CreatedAt: now.Add(-time.Minute)},
			},
			want: map[string]int{"a": 2},
		},
		{
			name: "低频任务跨多日连续失败（如 6h/24h 间隔任务）依然正确累计",
			rows: []TaskRunFact{
				{Task: "search-sync", Status: "failed", CreatedAt: now},
				{Task: "search-sync", Status: "failed", CreatedAt: now.Add(-24 * time.Hour)},
				{Task: "search-sync", Status: "failed", CreatedAt: now.Add(-48 * time.Hour)},
				{Task: "publish-fanout-reconcile", Status: "failed", CreatedAt: now},
				{Task: "publish-fanout-reconcile", Status: "failed", CreatedAt: now.Add(-6 * time.Hour)},
				{Task: "publish-fanout-reconcile", Status: "failed", CreatedAt: now.Add(-12 * time.Hour)},
			},
			want: map[string]int{"search-sync": 3, "publish-fanout-reconcile": 3},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ConsecutiveFailuresByTask(tt.rows))
		})
	}
}

// 🧪 webhook 未配置 → 整体禁用（零查询零投递）。
func TestRunTaskHealthAlertOnceDisabledWithoutWebhook(t *testing.T) {
	t.Helper()
	store := &fakeHealthStore{rows: []TaskRunFact{{Task: "a", Status: "failed"}, {Task: "a", Status: "failed"}, {Task: "a", Status: "failed"}}}
	assert.NotPanics(t, func() {
		RunTaskHealthAlertOnce(context.Background(), Config{}, store)
	})
	assert.Equal(t, 0, store.queries, "webhook 未配置时不得查询台账")
}

// 🧪 验证查询窗口 since 能够覆盖低频任务（至少覆盖 72 小时以上）
func TestRunTaskHealthAlertOnceQueryWindowCoversLowFrequencyTasks(t *testing.T) {
	t.Helper()
	store := &fakeHealthStore{
		rows: []TaskRunFact{
			{Task: "publish-fanout-reconcile", Status: "failed"},
			{Task: "publish-fanout-reconcile", Status: "failed"},
			{Task: "publish-fanout-reconcile", Status: "failed"},
		},
	}
	cfg := Config{MonitorAlertWebhookURL: "http://127.0.0.1:0/mock-alert"}
	RunTaskHealthAlertOnce(context.Background(), cfg, store)

	assert.Equal(t, 1, store.queries)
	// 验证 since 时间早于当前时间减去 48 小时，确保 6h 和 24h 间隔任务能采集到至少 3 轮
	assert.True(t, store.lastSince.Before(time.Now().Add(-48*time.Hour)), "查询窗口 since 必须覆盖低频任务跨度")
	assert.Equal(t, taskHealthPerTaskLimit, store.lastLimit, "查询 limit 必须为 perTaskLimit 避免全局扫描排挤")
}

type fakeHealthStore struct {
	rows      []TaskRunFact
	queries   int
	lastSince time.Time
	lastLimit int
}

func (f *fakeHealthStore) LatestDaemonTaskRuns(_ context.Context, since time.Time, limit int) ([]TaskRunFact, error) {
	f.queries++
	f.lastSince = since
	f.lastLimit = limit
	return f.rows, nil
}

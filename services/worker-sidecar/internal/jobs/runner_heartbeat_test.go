package jobs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHeartbeatIntervalMsSSOT(t *testing.T) {
	tests := []struct {
		name  string
		cfgMs int
		want  int
	}{
		{name: "配置正值原样生效", cfgMs: 15000, want: 15000},
		{name: "零值回退 10s 默认（与 BootSweep 阈值共用同一 SSOT）", cfgMs: 0, want: 10000},
		{name: "负值（非法配置）同样回退 10s，不产生负间隔 ticker", cfgMs: -5, want: 10000},
		{name: "最小正值 1ms 原样生效（亚秒心跳合法）", cfgMs: 1, want: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewRunner(Config{HeartbeatMs: tt.cfgMs}, &fakeJobQueue{})
			assert.Equal(t, tt.want, r.heartbeatIntervalMs())
		})
	}
}

func TestHeartbeatTicksPeriodicallyAndStopsAfterJobEnds(t *testing.T) {
	tests := []struct {
		name        string
		heartbeatMs int
		minTicks    int
	}{
		{name: "20ms 间隔下 200ms 长任务至少打点 5 次", heartbeatMs: 20, minTicks: 5},
		{name: "50ms 间隔下 200ms 长任务至少打点 3 次", heartbeatMs: 50, minTicks: 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeJobQueue{claims: [][]string{{"job-hb-periodic"}}}
			cfg := jobRunnerCfg()
			cfg.ImportJobExecutor = "go"
			cfg.HeartbeatMs = tt.heartbeatMs
			cfg.MaxWallMs = 30_000
			r := NewRunner(cfg, f)

			release := make(chan struct{})
			r.SetBodyDeps(&fakeBodyExecutor{
				onRunBody: func() bool {
					<-release
					return true
				},
			})
			r.Start()
			defer r.Stop()

			waitFor(t, func() bool {
				f.mu.Lock()
				defer f.mu.Unlock()
				return len(f.heartbeats) >= tt.minTicks
			})
			f.mu.Lock()
			for _, id := range f.heartbeats {
				assert.Equal(t, "job-hb-periodic", id, "心跳必须归属当前任务")
			}
			f.mu.Unlock()

			close(release)
			waitFor(t, func() bool {
				f.mu.Lock()
				defer f.mu.Unlock()
				for _, ev := range f.events {
					if ev.Type == "done" {
						return true
					}
				}
				return false
			})
			time.Sleep(5 * time.Duration(tt.heartbeatMs) * time.Millisecond)
			f.mu.Lock()
			countAtEnd := len(f.heartbeats)
			f.mu.Unlock()

			time.Sleep(5 * time.Duration(tt.heartbeatMs) * time.Millisecond)
			f.mu.Lock()
			defer f.mu.Unlock()
			assert.Equal(t, countAtEnd, len(f.heartbeats),
				"心跳必须随任务结束停止——悬挂 ticker 会无限刷新 lastHeartbeatAt，掩盖假死")
		})
	}
}

func TestReapStaleSQLGolden(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "queries", "jobs.sql"))
	require.NoError(t, err)
	src := string(data)
	i := strings.Index(src, "-- name: ReapStaleImportJobs")
	require.GreaterOrEqual(t, i, 0, "ReapStaleImportJobs 查询不存在")
	block := src[i:]
	if j := strings.Index(block, "\n-- name: "); j >= 0 {
		block = block[:j]
	}

	t.Run("收割置 FAILED 且仅限 RUNNING（不误杀终态）", func(t *testing.T) {
		assert.Contains(t, block, `SET "status" = 'FAILED'`)
		assert.Contains(t, block, `WHERE "status" = 'RUNNING'`)
	})
	t.Run("判死谓词：心跳缺失（NULL）或早于阈值均收割", func(t *testing.T) {
		assert.Contains(t, block, `("lastHeartbeatAt" IS NULL OR "lastHeartbeatAt" < $2)`)
	})
}

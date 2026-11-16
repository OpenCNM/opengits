package market

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
)

// ─────────────────────────────────────────────────────────────
// 换入引擎 swapInJob 直调测试（2026-11 外围清理：swap-in/reject/sweep
// HTTP 端点随试读表决退役拆除，本文件从 HTTP 契约测试改写为引擎级直调；
// HTTP 面的通用契约——鉴权、参数校验、错误映射——由 handler_phase10_test.go
// 对现存端点的同型覆盖承担）。
// ─────────────────────────────────────────────────────────────

func strPtr(s string) *string {
	return &s
}

// 🧪 并发换入 CAS 守卫验证：10 个并发 swapInJob 同一 jobId，有且仅有 1 个成功换入
func TestSwapInJobConcurrency(t *testing.T) {
	tests := []struct {
		name        string
		concurrency int
	}{{"single request", 1}, {"ten concurrent requests", 10}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeMarketSettleStore(t)
			job := TrialRow{
				ID:              "job-concurrent-cas",
				RepositoryID:    "repo-1",
				DocumentID:      "doc-1",
				Path:            "docs/concurrent.md",
				ToSha:           "sha-to",
				StagedContentID: "staged-cas-1",
			}

			concurrency := tt.concurrency
			results := make(chan bool, concurrency)

			var wg sync.WaitGroup
			for i := 0; i < concurrency; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					results <- swapInJob(context.Background(), Config{}, store, job, nil)
				}()
			}
			wg.Wait()
			close(results)

			swappedCount := 0
			loserCount := 0
			for swapped := range results {
				if swapped {
					swappedCount++
				} else {
					loserCount++
				}
			}

			assert.Equal(t, 1, swappedCount, "exactly 1 concurrent swap-in must win CAS")
			assert.Equal(t, concurrency-1, loserCount, "other concurrent calls must lose CAS")
		})
	}
}

// 🧪 [5.3.7.5] 版本置换成功后触发 onIndexRefresh 回调；CAS 输家不触发
func TestSwapInJob_OnIndexRefresh(t *testing.T) {
	tests := []struct {
		name     string
		loser    bool
		wantRepo string
	}{{"winner refreshes", false, "repo-refresh-1"}, {"CAS loser does not refresh", true, ""}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeMarketSettleStore(t)
			job := TrialRow{
				ID:              "job-swap-refresh",
				RepositoryID:    "repo-refresh-1",
				DocumentID:      "doc-1",
				Path:            "docs/intro.md",
				ToSha:           "sha-to",
				StagedContentID: "staged-1",
			}
			store.casLosers[job.ID] = tt.loser

			var refreshedRepo string
			swapped := swapInJob(context.Background(), Config{}, store, job, func(id string) {
				refreshedRepo = id
			})

			assert.Equal(t, !tt.loser, swapped)
			assert.Equal(t, tt.wantRepo, refreshedRepo)
		})
	}
}

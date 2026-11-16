package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/market"
)

// 🧪 [5.7.5.1] & [5.7.5.2] 全站孤儿任务与超时清扫 Table-Driven 单测
func TestRunOrphanSweep_AllComponents(t *testing.T) {
	tests := []struct {
		name                 string
		cfg                  Config
		setupMock            func(m *mockSweeperStore)
		cancelCtx            bool
		wantReapedImport     int64
		wantGcImport         int64
		wantReapedTx         int64
		wantReleasedClaims   int64
		wantFailedTrials     int64
		wantCleanedLeases    int64
		expectErr            bool
		minExpectedStaleDiff time.Duration
		minExpectedTtlDiff   time.Duration
	}{
		{
			name: "标准清扫流程：各组件孤儿任务与过期租约全部正常清扫并汇总",
			cfg: Config{
				StaleAfterMs:         300000, // 5m
				FinishedJobTtlDays:   30,     // 30d
				TranscriptionStaleMs: 600000, // 10m
			},
			setupMock: func(m *mockSweeperStore) {
				m.reapedImportJobs = 3
				m.gcImportJobs = 10
				m.reapedTranscriptionJobs = 2
				m.releasedClaims = 4
				m.failedTrials = 1
				m.cleanedLeases = 7
			},
			wantReapedImport:     3,
			wantGcImport:         10,
			wantReapedTx:         2,
			wantReleasedClaims:   4,
			wantFailedTrials:     1,
			wantCleanedLeases:    7,
			expectErr:            false,
			minExpectedStaleDiff: 4 * time.Minute,
			minExpectedTtlDiff:   29 * 24 * time.Hour,
		},
		{
			name: "零配置自愈回退到标准默认值（5m / 30d / 10m）",
			cfg:  Config{},
			setupMock: func(m *mockSweeperStore) {
				m.reapedImportJobs = 1
				m.cleanedLeases = 2
			},
			wantReapedImport:     1,
			wantGcImport:         0,
			wantReapedTx:         0,
			wantReleasedClaims:   0,
			wantFailedTrials:     0,
			wantCleanedLeases:    2,
			expectErr:            false,
			minExpectedStaleDiff: 4 * time.Minute,
			minExpectedTtlDiff:   29 * 24 * time.Hour,
		},
		{
			name: "单段报错非致命性容错：其余段照常推进并汇总",
			cfg: Config{
				StaleAfterMs: 60000,
			},
			setupMock: func(m *mockSweeperStore) {
				m.reapImportErr = errors.New("temporary DB connection timeout")
				m.gcImportJobs = 5
				m.reapedTranscriptionJobs = 3
				m.cleanedLeases = 4
			},
			wantReapedImport:  0, // 失败不计入
			wantGcImport:      5,
			wantReapedTx:      3,
			wantCleanedLeases: 4,
			expectErr:         false,
		},
		{
			name: "上下文取消时优雅退出并返回 ctx.Err",
			cfg:  Config{},
			setupMock: func(m *mockSweeperStore) {
				m.reapedImportJobs = 2
			},
			cancelCtx:        true,
			wantReapedImport: 0,
			expectErr:        true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newMockSweeperStore(t)
			tt.setupMock(m)

			ctx := context.Background()
			if tt.cancelCtx {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}

			start := time.Now()
			report, err := RunOrphanSweep(ctx, m, tt.cfg)

			if tt.expectErr {
				require.Error(t, err)
				assert.Equal(t, tt.wantReapedImport, report.ReapedImportJobs)
				assert.True(t, m.lastStaleBefore.IsZero(), "no queries should execute on canceled context")
				return
			}
			require.NoError(t, err)
			require.NotNil(t, report)

			assert.Equal(t, tt.wantReapedImport, report.ReapedImportJobs, "reaped import jobs mismatch")
			assert.Equal(t, tt.wantGcImport, report.GcImportJobs, "gc import jobs mismatch")
			assert.Equal(t, tt.wantReapedTx, report.ReapedTranscriptionJobs, "reaped transcription jobs mismatch")
			assert.Equal(t, tt.wantReleasedClaims, report.ReleasedMarketClaims, "released market claims mismatch")
			assert.Equal(t, tt.wantFailedTrials, report.FailedMarketTrials, "failed market trials mismatch")
			assert.Equal(t, tt.wantCleanedLeases, report.ExpiredLeasesCleaned, "cleaned leases mismatch")
			assert.GreaterOrEqual(t, report.DurationMs, int64(0), "duration should be non-negative")

			if tt.minExpectedStaleDiff > 0 {
				assert.WithinDuration(t, start.Add(-tt.minExpectedStaleDiff), m.lastStaleBefore, time.Minute)
			}
			if tt.minExpectedTtlDiff > 0 {
				assert.WithinDuration(t, start.Add(-tt.minExpectedTtlDiff), m.lastTtlBefore, 24*time.Hour)
			}
			assert.WithinDuration(t, start.Add(-24*time.Hour), m.lastLeaseCutoff, time.Minute)
		})
	}
}

func TestRunOrphanSweeperOnce_LeaseControl(t *testing.T) {
	tests := []struct {
		name      string
		leaseHeld bool
		wantSwept bool
	}{
		{
			name:      "成功获取租约：触发清扫执行",
			leaseHeld: false,
			wantSwept: true,
		},
		{
			name:      "租约被持：跳过本轮不执行清扫",
			leaseHeld: true,
			wantSwept: false,
		},
		{
			name:      "store 为 nil 时安全短路不 panic",
			leaseHeld: false,
			wantSwept: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeStore()
			if tt.leaseHeld {
				f.leaseRows = 0 // simulate lease held elsewhere
				f.leaseInsertErr = errors.New("unique violation: lease held")
			} else {
				f.leaseRows = 1
			}

			m := newMockSweeperStore(t)
			m.reapedImportJobs = 5

			combined := &mockTaskAndSweeperStore{
				fakeStore:        f,
				mockSweeperStore: m,
			}

			var store TaskStore = combined
			if tt.name == "store 为 nil 时安全短路不 panic" {
				store = nil
			}

			cfg := Config{}
			var refreshedRepo string
			RunOrphanSweeperOnce(context.Background(), cfg, store, func(repoId string) {
				refreshedRepo = repoId
			})

			if tt.wantSwept {
				assert.Equal(t, int64(5), m.reapedImportJobs)
				assert.False(t, m.lastStaleBefore.IsZero(), "staleBefore should be set when run")
			} else {
				assert.True(t, m.lastStaleBefore.IsZero(), "staleBefore should not be set when skipped")
				assert.Empty(t, refreshedRepo)
			}
		})
	}
}

func TestRunOrphanSweep_MarketSettleIntegration(t *testing.T) {
	tests := []struct {
		name         string
		trials       []market.TrialRow
		wantSwapped  int64
		wantRejected int64
	}{
		{
			// 试读表决退役（ChapterUpdateVote 零写入、VoteVerdict 链摘除）：
			// 超期 TRIAL 无票默认换入（无罪推定），rejected 恒 0
			name: "超期 TRIAL 任务无票默认换入",
			trials: []market.TrialRow{
				{
					ID:              "trial-swap",
					RepositoryID:    "repo-1",
					DocumentID:      "doc-1",
					StagedContentID: "staged-1",
				},
				{
					ID:              "trial-swap-2",
					RepositoryID:    "repo-1",
					DocumentID:      "doc-2",
					StagedContentID: "staged-2",
				},
			},
			wantSwapped:  2,
			wantRejected: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newMockSweeperStore(t)
			m.releasedClaims = 2
			m.failedTrials = 1

			fms := newFakeMarketSettleStore()
			fms.trials = tt.trials

			combined := &mockSweeperAndMarketStore{
				mockSweeperStore:      m,
				fakeMarketSettleStore: fms,
			}

			cfg := Config{}
			var refreshedRepo string
			report, err := RunOrphanSweep(context.Background(), combined, cfg, func(repoId string) {
				refreshedRepo = repoId
			})

			require.NoError(t, err)
			require.NotNil(t, report)
			assert.Equal(t, int64(2), report.ReleasedMarketClaims)
			assert.Equal(t, int64(1), report.FailedMarketTrials)
			assert.Equal(t, tt.wantSwapped, report.SwappedMarketTrials)
			assert.Equal(t, tt.wantRejected, report.RejectedMarketTrials)
			assert.Equal(t, "repo-1", refreshedRepo)
		})
	}
}

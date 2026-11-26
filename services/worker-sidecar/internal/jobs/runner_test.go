package jobs

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type pendingRewardQueue struct {
	fakeJobQueue
	pending     bool
	callbackErr error
	callbacks   int
}

func (f *pendingRewardQueue) ClaimPendingImportRewardJobs(_ context.Context, _ int, _ time.Time) ([]string, error) {
	if f.pending {
		return []string{"completed"}, nil
	}
	return nil, nil
}
func (f *pendingRewardQueue) RetryImportReward(_ context.Context, _ string) error {
	f.callbacks++
	if f.callbackErr != nil {
		return f.callbackErr
	}
	f.pending = false
	return nil
}
func TestPendingRewardsRetryWithoutIngestion(t *testing.T) {
	tests := []struct {
		name       string
		firstError error
	}{{"callback failure preserved", assert.AnError}, {"callback succeeds", nil}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &pendingRewardQueue{pending: true, callbackErr: tt.firstError}
			r := NewRunner(jobRunnerCfg(), f)
			r.retryPendingRewards()
			r.wg.Wait()
			assert.Equal(t, tt.firstError != nil, f.pending)
			f.callbackErr = nil
			r.retryPendingRewards()
			r.wg.Wait()
			assert.False(t, f.pending)
			want := 1
			if tt.firstError != nil {
				want = 2
			}
			assert.Equal(t, want, f.callbacks)
			assert.Empty(t, f.fails)
			assert.Empty(t, f.claimed)
		})
	}
}

func TestCompletedBodyCallbackFailureNeverFallsBack(t *testing.T) {
	tests := []struct{ name string }{{"completed callback failure"}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeJobQueue{jobRows: map[string]*JobRow{"completed": {Id: "completed", Status: "COMPLETED"}}}
			cfg := jobRunnerCfg()
			cfg.ImportJobExecutor = "go"
			r := NewRunner(cfg, f)
			r.SetBodyDeps(&fakeBodyExecutor{fallback: true})
			r.runJob("completed")
			assert.Empty(t, f.fails)
		})
	}
}

type fakeJobQueue struct {
	mu sync.Mutex

	claimed     [][]string
	claims      [][]string
	fails       []string
	reaps       []time.Time
	gcs         []time.Time
	emerRO      bool
	jobRows     map[string]*JobRow
	heartbeats  []string
	onHeartbeat func(context.Context, string) error
	events      []JobEventEntry
}

func (f *fakeJobQueue) GetImportJob(_ context.Context, jobId string) (*JobRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.jobRows != nil {
		if r, ok := f.jobRows[jobId]; ok {
			return r, nil
		}
	}
	return &JobRow{Id: jobId, Status: "RUNNING", Owner: "o", Repo: "r", Branch: "main", Params: []byte(`{"kind":"github","options":{}}`)}, nil
}

func (f *fakeJobQueue) ClaimNextQueuedJobs(_ context.Context, slots int, guard []string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	g := append([]string{}, guard...)
	f.claimed = append(f.claimed, g)
	if len(f.claims) == 0 {
		return nil, nil
	}
	ids := f.claims[0]
	f.claims = f.claims[1:]
	if slots > 0 && len(ids) > slots {
		ids = ids[:slots]
	}
	return ids, nil
}

func (f *fakeJobQueue) ReapStaleImportJobs(_ context.Context, before time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reaps = append(f.reaps, before)
	return 0, nil
}

func (f *fakeJobQueue) GcFinishedImportJobs(_ context.Context, before time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gcs = append(f.gcs, before)
	return 0, nil
}

func (f *fakeJobQueue) FailImportJob(_ context.Context, jobId, message string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fails = append(f.fails, jobId+"|"+message)
	return true, nil
}

func (f *fakeJobQueue) failsSnapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.fails...)
}

func (f *fakeJobQueue) eventsCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.events)
}

func (f *fakeJobQueue) EmergencyReadOnly(context.Context) (bool, error) {
	return f.emerRO, nil
}

func (f *fakeJobQueue) HeartbeatImportJob(ctx context.Context, jobId string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.onHeartbeat != nil {
		return f.onHeartbeat(ctx, jobId)
	}
	f.heartbeats = append(f.heartbeats, jobId)
	return nil
}

func (f *fakeJobQueue) UpdateImportJobProgress(_ context.Context, _ string, _ string, _ int) error {
	return nil
}

func (f *fakeJobQueue) InsertJobEvents(_ context.Context, _ string, events []JobEventEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, events...)
	return nil
}

func (f *fakeJobQueue) CreateImportJob(_ context.Context, _ CreateJobParams) (CreateJobResult, error) {
	return CreateJobResult{ID: "mock-job-id", Deduped: false}, nil
}

func (f *fakeJobQueue) ClaimSpecificJob(_ context.Context, _ string) (bool, error) {
	return true, nil
}

func (f *fakeJobQueue) CompleteImportJob(_ context.Context, _ string, _ any) (bool, error) {
	return true, nil
}

func (f *fakeJobQueue) RequestImportPublication(_ context.Context, _, _ string) error {
	return nil
}

func jobRunnerCfg() Config {
	return Config{
		SchedulerTickMs:    3600_000,
		MaxConcurrent:      2,
		MaxWallMs:          60_000,
		StaleAfterMs:       60_000,
		ReapIntervalMs:     20_000,
		FinishedJobTtlDays: 7,
		HeartbeatMs:        15000,
		EventFlushMs:       300,
		EventFlushCount:    50,
		MaxEventsPerJob:    1000,
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	require.FailNow(t, "condition not met within timeout")
}

func TestJobRunnerPumpClaimsAndRuns(t *testing.T) {
	f := &fakeJobQueue{claims: [][]string{{"job1"}}}
	cfg := jobRunnerCfg()
	cfg.ImportJobExecutor = "go"
	r := NewRunner(cfg, f)
	done := make(chan string, 1)
	r.SetBodyDeps(&fakeBodyExecutor{
		onRunBody: func() bool {
			done <- "job1"
			return true
		},
	})
	r.Start()
	defer r.Stop()

	waitFor(t, func() bool { return len(done) == 1 })
	assert.Equal(t, "job1", <-done)
}

func TestJobRunnerGuardPreventsSameTickRedispatch(t *testing.T) {
	f := &fakeJobQueue{claims: [][]string{{"job2"}}}
	r := NewRunner(jobRunnerCfg(), f)
	r.mu.Lock()
	r.guard["job1"] = true
	r.mu.Unlock()

	r.pump()

	f.mu.Lock()
	guard := f.claimed[0]
	f.mu.Unlock()

	require.Len(t, guard, 1)
	assert.Equal(t, "job1", guard[0])
}

func TestJobRunner_ReapStaleJobs(t *testing.T) {
	tests := []struct {
		name         string
		staleAfterMs int
		wantCutoff   time.Duration
	}{
		{
			name:         "1.15.2.1 reap cutoff uses explicit UTC and matches 120s stale window",
			staleAfterMs: 120_000,
			wantCutoff:   120 * time.Second,
		},
		{
			name:         "1.15.2.1 fresh jobs with 60s stale window protected by precise UTC cutoff",
			staleAfterMs: 60_000,
			wantCutoff:   60 * time.Second,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeJobQueue{}
			cfg := jobRunnerCfg()
			cfg.ReapIntervalMs = 0
			cfg.StaleAfterMs = tt.staleAfterMs
			r := NewRunner(cfg, f)
			r.maybeReap()

			f.mu.Lock()
			defer f.mu.Unlock()
			require.NotEmpty(t, f.reaps)
			cutoff := f.reaps[0]
			assert.Equal(t, time.UTC, cutoff.Location(), "1.15.2.1 reap cutoff 必须为显式 UTC 时间戳")
			diff := time.Now().UTC().Sub(cutoff)
			assert.True(t, diff >= tt.wantCutoff-time.Second && diff <= tt.wantCutoff+5*time.Second,
				"1.15.2.1 新鲜任务在阈值内不被误 reap 且截止时间对齐 UTC 墙钟窗口")
		})
	}
}

func TestJobRunnerWallClockFail(t *testing.T) {
	f := &fakeJobQueue{claims: [][]string{{"job1"}}}
	cfg := jobRunnerCfg()
	cfg.ImportJobExecutor = "go"
	cfg.MaxWallMs = 20
	r := NewRunner(cfg, f)
	r.SetBodyDeps(&fakeBodyExecutor{
		onRunBody: func() bool {
			time.Sleep(100 * time.Millisecond)
			return false
		},
	})
	r.Start()
	defer r.Stop()

	waitFor(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.fails) > 0
	})
	f.mu.Lock()
	got := f.fails[0]
	f.mu.Unlock()

	assert.Contains(t, got, "job1|")
	assert.Contains(t, got, "导入超过墙钟上限")
}

func TestJobRunnerCrashFailFallback(t *testing.T) {
	f := &fakeJobQueue{claims: [][]string{{"job1"}}}
	cfg := jobRunnerCfg()
	cfg.ImportJobExecutor = "go"
	r := NewRunner(cfg, f)
	r.SetBodyDeps(&fakeBodyExecutor{
		onRunBody: func() bool {
			return false
		},
	})
	r.Start()
	defer r.Stop()

	waitFor(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.fails) > 0
	})
}

func TestJobRunnerEmergencyReadOnlyStopsClaim(t *testing.T) {
	f := &fakeJobQueue{emerRO: true, claims: [][]string{{"job1"}}}
	cfg := jobRunnerCfg()
	cfg.ImportJobExecutor = "go"
	r := NewRunner(cfg, f)
	bodyCalled := false
	r.SetBodyDeps(&fakeBodyExecutor{
		onRunBody: func() bool {
			bodyCalled = true
			return true
		},
	})
	r.Start()
	defer r.Stop()
	time.Sleep(50 * time.Millisecond)

	assert.False(t, bodyCalled, "emergency read-only must stop claiming entirely")
	f.mu.Lock()
	n := len(f.claimed)
	f.mu.Unlock()
	assert.Equal(t, 0, n, "claim must not fire under emergency read-only")
}

func TestJobRunnerSlotCapRespectsMaxConcurrent(t *testing.T) {
	f := &fakeJobQueue{claims: [][]string{{"job1", "job2", "job3"}}}
	cfg := jobRunnerCfg()
	cfg.ImportJobExecutor = "go"
	cfg.MaxConcurrent = 2
	r := NewRunner(cfg, f)
	block := make(chan struct{})
	running := make(chan struct{}, 4)
	r.SetBodyDeps(&fakeBodyExecutor{
		onRunBody: func() bool {
			running <- struct{}{}
			<-block
			return true
		},
	})
	r.Start()
	defer func() { close(block); r.Stop() }()

	waitFor(t, func() bool { return len(running) == 2 })
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, 2, len(running), "concurrent executions must be capped at 2")
}

func TestClaimSQLGolden(t *testing.T) {
	tests := []struct {
		name     string
		fragment string
	}{
		{name: "1.15.1.1 skip locked cas", fragment: `FOR UPDATE SKIP LOCKED`},
		{name: "1.15.1.1 set status running", fragment: `SET "status" = 'RUNNING'`},
		{name: "startedAt coalesce", fragment: `"startedAt" = COALESCE("startedAt", NOW())`},
		{name: "order by createdAt", fragment: `ORDER BY q."createdAt" ASC`},
		{name: "status queued filter", fragment: `q."status" = 'QUEUED'`},
		{name: "limit param", fragment: `LIMIT $2`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Contains(t, claimSQL, tt.fragment)
		})
	}
}

func TestGcFinishedSQLGolden(t *testing.T) {
	tests := []struct {
		name     string
		fragment string
	}{
		{name: "pending callback excluded", fragment: `COALESCE(result->>'importRewardPending', 'false') <> 'true'`},
		{name: "unrewarded completed evidence excluded", fragment: `NOT EXISTS (
		      SELECT 1 FROM "CreditGrantLedger" l
		      WHERE l."repositoryId" = result->>'repositoryId' AND l.source = 'IMPORT_REWARD'`},
		{name: "only finished terminal states", fragment: `"status" IN ('COMPLETED', 'FAILED')`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Contains(t, gcFinishedSQL, tt.fragment)
		})
	}
}

type fakeBodyExecutor struct {
	web             InternalJobAPI
	fallback        bool
	onRunBody       func() bool
	runBodyWithEmit func(emit func(string, map[string]any)) bool
}

func (f *fakeBodyExecutor) RunBody(_ context.Context, _ Config, _ JobRow, emit func(string, map[string]any)) bool {
	if f.runBodyWithEmit != nil {
		return f.runBodyWithEmit(emit)
	}
	if f.onRunBody != nil {
		return f.onRunBody()
	}
	return !f.fallback
}

func (f *fakeBodyExecutor) WebClient() InternalJobAPI {
	return f.web
}

func TestJobRunnerFailClosed(t *testing.T) {
	tests := []struct {
		name        string
		kind        string
		wantFailSub string
	}{
		{
			name:        "repo kind rejected fails closed without node fallback",
			kind:        "repo",
			wantFailSub: "Go 编排体拒绝",
		},
		{
			name:        "web-doc kind rejected fails closed without node fallback",
			kind:        "web-doc",
			wantFailSub: "Go 编排体拒绝",
		},
		{
			name:        "web-sync kind rejected fails closed without node fallback",
			kind:        "web-sync",
			wantFailSub: "Go 编排体拒绝",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeJobQueue{
				claims: [][]string{{"job-code"}},
				jobRows: map[string]*JobRow{
					"job-code": {
						Id:     "job-code",
						Status: "RUNNING",
						Owner:  "test-owner",
						Repo:   "test-repo",
						Branch: "main",
						Params: []byte(`{"kind":"` + tt.kind + `","options":{"gitSha":"dummy-sha"}}`),
					},
				},
			}
			cfg := jobRunnerCfg()
			cfg.ImportJobExecutor = "go"
			r := NewRunner(cfg, f)

			r.SetBodyDeps(&fakeBodyExecutor{
				fallback: true,
			})

			r.Start()
			defer r.Stop()

			waitFor(t, func() bool { return len(f.failsSnapshot()) > 0 })
			require.NotEmpty(t, f.failsSnapshot(), "all kinds rejected must mark job FAILED")
			assert.Contains(t, f.failsSnapshot()[0], tt.wantFailSub)
		})
	}
}

func TestJobRunnerGoExecutorFallback(t *testing.T) {
	TestJobRunnerFailClosed(t)
}

type fakeJobWebAPI struct {
	calledJobId string
}

func TestJobRunnerNoExecutorConfigured(t *testing.T) {
	f := &fakeJobQueue{claims: [][]string{{"job-import-1"}}}
	cfg := jobRunnerCfg()
	r := NewRunner(cfg, f)

	r.Start()
	defer r.Stop()

	waitFor(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.fails) > 0
	})

	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.fails)
	assert.Contains(t, f.fails[0], "job-import-1|")
	assert.Contains(t, f.fails[0], "导入执行体未配置")
}

func TestJobRunnerHeartbeatAndEventStream(t *testing.T) {
	tests := []struct {
		name          string
		success       bool
		holdJob       time.Duration
		wantEventType string
		wantHeartbeat bool
	}{
		{
			name:          "successful job records done event and heartbeat",
			success:       true,
			holdJob:       60 * time.Millisecond,
			wantEventType: "done",
			wantHeartbeat: true,
		},
		{
			name:          "failed job records error event",
			success:       false,
			holdJob:       0,
			wantEventType: "error",
			wantHeartbeat: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeJobQueue{claims: [][]string{{"job-hb-1"}}}
			cfg := jobRunnerCfg()
			cfg.ImportJobExecutor = "go"
			cfg.HeartbeatMs = 20
			cfg.EventFlushMs = 10
			cfg.EventFlushCount = 5
			r := NewRunner(cfg, f)

			r.SetBodyDeps(&fakeBodyExecutor{
				onRunBody: func() bool {
					if tt.holdJob > 0 {
						time.Sleep(tt.holdJob)
					}
					return tt.success
				},
			})

			r.Start()
			defer r.Stop()

			waitFor(t, func() bool {
				f.mu.Lock()
				defer f.mu.Unlock()
				for _, ev := range f.events {
					if ev.Type == tt.wantEventType {
						return true
					}
				}
				return false
			})

			f.mu.Lock()
			defer f.mu.Unlock()
			if tt.wantHeartbeat {
				assert.NotEmpty(t, f.heartbeats, "heartbeat must be recorded")
				assert.Contains(t, f.heartbeats, "job-hb-1")
			}
			var found bool
			for _, ev := range f.events {
				if ev.Type == tt.wantEventType {
					found = true
					break
				}
			}
			assert.True(t, found, "expected event type not found")
		})
	}
}

func TestJobRunnerPanicRecoveryFailsJobInStore(t *testing.T) {
	f := &fakeJobQueue{claims: [][]string{{"job-panic-1"}}}
	cfg := jobRunnerCfg()
	cfg.ImportJobExecutor = "go"
	cfg.HeartbeatMs = 20
	cfg.EventFlushMs = 10
	cfg.EventFlushCount = 5
	r := NewRunner(cfg, f)

	r.SetBodyDeps(&fakeBodyExecutor{
		onRunBody: func() bool {
			panic("simulated fatal crash")
		},
	})

	r.Start()
	defer r.Stop()

	waitFor(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.fails) > 0
	})

	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.fails, "panicking job must be recorded as failed in store")
	assert.Contains(t, f.fails[0], "job-panic-1")
	assert.Contains(t, f.fails[0], "simulated fatal crash")

	var errorEventFound bool
	for _, ev := range f.events {
		if ev.Type == "error" {
			errorEventFound = true
			break
		}
	}
	assert.True(t, errorEventFound, "error event must be emitted on panic")
}

func TestJobRunnerFailClosedWhenNoExecutorConfigured(t *testing.T) {
	f := &fakeJobQueue{claims: [][]string{{"job-no-exec"}}}
	cfg := jobRunnerCfg()
	r := NewRunner(cfg, f)
	r.Start()
	defer r.Stop()

	waitFor(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.fails) > 0
	})

	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.fails, "job must fail when no executor configured")
	assert.Contains(t, f.fails[0], "job-no-exec")
	assert.Contains(t, f.fails[0], "导入执行体未配置")
}

func TestJobRunnerTerminalAfterClaimSkipsBody(t *testing.T) {
	f := &fakeJobQueue{
		claims: [][]string{{"job-terminal"}},
		jobRows: map[string]*JobRow{
			"job-terminal": {
				Id:     "job-terminal",
				Status: "FAILED",
				Owner:  "o", Repo: "r", Branch: "main",
				Params: []byte(`{"kind":"repo","options":{}}`),
			},
		},
	}
	cfg := jobRunnerCfg()
	cfg.ImportJobExecutor = "go"
	r := NewRunner(cfg, f)

	webMock := &fakeJobWebAPI{}
	r.SetBodyDeps(&fakeBodyExecutor{web: webMock, fallback: false})

	r.Start()
	defer r.Stop()

	waitFor(t, func() bool { return f.eventsCount() > 0 })
	require.NotEmpty(t, f.eventsCount(), "recheck branch must push a terminal done event")
	fails := f.failsSnapshot()
	assert.Empty(t, fails, "terminal job must not be failed again")
	assert.Empty(t, webMock.calledJobId, "terminal job must never reach the web endpoint")
}

func TestJobRunnerCapacityIncludesGuardJobs(t *testing.T) {
	tests := []struct {
		name          string
		maxConcurrent int
		activeCount   int
		guardCount    int
		expectedClaim bool
		wantSlots     int
	}{
		{
			name:          "guard 占满容量时暂停认领",
			maxConcurrent: 2,
			activeCount:   0,
			guardCount:    2,
			expectedClaim: false,
			wantSlots:     0,
		},
		{
			name:          "active + guard 混合占满容量时暂停认领",
			maxConcurrent: 2,
			activeCount:   1,
			guardCount:    1,
			expectedClaim: false,
			wantSlots:     0,
		},
		{
			name:          "guard 占部分槽位时仅认领剩余槽位",
			maxConcurrent: 3,
			activeCount:   1,
			guardCount:    1,
			expectedClaim: true,
			wantSlots:     1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeJobQueue{}
			cfg := jobRunnerCfg()
			cfg.MaxConcurrent = tt.maxConcurrent
			r := NewRunner(cfg, f)

			r.mu.Lock()
			for i := 0; i < tt.activeCount; i++ {
				r.active[strconv.Itoa(i)] = true
			}
			for i := 0; i < tt.guardCount; i++ {
				r.guard["guard-"+strconv.Itoa(i)] = true
			}
			r.mu.Unlock()

			r.pump()

			f.mu.Lock()
			claimedCalls := len(f.claimed)
			f.mu.Unlock()

			if tt.expectedClaim {
				assert.Equal(t, 1, claimedCalls)
			} else {
				assert.Equal(t, 0, claimedCalls)
			}
		})
	}
}

func TestJobRunner_CrashLoopDefense(t *testing.T) {
	t.Run("BootSweepOrphanedJobs reaps orphaned RUNNING jobs immediately on startup", func(t *testing.T) {
		f := &fakeJobQueue{}
		cfg := jobRunnerCfg()
		r := NewRunner(cfg, f)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		n, err := r.BootSweepOrphanedJobs(ctx)
		require.NoError(t, err)
		assert.Equal(t, int64(0), n)

		f.mu.Lock()
		reapsCount := len(f.reaps)
		f.mu.Unlock()
		assert.Equal(t, 1, reapsCount, "BootSweep must call ReapStaleImportJobs immediately")
		wantThreshold := r.startTime.Add(-2 * time.Duration(r.heartbeatIntervalMs()) * time.Millisecond)
		assert.Equal(t, wantThreshold, f.reaps[0],
			"BootSweep threshold must be startTime minus two heartbeat periods (protect neighbor jobs whose last heartbeat straddles our boot)")
	})

	t.Run("SetSafeMode clamps MaxConcurrent to 1", func(t *testing.T) {
		f := &fakeJobQueue{}
		cfg := jobRunnerCfg()
		cfg.MaxConcurrent = 8
		r := NewRunner(cfg, f)

		assert.Equal(t, 8, r.cfg.MaxConcurrent)
		r.SetSafeMode(true)
		assert.Equal(t, 1, r.cfg.MaxConcurrent)
	})

	t.Run("heartbeat goroutine panic is isolated and does not crash process", func(t *testing.T) {
		f := &fakeJobQueue{
			onHeartbeat: func(_ context.Context, _ string) error {
				panic("simulated heartbeat panic")
			},
		}
		cfg := jobRunnerCfg()
		cfg.HeartbeatMs = 5
		cfg.MaxWallMs = 30
		r := NewRunner(cfg, f)

		assert.NotPanics(t, func() {
			r.runJob("job-heartbeat-panic")
		})
	})
}

func TestJobRunner_BodyFailureErrorPassThrough(t *testing.T) {
	tests := []struct {
		name          string
		bodyErr       string
		wantFailMsg   string
		wantErrEvents int
	}{
		{
			name:          "body emits specific error -> captured as job failMsg without duplicate",
			bodyErr:       "归档不可用：仓库超过当前信誉配额（上限 80MB）或下载失败，请缩小导入范围或稍后重试",
			wantFailMsg:   "job-1|归档不可用：仓库超过当前信誉配额（上限 80MB）或下载失败，请缩小导入范围或稍后重试",
			wantErrEvents: 1,
		},
		{
			name:          "body silent failure -> uses generic fallback error",
			bodyErr:       "",
			wantFailMsg:   "job-1|导入执行失败：Go 编排体拒绝该任务（能力缺口或落库/结算异常），请查看任务日志或缩小导入范围后重试",
			wantErrEvents: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeJobQueue{}
			cfg := jobRunnerCfg()
			cfg.ImportJobExecutor = "go"
			r := NewRunner(cfg, f)

			exec := &fakeBodyExecutor{
				runBodyWithEmit: func(emit func(string, map[string]any)) bool {
					if tt.bodyErr != "" {
						emit("error", map[string]any{"message": tt.bodyErr})
					}
					return false
				},
			}
			r.SetBodyDeps(exec)

			r.runJob("job-1")

			fails := f.failsSnapshot()
			require.Len(t, fails, 1)
			assert.Equal(t, tt.wantFailMsg, fails[0])

			f.mu.Lock()
			errCount := 0
			for _, ev := range f.events {
				if ev.Type == "error" {
					errCount++
				}
			}
			f.mu.Unlock()
			assert.Equal(t, tt.wantErrEvents, errCount)
		})
	}
}

func TestJobRunner_StructuredGatewayErrorPersistsEncodedDbError(t *testing.T) {
	f := &fakeJobQueue{}
	cfg := jobRunnerCfg()
	cfg.ImportJobExecutor = "go"
	r := NewRunner(cfg, f)

	exec := &fakeBodyExecutor{
		runBodyWithEmit: func(emit func(string, map[string]any)) bool {
			emit("error", map[string]any{
				"message":         "大纲失败: Invalid API key",
				"code":            client.ErrCodeUpstreamAuthError,
				"provider":        "openai",
				"model":           "gpt-4o",
				"upstreamStatus":  401,
				"upstreamCode":    "invalid_api_key",
				"upstreamMessage": "Invalid API key",
			})
			return false
		},
	}
	r.SetBodyDeps(exec)

	r.runJob("job-structured")

	fails := f.failsSnapshot()
	require.Len(t, fails, 1)
	parts := strings.SplitN(fails[0], "|", 2)
	require.Len(t, parts, 2)
	assert.Equal(t, "job-structured", parts[0])
	decoded, ok := client.DecodeStructuredDbError(parts[1])
	require.True(t, ok)
	assert.Equal(t, client.ErrCodeUpstreamAuthError, decoded.Code)
	assert.Equal(t, "openai", decoded.Provider)
	assert.Equal(t, "gpt-4o", decoded.Model)
	assert.Equal(t, 401, decoded.UpstreamStatus)
	assert.Equal(t, "invalid_api_key", decoded.UpstreamCode)
	assert.Equal(t, "Invalid API key", decoded.Message)
}

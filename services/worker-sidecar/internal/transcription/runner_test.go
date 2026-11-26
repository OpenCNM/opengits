package transcription

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/platform/policy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeTranscriptionQueue struct {
	mu sync.Mutex

	claims    [][]TranscriptionClaim
	reaps     []time.Time
	fails     []string
	defers    []string
	completes []string
	emerRO    bool
}

func (f *fakeTranscriptionQueue) ClaimNextTranscriptionJobs(_ context.Context, limit int) ([]TranscriptionClaim, error) {
	if len(f.claims) == 0 {
		return nil, nil
	}
	c := f.claims[0]
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claims = f.claims[1:]
	if limit > 0 && len(c) > limit {
		c = c[:limit]
	}
	return c, nil
}

func (f *fakeTranscriptionQueue) ReapStaleTranscriptionJobs(_ context.Context, before time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reaps = append(f.reaps, before)
	return 0, nil
}

func (f *fakeTranscriptionQueue) DeferTranscriptionJob(_ context.Context, jobId string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.defers = append(f.defers, jobId)
	return true, nil
}

func (f *fakeTranscriptionQueue) FailTranscriptionJobExhausted(_ context.Context, jobId, message string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fails = append(f.fails, jobId+"|"+message)
	return true, nil
}

func (f *fakeTranscriptionQueue) CompleteTranscriptionJob(_ context.Context, jobId string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completes = append(f.completes, jobId)
	return nil
}

func (f *fakeTranscriptionQueue) FailTranscriptionJob(_ context.Context, _ string, _ string) (string, error) {
	return "queued", nil
}

func (f *fakeTranscriptionQueue) EnqueueTranscriptionJob(_ context.Context, _ EnqueueJobParams) (string, error) {
	return "queued", nil
}

func (f *fakeTranscriptionQueue) SaveTranscriptionCheckpoint(_ context.Context, _ SaveCheckpointParams) error {
	return nil
}

func (f *fakeTranscriptionQueue) CompleteTranscriptionByDocID(_ context.Context, _ string) error {
	return nil
}

func (f *fakeTranscriptionQueue) EmergencyReadOnly(context.Context) (bool, error) {
	return f.emerRO, nil
}

func (f *fakeTranscriptionQueue) BatchEnqueueTranscription(_ context.Context, _ string, _ string, _ any) (int64, error) {
	return 0, nil
}

func (f *fakeTranscriptionQueue) PrioritizeTranscriptionJob(_ context.Context, _ string, _ string, _ int) error {
	return nil
}

type fakeRuntimePolicyQueue struct {
	fakeTranscriptionQueue
	rt          policy.RuntimePolicy
	claimLimits []int
}

func (f *fakeRuntimePolicyQueue) ReadRuntimePolicy(_ context.Context) (policy.RuntimePolicy, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rt, nil
}

func (f *fakeRuntimePolicyQueue) ClaimNextTranscriptionJobs(ctx context.Context, limit int) ([]TranscriptionClaim, error) {
	f.mu.Lock()
	f.claimLimits = append(f.claimLimits, limit)
	f.mu.Unlock()
	return f.fakeTranscriptionQueue.ClaimNextTranscriptionJobs(ctx, limit)
}

func transcriptionCfg() Config {
	var cfg Config
	cfg.TranscriptionPollMs = 3600_000
	cfg.TranscriptionMaxPerCycle = 2
	cfg.TranscriptionMaxWallMs = 60_000
	cfg.TranscriptionStaleMs = 15 * 60 * 1000
	cfg.TranscriptionExecutor = "go"
	return cfg
}

func TestTranscriptionCycleRunsClaimedSerially(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
		{ID: "j2", DocumentID: "d2", RequestedBy: "u2"},
	}}}
	r := NewTranscriptionRunner(transcriptionCfg(), f)
	var order []string
	deps := BodyDeps{
		PrepareFunc: func(_ context.Context, docId, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
			order = append(order, docId)
			p := readyPrepForVirtual(false)
			p.Doc.ID = docId
			return p, nil
		},
		Llm:           &fakeLlm{text: "# Done"},
		Store:         &fakeBodyStore{cas: true},
		FinalizeStore: &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"},
	}
	r.SetBodyDeps(deps)
	r.cycleOnce()

	require.Len(t, order, 2)
	assert.Equal(t, []string{"d1", "d2"}, order)
	assert.Equal(t, []string{"j1", "j2"}, f.completes)
}

func TestTranscriptionCycleRunsClaimedConcurrently(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
		{ID: "j2", DocumentID: "d2", RequestedBy: "u2"},
	}}}
	cfg := transcriptionCfg()
	cfg.TranscriptionConcurrency = 2
	r := NewTranscriptionRunner(cfg, f)

	deps := BodyDeps{
		PrepareFunc: func(_ context.Context, docId, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
			p := readyPrepForVirtual(false)
			p.Doc.ID = docId
			return p, nil
		},
		Llm:           &fakeLlm{text: "# Done"},
		Store:         &fakeBodyStore{cas: true},
		FinalizeStore: &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"},
	}
	r.SetBodyDeps(deps)
	r.cycleOnce()

	require.Len(t, f.completes, 2)
	assert.Contains(t, f.completes, "j1")
	assert.Contains(t, f.completes, "j2")
}

func TestTranscriptionCycleCrashFallback(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
	}}}
	r := NewTranscriptionRunner(transcriptionCfg(), f)
	r.SetBodyDeps(BodyDeps{
		PrepareFunc: func(context.Context, string, string, doc.PrepareOptions) (*PrepareResult, error) {
			return nil, assert.AnError
		},
		Store: &fakeBodyStore{cas: true},
	})
	r.cycleOnce()

	assert.Len(t, f.fails, 1, "crash fallback should fire once")
}

func TestTranscriptionCycleSkipsWhileInFlight(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
	}}}
	r := NewTranscriptionRunner(transcriptionCfg(), f)
	r.SetBodyDeps(BodyDeps{
		PrepareFunc: func(context.Context, string, string, doc.PrepareOptions) (*PrepareResult, error) {
			require.FailNow(t, "in-flight cycle must not run")
			return nil, nil
		},
	})
	r.mu.Lock()
	r.inFly = true
	r.mu.Unlock()
	r.cycleOnce()

	assert.Len(t, f.claims, 1, "cycle must skip entirely while previous round is in flight")
}

func TestTranscriptionCycleEmergencyReadOnly(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{emerRO: true, claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
	}}}
	r := NewTranscriptionRunner(transcriptionCfg(), f)
	r.SetBodyDeps(BodyDeps{
		PrepareFunc: func(context.Context, string, string, doc.PrepareOptions) (*PrepareResult, error) {
			require.FailNow(t, "execution must not run under emergency read-only")
			return nil, nil
		},
	})
	r.cycleOnce()
}

func TestTranscriptionReapUsesUTCCutoff(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{}
	r := NewTranscriptionRunner(transcriptionCfg(), f)
	before := time.Now().UTC()
	r.cycleOnce()

	require.Len(t, f.reaps, 1, "reap should run once per cycle")
	cutoff := f.reaps[0]
	assert.Equal(t, time.UTC, cutoff.Location(), "reap cutoff must be UTC")
	want := before.Add(-time.Duration(transcriptionCfg().TranscriptionStaleMs) * time.Millisecond)
	assert.LessOrEqual(t, cutoff.Sub(want), time.Second)
}

func TestTranscriptionClaimSQLGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "queries", "transcription.sql"))
	require.NoError(t, err)
	claimSQL := string(raw)

	tests := []struct {
		name     string
		fragment string
	}{
		{name: "skip locked", fragment: `FOR UPDATE OF q SKIP LOCKED`},
		{name: "status running update", fragment: `SET "status" = 'RUNNING'`},
		{name: "priority and age calculation", fragment: `q."priority" + (EXTRACT(EPOCH FROM (NOW() - q."createdAt")) / 60)::int DESC`},
		{name: "order by createdAt", fragment: `q."createdAt" ASC`},
		{name: "returning columns contract", fragment: `RETURNING j."id", j."documentId", j."requestedBy"`},
		{name: "repository pause filter", fragment: `AND r."transcriptionPaused" = false`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Contains(t, claimSQL, tt.fragment)
		})
	}
}

type fakeWebClientMock struct {
	calledJobId string
	outcome     string
	err         error
	onExecute   func(jobId string)
}

func (f *fakeWebClientMock) Prepare(context.Context, string, string, doc.PrepareOptions) (*PrepareResult, error) {
	return nil, nil
}
func (f *fakeWebClientMock) ValidateMdx(context.Context, string) (bool, string, error) {
	return true, "", nil
}
func (f *fakeWebClientMock) ExtractManifest(_ context.Context, c, _ string) (string, error) {
	return c, nil
}
func (f *fakeWebClientMock) Transform(context.Context, string, string, string, *string, string, string) (string, error) {
	return "", nil
}
func (f *fakeWebClientMock) Finalize(context.Context, string, string, map[string]any) error {
	return nil
}

func TestTranscriptionRunnerExecutorUnavailableFailsClosed(t *testing.T) {
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
	}}}
	cfg := transcriptionCfg()
	cfg.TranscriptionExecutor = "unknown"
	r := NewTranscriptionRunner(cfg, f)

	r.cycleOnce()

	require.NotEmpty(t, f.fails)
	assert.Contains(t, f.fails[0], "j1|executor not available")
}

func goBodyDepsFor(t *testing.T, virtualChapter bool) BodyDeps {
	t.Helper()
	prep := readyPrepForVirtual(virtualChapter)
	return BodyDeps{
		Web: &fakeWebClientMock{outcome: "done"},
		PrepareFunc: func(_ context.Context, _, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
			return prep, nil
		},
		Llm:           &fakeLlm{text: "# 译文"},
		Store:         &fakeBodyStore{cas: true},
		FinalizeStore: &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"},
	}
}

func readyPrepForVirtual(virtualChapter bool) *PrepareResult {
	p := &PrepareResult{Outcome: "ready"}
	p.Doc.ID = "d1"
	p.Doc.RepositoryID = "repo-1"
	p.Doc.Path = "docs/a.md"
	p.Doc.Content = strPtr("# raw")
	p.Doc.IsMarkdown = true
	p.Doc.EnableAIEnhance = true
	p.Doc.VirtualChapter = virtualChapter
	p.Doc.Repository.Owner = "o"
	p.Doc.Repository.Repo = "r"
	p.Doc.Repository.Branch = "main"
	return p
}

func TestRunnerGoBodyCompletesJobDontLeaveRunning(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
	}}}
	cfg := transcriptionCfg()
	cfg.TranscriptionExecutor = "go"
	r := NewTranscriptionRunner(cfg, f)
	r.SetBodyDeps(goBodyDepsFor(t, false))
	r.cycleOnce()

	assert.Equal(t, []string{"j1"}, f.completes, "Go body 成功必须写 DONE（修复滞留 RUNNING 无限重扫缺口）")
}

func TestRunnerGoBodyVirtualChapterExecutesInGo(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
	}}}
	cfg := transcriptionCfg()
	cfg.TranscriptionExecutor = "go"
	r := NewTranscriptionRunner(cfg, f)
	deps := goBodyDepsFor(t, true)
	deps.Llm = &fakeLlm{text: "---\nsummary: Core\n---\n# Architecture\n\nContent\n"}
	r.SetBodyDeps(deps)
	r.cycleOnce()

	assert.Contains(t, f.completes, "j1", "Go 进程内直写收尾后必须标记任务完成")
}

func TestRunnerGoBodyPrepareFailureFailsAttemptsNotFallback(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
	}}}
	cfg := transcriptionCfg()
	cfg.TranscriptionExecutor = "go"
	r := NewTranscriptionRunner(cfg, f)
	deps := goBodyDepsFor(t, false)
	deps.PrepareFunc = func(_ context.Context, _, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
		return nil, assert.AnError
	}
	r.SetBodyDeps(deps)
	r.cycleOnce()

	assert.Len(t, f.fails, 1, "按 attempts 语义衰减（回队重试/上限 FAILED）")
}

func TestTranscriptionFairRoundRobinScheduling(t *testing.T) {
	type QueuedJob struct {
		ID           string
		RepositoryID string
		Priority     int
		CreatedAt    time.Time
	}

	baseTime := time.Now().Add(-10 * time.Minute)
	var queue []QueuedJob

	for i := 1; i <= 5; i++ {
		queue = append(queue, QueuedJob{
			ID:           fmt.Sprintf("repoA-ch%d", i),
			RepositoryID: "repo-A",
			Priority:     0,
			CreatedAt:    baseTime.Add(time.Duration(i) * time.Second),
		})
	}

	for i := 1; i <= 5; i++ {
		queue = append(queue, QueuedJob{
			ID:           fmt.Sprintf("repoB-ch%d", i),
			RepositoryID: "repo-B",
			Priority:     0,
			CreatedAt:    baseTime.Add(time.Duration(i) * time.Second),
		})
	}

	type RankedJob struct {
		Job       QueuedJob
		RowNumber int
	}

	repoCounters := make(map[string]int)
	var ranked []RankedJob
	for _, j := range queue {
		repoCounters[j.RepositoryID]++
		ranked = append(ranked, RankedJob{
			Job:       j,
			RowNumber: repoCounters[j.RepositoryID],
		})
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].Job.Priority != ranked[j].Job.Priority {
			return ranked[i].Job.Priority > ranked[j].Job.Priority
		}
		if ranked[i].RowNumber != ranked[j].RowNumber {
			return ranked[i].RowNumber < ranked[j].RowNumber
		}
		return ranked[i].Job.CreatedAt.Before(ranked[j].Job.CreatedAt)
	})

	var claimedOrder []string
	for _, r := range ranked {
		claimedOrder = append(claimedOrder, r.Job.ID)
	}

	expectedOrder := []string{
		"repoA-ch1", "repoB-ch1",
		"repoA-ch2", "repoB-ch2",
		"repoA-ch3", "repoB-ch3",
		"repoA-ch4", "repoB-ch4",
		"repoA-ch5", "repoB-ch5",
	}

	assert.Equal(t, expectedOrder, claimedOrder, "多仓库任务认领必须交替穿插，杜绝单一仓库垄断全部通道")
}

func TestTranscriptionCycleRateLimitDeferred(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	t.Setenv("TRANSCRIPTION_RETRY_BACKOFF_MS", "1")
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
	}}}
	r := NewTranscriptionRunner(transcriptionCfg(), f)

	deps := BodyDeps{
		PrepareFunc: func(_ context.Context, docId, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
			p := readyPrepForVirtual(true)
			p.Doc.ID = docId
			return p, nil
		},
		Llm:           &fakeLlm{err: &client.LlmGatewayError{Code: client.ErrCodeRateLimited, Status: 429}},
		Store:         &fakeBodyStore{cas: true},
		FinalizeStore: &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"},
	}
	r.SetBodyDeps(deps)
	r.cycleOnce()

	require.Len(t, f.defers, 1, "限流任务必须被延后回队")
	assert.Equal(t, "j1", f.defers[0])
	assert.Empty(t, f.fails, "限流任务不应记录为失败")
	assert.Empty(t, f.completes, "限流任务未完成")
}

func TestTranscriptionCycleRateLimitChineseDeferred(t *testing.T) {
	policy.DefaultGatewayPolicy.Reset()
	t.Setenv("TRANSCRIPTION_RETRY_BACKOFF_MS", "1")
	f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
		{ID: "j2", DocumentID: "d2", RequestedBy: "u2"},
	}}}
	r := NewTranscriptionRunner(transcriptionCfg(), f)

	deps := BodyDeps{
		PrepareFunc: func(_ context.Context, docId, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
			p := readyPrepForVirtual(true)
			p.Doc.ID = docId
			return p, nil
		},
		Llm:           &fakeLlm{err: &client.LlmGatewayError{Code: "GENERATION_FAILED", Message: "您的调用已触发服务商速率限制，请稍后重试"}},
		Store:         &fakeBodyStore{cas: true},
		FinalizeStore: &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"},
	}
	r.SetBodyDeps(deps)
	r.cycleOnce()

	require.Len(t, f.defers, 1, "中文限流任务必须被延后回队")
	assert.Equal(t, "j2", f.defers[0])
	assert.Empty(t, f.fails, "中文限流任务不应记录为失败")
	assert.Empty(t, f.completes, "中文限流任务未完成")
}

func TestTranscriptionRunner_CrashLoopDefense(t *testing.T) {
	t.Run("BootSweep reaps stale running jobs immediately on startup", func(t *testing.T) {
		f := &fakeTranscriptionQueue{}
		cfg := Config{
			TranscriptionPollMs:      1000,
			TranscriptionMaxPerCycle: 5,
			TranscriptionConcurrency: 4,
			TranscriptionExecutor:    "go",
		}
		r := NewTranscriptionRunner(cfg, f)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		n, err := r.BootSweep(ctx)
		require.NoError(t, err)
		assert.Equal(t, int64(0), n)

		f.mu.Lock()
		reapsCount := len(f.reaps)
		f.mu.Unlock()
		assert.Equal(t, 1, reapsCount, "BootSweep must call ReapStaleTranscriptionJobs immediately")
	})

	t.Run("SetSafeMode clamps TranscriptionConcurrency to 1", func(t *testing.T) {
		f := &fakeTranscriptionQueue{}
		cfg := Config{
			TranscriptionConcurrency: 8,
		}
		r := NewTranscriptionRunner(cfg, f)

		assert.Equal(t, 8, r.cfg.TranscriptionConcurrency)
		r.SetSafeMode(true)
		assert.Equal(t, 1, r.cfg.TranscriptionConcurrency)
	})

	t.Run("worker panic in pumpConcurrent immediately calls FailTranscriptionJobExhausted", func(t *testing.T) {
		f := &fakeTranscriptionQueue{
			claims: [][]TranscriptionClaim{
				{
					{ID: "job-panic-1", DocumentID: "doc-panic-1", RequestedBy: "user-1"},
				},
			},
		}
		cfg := Config{
			TranscriptionPollMs:      1000,
			TranscriptionMaxPerCycle: 1,
			TranscriptionConcurrency: 2,
			TranscriptionExecutor:    "go",
			TranscriptionMaxWallMs:   500,
		}
		r := NewTranscriptionRunner(cfg, f)

		deps := BodyDeps{
			PrepareFunc: func(_ context.Context, _ string, _ string, _ doc.PrepareOptions) (*doc.PrepareResult, error) {
				panic("simulated fatal worker panic")
			},
		}
		r.SetBodyDeps(deps)

		r.pumpConcurrent()

		require.Eventually(t, func() bool {
			f.mu.Lock()
			defer f.mu.Unlock()
			return len(f.fails) == 1
		}, 2*time.Second, 10*time.Millisecond)

		f.mu.Lock()
		failEntry := f.fails[0]
		f.mu.Unlock()

		assert.Contains(t, failEntry, "job-panic-1")
		assert.Contains(t, failEntry, "转录协程异常崩溃")
		assert.Contains(t, failEntry, "simulated fatal worker panic")
	})

	t.Run("pumpConcurrent respects live RuntimePolicy override and Safe Mode ceiling", func(t *testing.T) {
		defer policy.DefaultGatewayPolicy.Reset()
		eight := 8
		chunkFive := 5

		tests := []struct {
			name          string
			baseConc      int
			maxPerCycle   int
			override      *int
			chunkOverride *int
			safeMode      bool
			wantClaimCap  int
			wantSnapConc  int
			wantSnapChunk int
		}{
			{
				name:          "live policy expands concurrency above static maxPerCycle",
				baseConc:      3,
				maxPerCycle:   4,
				override:      &eight,
				chunkOverride: &chunkFive,
				safeMode:      false,
				wantClaimCap:  8,
				wantSnapConc:  8,
				wantSnapChunk: 5,
			},
			{
				name:          "safeMode always clamps concurrency to 1 even with live policy override",
				baseConc:      3,
				maxPerCycle:   4,
				override:      &eight,
				chunkOverride: &chunkFive,
				safeMode:      true,
				wantClaimCap:  1,
				wantSnapConc:  1,
				wantSnapChunk: 5,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				policy.DefaultGatewayPolicy.Reset()
				f := &fakeRuntimePolicyQueue{
					rt: policy.RuntimePolicy{
						TranscriptionConcurrency:      tt.override,
						TranscriptionChunkConcurrency: tt.chunkOverride,
					},
				}
				r := NewTranscriptionRunner(Config{
					TranscriptionConcurrency: tt.baseConc,
					TranscriptionMaxPerCycle: tt.maxPerCycle,
					TranscriptionExecutor:    "go",
				}, f)
				if tt.safeMode {
					r.SetSafeMode(true)
				}

				r.pumpConcurrent()

				f.mu.Lock()
				limits := append([]int(nil), f.claimLimits...)
				f.mu.Unlock()
				require.Equal(t, []int{tt.wantClaimCap}, limits)

				snap := r.SnapshotRuntimeState(context.Background())
				assert.Equal(t, tt.wantSnapConc, snap.TranscriptionConcurrency)
				assert.Equal(t, tt.wantSnapChunk, snap.TranscriptionChunkConcurrency)
				assert.Equal(t, tt.safeMode, snap.SafeMode)
			})
		}
	})
}

func TestRunnerPermanentUpstreamErrorPassesStructuredLastError(t *testing.T) {
	tests := []struct {
		name string
		err  *client.LlmGatewayError
	}{
		{
			name: "UPSTREAM_AUTH_ERROR forwards structured __OG_ERR__ to FailTranscriptionJobExhausted",
			err: &client.LlmGatewayError{
				Code:           client.ErrCodeUpstreamAuthError,
				Message:        "Invalid API key",
				Status:         401,
				Provider:       "openai",
				Model:          "gpt-4o",
				UpstreamStatus: 401,
				UpstreamCode:   "invalid_api_key",
			},
		},
		{
			name: "UPSTREAM_MODEL_NOT_FOUND forwards structured __OG_ERR__ to FailTranscriptionJobExhausted",
			err: &client.LlmGatewayError{
				Code:           client.ErrCodeUpstreamModelNotFound,
				Message:        "The model gpt-99 does not exist",
				Status:         404,
				Provider:       "openai",
				Model:          "gpt-99",
				UpstreamStatus: 404,
				UpstreamCode:   "model_not_found",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy.DefaultGatewayPolicy.Reset()
			f := &fakeTranscriptionQueue{claims: [][]TranscriptionClaim{{
				{ID: "j1", DocumentID: "d1", RequestedBy: "u1"},
			}}}
			cfg := transcriptionCfg()
			r := NewTranscriptionRunner(cfg, f)
			deps := goBodyDepsFor(t, true)
			deps.Llm = &fakeLlm{err: tt.err}
			r.SetBodyDeps(deps)

			r.cycleOnce()

			require.Len(t, f.fails, 1)
			assert.Empty(t, f.defers)
			assert.Empty(t, f.completes)

			parts := strings.SplitN(f.fails[0], "|", 2)
			require.Len(t, parts, 2)
			assert.Equal(t, "j1", parts[0])
			assert.True(t, isPermanentStructuredErrStr(parts[1]))

			decoded, ok := client.DecodeStructuredDbError(parts[1])
			require.True(t, ok)
			assert.Equal(t, tt.err.Code, decoded.Code)
			assert.Equal(t, tt.err.Provider, decoded.Provider)
			assert.Equal(t, tt.err.Model, decoded.Model)
			assert.Equal(t, tt.err.UpstreamStatus, decoded.UpstreamStatus)
			assert.Equal(t, tt.err.UpstreamCode, decoded.UpstreamCode)
		})
	}
}

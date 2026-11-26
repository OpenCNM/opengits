package update

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeRunnerStore struct {
	mu             sync.Mutex
	leaseRows      int64
	leaseInsertErr error
	leaseDeleted   []string
	repos          []StaleRepoRow
	docs           []DocIdPath
	busy           []string
	active         int
	emergency      bool
	leaseInserts   int
}

func (f *fakeRunnerStore) ReleaseExpiredClaims(context.Context) (int64, error) { return 0, nil }
func (f *fakeRunnerStore) FailTrialsWithoutStaging(context.Context) (int64, error) {
	return 0, nil
}
func (f *fakeRunnerStore) ListUpdatableRepos(context.Context, int) ([]StaleRepoRow, error) {
	return f.repos, nil
}
func (f *fakeRunnerStore) GetRepoProfile(context.Context, string) (*UpdateRepoProfile, error) {
	return nil, nil
}
func (f *fakeRunnerStore) GetDocuments(context.Context, string, *string) ([]UpdateDocumentMeta, error) {
	return nil, nil
}
func (f *fakeRunnerStore) ListProcessedSharedDocs(context.Context, string, []string) ([]DocIdPath, error) {
	return f.docs, nil
}
func (f *fakeRunnerStore) BusyUpdateJobDocIDs(context.Context, string) ([]string, error) {
	return f.busy, nil
}
func (f *fakeRunnerStore) CountActiveUpdateJobs(context.Context, string) (int, error) {
	return f.active, nil
}
func (f *fakeRunnerStore) CreateChapterUpdateJob(context.Context, string, string, string, string, string) error {
	return nil
}
func (f *fakeRunnerStore) SetPendingSyncSha(context.Context, string, string) error {
	return nil
}
func (f *fakeRunnerStore) AdvanceSyncBaseline(context.Context, string, string) error {
	return nil
}
func (f *fakeRunnerStore) ClearUpstreamUpdate(context.Context, string) error {
	return nil
}
func (f *fakeRunnerStore) CreateUpdateRun(context.Context, CreateUpdateRunParams) (string, error) {
	return "mock-run-id", nil
}
func (f *fakeRunnerStore) ClaimUpdateRun(context.Context, string) (bool, error) {
	return true, nil
}
func (f *fakeRunnerStore) UpdateRunStatus(context.Context, string, UpdateRunStatusParams) error {
	return nil
}
func (f *fakeRunnerStore) ApplyUpdatePlanTx(context.Context, ApplyUpdatePlanTxParams) (*ApplyUpdatePlanTxResult, error) {
	return &ApplyUpdatePlanTxResult{}, nil
}
func (f *fakeRunnerStore) EmergencyReadOnly(_ context.Context) (bool, error) {
	return f.emergency, nil
}

func (f *fakeRunnerStore) LeaseUpdateIfHeldOrExpired(ctx context.Context, key, owner string, until time.Time) (int64, error) {
	f.leaseInserts++
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.leaseRows, nil
}
func (f *fakeRunnerStore) LeaseInsert(ctx context.Context, key, owner string, until time.Time) error {
	f.leaseInserts++
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.leaseInsertErr
}
func (f *fakeRunnerStore) LeaseDelete(ctx context.Context, key, owner string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leaseDeleted = append(f.leaseDeleted, key+"@"+owner)
	return nil
}
func (f *fakeRunnerStore) CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error) {
	return 0, nil
}

type fakeAutoUpdateWeb struct {
	called bool
	err    error
}

func (f *fakeAutoUpdateWeb) RunMarketEngineTick(_ context.Context) error {
	f.called = true
	return f.err
}

type blockingAutoUpdateWeb struct {
	onTick func(ctx context.Context) error
}

func (b *blockingAutoUpdateWeb) RunMarketEngineTick(ctx context.Context) error {
	if b.onTick != nil {
		return b.onTick(ctx)
	}
	return nil
}

func TestAutoUpdateRunnerWebClient(t *testing.T) {
	tests := []struct {
		name   string
		webErr error
	}{
		{
			name:   "web endpoint handles auto update",
			webErr: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{}
			f := &fakeRunnerStore{leaseRows: 1}
			r := NewRunner(cfg, f)
			webMock := &fakeAutoUpdateWeb{err: tt.webErr}
			r.SetWebClient(webMock)

			r.RunOnce()

			assert.True(t, webMock.called, "webClient.RunMarketEngineTick must be called")
		})
	}
}

func TestAutoUpdateRunnerGuardsAndConfigs(t *testing.T) {
	tests := []struct {
		name      string
		assertion func(t *testing.T, cfg Config)
	}{
		{
			name: "5.8.2.1 first cycle stagger delay is 90s to offset upstream-check 60s",
			assertion: func(t *testing.T, _ Config) {
				assert.Equal(t, 90*time.Second, AutoUpdateInitialStagger)
			},
		},
		{
			name: "5.8.2.2 wall clock duration cancels execution context on timeout",
			assertion: func(t *testing.T, _ Config) {
				testCfg := Config{AutoUpdateMaxWallMs: 15}
				r := NewRunner(testCfg, nil)
				var gotErr error
				slowWeb := &blockingAutoUpdateWeb{
					onTick: func(ctx context.Context) error {
						<-ctx.Done()
						gotErr = ctx.Err()
						return gotErr
					},
				}
				r.SetWebClient(slowWeb)
				r.RunOnce()
				assert.Equal(t, context.DeadlineExceeded, gotErr)
			},
		},
		{
			name: "5.8.4.1 dockerignore contains wildcard node_modules",
			assertion: func(t *testing.T, _ Config) {
				content, err := os.ReadFile("../../../../.dockerignore")
				if err != nil {
					content, err = os.ReadFile("../../.dockerignore")
				}
				if err == nil {
					assert.Contains(t, string(content), "**/node_modules")
				}
			},
		},
	}

	cfg := Config{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.assertion(t, cfg)
		})
	}
}

func TestAutoUpdateRunnerLeaseContentionAndRelease(t *testing.T) {
	tests := []struct {
		name         string
		leaseHeld    bool
		wantExecuted bool
	}{
		{
			name:         "lease acquired executes cycle",
			leaseHeld:    false,
			wantExecuted: true,
		},
		{
			name:         "lease held elsewhere skips cycle",
			leaseHeld:    true,
			wantExecuted: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{}
			f := &fakeRunnerStore{leaseRows: 1}
			if tt.leaseHeld {
				f.leaseRows = 0
				f.leaseInsertErr = errors.New("unique violation: held by another")
			}
			r := NewRunner(cfg, f)
			webMock := &fakeAutoUpdateWeb{}
			r.SetWebClient(webMock)

			r.RunOnce()

			assert.Equal(t, tt.wantExecuted, webMock.called)
		})
	}

	t.Run("Stop releases lease gracefully", func(t *testing.T) {
		cfg := Config{}
		f := &fakeRunnerStore{}
		r := NewRunner(cfg, f)
		r.Stop()

		f.mu.Lock()
		defer f.mu.Unlock()
		require.NotEmpty(t, f.leaseDeleted)
		assert.Contains(t, f.leaseDeleted[0], "auto-update@")
	})
}

func TestAutoUpdateRunnerInProcessReentrancy(t *testing.T) {
	cfg := Config{}
	f := &fakeRunnerStore{leaseRows: 1}
	r := NewRunner(cfg, f)
	var activeCount int32
	var maxActive int32
	var totalRuns int32

	webMock := &blockingAutoUpdateWeb{
		onTick: func(ctx context.Context) error {
			cur := atomic.AddInt32(&activeCount, 1)
			defer atomic.AddInt32(&activeCount, -1)
			atomic.AddInt32(&totalRuns, 1)
			for {
				old := atomic.LoadInt32(&maxActive)
				if cur <= old || atomic.CompareAndSwapInt32(&maxActive, old, cur) {
					break
				}
			}
			time.Sleep(30 * time.Millisecond)
			return nil
		},
	}
	r.SetWebClient(webMock)

	concurrency := 5
	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.RunOnce()
		}()
	}
	wg.Wait()

	assert.Equal(t, int32(1), maxActive, "at most 1 cycle may execute concurrently in the same process")
	assert.Equal(t, int32(1), totalRuns, "concurrent triggers within the same process must be skipped")
}

func TestRunOnceEmergencyReadOnlyHalts(t *testing.T) {
	tests := []struct {
		name         string
		emergency    bool
		wantLeaseGot bool
	}{
		{name: "emergency active halts the whole cycle", emergency: true, wantLeaseGot: false},
		{name: "normal operation acquires the lease", emergency: false, wantLeaseGot: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeRunnerStore{emergency: tt.emergency}
			r := NewRunner(Config{}, f)
			r.RunOnce()
			assert.Equal(t, tt.wantLeaseGot, f.leaseInserts > 0 || f.leaseRows > 0,
				"lease acquisition must %s under emergency=%v", map[bool]string{true: "happen", false: "not happen"}[tt.wantLeaseGot], tt.emergency)
		})
	}
}

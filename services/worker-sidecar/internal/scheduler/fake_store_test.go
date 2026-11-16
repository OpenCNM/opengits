package scheduler

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/market"
)

func strp(s string) *string { return &s }

// fakeStore 单测桩：记录调度器相关调用供断言。
type fakeStore struct {
	mu sync.Mutex

	leaseRows      int64
	leaseInsertErr error
	pickErr        error
	deleteErr      error
	leaseUpdated   map[string]string
	leaseDeleted   []string

	emergencyRO bool

	picked  map[string]int
	pickIDs map[string][]string
	deleted map[string][]string
	deleteN map[string]int64

	sessionsDeleted      int64
	quotaLogsDeleted     int64
	expiredLeasesCleaned int64

	orphanIDs         []string
	coldDissectionIDs []string

	pubVersionsDeleted  int64
	privVersionsDeleted int64

	activeRepos map[string]bool

	// 前端监控告警计数（monitor-alert；Err 非 nil 模拟查询失败）
	monitorErrSessions   int64
	monitorKindCounts    map[string]int64
	monitorCountErr      error

	upstreamRepos []RepoRow
	touched       []string
	written       []string
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		leaseUpdated: map[string]string{},
		picked:       map[string]int{},
		pickIDs:      map[string][]string{},
		deleted:      map[string][]string{},
		deleteN:      map[string]int64{},
		activeRepos:  map[string]bool{},
	}
}

func (f *fakeStore) LeaseUpdateIfHeldOrExpired(_ context.Context, key, owner string, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leaseUpdated[key] = owner
	return f.leaseRows, nil
}

func (f *fakeStore) LeaseInsert(_ context.Context, key, owner string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.leaseInsertErr != nil {
		return f.leaseInsertErr
	}
	f.leaseUpdated[key] = owner
	return nil
}

func (f *fakeStore) LeaseDelete(_ context.Context, key, owner string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leaseDeleted = append(f.leaseDeleted, key+"@"+owner)
	return nil
}

func (f *fakeStore) CleanExpiredLeases(_ context.Context, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.expiredLeasesCleaned, nil
}

func (f *fakeStore) EmergencyReadOnly(_ context.Context) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.emergencyRO, nil
}

func (f *fakeStore) PickIdsBefore(_ context.Context, table, _ string, _ time.Time, _ int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pickErr != nil {
		return nil, f.pickErr
	}
	f.picked[table]++
	res := f.pickIDs[table]
	f.pickIDs[table] = nil // 模拟单次排空
	return res, nil
}

func (f *fakeStore) DeleteIds(_ context.Context, table string, ids []string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleteErr != nil {
		return 0, f.deleteErr
	}
	f.deleted[table] = append(f.deleted[table], strings.Join(ids, ","))
	if n, ok := f.deleteN[table]; ok {
		return n, nil
	}
	return int64(len(ids)), nil
}

func (f *fakeStore) DeleteExpiredSessions(_ context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sessionsDeleted, nil
}

func (f *fakeStore) DeleteQuotaLogsBefore(_ context.Context, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.quotaLogsDeleted, nil
}

func (f *fakeStore) PickOrphanContentIds(_ context.Context, _ time.Time, _ int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	res := f.orphanIDs
	f.orphanIDs = nil
	return res, nil
}

func (f *fakeStore) PickColdDissectionCacheIds(_ context.Context, _ time.Time, _ int, _ int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	res := f.coldDissectionIDs
	f.coldDissectionIDs = nil
	return res, nil
}

func (f *fakeStore) DeleteStalePublicVersions(_ context.Context, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pubVersionsDeleted, nil
}

func (f *fakeStore) DeleteExpiredPrivateVersions(_ context.Context, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.privVersionsDeleted, nil
}

func (f *fakeStore) ActiveRepoKeys(_ context.Context) (map[string]bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.activeRepos, nil
}

func (f *fakeStore) ActiveArchiveKeys(context.Context) (map[string]bool, error) {
	return map[string]bool{}, nil
}

func (f *fakeStore) ReposForUpstreamCheck(_ context.Context, _ int) ([]RepoRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.upstreamRepos, nil
}

func (f *fakeStore) TouchUpstreamChecked(_ context.Context, owner, repo, branch string, etag *string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	val := owner + "/" + repo + "@" + branch
	if etag != nil {
		val += ":" + *etag
	}
	f.touched = append(f.touched, val)
	return nil
}

func (f *fakeStore) WriteUpstreamChanged(_ context.Context, owner, repo, branch string, hasUpdate bool, etag *string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := ""
	if etag != nil {
		e = *etag
	}
	f.written = append(f.written, strings.Join([]string{owner, repo, branch, ifThen(hasUpdate, "true", "false"), e}, ":"))
	return nil
}

func (f *fakeStore) WriteUpstreamWebChecked(_ context.Context, repoID string, hasUpdate bool, etag *string, _ map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := ""
	if etag != nil {
		e = *etag
	}
	val := repoID + ":hasUpdate=" + ifThen(hasUpdate, "true", "false")
	if e != "" {
		val += ":" + e
	}
	f.written = append(f.written, val)
	return nil
}

func ifThen(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

func (f *fakeStore) CountMonitorErrorSessionsSince(_ context.Context, _ []string, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.monitorCountErr != nil {
		return 0, f.monitorCountErr
	}
	return f.monitorErrSessions, nil
}

func (f *fakeStore) CountMonitorEventsByKindSince(_ context.Context, kind string, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.monitorCountErr != nil {
		return 0, f.monitorCountErr
	}
	return f.monitorKindCounts[kind], nil
}

var _ TaskStore = (*fakeStore)(nil)

// mockSweeperStore 夹具：实现 OrphanSweeperStore 接口。
type mockSweeperStore struct {
	reapedImportJobs        int64
	gcImportJobs            int64
	reapedTranscriptionJobs int64
	releasedClaims          int64
	failedTrials            int64
	cleanedLeases           int64

	reapImportErr        error
	gcImportErr          error
	reapTranscriptionErr error
	releaseClaimsErr     error
	failTrialsErr        error
	cleanLeasesErr       error

	lastStaleBefore   time.Time
	lastTtlBefore     time.Time
	lastTxStaleBefore time.Time
	lastLeaseCutoff   time.Time
}

func newMockSweeperStore(t *testing.T) *mockSweeperStore {
	t.Helper()
	return &mockSweeperStore{}
}

func (m *mockSweeperStore) ReapStaleImportJobs(_ context.Context, staleBefore time.Time) (int64, error) {
	m.lastStaleBefore = staleBefore
	return m.reapedImportJobs, m.reapImportErr
}

func (m *mockSweeperStore) GcFinishedImportJobs(_ context.Context, ttlBefore time.Time) (int64, error) {
	m.lastTtlBefore = ttlBefore
	return m.gcImportJobs, m.gcImportErr
}

func (m *mockSweeperStore) ReapStaleTranscriptionJobs(_ context.Context, staleBefore time.Time) (int64, error) {
	m.lastTxStaleBefore = staleBefore
	return m.reapedTranscriptionJobs, m.reapTranscriptionErr
}

func (m *mockSweeperStore) ReleaseExpiredClaims(context.Context) (int64, error) {
	return m.releasedClaims, m.releaseClaimsErr
}

func (m *mockSweeperStore) FailTrialsWithoutStaging(context.Context) (int64, error) {
	return m.failedTrials, m.failTrialsErr
}

func (m *mockSweeperStore) CleanExpiredLeases(_ context.Context, expiredBefore time.Time) (int64, error) {
	m.lastLeaseCutoff = expiredBefore
	return m.cleanedLeases, m.cleanLeasesErr
}

var _ OrphanSweeperStore = (*mockSweeperStore)(nil)

type mockTaskAndSweeperStore struct {
	*fakeStore
	*mockSweeperStore
}

func (m *mockTaskAndSweeperStore) CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error) {
	return m.mockSweeperStore.CleanExpiredLeases(ctx, expiredBefore)
}

type fakeMarketSettleStore struct {
	mu           sync.Mutex
	trials       []market.TrialRow
	casLosers    map[string]bool
	swapped      []string
	rejected     []string
	events       []string
	ledger       map[string]int
	swapCounts   map[string]int
	qualityHold  []string
	chunked      []string
	metadata     []string
	scoreInputs  map[string]int
}

func newFakeMarketSettleStore() *fakeMarketSettleStore {
	return &fakeMarketSettleStore{
		casLosers:    map[string]bool{},
		ledger:       map[string]int{},
		swapCounts:   map[string]int{},
		scoreInputs:  map[string]int{},
	}
}

func (f *fakeMarketSettleStore) ListExpiredMarketTrials(_ context.Context, _ time.Time, excludeIDs []string, take int) ([]market.TrialRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	excl := map[string]bool{}
	for _, id := range excludeIDs {
		excl[id] = true
	}
	var out []market.TrialRow
	for _, tr := range f.trials {
		if excl[tr.ID] {
			continue
		}
		out = append(out, tr)
		if len(out) >= take {
			break
		}
	}
	return out, nil
}

func (f *fakeMarketSettleStore) LoadStagedContent(_ context.Context, _ string) (string, error) {
	return "# 暂存正文", nil
}

func (f *fakeMarketSettleStore) SettleSwapTx(_ context.Context, job market.TrialRow, _ string, _ bool) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.casLosers[job.ID] {
		return false, nil
	}
	for _, id := range f.swapped {
		if id == job.ID {
			return false, nil
		}
	}
	f.swapped = append(f.swapped, job.ID)
	return true, nil
}

func (f *fakeMarketSettleStore) ReleaseExpiredClaims(_ context.Context) (int64, error) {
	return 0, nil
}

func (f *fakeMarketSettleStore) FailTrialsWithoutStaging(_ context.Context) (int64, error) {
	return 0, nil
}

func (f *fakeMarketSettleStore) RecordMarketSettledEvent(_ context.Context, _ *string, jobID string) {
	f.events = append(f.events, jobID)
}

func (f *fakeMarketSettleStore) IncrementAutoSwapCount(_ context.Context, repoID string) (int, error) {
	f.swapCounts[repoID]++
	return f.swapCounts[repoID], nil
}

func (f *fakeMarketSettleStore) SetQualityHold(_ context.Context, repoID string) error {
	f.qualityHold = append(f.qualityHold, repoID)
	return nil
}

func (f *fakeMarketSettleStore) PostSwapDocument(_ context.Context, _, docID, _ string) error {
	f.chunked = append(f.chunked, docID)
	f.metadata = append(f.metadata, docID)
	return nil
}

func (f *fakeMarketSettleStore) LoadPipelineScoreInputs(_ context.Context, repoID string) (int, []market.PipelineScoreDoc, error) {
	if f.scoreInputs[repoID] < 70 {
		return 0, nil, nil
	}
	codey := func(body string) market.PipelineScoreDoc {
		return market.PipelineScoreDoc{Status: "PROCESSED", Content: "```ts\n" + body + "\n```\n"}
	}
	return 8, []market.PipelineScoreDoc{
		codey("import x from 'y';\ntry { await x(); } catch (e) {}"),
		codey("export const run = async () => { await retry(); };"),
	}, nil
}
func (f *fakeMarketSettleStore) ListActiveJobs(_ context.Context, _ string) ([]market.ActiveJobView, error) {
	return nil, nil
}
func (f *fakeMarketSettleStore) GetJobAuthInfo(_ context.Context, id string) (*market.JobAuthInfo, error) {
	return &market.JobAuthInfo{ID: id, RepositoryID: "repo-1", Kind: "UPDATE", Status: "PENDING", IsPublic: true}, nil
}
func (f *fakeMarketSettleStore) ClaimJob(_ context.Context, _, _ string, _ int) (*market.ClaimResult, error) {
	return &market.ClaimResult{FrozenCredits: 0}, nil
}
func (f *fakeMarketSettleStore) ReleaseClaim(_ context.Context, _, _ string) error {
	return nil
}
func (f *fakeMarketSettleStore) ExtendClaim(_ context.Context, _, _ string, _ int) (bool, error) {
	return true, nil
}
func (f *fakeMarketSettleStore) SettleRelayTx(_ context.Context, _ market.RelaySettleInput) error {
	return nil
}
func (f *fakeMarketSettleStore) MarkJobFailed(_ context.Context, _, _, _ string) error {
	return nil
}
func (f *fakeMarketSettleStore) EnsureRelayJob(_ context.Context, _ string) (*market.RelayJobView, error) {
	return &market.RelayJobView{ID: "job-relay-1", RepositoryID: "repo-1", Kind: "RELAY", Status: "PENDING"}, nil
}
func (f *fakeMarketSettleStore) CreateRetranslateJob(_ context.Context, _ market.RetranslateJobInput) error {
	return nil
}
func (f *fakeMarketSettleStore) CreateStaleJobs(_ context.Context, _ market.CreateStaleJobsInput) (int, error) {
	return 0, nil
}

var _ market.Store = (*fakeMarketSettleStore)(nil)

type mockSweeperAndMarketStore struct {
	*mockSweeperStore
	*fakeMarketSettleStore
}

func (m *mockSweeperAndMarketStore) ReleaseExpiredClaims(ctx context.Context) (int64, error) {
	return m.mockSweeperStore.ReleaseExpiredClaims(ctx)
}

func (m *mockSweeperAndMarketStore) FailTrialsWithoutStaging(ctx context.Context) (int64, error) {
	return m.mockSweeperStore.FailTrialsWithoutStaging(ctx)
}

func (m *mockSweeperAndMarketStore) CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error) {
	return m.mockSweeperStore.CleanExpiredLeases(ctx, expiredBefore)
}

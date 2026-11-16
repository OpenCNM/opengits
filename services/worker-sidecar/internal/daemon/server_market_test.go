package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/market"
	"github.com/opengits/worker-sidecar/internal/ogis"
	"github.com/opengits/worker-sidecar/internal/search"
)

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
func (f *fakeMarketSettleStore) GetJobAuthInfo(_ context.Context, id string) (*market.JobAuthInfo, error) {
	return &market.JobAuthInfo{ID: id, RepositoryID: "repo-1", Kind: "UPDATE", Status: "PENDING", IsPublic: true}, nil
}

// 🧪 [9.4.3.3] 版本置换成功后原子触发 ScheduleRefresh 与 ogisIndexCache 内存失效
//（2026-11 外围清理：swap-in 端点退役，语义改由活路径 relay-settle 承担）
func TestMarketRelaySettle_IndexCacheInvalidation(t *testing.T) {
	token := "test-internal-token"
	store := newFakeMarketSettleStore()

	cfg := Config{
		InternalToken: token,
		ArchiveRoot:   t.TempDir(),
	}
	s := newServer(cfg, nil, nil, nil, nil)
	s.marketStore = store
	handler := s.routes()

	indexStore := newFakeSearchIndexStore()
	indexStore.addRepo(search.OGISRepoMeta{
		ID:    "repo-refresh-1",
		Owner: "opengits",
		Repo:  "myrepo",
	})
	s.cfg.SearchIndexDebounceMs = 10000
	assets := archive.NewDiskAssetStore(t.TempDir())
	s.indexBuilder = search.NewIndexBuilder(s.cfg.SearchConfig(), indexStore, assets)
	t.Cleanup(s.indexBuilder.CancelAll)

	cacheKey := "opengits/myrepo/head"
	s.indexCache.Set(cacheKey, &ogis.Index{})
	_, ok := s.indexCache.Get(cacheKey)
	require.True(t, ok)

	bodyBytes, _ := json.Marshal(map[string]string{
		"jobId":           "job-relay-settle-1",
		"userId":          "user-1",
		"documentId":      "doc-1",
		"repositoryId":    "repo-refresh-1",
		"stagedContentId": "staged-1",
		"stagedModel":     "m1",
		"toSha":           "sha-to",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/relay-settle", bytes.NewReader(bodyBytes))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-internal-token", token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	var res market.MarketJobRelaySettleResponse
	err := json.Unmarshal(rec.Body.Bytes(), &res)
	require.NoError(t, err)
	assert.True(t, res.OK)

	// 断言 1: ScheduleRefresh 已调度去抖重建
	assert.Contains(t, s.indexBuilder.PendingRebuilds(), "repo-refresh-1")

	// 断言 2: indexCache 内存已原子失效
	_, okAfter := s.indexCache.Get(cacheKey)
	assert.False(t, okAfter, "ogisIndexCache must be invalidated upon successful relay settle")
}

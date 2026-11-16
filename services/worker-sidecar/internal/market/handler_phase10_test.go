package market

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type phase10TestStore struct {
	fakeMarketSettleStore
	activeJobs   []ActiveJobView
	claimErr     error
	releaseErr   error
	relayErr     error
	failedErr    error
	relayJobView *RelayJobView
	relayJobErr  error
	retransErr   error
	staleCount   int
	staleErr     error
}

func (s *phase10TestStore) ListActiveJobs(_ context.Context, repoID string) ([]ActiveJobView, error) {
	if s.activeJobs != nil {
		return s.activeJobs, nil
	}
	return []ActiveJobView{
		{
			ID:            "job-active-1",
			DocumentID:    "doc-1",
			Path:          "docs/intro.md",
			Status:        "PENDING",
			Kind:          "UPDATE",
			FromSha:       "sha-1",
			ToSha:         "sha-2",
			FrozenCredits: 0,
			Document:      &ActiveJobDoc{Title: "Introduction"},
		},
	}, nil
}

func (s *phase10TestStore) ClaimJob(_ context.Context, jobID, userID string, ttlMinutes int) (*ClaimResult, error) {
	if s.claimErr != nil {
		return nil, s.claimErr
	}
	return &ClaimResult{FrozenCredits: 0}, nil
}

func (s *phase10TestStore) ReleaseClaim(_ context.Context, jobID, userID string) error {
	return s.releaseErr
}

func (s *phase10TestStore) SettleRelayTx(_ context.Context, input RelaySettleInput) error {
	return s.relayErr
}

func (s *phase10TestStore) MarkJobFailed(_ context.Context, jobID, userID, errMsg string) error {
	return s.failedErr
}


func (s *phase10TestStore) EnsureRelayJob(_ context.Context, documentID string) (*RelayJobView, error) {
	if s.relayJobErr != nil {
		return nil, s.relayJobErr
	}
	if s.relayJobView != nil {
		return s.relayJobView, nil
	}
	return &RelayJobView{
		ID:           "relay-job-1",
		RepositoryID: "repo-1",
		Kind:         "RELAY",
		Status:       "PENDING",
	}, nil
}

func (s *phase10TestStore) CreateRetranslateJob(_ context.Context, input RetranslateJobInput) error {
	return s.retransErr
}

func (s *phase10TestStore) CreateStaleJobs(_ context.Context, input CreateStaleJobsInput) (int, error) {
	if s.staleErr != nil {
		return 0, s.staleErr
	}
	if s.staleCount > 0 {
		return s.staleCount, nil
	}
	return len(input.Paths), nil
}

func newPhase10Router(h *Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/market/jobs/list", h.HandleJobsList)
	mux.HandleFunc("POST /v1/market/jobs/claim", h.HandleJobClaim)
	mux.HandleFunc("POST /v1/market/jobs/release", h.HandleJobRelease)
	mux.HandleFunc("POST /v1/market/jobs/relay-settle", h.HandleJobRelaySettle)
	mux.HandleFunc("POST /v1/market/jobs/mark-failed", h.HandleJobMarkFailed)
	mux.HandleFunc("POST /v1/market/jobs/ensure-relay", h.HandleJobEnsureRelay)
	mux.HandleFunc("POST /v1/market/jobs/retranslate-record", h.HandleJobRetranslateRecord)
	mux.HandleFunc("POST /v1/market/jobs/create-stale", h.HandleJobCreateStale)
	return mux
}

// 🧪 [5.3.7.6 · CRITICAL] Phase 10 更新协同市场单写者内部端点契约与错误映射
//（staged-content / enter-trial / vote 已随试读表决退役拆除）
func TestMarketPhase10Endpoints(t *testing.T) {
	t.Run("HandleJobsList", func(t *testing.T) {
		store := &phase10TestStore{}
		h := NewHandler(Config{}, store)
		router := newPhase10Router(h)

		// 缺失 repositoryId -> 400
		req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/list", bytes.NewReader([]byte(`{}`)))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code)

		// 正常查询 -> 200
		req = httptest.NewRequest(http.MethodPost, "/v1/market/jobs/list", bytes.NewReader([]byte(`{"repositoryId":"repo-1"}`)))
		req.Header.Set("content-type", "application/json")
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)

		var res MarketJobsListResponse
		err := json.Unmarshal(rec.Body.Bytes(), &res)
		require.NoError(t, err)
		assert.True(t, res.OK)
		assert.Len(t, res.Jobs, 1)
		assert.Equal(t, "Introduction", res.Jobs[0].Document.Title)
	})

	t.Run("HandleJobClaim", func(t *testing.T) {
		store := &phase10TestStore{}
		h := NewHandler(Config{}, store)
		router := newPhase10Router(h)

		// 认领成功
		req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/claim", bytes.NewReader([]byte(`{"jobId":"j1","userId":"u1"}`)))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)

		var res MarketJobClaimResponse
		err := json.Unmarshal(rec.Body.Bytes(), &res)
		require.NoError(t, err)
		assert.True(t, res.OK)
		assert.Equal(t, 0, res.FrozenCredits)

		// 已被认领 -> 409
		store.claimErr = ErrJobAlreadyClaimed
		req = httptest.NewRequest(http.MethodPost, "/v1/market/jobs/claim", bytes.NewReader([]byte(`{"jobId":"j1","userId":"u1"}`)))
		req.Header.Set("content-type", "application/json")
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("HandleJobRelease", func(t *testing.T) {
		store := &phase10TestStore{}
		h := NewHandler(Config{}, store)
		router := newPhase10Router(h)

		// 释放成功
		req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/release", bytes.NewReader([]byte(`{"jobId":"j1","userId":"u1"}`)))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)

		// 状态不对 -> 409
		store.releaseErr = ErrJobInvalidState
		req = httptest.NewRequest(http.MethodPost, "/v1/market/jobs/release", bytes.NewReader([]byte(`{"jobId":"j1","userId":"u1"}`)))
		req.Header.Set("content-type", "application/json")
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("HandleJobRelaySettle", func(t *testing.T) {
		store := &phase10TestStore{}
		h := NewHandler(Config{}, store)
		router := newPhase10Router(h)

		req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/relay-settle", bytes.NewReader([]byte(`{"jobId":"j1","userId":"u1","documentId":"d1","repositoryId":"r1","stagedContentId":"sc1","stagedModel":"m1","toSha":"sha2","dualWrite":true}`)))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("HandleJobMarkFailed", func(t *testing.T) {
		store := &phase10TestStore{}
		h := NewHandler(Config{}, store)
		router := newPhase10Router(h)

		req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/mark-failed", bytes.NewReader([]byte(`{"jobId":"j1","userId":"u1","errorMessage":"L0 failed"}`)))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("HandleJobEnsureRelay", func(t *testing.T) {
		store := &phase10TestStore{}
		h := NewHandler(Config{}, store)
		router := newPhase10Router(h)

		req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/ensure-relay", bytes.NewReader([]byte(`{"documentId":"d1"}`)))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)

		var res MarketJobEnsureRelayResponse
		err := json.Unmarshal(rec.Body.Bytes(), &res)
		require.NoError(t, err)
		assert.True(t, res.OK)
		assert.Equal(t, "relay-job-1", res.Job.ID)
	})

	t.Run("HandleJobRetranslateRecord", func(t *testing.T) {
		store := &phase10TestStore{}
		h := NewHandler(Config{}, store)
		router := newPhase10Router(h)

		req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/retranslate-record", bytes.NewReader([]byte(`{"repositoryId":"r1","documentId":"d1","path":"p1","gitSha":"s1","userId":"u1","stagedContentId":"sc1","stagedModel":"m1"}`)))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("HandleJobCreateStale", func(t *testing.T) {
		store := &phase10TestStore{}
		h := NewHandler(Config{}, store)
		router := newPhase10Router(h)

		req := httptest.NewRequest(http.MethodPost, "/v1/market/jobs/create-stale", bytes.NewReader([]byte(`{"repositoryId":"r1","fromSha":"s1","toSha":"s2","paths":["a.md","b.md"]}`)))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)

		var res MarketJobCreateStaleResponse
		err := json.Unmarshal(rec.Body.Bytes(), &res)
		require.NoError(t, err)
		assert.True(t, res.OK)
		assert.Equal(t, 2, res.Created)
	})
}

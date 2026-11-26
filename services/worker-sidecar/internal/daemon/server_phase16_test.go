package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/transcription"
	"github.com/opengits/worker-sidecar/internal/update"
	"github.com/stretchr/testify/assert"
)

type mockJobsQueueStore struct {
	jobs.QueueStore
	eventsInserted bool
	lastJobID      string
	lastEvents     []jobs.JobEventEntry
}

func (m *mockJobsQueueStore) InsertJobEvents(ctx context.Context, jobId string, events []jobs.JobEventEntry) error {
	m.eventsInserted = true
	m.lastJobID = jobId
	m.lastEvents = events
	return nil
}

func (m *mockJobsQueueStore) ClaimNextQueuedJobs(ctx context.Context, slots int, guard []string) ([]string, error) {
	return nil, nil
}
func (m *mockJobsQueueStore) GetImportJob(ctx context.Context, jobId string) (*jobs.JobRow, error) {
	return nil, nil
}
func (m *mockJobsQueueStore) ReapStaleImportJobs(ctx context.Context, staleBefore time.Time) (int64, error) {
	return 0, nil
}
func (m *mockJobsQueueStore) GcFinishedImportJobs(ctx context.Context, ttlBefore time.Time) (int64, error) {
	return 0, nil
}
func (m *mockJobsQueueStore) FailImportJob(ctx context.Context, jobId, message string) (bool, error) {
	return true, nil
}
func (m *mockJobsQueueStore) HeartbeatImportJob(ctx context.Context, jobId string) error {
	return nil
}
func (m *mockJobsQueueStore) UpdateImportJobProgress(ctx context.Context, jobId string, step string, progress int) error {
	return nil
}
func (m *mockJobsQueueStore) EmergencyReadOnly(ctx context.Context) (bool, error) {
	return false, nil
}

func (m *mockJobsQueueStore) CreateImportJob(_ context.Context, _ jobs.CreateJobParams) (jobs.CreateJobResult, error) {
	return jobs.CreateJobResult{ID: "job-created-1", Deduped: false}, nil
}

func (m *mockJobsQueueStore) ClaimSpecificJob(_ context.Context, _ string) (bool, error) {
	return true, nil
}

func (m *mockJobsQueueStore) CompleteImportJob(_ context.Context, _ string, _ any) (bool, error) {
	return true, nil
}

func (m *mockJobsQueueStore) RequestImportPublication(_ context.Context, _, _ string) error {
	return nil
}

type mockIngestStore struct {
	ingest.Store
	snapshotRegistered bool
	lastParams         ingest.RegisterSnapshotParams
}

func (m *mockIngestStore) RegisterImportSnapshot(ctx context.Context, p ingest.RegisterSnapshotParams) (bool, error) {
	m.snapshotRegistered = true
	m.lastParams = p
	return true, nil
}

func (m *mockIngestStore) StoreOutlineDraft(ctx context.Context, repositoryId string, draft ingest.OutlineDraft, isActive bool) (string, error) {
	return "outline-123", nil
}

func (m *mockIngestStore) ActivateOutline(ctx context.Context, repositoryId, outlineId string) error {
	return nil
}

func (m *mockIngestStore) DeactivateAllOutlines(ctx context.Context, repositoryId string) error {
	return nil
}

func TestServer_Phase16Step1Endpoints(t *testing.T) {
	mockJobs := &mockJobsQueueStore{}
	mockIng := &mockIngestStore{}
	cfg := Config{
		InternalToken: "secret-token",
	}
	s := newServer(cfg, nil, nil, nil, nil)
	s.SetJobStore(mockJobs)
	s.SetIngestStore(mockIng)
	handler := s.routes()

	t.Run("POST /v1/ingest/snapshot/register", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"userId":            "user-1",
			"repositoryId":      "repo-1",
			"owner":             "octocat",
			"repo":              "hello-world",
			"branch":            "main",
			"sha":               "sha-123",
			"skipDocumentReset": true,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/ingest/snapshot/register", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockIng.snapshotRegistered)
		assert.Equal(t, "user-1", mockIng.lastParams.UserId)
		assert.Equal(t, "repo-1", mockIng.lastParams.RepositoryId)
		assert.True(t, mockIng.lastParams.SkipReset)
	})

	t.Run("POST /v1/outlines/draft/store", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"repositoryId": "repo-1",
			"draft": map[string]any{
				"parts":    []any{},
				"chapters": []any{},
			},
			"isActive": true,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/outlines/draft/store", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
		var resp map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		assert.Equal(t, true, resp["ok"])
		assert.Equal(t, "outline-123", resp["outlineId"])
	})

	t.Run("POST /v1/outlines/activate", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"repositoryId": "repo-1",
			"outlineId":    "outline-123",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/outlines/activate", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("POST /v1/outlines/deactivate", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"repositoryId": "repo-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/outlines/deactivate", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("POST /v1/jobs/create", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"owner": "octocat", "repo": "hello-world", "branch": "main", "userId": "u-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/jobs/create", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
		var resp map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		assert.Equal(t, "job-created-1", resp["id"])
		assert.Equal(t, false, resp["deduped"])
	})

	t.Run("POST /v1/jobs/request-publication", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"repositoryId": "repo-1", "userId": "u-1"})
		req := httptest.NewRequest(http.MethodPost, "/v1/jobs/request-publication", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
	})
}

type mockUpdateRunStore struct {
	update.Store
	createCalled bool
	claimCalled  bool
	statusCalled bool
	lastRunID    string
}

func (m *mockUpdateRunStore) CreateUpdateRun(ctx context.Context, p update.CreateUpdateRunParams) (string, error) {
	m.createCalled = true
	return "run-xyz", nil
}

func (m *mockUpdateRunStore) ClaimUpdateRun(ctx context.Context, id string) (bool, error) {
	m.claimCalled = true
	m.lastRunID = id
	return true, nil
}

func (m *mockUpdateRunStore) UpdateRunStatus(ctx context.Context, id string, p update.UpdateRunStatusParams) error {
	m.statusCalled = true
	m.lastRunID = id
	return nil
}

func TestServer_Phase16Step2UpdateRunEndpoints(t *testing.T) {
	mockUp := &mockUpdateRunStore{}
	cfg := Config{
		InternalToken: "secret-token",
	}
	s := newServer(cfg, nil, nil, nil, nil)
	s.updateStore = mockUp
	handler := s.routes()

	t.Run("POST /v1/update/runs/create", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"repositoryId": "repo-1",
			"userId":       "user-1",
			"fromSha":      "sha1",
			"toSha":        "sha2",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/update/runs/create", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockUp.createCalled)
	})

	t.Run("POST /v1/update/runs/claim", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"id": "run-xyz",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/update/runs/claim", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockUp.claimCalled)
		assert.Equal(t, "run-xyz", mockUp.lastRunID)
	})

	t.Run("POST /v1/update/runs/status", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{
			"id":     "run-xyz",
			"status": "APPLIED",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/update/runs/status", bytes.NewReader(body))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockUp.statusCalled)
		assert.Equal(t, "run-xyz", mockUp.lastRunID)
	})
}

type mockTranscriptionQueueStore struct {
	transcription.QueueStore
	enqueueCalled      bool
	checkpointCalled   bool
	completeDocCalled  bool
	completeJobCalled  bool
	failCalled         bool
	deferCalled        bool
	reapCalled         bool
	claimCalled        bool
	batchEnqueueCalled bool
	prioritizeCalled   bool
}

func (m *mockTranscriptionQueueStore) BatchEnqueueTranscription(ctx context.Context, repoId, requestedBy string, options any) (int64, error) {
	m.batchEnqueueCalled = true
	return 5, nil
}

func (m *mockTranscriptionQueueStore) PrioritizeTranscriptionJob(ctx context.Context, documentId, requestedBy string, priority int) error {
	m.prioritizeCalled = true
	return nil
}

func (m *mockTranscriptionQueueStore) EnqueueTranscriptionJob(ctx context.Context, p transcription.EnqueueJobParams) (string, error) {
	m.enqueueCalled = true
	return "queued", nil
}

func (m *mockTranscriptionQueueStore) SaveTranscriptionCheckpoint(ctx context.Context, p transcription.SaveCheckpointParams) error {
	m.checkpointCalled = true
	return nil
}

func (m *mockTranscriptionQueueStore) CompleteTranscriptionByDocID(ctx context.Context, docID string) error {
	m.completeDocCalled = true
	return nil
}

func (m *mockTranscriptionQueueStore) CompleteTranscriptionJob(ctx context.Context, jobId string) error {
	m.completeJobCalled = true
	return nil
}

func (m *mockTranscriptionQueueStore) FailTranscriptionJob(ctx context.Context, jobId, message string) (string, error) {
	m.failCalled = true
	return "QUEUED", nil
}

func (m *mockTranscriptionQueueStore) DeferTranscriptionJob(ctx context.Context, jobId string) (bool, error) {
	m.deferCalled = true
	return true, nil
}

func (m *mockTranscriptionQueueStore) ReapStaleTranscriptionJobs(ctx context.Context, staleBefore time.Time) (int64, error) {
	m.reapCalled = true
	return 2, nil
}

func (m *mockTranscriptionQueueStore) ClaimNextTranscriptionJobs(ctx context.Context, limit int) ([]transcription.TranscriptionClaim, error) {
	m.claimCalled = true
	return []transcription.TranscriptionClaim{{ID: "t-1", DocumentID: "doc-1", RequestedBy: "u-1"}}, nil
}

func TestServer_Phase16TranscriptionEndpoints(t *testing.T) {
	mockT := &mockTranscriptionQueueStore{}
	cfg := Config{InternalToken: "secret-token"}
	s := newServer(cfg, nil, nil, nil, nil)
	s.SetTranscriptionStore(mockT)
	handler := s.routes()

	call := func(path string, body map[string]any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
		req.Header.Set("x-internal-token", "secret-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	t.Run("POST /v1/transcription/jobs/enqueue", func(t *testing.T) {
		rec := call("/v1/transcription/jobs/enqueue", map[string]any{
			"documentId": "doc-1", "requestedBy": "u-1", "priority": 100,
		})
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockT.enqueueCalled)
	})

	t.Run("POST /v1/transcription/jobs/prioritize", func(t *testing.T) {
		rec := call("/v1/transcription/jobs/prioritize", map[string]any{"documentId": "doc-1", "priority": 1000000})
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, mockT.prioritizeCalled)
	})
}

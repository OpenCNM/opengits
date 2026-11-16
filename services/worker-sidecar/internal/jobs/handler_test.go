package jobs

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

type mockJobsHandlerStore struct {
	QueueStore
	createFunc func(ctx context.Context, p CreateJobParams) (CreateJobResult, error)
}

func (m *mockJobsHandlerStore) CreateImportJob(ctx context.Context, p CreateJobParams) (CreateJobResult, error) {
	if m.createFunc != nil {
		return m.createFunc(ctx, p)
	}
	return CreateJobResult{ID: "job-default-1", Deduped: false}, nil
}

func TestHandler_HandleCreateJob(t *testing.T) {
	tests := []struct {
		name           string
		body           map[string]any
		mockResult     CreateJobResult
		expectedStatus int
		expectedID     string
		expectedDedup  bool
	}{
		{
			name: "creates new job when no active job exists",
			body: map[string]any{
				"owner":  "octocat",
				"repo":   "hello-world",
				"branch": "main",
				"userId": "user-1",
			},
			mockResult:     CreateJobResult{ID: "job-new-123", Deduped: false},
			expectedStatus: http.StatusOK,
			expectedID:     "job-new-123",
			expectedDedup:  false,
		},
		{
			name: "returns existing job with deduped true when active job exists",
			body: map[string]any{
				"owner":   "octocat",
				"repo":    "hello-world",
				"branch":  "main",
				"edition": "v2",
				"userId":  "user-1",
			},
			mockResult:     CreateJobResult{ID: "job-existing-456", Deduped: true},
			expectedStatus: http.StatusOK,
			expectedID:     "job-existing-456",
			expectedDedup:  true,
		},
		{
			name: "fails with 400 when owner is missing",
			body: map[string]any{
				"repo": "hello-world",
			},
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockJobsHandlerStore{
				createFunc: func(_ context.Context, _ CreateJobParams) (CreateJobResult, error) {
					return tc.mockResult, nil
				},
			}
			h := NewHandler(store)

			raw, err := json.Marshal(tc.body)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/v1/jobs/create", bytes.NewReader(raw))
			rec := httptest.NewRecorder()

			h.HandleCreateJob(rec, req)

			assert.Equal(t, tc.expectedStatus, rec.Code)
			if tc.expectedStatus == http.StatusOK {
				var resp CreateJobResult
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tc.expectedID, resp.ID)
				assert.Equal(t, tc.expectedDedup, resp.Deduped)
			}
		})
	}
}

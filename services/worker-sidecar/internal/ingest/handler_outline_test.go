package ingest

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// outlineStubStore 仅覆写大纲写三个方法的最小桩（嵌入接口，未覆写方法被调用即 panic）。
type outlineStubStore struct {
	Store
	storeErr error
}

func (s *outlineStubStore) StoreOutlineDraft(ctx context.Context, repositoryId string, draft OutlineDraft, isActive bool) (string, error) {
	if s.storeErr != nil {
		return "", s.storeErr
	}
	return "outline-1", nil
}

func (s *outlineStubStore) ActivateOutline(ctx context.Context, repositoryId, outlineId string) error {
	return s.storeErr
}

func (s *outlineStubStore) DeactivateAllOutlines(ctx context.Context, repositoryId string) error {
	return s.storeErr
}

// recordingNotifier 记录触发仓库 ID 的线程安全通知器。
type recordingNotifier struct {
	mu    sync.Mutex
	calls []string
}

func (n *recordingNotifier) notify(repoID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls = append(n.calls, repoID)
}

func (n *recordingNotifier) recorded() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.calls...)
}

func newOutlineRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "/", bytes.NewBufferString(body))
	require.NoError(t, err)
	req.Header.Set("content-type", "application/json")
	return req
}

func TestOutlineHandlersFireWebRevalidate(t *testing.T) {
	tests := []struct {
		name        string
		handler     func(h *Handler) http.HandlerFunc
		body        string
		storeErr    error
		wantStatus  int
		wantNoticed []string
	}{
		{
			name: "draft store active 成功后触发失效",
			handler: func(h *Handler) http.HandlerFunc {
				return h.HandleStoreOutlineDraft
			},
			body:        `{"repositoryId":"repo-1","isActive":true}`,
			wantStatus:  http.StatusOK,
			wantNoticed: []string{"repo-1"},
		},
		{
			name: "draft store 影子模式不触发失效",
			handler: func(h *Handler) http.HandlerFunc {
				return h.HandleStoreOutlineDraft
			},
			body:        `{"repositoryId":"repo-1","isActive":false}`,
			wantStatus:  http.StatusOK,
			wantNoticed: nil,
		},
		{
			name: "draft store 失败不触发失效",
			handler: func(h *Handler) http.HandlerFunc {
				return h.HandleStoreOutlineDraft
			},
			body:        `{"repositoryId":"repo-1","isActive":true}`,
			storeErr:    errors.New("db down"),
			wantStatus:  http.StatusInternalServerError,
			wantNoticed: nil,
		},
		{
			name: "activate 成功后触发失效",
			handler: func(h *Handler) http.HandlerFunc {
				return h.HandleActivateOutline
			},
			body:        `{"repositoryId":"repo-2","outlineId":"outline-1"}`,
			wantStatus:  http.StatusOK,
			wantNoticed: []string{"repo-2"},
		},
		{
			name: "deactivate 成功后触发失效",
			handler: func(h *Handler) http.HandlerFunc {
				return h.HandleDeactivateAllOutlines
			},
			body:        `{"repositoryId":"repo-3"}`,
			wantStatus:  http.StatusOK,
			wantNoticed: []string{"repo-3"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			notifier := &recordingNotifier{}
			h := NewHandler(&outlineStubStore{storeErr: tt.storeErr})
			h.SetOutlineChangedNotifier(notifier.notify)

			rec := httptest.NewRecorder()
			tt.handler(h)(rec, newOutlineRequest(t, tt.body))

			assert.Equal(t, tt.wantStatus, rec.Code)
			assert.Equal(t, tt.wantNoticed, notifier.recorded())
		})
	}
}

func TestOutlineHandlersNoNotifierIsNoop(t *testing.T) {
	h := NewHandler(&outlineStubStore{})

	rec := httptest.NewRecorder()
	h.HandleActivateOutline(rec, newOutlineRequest(t, `{"repositoryId":"repo-1","outlineId":"o-1"}`))

	assert.Equal(t, http.StatusOK, rec.Code)
}

package transcription

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type clampMockStore struct {
	QueueStore
	capturedPriority int
	capturedDoc      string
}

func (m *clampMockStore) PrioritizeTranscriptionJob(ctx context.Context, documentId, requestedBy string, priority int) error {
	m.capturedDoc = documentId
	m.capturedPriority = priority
	return nil
}

func TestHandlePrioritizeClamp(t *testing.T) {
	tests := []struct {
		name         string
		body         string
		jitCap       int
		wantPriority int
	}{
		{name: "未传优先级 → 默认上限", body: `{"documentId":"doc-1","requestedBy":"u1"}`, jitCap: 0, wantPriority: defaultJitPriorityCap},
		{name: "零值优先级 → 默认上限", body: `{"documentId":"doc-1","requestedBy":"u1","priority":0}`, jitCap: 0, wantPriority: defaultJitPriorityCap},
		{name: "负值优先级 → 默认上限", body: `{"documentId":"doc-1","requestedBy":"u1","priority":-5}`, jitCap: 0, wantPriority: defaultJitPriorityCap},
		{name: "历史 1_000_000 高权 → 钳制到默认上限", body: `{"documentId":"doc-1","requestedBy":"u1","priority":1000000}`, jitCap: 0, wantPriority: defaultJitPriorityCap},
		{name: "合法低值 → 原样保留", body: `{"documentId":"doc-1","requestedBy":"u1","priority":15000}`, jitCap: 0, wantPriority: 15000},
		{name: "注入自定义上限后超限 → 钳到自定义上限", body: `{"documentId":"doc-1","requestedBy":"u1","priority":1000000}`, jitCap: 50000, wantPriority: 50000},
		{name: "注入自定义上限后合法低值 → 保留", body: `{"documentId":"doc-1","requestedBy":"u1","priority":20000}`, jitCap: 50000, wantPriority: 20000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &clampMockStore{}
			h := NewHandler(store)
			if tt.jitCap > 0 {
				h.SetJitPriorityCap(tt.jitCap)
			}

			req := httptest.NewRequest(http.MethodPost, "/v1/transcription/jobs/prioritize", strings.NewReader(tt.body))
			rec := httptest.NewRecorder()
			h.HandlePrioritize(rec, req)

			require.Equal(t, http.StatusOK, rec.Code, "body: %s", rec.Body.String())
			assert.Equal(t, "doc-1", store.capturedDoc)
			assert.Equal(t, tt.wantPriority, store.capturedPriority)
		})
	}
}

func TestSetJitPriorityCapRejectsNonPositive(t *testing.T) {
	h := NewHandler(&clampMockStore{})
	h.SetJitPriorityCap(-1)
	assert.Equal(t, defaultJitPriorityCap, h.jitPriorityCap)
}

var _ QueueStore = (*clampMockStore)(nil)

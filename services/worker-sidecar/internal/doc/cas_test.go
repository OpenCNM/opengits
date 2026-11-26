package doc

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeCasStore struct {
	fakeDocStore
	upsertId        string
	upsertErr       error
	gcScanned       int
	gcRemoved       int
	gcErr           error
	attachCount     int
	attachErr       error
	storeChunksN    int
	storeChunksErr  error
	deleteChunksErr error
}

func (f *fakeCasStore) UpsertContent(ctx context.Context, input UpsertContentInput) (string, error) {
	if f.upsertErr != nil {
		return "", f.upsertErr
	}
	if f.upsertId != "" {
		return f.upsertId, nil
	}
	return "content-uuid-1", nil
}

func (f *fakeCasStore) OrphanContentGC(ctx context.Context, input OrphanContentGCInput) (OrphanContentGCResult, error) {
	if f.gcErr != nil {
		return OrphanContentGCResult{}, f.gcErr
	}
	return OrphanContentGCResult{
		Scanned: f.gcScanned,
		Removed: f.gcRemoved,
		DryRun:  input.DryRun,
	}, nil
}

func (f *fakeCasStore) AttachChunks(ctx context.Context, contentId, documentId string) (int, error) {
	if f.attachErr != nil {
		return 0, f.attachErr
	}
	return f.attachCount, nil
}

func (f *fakeCasStore) StoreDocumentChunks(ctx context.Context, input StoreChunksInput) (int, error) {
	if f.storeChunksErr != nil {
		return 0, f.storeChunksErr
	}
	return len(input.Chunks), nil
}

func TestHandleUpsertContent(t *testing.T) {
	t.Helper()
	store := &fakeCasStore{upsertId: "cnt-123"}
	h := NewHandler(Config{}, store, nil)

	payload := UpsertContentInput{
		ContentHash: "hash-abc",
		Content:     "hello world",
		Lang:        "zh",
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v1/cas/content/upsert", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleUpsertContent(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var res map[string]any
	err := json.Unmarshal(rec.Body.Bytes(), &res)
	require.NoError(t, err)
	assert.True(t, res["ok"].(bool))
	assert.Equal(t, "cnt-123", res["contentId"])
}

func TestHandleOrphanContentGC(t *testing.T) {
	t.Helper()
	store := &fakeCasStore{gcScanned: 10, gcRemoved: 5}
	h := NewHandler(Config{}, store, nil)

	payload := OrphanContentGCInput{
		GraceDays: 7,
		DryRun:    false,
		MaxPerRun: 100,
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v1/cas/content/orphan-gc", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleOrphanContentGC(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var res map[string]any
	err := json.Unmarshal(rec.Body.Bytes(), &res)
	require.NoError(t, err)
	assert.True(t, res["ok"].(bool))
	assert.Equal(t, float64(10), res["scanned"])
	assert.Equal(t, float64(5), res["removed"])
}

func TestHandleAttachChunks(t *testing.T) {
	t.Helper()
	store := &fakeCasStore{attachCount: 4}
	h := NewHandler(Config{}, store, nil)

	payload := AttachChunksRequest{
		ContentID:  "cnt-1",
		DocumentID: "doc-1",
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v1/cas/chunks/attach", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleAttachChunks(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var res map[string]any
	err := json.Unmarshal(rec.Body.Bytes(), &res)
	require.NoError(t, err)
	assert.True(t, res["ok"].(bool))
	assert.Equal(t, float64(4), res["count"])
}

func TestHandleStoreChunksAPI(t *testing.T) {
	t.Helper()
	store := &fakeCasStore{}
	h := NewHandler(Config{}, store, nil)

	payload := StoreChunksInput{
		DocumentID: "doc-1",
		Chunks: []chunker.MarkdownChunk{
			{Heading: "H1", Content: "Body 1"},
			{Heading: "H2", Content: "Body 2"},
		},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v1/chunks/store", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleStoreChunksAPI(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var res map[string]any
	err := json.Unmarshal(rec.Body.Bytes(), &res)
	require.NoError(t, err)
	assert.True(t, res["ok"].(bool))
	assert.Equal(t, float64(2), res["count"])
}

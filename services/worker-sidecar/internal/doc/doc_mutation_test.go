package doc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type mockDocMutationStore struct {
	fakeDocStore
	resetDocFunc     func(ctx context.Context, input ResetDocInput) (*ResetDocResult, int, error)
	batchDeleteFunc  func(ctx context.Context, input BatchDeleteDocsInput) (int, error)
	applyMutationFunc func(ctx context.Context, input ApplyDocMutationsInput) (ApplyDocMutationsResult, error)
	transferFunc     func(ctx context.Context, input TransferOwnershipInput) (TransferOwnershipResult, error)
}

func (m *mockDocMutationStore) ResetDocument(ctx context.Context, input ResetDocInput) (*ResetDocResult, int, error) {
	if m.resetDocFunc != nil {
		return m.resetDocFunc(ctx, input)
	}
	return &ResetDocResult{ID: input.DocumentID, Path: "a.md", Status: "UNPROCESSED"}, 200, nil
}

func (m *mockDocMutationStore) BatchDeleteDocuments(ctx context.Context, input BatchDeleteDocsInput) (int, error) {
	if m.batchDeleteFunc != nil {
		return m.batchDeleteFunc(ctx, input)
	}
	return 1, nil
}

func (m *mockDocMutationStore) ApplyDocumentMutations(ctx context.Context, input ApplyDocMutationsInput) (ApplyDocMutationsResult, error) {
	if m.applyMutationFunc != nil {
		return m.applyMutationFunc(ctx, input)
	}
	return ApplyDocMutationsResult{Renamed: 1, Updated: 1, Removed: 1, Created: 1}, nil
}

func (m *mockDocMutationStore) TransferOwnership(ctx context.Context, input TransferOwnershipInput) (TransferOwnershipResult, error) {
	if m.transferFunc != nil {
		return m.transferFunc(ctx, input)
	}
	return TransferOwnershipResult{Deleted: 1, Transferred: 2}, nil
}

func TestDocMutationHandlers(t *testing.T) {
	mockStore := &mockDocMutationStore{}
	h := NewHandler(Config{}, mockStore, nil)

	t.Run("HandleResetDoc success and conflict", func(t *testing.T) {
		body, _ := json.Marshal(ResetDocInput{
			DocumentID: "doc-1",
			Force:      false,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/documents/reset", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.HandleResetDoc(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		mockStore.resetDocFunc = func(ctx context.Context, input ResetDocInput) (*ResetDocResult, int, error) {
			return nil, 409, errors.New("document is currently processing")
		}
		req2 := httptest.NewRequest(http.MethodPost, "/v1/documents/reset", bytes.NewReader(body))
		w2 := httptest.NewRecorder()
		h.HandleResetDoc(w2, req2)
		if w2.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d", w2.Code)
		}
		mockStore.resetDocFunc = nil
	})

	t.Run("HandleApplyDocMutations", func(t *testing.T) {
		body, _ := json.Marshal(ApplyDocMutationsInput{
			RepositoryID: "repo-1",
			Updates:      []string{"a.md"},
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/documents/mutation", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.HandleApplyDocMutations(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
	})

	t.Run("HandleTransferOwnership", func(t *testing.T) {
		body, _ := json.Marshal(TransferOwnershipInput{
			RepositoryID: "repo-1",
			UserID:       "user-1",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/documents/ownership/transfer", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.HandleTransferOwnership(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
	})
}

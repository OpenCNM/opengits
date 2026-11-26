package doc

import (
	"context"
	"net/http"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type DocMutationStore interface {
	ResetDocument(ctx context.Context, input ResetDocInput) (*ResetDocResult, int, error)
	BatchDeleteDocuments(ctx context.Context, input BatchDeleteDocsInput) (int, error)
	ApplyDocumentMutations(ctx context.Context, input ApplyDocMutationsInput) (ApplyDocMutationsResult, error)
	TransferOwnership(ctx context.Context, input TransferOwnershipInput) (TransferOwnershipResult, error)
}

func (h *Handler) HandleResetDoc(w http.ResponseWriter, r *http.Request) {
	var req ResetDocInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	req.DocumentID = strings.TrimSpace(req.DocumentID)
	if req.DocumentID == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId is required")
		return
	}

	ms, ok := h.store.(DocMutationStore)
	if !ok || ms == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "doc mutation store is not configured")
		return
	}

	doc, status, err := ms.ResetDocument(r.Context(), req)
	if err != nil {
		httpx.Error(w, status, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"document": doc,
	})
}

func (h *Handler) HandleApplyDocMutations(w http.ResponseWriter, r *http.Request) {
	var req ApplyDocMutationsInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	req.RepositoryID = strings.TrimSpace(req.RepositoryID)
	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}

	ms, ok := h.store.(DocMutationStore)
	if !ok || ms == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "doc mutation store is not configured")
		return
	}

	res, err := ms.ApplyDocumentMutations(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"renamed": res.Renamed,
		"updated": res.Updated,
		"removed": res.Removed,
		"created": res.Created,
	})
}

func (h *Handler) HandleTransferOwnership(w http.ResponseWriter, r *http.Request) {
	var req TransferOwnershipInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	req.RepositoryID = strings.TrimSpace(req.RepositoryID)
	req.UserID = strings.TrimSpace(req.UserID)
	if req.RepositoryID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId and userId are required")
		return
	}

	ms, ok := h.store.(DocMutationStore)
	if !ok || ms == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "doc mutation store is not configured")
		return
	}

	res, err := ms.TransferOwnership(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"deleted":     res.Deleted,
		"transferred": res.Transferred,
	})
}

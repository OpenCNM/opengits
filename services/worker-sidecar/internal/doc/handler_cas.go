package doc

import (
	"context"
	"net/http"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type CasStore interface {
	UpsertContent(ctx context.Context, input UpsertContentInput) (string, error)
	OrphanContentGC(ctx context.Context, input OrphanContentGCInput) (OrphanContentGCResult, error)
	AttachChunks(ctx context.Context, contentId, documentId string) (int, error)
	StoreDocumentChunks(ctx context.Context, input StoreChunksInput) (int, error)
}

func (h *Handler) HandleUpsertContent(w http.ResponseWriter, r *http.Request) {
	var req UpsertContentInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	req.ContentHash = strings.TrimSpace(req.ContentHash)
	if req.ContentHash == "" {
		httpx.Error(w, http.StatusBadRequest, "contentHash is required")
		return
	}

	cs, ok := h.store.(CasStore)
	if !ok || cs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "cas store is not configured")
		return
	}

	id, err := cs.UpsertContent(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"contentId": id,
	})
}

func (h *Handler) HandleOrphanContentGC(w http.ResponseWriter, r *http.Request) {
	var req OrphanContentGCInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	cs, ok := h.store.(CasStore)
	if !ok || cs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "cas store is not configured")
		return
	}

	res, err := cs.OrphanContentGC(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"scanned": res.Scanned,
		"removed": res.Removed,
		"dryRun":  res.DryRun,
	})
}

type AttachChunksRequest struct {
	ContentID  string `json:"contentId"`
	DocumentID string `json:"documentId"`
}

func (h *Handler) HandleAttachChunks(w http.ResponseWriter, r *http.Request) {
	var req AttachChunksRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	req.ContentID = strings.TrimSpace(req.ContentID)
	req.DocumentID = strings.TrimSpace(req.DocumentID)
	if req.ContentID == "" || req.DocumentID == "" {
		httpx.Error(w, http.StatusBadRequest, "contentId and documentId are required")
		return
	}

	cs, ok := h.store.(CasStore)
	if !ok || cs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "cas store is not configured")
		return
	}

	count, err := cs.AttachChunks(r.Context(), req.ContentID, req.DocumentID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"count": count,
	})
}

func (h *Handler) HandleStoreChunksAPI(w http.ResponseWriter, r *http.Request) {
	var req StoreChunksInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	req.DocumentID = strings.TrimSpace(req.DocumentID)
	req.ContentID = strings.TrimSpace(req.ContentID)
	if req.DocumentID == "" && req.ContentID == "" {
		httpx.Error(w, http.StatusBadRequest, "either documentId or contentId is required")
		return
	}

	cs, ok := h.store.(CasStore)
	if !ok || cs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "cas store is not configured")
		return
	}

	count, err := cs.StoreDocumentChunks(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"count": count,
	})
}

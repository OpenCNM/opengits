package userinteraction

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type UpdateCanonicalConceptsRequest struct {
	Updates []CanonicalConceptUpdate `json:"updates"`
}

func (h *Handler) HandleUpdateCanonicalConcepts(w http.ResponseWriter, r *http.Request) {
	var req UpdateCanonicalConceptsRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if len(req.Updates) == 0 {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "count": 0})
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	count, err := h.store.UpdateCanonicalConcepts(r.Context(), req.Updates)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"count": count,
	})
}

func (h *Handler) HandleReplaceConceptEdges(w http.ResponseWriter, r *http.Request) {
	var req ReplaceConceptEdgesInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	if req.RepositoryID == "" || (req.Source == "" && len(req.Sources) == 0) {
		httpx.Error(w, http.StatusBadRequest, "repositoryId and source/sources are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	count, err := h.store.ReplaceConceptEdges(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"count": count,
	})
}

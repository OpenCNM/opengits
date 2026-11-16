package ingest

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type StoreOutlineDraftRequest struct {
	RepositoryID string       `json:"repositoryId"`
	Draft        OutlineDraft `json:"draft"`
	IsActive     bool         `json:"isActive"`
}

type StoreOutlineDraftResponse struct {
	Ok        bool   `json:"ok"`
	OutlineID string `json:"outlineId,omitempty"`
	Error     string `json:"error,omitempty"`
}

type ActivateOutlineRequest struct {
	RepositoryID string `json:"repositoryId"`
	OutlineID    string `json:"outlineId"`
}

type DeactivateOutlinesRequest struct {
	RepositoryID string `json:"repositoryId"`
}

// HandleStoreOutlineDraft handles POST /v1/outlines/draft/store.
func (h *Handler) HandleStoreOutlineDraft(w http.ResponseWriter, r *http.Request) {
	var req StoreOutlineDraftRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}

	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	outlineID, err := h.store.StoreOutlineDraft(r.Context(), req.RepositoryID, req.Draft, req.IsActive)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 影子草稿（IsActive=false）不影响读者端投影，不触发失效
	if req.IsActive {
		h.notifyOutlineChanged(req.RepositoryID)
	}

	httpx.WriteJSON(w, http.StatusOK, StoreOutlineDraftResponse{
		Ok:        true,
		OutlineID: outlineID,
	})
}

// HandleActivateOutline handles POST /v1/outlines/activate.
func (h *Handler) HandleActivateOutline(w http.ResponseWriter, r *http.Request) {
	var req ActivateOutlineRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.RepositoryID == "" || req.OutlineID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId and outlineId are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.ActivateOutline(r.Context(), req.RepositoryID, req.OutlineID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	h.notifyOutlineChanged(req.RepositoryID)

	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// HandleDeactivateAllOutlines handles POST /v1/outlines/deactivate.
func (h *Handler) HandleDeactivateAllOutlines(w http.ResponseWriter, r *http.Request) {
	var req DeactivateOutlinesRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.DeactivateAllOutlines(r.Context(), req.RepositoryID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	h.notifyOutlineChanged(req.RepositoryID)

	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// notifyOutlineChanged 在大纲写事务成功提交后触发 Web 端 L1/L2 失效
// （异步有界，见 daemon.fireWebRevalidate；未注入通知方时静默跳过）。
func (h *Handler) notifyOutlineChanged(repoID string) {
	if h.onOutlineChanged == nil || repoID == "" {
		return
	}
	h.onOutlineChanged(repoID)
}

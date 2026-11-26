package userinteraction

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type BundleUseRequest struct {
	BundleID string `json:"bundleId"`
}

type BundleDeleteRequest struct {
	ID string `json:"id"`
}

func (h *Handler) HandleBundleUse(w http.ResponseWriter, r *http.Request) {
	var req BundleUseRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.BundleID == "" {
		httpx.Error(w, http.StatusBadRequest, "bundleId cannot be empty")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.IncrementBundleUseCount(r.Context(), req.BundleID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) HandleBundleCreate(w http.ResponseWriter, r *http.Request) {
	var req BundleCreateInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.Title == "" {
		httpx.Error(w, http.StatusBadRequest, "title cannot be empty")
		return
	}
	if req.Slug == "" {
		httpx.Error(w, http.StatusBadRequest, "slug cannot be empty")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	bundle, err := h.store.CreateBundle(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "bundle": bundle})
}

func (h *Handler) HandleBundleUpdate(w http.ResponseWriter, r *http.Request) {
	var req BundleUpdateInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.ID == "" {
		httpx.Error(w, http.StatusBadRequest, "id cannot be empty")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	bundle, err := h.store.UpdateBundle(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "bundle": bundle})
}

func (h *Handler) HandleBundleDelete(w http.ResponseWriter, r *http.Request) {
	var req BundleDeleteRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.ID == "" {
		httpx.Error(w, http.StatusBadRequest, "id cannot be empty")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.DeleteBundle(r.Context(), req.ID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

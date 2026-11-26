package userinteraction

import (
	"errors"
	"net/http"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

func (h *Handler) HandleRepoPatch(w http.ResponseWriter, r *http.Request) {
	var req RepoPatchInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		httpx.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	err := h.store.PatchRepo(r.Context(), req)
	if err != nil {
		if errors.Is(err, ErrRepositoryNotFound) {
			httpx.Error(w, http.StatusNotFound, "repository not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true,
	})
}

func (h *Handler) HandleRepoBatchPatch(w http.ResponseWriter, r *http.Request) {
	var req RepoBatchPatchInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if len(req.IDs) == 0 {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"updated": 0,
		})
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	count, err := h.store.BatchPatchRepos(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"updated": count,
	})
}

func (h *Handler) HandleRepoIncrement(w http.ResponseWriter, r *http.Request) {
	var req RepoIncrementInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.IncrementRepoCounters(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

func (h *Handler) HandleRepoDelete(w http.ResponseWriter, r *http.Request) {
	var req RepoDeleteInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	count, err := h.store.DeleteRepo(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"deleted": count,
	})
}

func (h *Handler) HandleRepoUnpublish(w http.ResponseWriter, r *http.Request) {
	var req RepoUnpublishInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		httpx.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.UnpublishRepo(r.Context(), req)
	if err != nil {
		if errors.Is(err, ErrRepositoryNotFound) {
			httpx.Error(w, http.StatusNotFound, "repository not found")
			return
		}
		if strings.Contains(err.Error(), "not public") || strings.Contains(err.Error(), "already private") {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

func (h *Handler) HandleRepoPromoteEdition(w http.ResponseWriter, r *http.Request) {
	var req RepoPromoteEditionInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		httpx.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.PromoteEditionRepo(r.Context(), req)
	if err != nil {
		if errors.Is(err, ErrRepositoryNotFound) {
			httpx.Error(w, http.StatusNotFound, "repository not found")
			return
		}
		if strings.Contains(err.Error(), "already the default edition") {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

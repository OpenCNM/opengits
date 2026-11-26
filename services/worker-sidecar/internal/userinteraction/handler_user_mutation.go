package userinteraction

import (
	"errors"
	"net/http"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

func (h *Handler) HandleUserAuthCreate(w http.ResponseWriter, r *http.Request) {
	var req AuthCreateUserInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	user, err := h.store.CreateUserAuth(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"user": user,
	})
}

func (h *Handler) HandleUserUpdate(w http.ResponseWriter, r *http.Request) {
	var req UpdateUserInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if strings.TrimSpace(req.ID) == "" && strings.TrimSpace(req.UserID) != "" {
		req.ID = strings.TrimSpace(req.UserID)
	}
	if strings.TrimSpace(req.ID) == "" {
		httpx.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	user, err := h.store.UpdateUser(r.Context(), req)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			httpx.Error(w, http.StatusNotFound, "user not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"user": user,
	})
}

func (h *Handler) HandleUserDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		UserID string `json:"userId"`
	}
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	id := strings.TrimSpace(req.ID)
	if id == "" {
		id = strings.TrimSpace(req.UserID)
	}
	if id == "" {
		httpx.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	err := h.store.DeleteUser(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			httpx.Error(w, http.StatusNotFound, "user not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"deleted": true,
	})
}

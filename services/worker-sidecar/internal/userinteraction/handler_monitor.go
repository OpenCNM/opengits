package userinteraction

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type MonitorBatchRequest struct {
	UserID string              `json:"userId"`
	Events []MonitorEventInput `json:"events"`
}

type MonitorBatchResponse struct {
	Ok    bool   `json:"ok"`
	Count int    `json:"count"`
	Error string `json:"error,omitempty"`
}

func (h *Handler) HandleMonitorEvents(w http.ResponseWriter, r *http.Request) {
	var req MonitorBatchRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	count, err := h.store.RecordMonitorEvents(r.Context(), req.UserID, req.Events)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, MonitorBatchResponse{
		Ok:    true,
		Count: count,
	})
}

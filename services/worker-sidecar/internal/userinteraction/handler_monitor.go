package userinteraction

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// MonitorBatchRequest represents batch frontend monitor events upload request.
type MonitorBatchRequest struct {
	UserID string               `json:"userId"`
	Events []MonitorEventInput  `json:"events"`
}

// MonitorBatchResponse returns count of persisted monitor events.
type MonitorBatchResponse struct {
	Ok    bool   `json:"ok"`
	Count int    `json:"count"`
	Error string `json:"error,omitempty"`
}

// HandleMonitorEvents handles POST /v1/monitor/events.
// Next /api/monitor 网关（Zod discriminated union 校验后）的唯一合法写入入口。
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

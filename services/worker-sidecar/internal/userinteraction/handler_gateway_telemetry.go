package userinteraction

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// McpPresenceTouchRequest represents touch heartbeat input.
type McpPresenceTouchRequest struct {
	UserID     string `json:"userId"`
	ClientName string `json:"clientName"`
	ClientVer  string `json:"clientVer,omitempty"`
	IPAddress  string `json:"ipAddress,omitempty"`
}

// McpUsageIncrementRequest represents daily MCP usage increment input.
type McpUsageIncrementRequest struct {
	UserID string `json:"userId"`
	Day    string `json:"day"`
}

// HandleMcpPresenceTouch handles POST /v1/mcp/presence/touch.
func (h *Handler) HandleMcpPresenceTouch(w http.ResponseWriter, r *http.Request) {
	var req McpPresenceTouchRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.UserID == "" || req.ClientName == "" {
		httpx.Error(w, http.StatusBadRequest, "userId and clientName are required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.TouchMcpPresence(r.Context(), req.UserID, req.ClientName, req.ClientVer, req.IPAddress); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// HandleMcpUsageIncrement handles POST /v1/mcp/usage/increment.
func (h *Handler) HandleMcpUsageIncrement(w http.ResponseWriter, r *http.Request) {
	var req McpUsageIncrementRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.UserID == "" || req.Day == "" {
		httpx.Error(w, http.StatusBadRequest, "userId and day are required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.IncrementMcpUsage(r.Context(), req.UserID, req.Day); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// HandleMcpCallLog handles POST /v1/telemetry/mcp-call-log.
func (h *Handler) HandleMcpCallLog(w http.ResponseWriter, r *http.Request) {
	var req McpCallLogInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.ToolName == "" {
		httpx.Error(w, http.StatusBadRequest, "toolName is required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.RecordMcpCallLog(r.Context(), req); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// HandleGithubQuotaSample handles POST /v1/github/quota/sample.
func (h *Handler) HandleGithubQuotaSample(w http.ResponseWriter, r *http.Request) {
	var req GithubQuotaSampleInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.Fingerprint == "" {
		httpx.Error(w, http.StatusBadRequest, "fingerprint is required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.RecordGithubQuotaSample(r.Context(), req); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

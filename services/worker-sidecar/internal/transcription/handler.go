package transcription

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type Handler struct {
	store  QueueStore
	runner *TranscriptionRunner
	// Server-authoritative priority cap prevents callers from starving batch imports while +1/min aging catches up.
	jitPriorityCap int
}

const defaultJitPriorityCap = 20000

func NewHandler(store QueueStore) *Handler {
	return &Handler{store: store, jitPriorityCap: defaultJitPriorityCap}
}

func (h *Handler) SetRunner(r *TranscriptionRunner) {
	h.runner = r
}

func (h *Handler) SetJitPriorityCap(cap int) {
	if cap > 0 {
		h.jitPriorityCap = cap
	}
}

type EnqueueRequest struct {
	DocumentID  string `json:"documentId"`
	RequestedBy string `json:"requestedBy"`
	Priority    int    `json:"priority"`
	Options     any    `json:"options,omitempty"`
}

func (h *Handler) HandleEnqueue(w http.ResponseWriter, r *http.Request) {
	var req EnqueueRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.DocumentID == "" || req.RequestedBy == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId and requestedBy are required")
		return
	}
	status, err := h.store.EnqueueTranscriptionJob(r.Context(), EnqueueJobParams{
		DocumentID:  req.DocumentID,
		RequestedBy: req.RequestedBy,
		Priority:    req.Priority,
		Options:     req.Options,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to enqueue transcription job: "+err.Error())
		return
	}
	if h.runner != nil {
		h.runner.TriggerPump()
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"status": status})
}

type StagedGenerateRequest struct {
	DocumentID string `json:"documentId"`
	UserID     string `json:"userId,omitempty"`
	SourceSha  string `json:"sourceSha"`
	Model      string `json:"model,omitempty"`
}

func (h *Handler) HandleStagedGenerate(w http.ResponseWriter, r *http.Request) {
	var req StagedGenerateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.DocumentID == "" || req.SourceSha == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId and sourceSha are required")
		return
	}
	if h.runner == nil || h.runner.bodyDeps == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "transcription executor not configured")
		return
	}
	userID := req.UserID
	if userID == "" {
		userID = "system"
	}
	res, err := RunStagedBody(r.Context(), h.runner.cfg, *h.runner.bodyDeps, req.DocumentID, userID, req.SourceSha, req.Model)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

type PrioritizeJobRequest struct {
	DocumentID  string `json:"documentId"`
	RequestedBy string `json:"requestedBy"`
	Priority    int    `json:"priority"`
}

func (h *Handler) HandlePrioritize(w http.ResponseWriter, r *http.Request) {
	var req PrioritizeJobRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.DocumentID == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId is required")
		return
	}
	if req.Priority <= 0 || req.Priority > h.jitPriorityCap {
		req.Priority = h.jitPriorityCap
	}
	if req.RequestedBy == "" {
		req.RequestedBy = "system"
	}
	if err := h.store.PrioritizeTranscriptionJob(r.Context(), req.DocumentID, req.RequestedBy, req.Priority); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to prioritize transcription job: "+err.Error())
		return
	}
	if h.runner != nil {
		h.runner.TriggerPump()
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type StagedRelayGenerateRequest struct {
	DocumentID string `json:"documentId"`
	UserID     string `json:"userId,omitempty"`
	SourceSha  string `json:"sourceSha"`
	Model      string `json:"model,omitempty"`
}

func (h *Handler) HandleStagedRelayGenerate(w http.ResponseWriter, r *http.Request) {
	var req StagedRelayGenerateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.DocumentID == "" || req.SourceSha == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId and sourceSha are required")
		return
	}
	if h.runner == nil || h.runner.bodyDeps == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "transcription executor not configured")
		return
	}
	userID := req.UserID
	if userID == "" {
		userID = "system"
	}
	res, err := RunStagedRelayBody(r.Context(), h.runner.cfg, *h.runner.bodyDeps, req.DocumentID, userID, req.SourceSha, req.Model)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

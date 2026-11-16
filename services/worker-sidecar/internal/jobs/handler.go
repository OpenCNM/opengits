package jobs

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type Handler struct {
	store  QueueStore
	runner *Runner
}

func NewHandler(store QueueStore) *Handler {
	return &Handler{store: store}
}

// SetRunner 注入调度器（入队唤醒端点用；入队即时拾取，tick 兜底）。
func (h *Handler) SetRunner(r *Runner) { h.runner = r }

type CreateJobRequest struct {
	Owner   string  `json:"owner"`
	Repo    string  `json:"repo"`
	Branch  string  `json:"branch"`
	Edition string  `json:"edition,omitempty"`
	UserID  *string `json:"userId"`
	Params  any     `json:"params,omitempty"`
}

func (h *Handler) HandleCreateJob(w http.ResponseWriter, r *http.Request) {
	var req CreateJobRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.Owner == "" || req.Repo == "" {
		httpx.Error(w, http.StatusBadRequest, "owner and repo are required")
		return
	}
	if req.Branch == "" {
		req.Branch = "main"
	}
	res, err := h.store.CreateImportJob(r.Context(), CreateJobParams{
		Owner:   req.Owner,
		Repo:    req.Repo,
		Branch:  req.Branch,
		Edition: req.Edition,
		UserID:  req.UserID,
		Params:  req.Params,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create import job: "+err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

type RequestPublicationRequest struct {
	RepositoryID string `json:"repositoryId"`
	UserID       string `json:"userId"`
}

func (h *Handler) HandleRequestPublication(w http.ResponseWriter, r *http.Request) {
	var req RequestPublicationRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.RepositoryID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId and userId are required")
		return
	}
	if err := h.store.RequestImportPublication(r.Context(), req.RepositoryID, req.UserID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to request publication: "+err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// HandleEnqueuePump POST /v1/jobs/enqueue-pump：入队后即时唤醒调度泵
// （Node scheduleImportJob 薄封装调用；无 runner 注入时静默——tick 3s 兜底）。
func (h *Handler) HandleEnqueuePump(w http.ResponseWriter, r *http.Request) {
	if h.runner != nil {
		h.runner.TriggerPump()
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

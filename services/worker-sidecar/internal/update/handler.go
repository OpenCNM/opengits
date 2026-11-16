package update

import (
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// Handler handles HTTP requests for candidate extraction and update application.
type Handler struct {
	cfg            Config
	store          Store
	onIndexRefresh func(string)
}

// NewHandler constructs a new Handler instance.
func NewHandler(cfg Config, store Store, onIndexRefresh func(string), diffEngine ...SemanticDiffFunc) *Handler {
	if len(diffEngine) > 0 && diffEngine[0] != nil {
		SemanticDiffEngine = diffEngine[0]
	}
	return &Handler{
		cfg:            cfg,
		store:          store,
		onIndexRefresh: onIndexRefresh,
	}
}

// HandleUpdateCandidateSet handles POST /v1/update/candidate-set requests.
func (h *Handler) HandleUpdateCandidateSet(w http.ResponseWriter, r *http.Request) {
	var req UpdateCandidateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.Owner == "" || req.Repo == "" || req.FromSha == "" || req.ToSha == "" || req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields (owner, repo, fromSha, toSha, repositoryId)")
		return
	}

	if !httpx.AssertSegments(w,
		httpx.SegmentField{Name: "owner", Value: req.Owner},
		httpx.SegmentField{Name: "repo", Value: req.Repo},
		httpx.SegmentField{Name: "fromSha", Value: req.FromSha},
		httpx.SegmentField{Name: "toSha", Value: req.ToSha},
	) {
		return
	}

	resp, err := BuildUpdateCandidateSet(h.cfg, req, h.store)
	if err != nil {
		log.Printf("[worker-sidecar] update candidate set error: %v", err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, resp)
}

// HandleUpdateApply handles POST /v1/update/apply requests.
func (h *Handler) HandleUpdateApply(w http.ResponseWriter, r *http.Request) {
	var req UpdateApplyRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.RepositoryID == "" || req.UserID == "" || req.FromSha == "" || req.ToSha == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields (repositoryId, userId, fromSha, toSha)")
		return
	}

	if !httpx.AssertSegments(w,
		httpx.SegmentField{Name: "fromSha", Value: req.FromSha},
		httpx.SegmentField{Name: "toSha", Value: req.ToSha},
	) {
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "update store not configured")
		return
	}

	result, err := ApplyUpdatePlan(r.Context(), h.cfg, h.store, req)
	if err != nil {
		log.Printf("[worker-sidecar] update apply error: %v", err)
		var valErr *PlanValidationError
		if errors.As(err, &valErr) {
			httpx.Error(w, http.StatusBadRequest, valErr.Message)
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if h.onIndexRefresh != nil {
		h.onIndexRefresh(req.RepositoryID)
	}

	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"result": result,
	})
}

type CreateRunRequest struct {
	RepositoryID string `json:"repositoryId"`
	UserID       string `json:"userId"`
	FromSha      string `json:"fromSha"`
	ToSha        string `json:"toSha"`
	Status       string `json:"status,omitempty"`
	Plan         any    `json:"plan,omitempty"`
	CandidateSet any    `json:"candidateSet,omitempty"`
	Stats        any    `json:"stats,omitempty"`
}

func (h *Handler) HandleCreateRun(w http.ResponseWriter, r *http.Request) {
	var req CreateRunRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}
	if req.RepositoryID == "" || req.UserID == "" || req.FromSha == "" || req.ToSha == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId, userId, fromSha, and toSha are required")
		return
	}
	id, err := h.store.CreateUpdateRun(r.Context(), CreateUpdateRunParams{
		RepositoryID: req.RepositoryID,
		UserID:       req.UserID,
		FromSha:      req.FromSha,
		ToSha:        req.ToSha,
		Status:       req.Status,
		Plan:         req.Plan,
		CandidateSet: req.CandidateSet,
		Stats:        req.Stats,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to create update run: "+err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"id": id,
	})
}

type ClaimRunRequest struct {
	ID string `json:"id"`
}

func (h *Handler) HandleClaimRun(w http.ResponseWriter, r *http.Request) {
	var req ClaimRunRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.ID == "" {
		httpx.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	claimed, err := h.store.ClaimUpdateRun(r.Context(), req.ID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to claim update run: "+err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"claimed": claimed,
	})
}

type UpdateRunStatusRequest struct {
	ID         string     `json:"id"`
	Status     string     `json:"status"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Stats      any        `json:"stats,omitempty"`
}

func (h *Handler) HandleUpdateRunStatus(w http.ResponseWriter, r *http.Request) {
	var req UpdateRunStatusRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}
	if req.ID == "" || req.Status == "" {
		httpx.Error(w, http.StatusBadRequest, "id and status are required")
		return
	}
	err := h.store.UpdateRunStatus(r.Context(), req.ID, UpdateRunStatusParams{
		Status:     req.Status,
		FinishedAt: req.FinishedAt,
		Stats:      req.Stats,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to update run status: "+err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true,
	})
}

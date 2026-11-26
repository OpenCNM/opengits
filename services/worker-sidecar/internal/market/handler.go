package market

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type Handler struct {
	cfg            Config
	store          Store
	onIndexRefresh func(repoID string)
}

func NewHandler(cfg Config, store Store, onIndexRefresh ...func(repoID string)) *Handler {
	var refreshCb func(repoID string)
	if len(onIndexRefresh) > 0 {
		refreshCb = onIndexRefresh[0]
	}
	return &Handler{
		cfg:            cfg,
		store:          store,
		onIndexRefresh: refreshCb,
	}
}

func mapMarketError(err error) (int, string) {
	switch {
	case errors.Is(err, ErrJobNotFound), errors.Is(err, ErrDocNotFound):
		return http.StatusNotFound, "NOT_FOUND"
	case errors.Is(err, ErrJobAlreadyClaimed):
		return http.StatusConflict, "ALREADY_CLAIMED"
	case errors.Is(err, ErrJobInvalidState):
		return http.StatusConflict, "INVALID_STATE"
	default:
		return http.StatusInternalServerError, err.Error()
	}
}

type MarketJobsListRequest struct {
	RepositoryID string `json:"repositoryId"`
}

type MarketJobsListResponse struct {
	OK   bool            `json:"ok"`
	Jobs []ActiveJobView `json:"jobs"`
}

func (h *Handler) HandleJobsList(w http.ResponseWriter, r *http.Request) {
	var req MarketJobsListRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.RepositoryID = strings.TrimSpace(req.RepositoryID)
	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing repositoryId")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	jobs, err := h.store.ListActiveJobs(r.Context(), req.RepositoryID)
	if err != nil {
		log.Printf("[market-handler] list jobs failed for %s: %v", req.RepositoryID, err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if jobs == nil {
		jobs = []ActiveJobView{}
	}
	httpx.WriteJSON(w, http.StatusOK, MarketJobsListResponse{OK: true, Jobs: jobs})
}

type MarketJobAuthInfoRequest struct {
	JobID string `json:"jobId"`
}

func (h *Handler) HandleJobAuthInfo(w http.ResponseWriter, r *http.Request) {
	var req MarketJobAuthInfoRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.JobID = strings.TrimSpace(req.JobID)
	if req.JobID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing jobId")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	info, err := h.store.GetJobAuthInfo(r.Context(), req.JobID)
	if err != nil {
		status, msg := mapMarketError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, info)
}

type MarketJobClaimRequest struct {
	JobID      string `json:"jobId"`
	UserID     string `json:"userId"`
	TTLMinutes int    `json:"ttlMinutes"`
}

type MarketJobClaimResponse struct {
	OK            bool `json:"ok"`
	FrozenCredits int  `json:"frozenCredits"`
}

func (h *Handler) HandleJobClaim(w http.ResponseWriter, r *http.Request) {
	var req MarketJobClaimRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.JobID = strings.TrimSpace(req.JobID)
	req.UserID = strings.TrimSpace(req.UserID)
	if req.JobID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing jobId or userId")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	res, err := h.store.ClaimJob(r.Context(), req.JobID, req.UserID, req.TTLMinutes)
	if err != nil {
		status, msg := mapMarketError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, MarketJobClaimResponse{OK: true, FrozenCredits: res.FrozenCredits})
}

type MarketJobExtendClaimRequest struct {
	JobID      string `json:"jobId"`
	UserID     string `json:"userId"`
	TTLMinutes int    `json:"ttlMinutes"`
}

type MarketJobExtendClaimResponse struct {
	OK bool `json:"ok"`
}

func (h *Handler) HandleJobExtendClaim(w http.ResponseWriter, r *http.Request) {
	var req MarketJobExtendClaimRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.JobID = strings.TrimSpace(req.JobID)
	req.UserID = strings.TrimSpace(req.UserID)
	if req.JobID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing jobId or userId")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	extended, err := h.store.ExtendClaim(r.Context(), req.JobID, req.UserID, req.TTLMinutes)
	if err != nil {
		status, msg := mapMarketError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, MarketJobExtendClaimResponse{OK: extended})
}

type MarketJobReleaseRequest struct {
	JobID  string `json:"jobId"`
	UserID string `json:"userId"`
}

type MarketJobReleaseResponse struct {
	OK bool `json:"ok"`
}

func (h *Handler) HandleJobRelease(w http.ResponseWriter, r *http.Request) {
	var req MarketJobReleaseRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.JobID = strings.TrimSpace(req.JobID)
	req.UserID = strings.TrimSpace(req.UserID)
	if req.JobID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing jobId or userId")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	if err := h.store.ReleaseClaim(r.Context(), req.JobID, req.UserID); err != nil {
		status, msg := mapMarketError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, MarketJobReleaseResponse{OK: true})
}

type MarketJobRelaySettleRequest struct {
	JobID           string `json:"jobId"`
	UserID          string `json:"userId"`
	DocumentID      string `json:"documentId"`
	RepositoryID    string `json:"repositoryId"`
	StagedContentID string `json:"stagedContentId"`
	StagedModel     string `json:"stagedModel"`
	ToSha           string `json:"toSha"`
	DualWrite       bool   `json:"dualWrite"`
}

type MarketJobRelaySettleResponse struct {
	OK bool `json:"ok"`
}

func (h *Handler) HandleJobRelaySettle(w http.ResponseWriter, r *http.Request) {
	var req MarketJobRelaySettleRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}
	req.JobID = strings.TrimSpace(req.JobID)
	req.UserID = strings.TrimSpace(req.UserID)
	req.DocumentID = strings.TrimSpace(req.DocumentID)
	req.RepositoryID = strings.TrimSpace(req.RepositoryID)
	req.StagedContentID = strings.TrimSpace(req.StagedContentID)
	if req.JobID == "" || req.UserID == "" || req.DocumentID == "" || req.RepositoryID == "" || req.StagedContentID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	err := h.store.SettleRelayTx(r.Context(), RelaySettleInput{
		JobID:           req.JobID,
		UserID:          req.UserID,
		DocumentID:      req.DocumentID,
		RepositoryID:    req.RepositoryID,
		StagedContentID: req.StagedContentID,
		StagedModel:     req.StagedModel,
		ToSha:           req.ToSha,
		DualWrite:       req.DualWrite,
	})
	if err != nil {
		status, msg := mapMarketError(err)
		httpx.Error(w, status, msg)
		return
	}

	if h.onIndexRefresh != nil {
		h.onIndexRefresh(req.RepositoryID)
	}

	httpx.WriteJSON(w, http.StatusOK, MarketJobRelaySettleResponse{OK: true})
}

type MarketJobMarkFailedRequest struct {
	JobID        string `json:"jobId"`
	UserID       string `json:"userId"`
	ErrorMessage string `json:"errorMessage"`
}

type MarketJobMarkFailedResponse struct {
	OK bool `json:"ok"`
}

func (h *Handler) HandleJobMarkFailed(w http.ResponseWriter, r *http.Request) {
	var req MarketJobMarkFailedRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.JobID = strings.TrimSpace(req.JobID)
	req.UserID = strings.TrimSpace(req.UserID)
	if req.JobID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing jobId or userId")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	if err := h.store.MarkJobFailed(r.Context(), req.JobID, req.UserID, req.ErrorMessage); err != nil {
		status, msg := mapMarketError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, MarketJobMarkFailedResponse{OK: true})
}

type MarketJobEnsureRelayRequest struct {
	DocumentID string `json:"documentId"`
}

type MarketJobEnsureRelayResponse struct {
	OK  bool          `json:"ok"`
	Job *RelayJobView `json:"job"`
}

func (h *Handler) HandleJobEnsureRelay(w http.ResponseWriter, r *http.Request) {
	var req MarketJobEnsureRelayRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.DocumentID = strings.TrimSpace(req.DocumentID)
	if req.DocumentID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing documentId")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	job, err := h.store.EnsureRelayJob(r.Context(), req.DocumentID)
	if err != nil {
		status, msg := mapMarketError(err)
		httpx.Error(w, status, msg)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, MarketJobEnsureRelayResponse{OK: true, Job: job})
}

type MarketJobRetranslateRecordRequest struct {
	RepositoryID    string `json:"repositoryId"`
	DocumentID      string `json:"documentId"`
	Path            string `json:"path"`
	GitSha          string `json:"gitSha"`
	UserID          string `json:"userId"`
	StagedContentID string `json:"stagedContentId"`
	StagedModel     string `json:"stagedModel"`
}

type MarketJobRetranslateRecordResponse struct {
	OK bool `json:"ok"`
}

func (h *Handler) HandleJobRetranslateRecord(w http.ResponseWriter, r *http.Request) {
	var req MarketJobRetranslateRecordRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.RepositoryID = strings.TrimSpace(req.RepositoryID)
	req.DocumentID = strings.TrimSpace(req.DocumentID)
	req.Path = strings.TrimSpace(req.Path)
	req.UserID = strings.TrimSpace(req.UserID)
	req.StagedContentID = strings.TrimSpace(req.StagedContentID)
	if req.RepositoryID == "" || req.DocumentID == "" || req.Path == "" || req.UserID == "" || req.StagedContentID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	err := h.store.CreateRetranslateJob(r.Context(), RetranslateJobInput{
		RepositoryID:    req.RepositoryID,
		DocumentID:      req.DocumentID,
		Path:            req.Path,
		GitSha:          req.GitSha,
		UserID:          req.UserID,
		StagedContentID: req.StagedContentID,
		StagedModel:     req.StagedModel,
	})
	if err != nil {
		log.Printf("[market-handler] retranslate record failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, MarketJobRetranslateRecordResponse{OK: true})
}

type MarketJobCreateStaleRequest struct {
	RepositoryID string   `json:"repositoryId"`
	FromSha      string   `json:"fromSha"`
	ToSha        string   `json:"toSha"`
	Paths        []string `json:"paths"`
}

type MarketJobCreateStaleResponse struct {
	OK         bool `json:"ok"`
	Created    int  `json:"created"`
	Structural bool `json:"structural"`
}

func (h *Handler) HandleJobCreateStale(w http.ResponseWriter, r *http.Request) {
	var req MarketJobCreateStaleRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	req.RepositoryID = strings.TrimSpace(req.RepositoryID)
	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "missing repositoryId")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}

	created, err := h.store.CreateStaleJobs(r.Context(), CreateStaleJobsInput{
		RepositoryID: req.RepositoryID,
		FromSha:      req.FromSha,
		ToSha:        req.ToSha,
		Paths:        req.Paths,
	})
	if err != nil {
		log.Printf("[market-handler] create stale jobs failed for %s: %v", req.RepositoryID, err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, MarketJobCreateStaleResponse{OK: true, Created: created, Structural: false})
}

type MarketRepoAuditRequest struct {
	RepositoryID string `json:"repositoryId"`
	Enforce      *bool  `json:"enforce,omitempty"`
}

type MarketRepoAuditResponse struct {
	Ok         bool                    `json:"ok"`
	Score      int                     `json:"score"`
	Floor      int                     `json:"floor"`
	Held       bool                    `json:"held"`
	Dimensions []PipelineDimensionItem `json:"dimensions"`
	Dims       PipelineScoreDims       `json:"dims"`
}

func (h *Handler) HandleRepoAudit(w http.ResponseWriter, r *http.Request) {
	var req MarketRepoAuditRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	req.RepositoryID = strings.TrimSpace(req.RepositoryID)
	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}
	if h == nil || h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "market store not configured")
		return
	}
	chapterCount, meta, docs, err := h.store.LoadPipelineScoreInputs(r.Context(), req.RepositoryID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "audit inputs: "+err.Error())
		return
	}
	score, dimensions, dims := EvaluatePhysicalPipelineScore(chapterCount, meta, docs)
	held := false
	enforce := req.Enforce == nil || *req.Enforce
	if enforce && score < QualityFloor() {
		if err := h.store.SetQualityHold(r.Context(), req.RepositoryID); err == nil {
			held = true
			log.Printf("[market-audit] quality hold: pipeline %d < floor %d for %s", score, QualityFloor(), req.RepositoryID)
		} else {
			httpx.Error(w, http.StatusInternalServerError, "set quality hold: "+err.Error())
			return
		}
	}
	httpx.WriteJSON(w, http.StatusOK, MarketRepoAuditResponse{
		Ok:         true,
		Score:      score,
		Floor:      QualityFloor(),
		Held:       held,
		Dimensions: dimensions,
		Dims:       dims,
	})
}

package market

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// Handler 封装更新市场相关 HTTP 端点处理逻辑。
type Handler struct {
	cfg            Config
	store          Store
	onIndexRefresh func(repoID string)
}

// NewHandler 构造更新市场 HTTP 处理器。
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

// ── Phase 10: 更新市场状态机单写者 HTTP 端点实现 ──────────────────
// 历史端点 swap-in / reject / sweep / staged-content / enter-trial / vote
// 已随「试读与表决」退役拆除（2026-11 外围清理）：存量 TRIAL 排水由 Go 侧
// orphan-sweeper（60s 互斥）与 auto-update runner 周期直调结算引擎收敛，
// 不再暴露 HTTP 面。

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

// MarketJobsListRequest POST /v1/market/jobs/list
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

// MarketJobAuthInfoRequest POST /v1/market/jobs/auth-info
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

// MarketJobClaimRequest POST /v1/market/jobs/claim
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

// MarketJobExtendClaimRequest POST /v1/market/jobs/extend-claim
type MarketJobExtendClaimRequest struct {
	JobID      string `json:"jobId"`
	UserID     string `json:"userId"`
	TTLMinutes int    `json:"ttlMinutes"`
}

type MarketJobExtendClaimResponse struct {
	OK bool `json:"ok"`
}

// HandleJobExtendClaim 认领租约续期（批量接力异步执行器随附）：
// 租约丢失/过期返回 ok=false（非错误——调用方据此停止后续续期，任务交由
// 既有回池/超时语义收敛）。
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

// MarketJobReleaseRequest POST /v1/market/jobs/release
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

// MarketJobRelaySettleRequest POST /v1/market/jobs/relay-settle
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

// MarketJobMarkFailedRequest POST /v1/market/jobs/mark-failed
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

// MarketJobEnsureRelayRequest POST /v1/market/jobs/ensure-relay
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

// MarketJobRetranslateRecordRequest POST /v1/market/jobs/retranslate-record
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

// MarketJobCreateStaleRequest POST /v1/market/jobs/create-stale
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

// MarketRepoAuditRequest POST /v1/market/repo-audit
type MarketRepoAuditRequest struct {
	RepositoryID string `json:"repositoryId"`
	// Enforce=false 只评分不落 qualityHold（Node 初审雷达图等只读消费方）；
	// 缺省 true = 周期复检语义（跌破置 hold）
	Enforce *bool `json:"enforce,omitempty"`
}

// MarketRepoAuditResponse AST 口径管线分复检结果。
type MarketRepoAuditResponse struct {
	Ok    bool              `json:"ok"`
	Score int               `json:"score"`
	Floor int               `json:"floor"`
	Held  bool              `json:"held"`
	Dims  PipelineScoreDims `json:"dims"`
}

// HandleRepoAudit 立即执行一次 AST 复检（RELAY 换入路径调用，取代 Node
// 正则版 computePipelineScore——散文里的 retry/import 不再计分，两路换入
// 复检收敛为同一 AST 单一口径）。
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
	chapterCount, docs, err := h.store.LoadPipelineScoreInputs(r.Context(), req.RepositoryID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "audit inputs: "+err.Error())
		return
	}
	score, dims := PipelineScoreTotalASTWithDims(r.Context(), chapterCount, docs)
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
	httpx.WriteJSON(w, http.StatusOK, MarketRepoAuditResponse{Ok: true, Score: score, Floor: QualityFloor(), Held: held, Dims: dims})
}

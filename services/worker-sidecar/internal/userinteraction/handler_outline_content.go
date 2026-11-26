package userinteraction

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type ActiveOutlineRequest struct {
	RepositoryID string `json:"repositoryId"`
}

type ActiveOutlineResponse struct {
	Ok      bool               `json:"ok"`
	Outline *ActiveOutlineView `json:"outline"`
}

func (h *Handler) HandleActiveOutline(w http.ResponseWriter, r *http.Request) {
	var req ActiveOutlineRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	outline, err := h.store.GetActiveOutline(r.Context(), req.RepositoryID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ActiveOutlineResponse{
		Ok:      true,
		Outline: outline,
	})
}

type HelpfulRequest struct {
	RepositoryID string `json:"repositoryId"`
	UserID       string `json:"userId"`
}

type HelpfulResponse struct {
	Ok           bool `json:"ok"`
	Voted        bool `json:"voted"`
	HelpfulCount int  `json:"helpfulCount"`
}

func (h *Handler) HandleHelpful(w http.ResponseWriter, r *http.Request) {
	var req HelpfulRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.RepositoryID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId and userId are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	voted, count, err := h.store.ToggleHelpfulVote(r.Context(), req.RepositoryID, req.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "repository not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, HelpfulResponse{
		Ok:           true,
		Voted:        voted,
		HelpfulCount: count,
	})
}

type DocumentStatusRequest struct {
	DocumentID string `json:"documentId"`
}

type DocumentStatusResponse struct {
	Ok           bool           `json:"ok"`
	Found        bool           `json:"found"`
	Status       string         `json:"status"`
	ErrorMessage *string        `json:"errorMessage"`
	Progress     int            `json:"progress"`
	Step         string         `json:"step"`
	ProgressInfo map[string]any `json:"progressInfo"`
}

func (h *Handler) HandleDocumentStatus(w http.ResponseWriter, r *http.Request) {
	var req DocumentStatusRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.DocumentID == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	status, err := h.store.GetDocumentStatus(r.Context(), req.DocumentID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !status.Found {
		httpx.Error(w, http.StatusNotFound, "document not found")
		return
	}

	httpx.WriteJSON(w, http.StatusOK, DocumentStatusResponse{
		Ok:           true,
		Found:        true,
		Status:       status.Status,
		ErrorMessage: status.ErrorMessage,
		Progress:     status.Progress,
		Step:         status.Step,
		ProgressInfo: status.ProgressInfo,
	})
}

type IngestStatusRequest struct {
	Owner   string  `json:"owner"`
	Repo    string  `json:"repo"`
	Branch  string  `json:"branch"`
	Edition *string `json:"edition"`
	UserID  *string `json:"userId"`
}

type IngestStatusResponse struct {
	Ok               bool              `json:"ok"`
	NotFound         bool              `json:"notFound,omitempty"`
	Forbidden        bool              `json:"forbidden,omitempty"`
	Repository       *IngestStatusRepo `json:"repository,omitempty"`
	Documents        []IngestStatusDoc `json:"documents,omitempty"`
	PublishRequested bool              `json:"publishRequested,omitempty"`
	AvgJobSeconds    *float64          `json:"avgJobSeconds,omitempty"`
}

func (h *Handler) HandleIngestStatus(w http.ResponseWriter, r *http.Request) {
	var req IngestStatusRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.Owner == "" || req.Repo == "" {
		httpx.Error(w, http.StatusBadRequest, "owner and repo are required")
		return
	}
	if req.Branch == "" {
		req.Branch = "main"
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.GetIngestStatus(r.Context(), req.Owner, req.Repo, req.Branch, req.Edition, req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !res.Found {
		httpx.WriteJSON(w, http.StatusOK, IngestStatusResponse{
			Ok:       false,
			NotFound: true,
		})
		return
	}

	if res.Forbidden {
		httpx.WriteJSON(w, http.StatusOK, IngestStatusResponse{
			Ok:        false,
			Forbidden: true,
		})
		return
	}

	httpx.WriteJSON(w, http.StatusOK, IngestStatusResponse{
		Ok:               true,
		Repository:       res.Repository,
		Documents:        res.Documents,
		PublishRequested: res.PublishRequested,
		AvgJobSeconds:    res.AvgJobSeconds,
	})
}

type FeaturedSearchRequest struct {
	Limit int `json:"limit"`
}

type FeaturedSearchResponse struct {
	Ok    bool           `json:"ok"`
	Repos []FeaturedRepo `json:"repos"`
}

func (h *Handler) HandleFeaturedSearch(w http.ResponseWriter, r *http.Request) {
	var req FeaturedSearchRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.Limit <= 0 {
		req.Limit = 6
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	repos, err := h.store.GetFeaturedRepos(r.Context(), req.Limit)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, FeaturedSearchResponse{
		Ok:    true,
		Repos: repos,
	})
}

type RepoPauseRequest struct {
	Owner   string  `json:"owner"`
	Repo    string  `json:"repo"`
	Branch  string  `json:"branch"`
	Edition *string `json:"edition"`
	UserID  *string `json:"userId"`
	Paused  bool    `json:"paused"`
}

type RepoPauseResponse struct {
	Ok        bool `json:"ok"`
	NotFound  bool `json:"notFound,omitempty"`
	Forbidden bool `json:"forbidden,omitempty"`
	Paused    bool `json:"paused"`
}

func (h *Handler) HandleRepoPause(w http.ResponseWriter, r *http.Request) {
	var req RepoPauseRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.Owner == "" || req.Repo == "" {
		httpx.Error(w, http.StatusBadRequest, "owner and repo are required")
		return
	}
	if req.Branch == "" {
		req.Branch = "main"
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.PauseRepo(r.Context(), req.Owner, req.Repo, req.Branch, req.Edition, req.UserID, req.Paused)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !res.Found {
		httpx.WriteJSON(w, http.StatusOK, RepoPauseResponse{
			Ok:       false,
			NotFound: true,
		})
		return
	}

	if res.Forbidden {
		httpx.WriteJSON(w, http.StatusOK, RepoPauseResponse{
			Ok:        false,
			Forbidden: true,
		})
		return
	}

	if !req.Paused && h.onResume != nil {
		h.onResume()
	}

	httpx.WriteJSON(w, http.StatusOK, RepoPauseResponse{
		Ok:     true,
		Paused: res.Paused,
	})
}

type DocumentContentRequest struct {
	RepositoryID   string   `json:"repositoryId"`
	CandidatePaths []string `json:"candidatePaths"`
	UserID         *string  `json:"userId,omitempty"`
}

type DocumentContentResponse struct {
	Ok       bool                   `json:"ok"`
	Document *DocumentContentResult `json:"document,omitempty"`
	Error    string                 `json:"error,omitempty"`
	Code     string                 `json:"code,omitempty"`
}

func (h *Handler) HandleDocumentContent(w http.ResponseWriter, r *http.Request) {
	var req DocumentContentRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}
	if len(req.CandidatePaths) == 0 {
		httpx.Error(w, http.StatusBadRequest, "candidatePaths is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	doc, err := h.store.GetDocumentContent(r.Context(), req.RepositoryID, req.CandidatePaths, req.UserID)
	if err != nil {
		if errors.Is(err, ErrDocumentNotFound) || errors.Is(err, ErrDocumentContentEmpty) {
			httpx.WriteJSON(w, http.StatusNotFound, DocumentContentResponse{
				Ok:    false,
				Error: "Document content not found or processing",
				Code:  "DOCUMENT_NOT_FOUND",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, DocumentContentResponse{
		Ok:       true,
		Document: doc,
	})
}

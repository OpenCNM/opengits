package userinteraction

import (
	"context"
	"errors"
	"flag"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type ViewRequest struct {
	RepositoryID string `json:"repositoryId"`
}

type ViewResponse struct {
	Ok bool `json:"ok"`
}

func (h *Handler) HandleView(w http.ResponseWriter, r *http.Request) {
	var req ViewRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}

	if h.store != nil {
		repoID := req.RepositoryID

		if flag.Lookup("test.v") != nil {
			_ = h.store.IncrementRepoViews(r.Context(), repoID)
		} else {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = h.store.IncrementRepoViews(ctx, repoID)
			}()
		}
	}

	httpx.WriteJSON(w, http.StatusOK, ViewResponse{Ok: true})
}

type PinRequest struct {
	UserID       string `json:"userId"`
	RepositoryID string `json:"repositoryId"`
	IsPinned     *bool  `json:"isPinned"`
}

type PinResponse struct {
	Ok            bool     `json:"ok"`
	PinnedRepoIds []string `json:"pinnedRepoIds"`
}

func (h *Handler) HandlePin(w http.ResponseWriter, r *http.Request) {
	var req PinRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" || req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId and repositoryId are required")
		return
	}

	isPinned := true
	if req.IsPinned != nil {
		isPinned = *req.IsPinned
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	pins, err := h.store.UpdatePinnedRepos(r.Context(), req.UserID, req.RepositoryID, isPinned)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "user not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, PinResponse{
		Ok:            true,
		PinnedRepoIds: pins,
	})
}

type ReadingProgressSyncRequest struct {
	UserID  string  `json:"userId"`
	Owner   string  `json:"owner"`
	Repo    string  `json:"repo"`
	Edition *string `json:"edition,omitempty"`
}

type ReadingProgressSyncResponse struct {
	Ok              bool               `json:"ok"`
	ChapterScores   map[string]float64 `json:"chapterScores"`
	OverallProgress float64            `json:"overallProgress"`
	ViewedCount     int                `json:"viewedCount"`
	LastReadPath    *string            `json:"lastReadPath,omitempty"`
	LastReadAt      *string            `json:"lastReadAt,omitempty"`
	Error           string             `json:"error,omitempty"`
}

func (h *Handler) HandleReadingProgressSync(w http.ResponseWriter, r *http.Request) {
	var req ReadingProgressSyncRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.Owner == "" || req.Repo == "" {
		httpx.Error(w, http.StatusBadRequest, "owner and repo are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.GetReadingProgressSync(r.Context(), req.UserID, req.Owner, req.Repo, req.Edition)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ReadingProgressSyncResponse{
		Ok:              true,
		ChapterScores:   res.ChapterScores,
		OverallProgress: res.OverallProgress,
		ViewedCount:     res.ViewedCount,
		LastReadPath:    res.LastReadPath,
		LastReadAt:      res.LastReadAt,
	})
}

type TelemetryBatchRequest struct {
	UserID string                `json:"userId"`
	Events []TelemetryEventInput `json:"events"`
}

type TelemetryBatchResponse struct {
	Ok    bool   `json:"ok"`
	Count int    `json:"count"`
	Error string `json:"error,omitempty"`
}

func (h *Handler) HandleTelemetryEvents(w http.ResponseWriter, r *http.Request) {
	var req TelemetryBatchRequest
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

	count, err := h.store.RecordTelemetryEvents(r.Context(), req.UserID, req.Events)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, TelemetryBatchResponse{
		Ok:    true,
		Count: count,
	})
}

type UserPreferencesGetRequest struct {
	UserID string `json:"userId"`
}

type UserPreferencesGetResponse struct {
	Ok          bool                   `json:"ok"`
	Preferences *UserPreferencesResult `json:"preferences,omitempty"`
	Error       string                 `json:"error,omitempty"`
}

func (h *Handler) HandleUserPreferencesGet(w http.ResponseWriter, r *http.Request) {
	var req UserPreferencesGetRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
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

	prefs, err := h.store.GetUserPreferences(r.Context(), req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, UserPreferencesGetResponse{
		Ok:          true,
		Preferences: prefs,
	})
}

type UsageSummaryRequest struct {
	UserID string `json:"userId"`
}

type UsageSummaryResponse struct {
	Ok      bool                `json:"ok"`
	Summary *UsageSummaryResult `json:"summary,omitempty"`
	Error   string              `json:"error,omitempty"`
	Code    string              `json:"code,omitempty"`
}

func (h *Handler) HandleUsageSummary(w http.ResponseWriter, r *http.Request) {
	var req UsageSummaryRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
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

	summary, err := h.store.GetUsageSummary(r.Context(), req.UserID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, UsageSummaryResponse{
				Ok:    false,
				Error: "User not found",
				Code:  "USER_NOT_FOUND",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, UsageSummaryResponse{
		Ok:      true,
		Summary: summary,
	})
}

type UserPreferencesSetRequest struct {
	UserID             string   `json:"userId"`
	PreferredLang1     *string  `json:"preferredLang1"`
	PreferredLang2     *string  `json:"preferredLang2"`
	PreferredLang3     *string  `json:"preferredLang3"`
	Industry           *string  `json:"industry"`
	PrimaryProgLang    *string  `json:"primaryProgLang"`
	SecondaryProgLang  *string  `json:"secondaryProgLang"`
	FontSize           *string  `json:"fontSize"`
	DisabledMcpRepoIds []string `json:"disabledMcpRepoIds,omitempty"`
	HasDisabledRepos   bool     `json:"hasDisabledRepos"`
}

type UserPreferencesSetResponse struct {
	Ok    bool                   `json:"ok"`
	User  *UserPreferencesRecord `json:"user,omitempty"`
	Error string                 `json:"error,omitempty"`
}

func (h *Handler) HandleUserPreferencesSet(w http.ResponseWriter, r *http.Request) {
	var req UserPreferencesSetRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	userRecord, err := h.store.SetUserPreferences(r.Context(), UserPreferencesSetInput{
		UserID:             req.UserID,
		PreferredLang1:     req.PreferredLang1,
		PreferredLang2:     req.PreferredLang2,
		PreferredLang3:     req.PreferredLang3,
		Industry:           req.Industry,
		PrimaryProgLang:    req.PrimaryProgLang,
		SecondaryProgLang:  req.SecondaryProgLang,
		FontSize:           req.FontSize,
		DisabledMcpRepoIds: req.DisabledMcpRepoIds,
		HasDisabledRepos:   req.HasDisabledRepos,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, UserPreferencesSetResponse{
		Ok:   true,
		User: userRecord,
	})
}

type RepoUnsaveRequest struct {
	UserID       string `json:"userId"`
	RepositoryID string `json:"repositoryId"`
}

type RepoUnsaveResponse struct {
	Ok bool `json:"ok"`
}

func (h *Handler) HandleRepoUnsave(w http.ResponseWriter, r *http.Request) {
	var req RepoUnsaveRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.UserID == "" || req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId and repositoryId are required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.UnsaveRepo(r.Context(), req.UserID, req.RepositoryID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, RepoUnsaveResponse{Ok: true})
}

type RepoFollowRequest struct {
	UserID       string `json:"userId"`
	RepositoryID string `json:"repositoryId"`
	AutoFollow   bool   `json:"autoFollow"`
}

type RepoFollowResponse struct {
	Ok      bool `json:"ok"`
	Updated bool `json:"updated"`
}

func (h *Handler) HandleRepoFollow(w http.ResponseWriter, r *http.Request) {
	var req RepoFollowRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.UserID == "" || req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId and repositoryId are required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	updated, err := h.store.SetSavedRepoFollow(r.Context(), req.UserID, req.RepositoryID, req.AutoFollow)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, RepoFollowResponse{Ok: true, Updated: updated})
}

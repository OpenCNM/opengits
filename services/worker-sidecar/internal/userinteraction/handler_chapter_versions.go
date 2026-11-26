package userinteraction

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type ChapterVersionVoteRequest struct {
	VersionID string `json:"versionId"`
	UserID    string `json:"userId"`
}

type ChapterVersionVoteResponse struct {
	Ok           bool   `json:"ok"`
	NotFound     bool   `json:"notFound,omitempty"`
	Forbidden    bool   `json:"forbidden,omitempty"`
	InvalidState bool   `json:"invalidState,omitempty"`
	SelfVote     bool   `json:"selfVote,omitempty"`
	Voted        bool   `json:"voted"`
	VoteCount    int    `json:"voteCount"`
	DocumentID   string `json:"documentId,omitempty"`
}

func (h *Handler) HandleChapterVersionVote(w http.ResponseWriter, r *http.Request) {
	var req ChapterVersionVoteRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.VersionID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "versionId and userId are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.ToggleChapterVersionVote(r.Context(), req.VersionID, req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !res.Found {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionVoteResponse{
			Ok:       false,
			NotFound: true,
		})
		return
	}

	if res.Forbidden {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionVoteResponse{
			Ok:        false,
			Forbidden: true,
		})
		return
	}

	if res.InvalidState {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionVoteResponse{
			Ok:           false,
			InvalidState: true,
		})
		return
	}

	if res.SelfVote {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionVoteResponse{
			Ok:       false,
			SelfVote: true,
		})
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ChapterVersionVoteResponse{
		Ok:         true,
		Voted:      res.Voted,
		VoteCount:  res.VoteCount,
		DocumentID: res.DocumentID,
	})
}

type ChapterVersionsListRequest struct {
	DocumentID string  `json:"documentId"`
	UserID     *string `json:"userId,omitempty"`
}

type ChapterVersionsListResponse struct {
	Ok       bool                 `json:"ok"`
	Versions []ChapterVersionItem `json:"versions"`
	Error    string               `json:"error,omitempty"`
}

func (h *Handler) HandleChapterVersionsList(w http.ResponseWriter, r *http.Request) {
	var req ChapterVersionsListRequest
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

	versions, err := h.store.ListChapterVersions(r.Context(), req.DocumentID, req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ChapterVersionsListResponse{
		Ok:       true,
		Versions: versions,
	})
}

type ChapterVersionCreateRequest struct {
	DocumentID   string `json:"documentId"`
	RepositoryID string `json:"repositoryId"`
	AuthorID     string `json:"authorId"`
	ContentID    string `json:"contentId"`
	Source       string `json:"source,omitempty"`
	Visibility   string `json:"visibility,omitempty"`
}

type ChapterVersionCreateResponse struct {
	Ok        bool   `json:"ok"`
	VersionID string `json:"versionId,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (h *Handler) HandleChapterVersionCreate(w http.ResponseWriter, r *http.Request) {
	var req ChapterVersionCreateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.DocumentID == "" || req.RepositoryID == "" || req.AuthorID == "" || req.ContentID == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId, repositoryId, authorId, and contentId are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.CreateChapterVersion(r.Context(), ChapterVersionCreateInput{
		DocumentID:   req.DocumentID,
		RepositoryID: req.RepositoryID,
		AuthorID:     req.AuthorID,
		ContentID:    req.ContentID,
		Source:       req.Source,
		Visibility:   req.Visibility,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ChapterVersionCreateResponse{
		Ok:        true,
		VersionID: res.VersionID,
	})
}

type ChapterVersionPublishRequest struct {
	VersionID string `json:"versionId"`
	UserID    string `json:"userId"`
}

type ChapterVersionPublishResponse struct {
	Ok           bool   `json:"ok"`
	NotFound     bool   `json:"notFound,omitempty"`
	Forbidden    bool   `json:"forbidden,omitempty"`
	InvalidState bool   `json:"invalidState,omitempty"`
	Base         int    `json:"base"`
	Error        string `json:"error,omitempty"`
}

func (h *Handler) HandleChapterVersionPublish(w http.ResponseWriter, r *http.Request) {
	var req ChapterVersionPublishRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.VersionID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "versionId and userId are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.PublishChapterVersion(r.Context(), req.VersionID, req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !res.Found {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionPublishResponse{
			Ok:       false,
			NotFound: true,
			Error:    "version not found",
		})
		return
	}

	if res.Forbidden {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionPublishResponse{
			Ok:        false,
			Forbidden: true,
			Error:     "forbidden",
		})
		return
	}

	if res.InvalidState {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionPublishResponse{
			Ok:           false,
			InvalidState: true,
			Error:        "version no longer private (concurrent state change)",
		})
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ChapterVersionPublishResponse{
		Ok:   true,
		Base: res.Base,
	})
}

type ChapterVersionDeleteRequest struct {
	VersionID string `json:"versionId"`
	UserID    string `json:"userId"`
}

type ChapterVersionDeleteResponse struct {
	Ok           bool   `json:"ok"`
	NotFound     bool   `json:"notFound,omitempty"`
	Forbidden    bool   `json:"forbidden,omitempty"`
	InvalidState bool   `json:"invalidState,omitempty"`
	Error        string `json:"error,omitempty"`
}

func (h *Handler) HandleChapterVersionDelete(w http.ResponseWriter, r *http.Request) {
	var req ChapterVersionDeleteRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.VersionID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "versionId and userId are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.DeleteChapterVersion(r.Context(), req.VersionID, req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !res.Found {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionDeleteResponse{
			Ok:       false,
			NotFound: true,
			Error:    "version not found",
		})
		return
	}

	if res.Forbidden {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionDeleteResponse{
			Ok:        false,
			Forbidden: true,
			Error:     "forbidden",
		})
		return
	}

	if res.InvalidState {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionDeleteResponse{
			Ok:           false,
			InvalidState: true,
			Error:        "cannot delete public version",
		})
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ChapterVersionDeleteResponse{
		Ok: true,
	})
}

type ChapterVersionPinRequest struct {
	VersionID string `json:"versionId"`
	UserID    string `json:"userId"`
}

type ChapterVersionPinResponse struct {
	Ok              bool             `json:"ok"`
	NotFound        bool             `json:"notFound,omitempty"`
	Forbidden       bool             `json:"forbidden,omitempty"`
	Success         bool             `json:"success"`
	Flipped         bool             `json:"flipped"`
	Reason          string           `json:"reason,omitempty"`
	DocumentID      string           `json:"documentId,omitempty"`
	PostSwapPayload *PostSwapPayload `json:"postSwapPayload,omitempty"`
	Error           string           `json:"error,omitempty"`
}

func (h *Handler) HandleChapterVersionPin(w http.ResponseWriter, r *http.Request) {
	var req ChapterVersionPinRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.VersionID == "" || req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "versionId and userId are required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.PinChapterVersion(r.Context(), ChapterVersionPinInput{
		VersionID: req.VersionID,
		UserID:    req.UserID,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !res.Found {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionPinResponse{
			Ok:       false,
			NotFound: true,
			Error:    "version not found",
		})
		return
	}

	if res.Forbidden {
		httpx.WriteJSON(w, http.StatusOK, ChapterVersionPinResponse{
			Ok:        false,
			Forbidden: true,
			Error:     "forbidden",
		})
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ChapterVersionPinResponse{
		Ok:              true,
		Success:         res.Success,
		Flipped:         res.Flipped,
		Reason:          res.Reason,
		DocumentID:      res.DocumentID,
		PostSwapPayload: res.PostSwapPayload,
	})
}

type ChapterVersionPromoteRequest struct {
	DocumentID      string  `json:"documentId"`
	TargetVersionID *string `json:"targetVersionId,omitempty"`
	IsPinOperation  bool    `json:"isPinOperation,omitempty"`
	OperatorUserID  *string `json:"operatorUserId,omitempty"`
	FlipMargin      int     `json:"flipMargin,omitempty"`
}

type ChapterVersionPromoteResponse struct {
	Ok                 bool             `json:"ok"`
	Flipped            bool             `json:"flipped"`
	CanonicalVersionID *string          `json:"canonicalVersionId,omitempty"`
	PreviousVersionID  *string          `json:"previousVersionId,omitempty"`
	Reason             string           `json:"reason,omitempty"`
	PostSwapPayload    *PostSwapPayload `json:"postSwapPayload,omitempty"`
	Error              string           `json:"error,omitempty"`
}

func (h *Handler) HandleChapterVersionPromote(w http.ResponseWriter, r *http.Request) {
	var req ChapterVersionPromoteRequest
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

	res, err := h.store.PromoteCanonicalChapterVersion(r.Context(), CanonicalPromotionInput{
		DocumentID:      req.DocumentID,
		TargetVersionID: req.TargetVersionID,
		IsPinOperation:  req.IsPinOperation,
		OperatorUserID:  req.OperatorUserID,
		FlipMargin:      req.FlipMargin,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ChapterVersionPromoteResponse{
		Ok:                 true,
		Flipped:            res.Flipped,
		CanonicalVersionID: res.CanonicalVersionID,
		PreviousVersionID:  res.PreviousVersionID,
		Reason:             res.Reason,
		PostSwapPayload:    res.PostSwapPayload,
	})
}

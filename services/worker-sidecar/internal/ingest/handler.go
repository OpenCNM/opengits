package ingest

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type Handler struct {
	store            Store
	onOutlineChanged func(repoID string)
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) SetOutlineChangedNotifier(f func(repoID string)) {
	h.onOutlineChanged = f
}

type RegisterSnapshotRequest struct {
	UserId            string   `json:"userId"`
	RepositoryId      string   `json:"repositoryId"`
	Owner             string   `json:"owner"`
	Repo              string   `json:"repo"`
	Branch            string   `json:"branch"`
	Sha               string   `json:"sha"`
	Prefix            *string  `json:"prefix"`
	DocOwnerId        *string  `json:"docOwnerId"`
	Changed           []string `json:"changed"`
	Removed           []string `json:"removed"`
	SkipDocumentReset bool     `json:"skipDocumentReset"`
}

func (h *Handler) HandleRegisterSnapshot(w http.ResponseWriter, r *http.Request) {
	var req RegisterSnapshotRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.RepositoryId == "" {
		httpx.Error(w, http.StatusBadRequest, "repositoryId is required")
		return
	}
	shaChanged, err := h.store.RegisterImportSnapshot(r.Context(), RegisterSnapshotParams{
		UserId:       req.UserId,
		RepositoryId: req.RepositoryId,
		Owner:        req.Owner,
		Repo:         req.Repo,
		Branch:       req.Branch,
		Sha:          req.Sha,
		Prefix:       req.Prefix,
		DocOwnerId:   req.DocOwnerId,
		Changed:      req.Changed,
		Removed:      req.Removed,
		SkipReset:    req.SkipDocumentReset,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "register snapshot failed: "+err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"shaChanged": shaChanged,
	})
}

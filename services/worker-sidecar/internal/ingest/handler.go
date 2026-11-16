package ingest

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type Handler struct {
	store Store
	// onOutlineChanged 在大纲落库/激活/撤销成功提交后触发（daemon 注入 Web L1/L2
	// revalidate）。nil = 无通知方（测试/独立运行），静默跳过。
	onOutlineChanged func(repoID string)
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

// SetOutlineChangedNotifier 注入大纲变更通知回调（幂等：重复注入后者生效）。
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

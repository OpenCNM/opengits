package diff

import (
	"net/http"
	"os"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// Handler 封装 Diff 端点所需的基础配置（如归档存储根目录）。
type Handler struct {
	ArchiveRoot string
}

// NewHandler 构造带 ArchiveRoot 的 Diff HTTP 处理器。
func NewHandler(archiveRoot string) *Handler {
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}
	return &Handler{ArchiveRoot: archiveRoot}
}

func (h *Handler) getArchiveRoot() string {
	if h != nil && h.ArchiveRoot != "" {
		return h.ArchiveRoot
	}
	return "storage/repos"
}

func archiveExists(archiveRoot, owner, repo, sha string) bool {
	dir1 := ArchiveDirFor(archiveRoot, owner, repo, sha)
	if fi, err := os.Stat(dir1); err == nil && fi.IsDir() {
		return true
	}
	dir2 := archive.ArchiveDirFor(archiveRoot, owner, repo, sha)
	if fi, err := os.Stat(dir2); err == nil && fi.IsDir() {
		return true
	}
	compact := archive.CompactArchivePathFor(archiveRoot, owner, repo, sha)
	if fi, err := os.Stat(compact); err == nil && !fi.IsDir() {
		return true
	}
	return false
}

// HandleArchiveDiff handles POST /v1/archive/diff to compare unpacked archive directories.
func (h *Handler) HandleArchiveDiff(w http.ResponseWriter, r *http.Request) {
	var req ArchiveDiffRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	oldSha := req.OldSha
	if oldSha == "" {
		oldSha = req.FromSha
	}
	newSha := req.NewSha
	if newSha == "" {
		newSha = req.ToSha
	}

	if req.Owner == "" || req.Repo == "" || oldSha == "" || newSha == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields (owner, repo, oldSha/fromSha, newSha/toSha)")
		return
	}

	if !httpx.AssertSegments(w,
		httpx.SegmentField{Name: "owner", Value: req.Owner},
		httpx.SegmentField{Name: "repo", Value: req.Repo},
		httpx.SegmentField{Name: "oldSha", Value: oldSha},
		httpx.SegmentField{Name: "newSha", Value: newSha},
	) {
		return
	}

	archiveRoot := h.getArchiveRoot()
	if !archiveExists(archiveRoot, req.Owner, req.Repo, oldSha) || !archiveExists(archiveRoot, req.Owner, req.Repo, newSha) {
		httpx.Error(w, http.StatusNotFound, "archive not found")
		return
	}

	diff, _, err := ComputeArchiveDiffFromDisk(archiveRoot, req.Owner, req.Repo, oldSha, newSha)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to compute archive diff: "+err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, diff)
}

// HandleArchiveDiff (包级默认配置直连函数) 处理 POST /v1/archive/diff。
func HandleArchiveDiff(w http.ResponseWriter, r *http.Request) {
	NewHandler("").HandleArchiveDiff(w, r)
}

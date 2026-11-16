package scout

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// Handler 封装 Scout 探测端点所需依赖。
type Handler struct {
	cfg         Config
	inspector   *Inspector
	getPatterns func() Patterns
}

// NewHandler 构造带配置与模式提供者的 Handler。
func NewHandler(cfg Config, getPatterns func() Patterns) *Handler {
	return &Handler{
		cfg:         cfg,
		inspector:   NewInspector(cfg),
		getPatterns: getPatterns,
	}
}

// HandleInspect handles POST /v1/scout/inspect for zero-tree Scout inspection.
func (h *Handler) HandleInspect(w http.ResponseWriter, r *http.Request) {
	var req ScoutInspectRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.Owner == "" || req.Repo == "" {
		httpx.Error(w, http.StatusBadRequest, "missing required fields (owner, repo)")
		return
	}
	if !httpx.AssertSegments(w,
		httpx.SegmentField{Name: "owner", Value: req.Owner},
		httpx.SegmentField{Name: "repo", Value: req.Repo},
	) {
		return
	}
	if req.Sha != "" {
		if !httpx.AssertSegments(w, httpx.SegmentField{Name: "sha", Value: req.Sha}) {
			return
		}
	}

	var patterns Patterns
	if h != nil && h.getPatterns != nil {
		patterns = h.getPatterns()
	}
	if patterns == nil {
		httpx.Error(w, http.StatusInternalServerError, "ingest patterns not loaded")
		return
	}

	res, err := h.inspector.Inspect(r.Context(), req, patterns)
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, res)
}

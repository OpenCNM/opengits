package cognitive

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/testutil"
)

// testRoutes 测试内联鉴权 mux（原独立 Routes/RegisterRoutes 装配器已随
// /v1/cognitive/project 与 /v1/fact-grounding/verify 死端点下线删除，
// 2026-11 收口——本辅助仅注册现役 outline 四端点）。
func (h *Handler) testRoutes(internalToken string) http.Handler {
	mux := http.NewServeMux()
	wrap := func(next http.HandlerFunc) http.HandlerFunc {
		return testutil.InternalAuthWrap(internalToken, next)
	}
	mux.HandleFunc("POST /v1/outline/candidates", wrap(h.HandleCandidates))
	mux.HandleFunc("POST /v1/outline/rule-fallback", wrap(h.HandleRuleFallback))
	mux.HandleFunc("POST /v1/outline/sanitize", wrap(h.HandleSanitize))
	mux.HandleFunc("POST /v1/outline/prepare-signals", wrap(h.HandlePrepareSignals))
	return mux
}

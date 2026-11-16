package rsg

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/testutil"
)

// testRoutes 测试内联鉴权 mux（原独立 Routes 装配器已随 /v1/graph/build|diff
// 死端点下线删除，2026-11 收口——生产注册统一走 daemon/server.go 单写者；
// 本辅助仅注册现役图谱读侧端点）。
func (h *Handler) testRoutes(internalToken string) http.Handler {
	mux := http.NewServeMux()
	wrap := func(next http.HandlerFunc) http.HandlerFunc {
		return testutil.InternalAuthWrap(internalToken, next)
	}
	mux.HandleFunc("POST /v1/graph/concept-grounding", wrap(h.HandleGrounding))
	mux.HandleFunc("POST /v1/graph/symbol-lookup", wrap(h.HandleSymbolLookup))
	mux.HandleFunc("POST /v1/graph/symbol-search", wrap(h.HandleSymbolSearch))
	mux.HandleFunc("POST /v1/graph/slice-context", wrap(h.HandleTopologySlice))
	mux.HandleFunc("POST /v1/symbols/extract", wrap(h.HandleSymbolsExtract))
	return mux
}

package archive

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/testutil"
)

// testRoutes 测试内联鉴权 mux（原独立 Routes/RegisterRoutes 装配器已随死
// 装配面收口删除，2026-11 收口——生产注册统一走 daemon/server.go 单写者）。
func (h *Handler) testRoutes(internalToken string) http.Handler {
	mux := http.NewServeMux()
	wrap := func(next http.HandlerFunc) http.HandlerFunc {
		return testutil.InternalAuthWrap(internalToken, next)
	}
	mux.HandleFunc("POST /v1/archive/tree", wrap(h.HandleTree))
	mux.HandleFunc("POST /v1/archive/sniff", wrap(h.HandleSniff))
	mux.HandleFunc("POST /v1/archive/ensure", wrap(h.HandleEnsure))
	mux.HandleFunc("GET /v1/assets/serve", wrap(h.HandleAssetServe))
	return mux
}

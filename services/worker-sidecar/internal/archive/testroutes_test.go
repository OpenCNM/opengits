package archive

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/testutil"
)

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

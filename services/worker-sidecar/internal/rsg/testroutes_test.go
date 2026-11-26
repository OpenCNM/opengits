package rsg

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/testutil"
)

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

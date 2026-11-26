package cognitive

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/testutil"
)

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

package sanitize

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// HandleSanitize handles POST /v1/mdx/sanitize requests to sanitize MDX content.
func HandleSanitize(w http.ResponseWriter, r *http.Request) {
	var req SanitizeRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	sanitized, err := SanitizeText(req.Content)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "sanitize failed: "+err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, SanitizeResponse{
		Ok:      true,
		Content: sanitized,
	})
}

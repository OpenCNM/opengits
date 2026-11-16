package mdx

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// HealRequest represents incoming MDX heal payload.
type HealRequest struct {
	Content string `json:"content"`
}

// HealResponse represents successful MDX heal response.
type HealResponse struct {
	Ok      bool   `json:"ok"`
	Content string `json:"content"`
}

// Backward compatibility aliases for Heal.
type (
	MdxTransformRequest = HealRequest
	TransformRequest    = HealRequest
	TransformResponse   = HealResponse
)

// HandleHeal handles POST /v1/mdx/heal to heal unescaped curly braces in MDX.
func HandleHeal(w http.ResponseWriter, r *http.Request) {
	var req HealRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	healed, err := HealSource(req.Content)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "heal failed: "+err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, HealResponse{
		Ok:      true,
		Content: healed,
	})
}

// ValidateRequest represents incoming MDX validation payload.
type ValidateRequest struct {
	Content string `json:"content"`
}

// ValidateResponse represents MDX validation response.
type ValidateResponse struct {
	Ok    bool   `json:"ok"`
	Valid bool   `json:"valid"`
	Error string `json:"error,omitempty"`
}

// Backward compatibility aliases for Validate.
type (
	MdxValidateRequest = ValidateRequest
)

// HandleValidate handles POST /v1/mdx/validate to validate MDX content.
func HandleValidate(w http.ResponseWriter, r *http.Request) {
	var req ValidateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	valid, errMsg := ValidateDetailed(req.Content)
	httpx.WriteJSON(w, http.StatusOK, ValidateResponse{
		Ok:    true,
		Valid: valid,
		Error: errMsg,
	})
}

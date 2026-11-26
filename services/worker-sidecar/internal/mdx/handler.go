package mdx

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type HealRequest struct {
	Content string `json:"content"`
}

type HealResponse struct {
	Ok      bool   `json:"ok"`
	Content string `json:"content"`
}

type (
	MdxTransformRequest = HealRequest
	TransformRequest    = HealRequest
	TransformResponse   = HealResponse
)

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

type ValidateRequest struct {
	Content string `json:"content"`
}

type ValidateResponse struct {
	Ok    bool   `json:"ok"`
	Valid bool   `json:"valid"`
	Error string `json:"error,omitempty"`
}

type (
	MdxValidateRequest = ValidateRequest
)

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

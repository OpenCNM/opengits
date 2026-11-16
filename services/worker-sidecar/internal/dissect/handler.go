package dissect

import (
	"encoding/json"
	"net/http"

	"github.com/opengits/worker-sidecar/internal/treesitter"
)

// HandleDissectAst handles POST /v1/dissect/ast requests.
func HandleDissectAst(engine *treesitter.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req DissectRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error": "invalid json payload: " + err.Error(),
			})
			return
		}

		resp, err := ProjectCodeAst(r.Context(), engine, req.Code, req.Language)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error": "failed to project code ast: " + err.Error(),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	}
}

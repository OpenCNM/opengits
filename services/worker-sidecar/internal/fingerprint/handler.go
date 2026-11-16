package fingerprint

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// HandleCompute handles POST /v1/fingerprint/compute.
func HandleCompute(w http.ResponseWriter, r *http.Request) {
	var req FingerprintComputeRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	result := ComputeFingerprint(req.Chapters, req.Events, req.Config)
	httpx.WriteJSON(w, http.StatusOK, FingerprintComputeResponse{
		OK:     true,
		Result: &result,
	})
}

// HandleComputeBatch handles POST /v1/fingerprint/compute-batch.
func HandleComputeBatch(w http.ResponseWriter, r *http.Request) {
	var req FingerprintComputeBatchRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	results := make(map[string]FingerprintProgress, len(req.Items))
	for _, item := range req.Items {
		if item.RepoID == "" {
			continue
		}
		results[item.RepoID] = ComputeFingerprint(item.Chapters, item.Events, req.Config)
	}

	httpx.WriteJSON(w, http.StatusOK, FingerprintComputeBatchResponse{
		OK:      true,
		Results: results,
	})
}

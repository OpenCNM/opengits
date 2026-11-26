package chunker

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

func HandleCodeModule(w http.ResponseWriter, r *http.Request) {
	var req CodeModuleChunkRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	chunks := ChunkCodeModule(req)
	httpx.WriteJSON(w, http.StatusOK, CodeModuleChunkResponse{
		Chunks: chunks,
	})
}

func HandleMarkdown(w http.ResponseWriter, r *http.Request) {
	var req MarkdownChunkRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	chunks := ChunkMarkdown(req)
	httpx.WriteJSON(w, http.StatusOK, MarkdownChunkResponse{
		Chunks: chunks,
	})
}

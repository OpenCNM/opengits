package llmstream

import (
	"encoding/json"
	"io"
	"net/http"
)

// Handler 暴露 HTTP POST /v1/llm/stream 端点
type Handler struct {
	engine *Engine
}

func NewHandler(engine *Engine) *Handler {
	if engine == nil {
		engine = NewEngine(nil)
	}
	return &Handler{engine: engine}
}

func (h *Handler) HandleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024))
	if err != nil {
		http.Error(w, "Bad Request: failed to read body", http.StatusBadRequest)
		return
	}

	var req StreamRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Bad Request: invalid json", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported by response writer", http.StatusInternalServerError)
		return
	}

	// 设置响应头
	if req.StreamFormat == "ndjson" {
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("x-vercel-ai-data-stream", "v1")
	}
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("x-accel-buffering", "no")
	if req.CallID != "" {
		w.Header().Set("x-llm-call-id", req.CallID)
	}

	var encoder StreamEncoder
	if req.StreamFormat == "ndjson" {
		encoder = NewNdjsonEncoder(w, flusher)
	} else {
		encoder = NewAiSdkEncoder(w, flusher)
	}

	_ = h.engine.Stream(r.Context(), req, encoder)
}

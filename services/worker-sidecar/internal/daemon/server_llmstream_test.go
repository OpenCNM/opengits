package daemon

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/llmstream"
)

func TestServer_LlmStreamEndpoint(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		require.True(t, ok)

		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello from sidecar daemon\"}}]}\n\n")
		flusher.Flush()

		fmt.Fprintf(w, "data: {\"choices\":[{\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":10}}\n\n")
		fmt.Fprintf(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer mockUpstream.Close()

	cfg := Config{InternalToken: "valid-secret"}
	srv := newServer(cfg, nil, nil, nil, nil)

	engine := llmstream.NewEngine(mockUpstream.Client())
	srv.SetLlmStreamHandler(llmstream.NewHandler(engine))

	handler := srv.routes()

	t.Run("POST /v1/llm/stream without token returns 403 Forbidden", func(t *testing.T) {
		reqBody, _ := json.Marshal(llmstream.StreamRequest{
			Model: llmstream.ModelConfig{
				Provider: "openai",
				ModelID:  "gpt-4o",
				APIKey:   "sk-test",
				BaseURL:  mockUpstream.URL,
			},
			Messages: []llmstream.ChatMessage{{Role: "user", Content: "hi"}},
		})

		req := httptest.NewRequest(http.MethodPost, "/v1/llm/stream", bytes.NewReader(reqBody))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		assert.Equal(t, http.StatusForbidden, w.Code)
	})

	t.Run("POST /v1/llm/stream with token streams AI SDK format", func(t *testing.T) {
		reqBody, _ := json.Marshal(llmstream.StreamRequest{
			Model: llmstream.ModelConfig{
				Provider: "openai",
				ModelID:  "gpt-4o",
				APIKey:   "sk-test",
				BaseURL:  mockUpstream.URL,
			},
			Messages:     []llmstream.ChatMessage{{Role: "user", Content: "hi"}},
			StreamFormat: "ai-sdk",
			CallID:       "call-daemon-1",
		})

		req := httptest.NewRequest(http.MethodPost, "/v1/llm/stream", bytes.NewReader(reqBody))
		req.Header.Set("x-internal-token", "valid-secret")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Equal(t, "text/plain; charset=utf-8", w.Header().Get("Content-Type"))
		assert.Equal(t, "v1", w.Header().Get("x-vercel-ai-data-stream"))
		assert.Equal(t, "call-daemon-1", w.Header().Get("x-llm-call-id"))

		body := w.Body.String()
		assert.Contains(t, body, "0:\"Hello from sidecar daemon\"")
		assert.Contains(t, body, "d:{\"finishReason\":\"stop\"")
	})

	t.Run("POST /v1/llm/stream with ndjson format streams NDJSON", func(t *testing.T) {
		reqBody, _ := json.Marshal(llmstream.StreamRequest{
			Model: llmstream.ModelConfig{
				Provider: "openai",
				ModelID:  "gpt-4o",
				APIKey:   "sk-test",
				BaseURL:  mockUpstream.URL,
			},
			Messages:     []llmstream.ChatMessage{{Role: "user", Content: "hi"}},
			StreamFormat: "ndjson",
			CallID:       "call-daemon-2",
		})

		req := httptest.NewRequest(http.MethodPost, "/v1/llm/stream", bytes.NewReader(reqBody))
		req.Header.Set("x-internal-token", "valid-secret")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		assert.Equal(t, "application/x-ndjson; charset=utf-8", w.Header().Get("Content-Type"))
		assert.Equal(t, "call-daemon-2", w.Header().Get("x-llm-call-id"))

		body := w.Body.String()
		assert.Contains(t, body, "{\"delta\":\"Hello from sidecar daemon\",\"kind\":\"content\",\"type\":\"chunk\"}")
		assert.Contains(t, body, "{\"finishReason\":\"stop\",\"ok\":true,\"type\":\"done\"")
	})
}

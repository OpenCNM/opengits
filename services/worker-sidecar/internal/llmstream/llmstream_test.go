package llmstream

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type dummyFlusher struct {
	flushed bool
}

func (f *dummyFlusher) Flush() {
	f.flushed = true
}

func TestEncoders(t *testing.T) {
	t.Run("AiSdkEncoder format verification", func(t *testing.T) {
		buf := &bytes.Buffer{}
		flusher := &dummyFlusher{}
		enc := NewAiSdkEncoder(buf, flusher)

		require.NoError(t, enc.WriteTextDelta("Hello world"))
		require.NoError(t, enc.WriteReasoningDelta("Thinking step 1"))
		require.NoError(t, enc.WriteToolCall("tc1", "search", map[string]any{"q": "go"}))
		require.NoError(t, enc.WriteFinish("stop", StreamUsage{PromptTokens: 10, CompletionTokens: 20}))
		require.NoError(t, enc.WritePing())

		output := buf.String()
		lines := strings.Split(strings.TrimSpace(output), "\n")

		assert.Contains(t, lines, "0:\"Hello world\"")
		assert.Contains(t, lines, "b:\"Thinking step 1\"")
		assert.True(t, strings.HasPrefix(lines[2], "9:{"))
		assert.Contains(t, output, "d:{\"finishReason\":\"stop\",\"usage\":{\"completionTokens\":20,\"promptTokens\":10}}")
		assert.Contains(t, output, ": ping")
		assert.True(t, flusher.flushed)
	})

	t.Run("NdjsonEncoder format verification", func(t *testing.T) {
		buf := &bytes.Buffer{}
		flusher := &dummyFlusher{}
		enc := NewNdjsonEncoder(buf, flusher)

		require.NoError(t, enc.WriteTextDelta("Hello ndjson"))
		require.NoError(t, enc.WriteReasoningDelta("Reasoning ndjson"))
		require.NoError(t, enc.WriteFinish("stop", StreamUsage{PromptTokens: 5, CompletionTokens: 15, TotalTokens: 20}))
		require.NoError(t, enc.WritePing())

		output := buf.String()
		assert.Contains(t, output, `{"delta":"Hello ndjson","kind":"content","type":"chunk"}`)
		assert.Contains(t, output, `{"delta":"Reasoning ndjson","kind":"reasoning","type":"chunk"}`)
		assert.Contains(t, output, `{"finishReason":"stop","ok":true,"type":"done"`)
		assert.Contains(t, output, `{"type":"ping"}`)
	})
}

func TestNormalizer(t *testing.T) {
	tests := []struct {
		name     string
		chunk    string
		wantKind string
		wantText string
	}{
		{
			name:     "OpenAI content chunk",
			chunk:    `{"choices":[{"delta":{"content":"foo"}}]}`,
			wantKind: "content",
			wantText: "foo",
		},
		{
			name:     "DeepSeek reasoning_content chunk",
			chunk:    `{"choices":[{"delta":{"reasoning_content":"think bar"}}]}`,
			wantKind: "reasoning",
			wantText: "think bar",
		},
		{
			name:     "Qwen reasoning chunk",
			chunk:    `{"choices":[{"delta":{"reasoning":"think baz"}}]}`,
			wantKind: "reasoning",
			wantText: "think baz",
		},
		{
			name:     "Finish reason stop",
			chunk:    `{"choices":[{"finish_reason":"stop"}]}`,
			wantKind: "finish",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			normalizer := NewStreamNormalizer("test-call")
			part, err := normalizer.ParseOpenAIChunk([]byte(tt.chunk))
			require.NoError(t, err)
			assert.Equal(t, tt.wantKind, part.Kind)
			if tt.wantText != "" {
				assert.Equal(t, tt.wantText, part.Text)
			}
		})
	}

	t.Run("Anthropic parsing", func(t *testing.T) {
		normalizer := NewStreamNormalizer("test-call")
		part1, err := normalizer.ParseAnthropicChunk("content_block_delta", []byte(`{"delta":{"type":"text_delta","text":"anthropic text"}}`))
		require.NoError(t, err)
		assert.Equal(t, "content", part1.Kind)
		assert.Equal(t, "anthropic text", part1.Text)

		part2, err := normalizer.ParseAnthropicChunk("content_block_delta", []byte(`{"delta":{"type":"thinking_delta","thinking":"anthropic thought"}}`))
		require.NoError(t, err)
		assert.Equal(t, "reasoning", part2.Kind)
		assert.Equal(t, "anthropic thought", part2.Text)
	})
}

func TestEngine_StreamWithMockUpstream(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer sk-test", r.Header.Get("Authorization"))
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))

		flusher, ok := w.(http.Flusher)
		require.True(t, ok)

		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"I think...\"}}]}\n\n")
		flusher.Flush()
		time.Sleep(10 * time.Millisecond)

		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello world\"}}]}\n\n")
		flusher.Flush()
		time.Sleep(10 * time.Millisecond)

		fmt.Fprintf(w, "data: {\"choices\":[{\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":16}}\n\n")
		flusher.Flush()

		fmt.Fprintf(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer mockServer.Close()

	engine := NewEngine(mockServer.Client())
	engine.SetActivityTimeout(5 * time.Second)
	engine.SetPingInterval(100 * time.Millisecond)

	req := StreamRequest{
		Model: ModelConfig{
			Provider: "openai",
			ModelID:  "gpt-4o",
			APIKey:   "sk-test",
			BaseURL:  mockServer.URL,
		},
		Messages: []ChatMessage{
			{Role: "user", Content: "Hi"},
		},
		CallID: "call-123",
	}

	buf := &bytes.Buffer{}
	flusher := &dummyFlusher{}
	encoder := NewAiSdkEncoder(buf, flusher)

	err := engine.Stream(context.Background(), req, encoder)
	require.NoError(t, err)

	out := buf.String()
	assert.Contains(t, out, "b:\"I think...\"")
	assert.Contains(t, out, "0:\"Hello world\"")
	assert.Contains(t, out, "d:{\"finishReason\":\"stop\"")
	assert.Contains(t, out, "e:{\"finishReason\":\"stop\"")
	assert.Contains(t, out, "\"isContinued\":false")
}

func TestHandler_HandleStream(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher := w.(http.Flusher)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok from handler\"}}]}\n\n")
		fmt.Fprintf(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer mockServer.Close()

	engine := NewEngine(mockServer.Client())
	handler := NewHandler(engine)

	reqPayload := StreamRequest{
		Model: ModelConfig{
			Provider: "openai",
			ModelID:  "gpt-4o",
			APIKey:   "sk-key",
			BaseURL:  mockServer.URL,
		},
		Messages:     []ChatMessage{{Role: "user", Content: "test"}},
		StreamFormat: "ai-sdk",
		CallID:       "call-abc",
	}
	body, _ := json.Marshal(reqPayload)

	httpReq := httptest.NewRequest(http.MethodPost, "/v1/llm/stream", bytes.NewReader(body))
	w := httptest.NewRecorder()

	handler.HandleStream(w, httpReq)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "text/plain; charset=utf-8", w.Header().Get("Content-Type"))
	assert.Equal(t, "v1", w.Header().Get("x-vercel-ai-data-stream"))
	assert.Equal(t, "call-abc", w.Header().Get("x-llm-call-id"))
	assert.Contains(t, w.Body.String(), "0:\"ok from handler\"")
}

func TestNormalizerMalformedFrames(t *testing.T) {
	tests := []struct {
		name     string
		chunk    string
		wantKind string
		wantFin  string
		wantTok  int
	}{
		{name: "choices first element null", chunk: `{"choices":[null]}`, wantKind: "unknown"},
		{name: "choices is object not array", chunk: `{"choices":{"a":1}}`, wantKind: "other"},
		{name: "delta null with finish_reason", chunk: `{"choices":[{"finish_reason":"stop"}]}`, wantKind: "finish", wantFin: "stop"},
		{name: "delta null without finish_reason", chunk: `{"choices":[{"index":0}]}`, wantKind: "other"},
		{name: "usage-only final frame", chunk: `{"usage":{"prompt_tokens":5,"completion_tokens":7}}`, wantKind: "finish", wantFin: "stop", wantTok: 7},
		{name: "content non-string tolerated", chunk: `{"choices":[{"delta":{"content":123}}]}`, wantKind: "other"},
		{name: "tool_calls first null falls to other", chunk: `{"choices":[{"delta":{"tool_calls":[null]}}]}`, wantKind: "other"},
		{name: "tool function null still tool_call", chunk: `{"choices":[{"delta":{"tool_calls":[{"id":"t1"}]}}]}`, wantKind: "tool_call"},
		{name: "usage non-object ignored", chunk: `{"usage":[1,2],"choices":[{"delta":{"content":"x"}}]}`, wantKind: "content"},
		{name: "finish_reason non-string tolerated", chunk: `{"choices":[{"delta":{},"finish_reason":42}]}`, wantKind: "other"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n := NewStreamNormalizer("mal-test")
			part, err := n.ParseOpenAIChunk([]byte(tt.chunk))
			require.NoError(t, err)
			require.NotNil(t, part)
			assert.Equal(t, tt.wantKind, part.Kind)
			if tt.wantFin != "" {
				assert.Equal(t, tt.wantFin, part.Finish)
			}
			if tt.wantTok != 0 {
				assert.Equal(t, tt.wantTok, part.CompTok)
			}
		})
	}

	t.Run("invalid json errors as unknown", func(t *testing.T) {
		n := NewStreamNormalizer("mal-test")
		part, err := n.ParseOpenAIChunk([]byte(`{"choices":`))
		require.Error(t, err)
		assert.Nil(t, part)
		assert.Equal(t, 1, n.PartsHistogram().Unknown)
	})

	t.Run("anthropic delta null falls to other", func(t *testing.T) {
		n := NewStreamNormalizer("mal-test")
		part, err := n.ParseAnthropicChunk("content_block_delta", []byte(`{"delta":null}`))
		require.NoError(t, err)
		require.NotNil(t, part)
		assert.Equal(t, "other", part.Kind)
	})
}

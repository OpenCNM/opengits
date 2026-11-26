package llmstream

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func captureEngineLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return buf
}

func TestFrame1AnomalyTemporal(t *testing.T) {
	buf := captureEngineLog(t)
	n := NewStreamNormalizer("call-f1")

	part, err := n.ParseOpenAIChunk([]byte(`{"choices":[{"delta":{"role":"assistant"}}]}`))
	require.NoError(t, err)
	assert.Equal(t, "other", part.Kind, "无效载荷帧归类 other（丢帧不阻断流）")
	assert.Contains(t, buf.String(), "FRAME_1_ANOMALY: call=call-f1", "首帧异常必须即刻告警（actual_keys 指认）")
	assert.Contains(t, buf.String(), "keys=[")

	part, err = n.ParseOpenAIChunk([]byte(`{"choices":[{"delta":{"content":"ok"}}]}`))
	require.NoError(t, err)
	assert.Equal(t, "content", part.Kind)

	before := strings.Count(buf.String(), "FRAME_1_ANOMALY")
	part, err = n.ParseOpenAIChunk([]byte(`{"choices":[{"delta":{"role":"assistant"}}]}`))
	require.NoError(t, err)
	assert.Equal(t, "other", part.Kind)
	assert.Equal(t, before, strings.Count(buf.String(), "FRAME_1_ANOMALY"), "frame-1 告警不刷屏")
}

func TestNormalizerHistogramConservation(t *testing.T) {
	n := NewStreamNormalizer("call-hist")

	steps := []struct {
		name string
		data string
	}{
		{"content-1", `{"choices":[{"delta":{"content":"a"}}]}`},
		{"content-2", `{"choices":[{"delta":{"content":"b"}}]}`},
		{"content-3", `{"choices":[{"delta":{"content":"c"}}]}`},
		{"reasoning-1", `{"choices":[{"delta":{"reasoning_content":"think-1"}}]}`},
		{"reasoning-2", `{"choices":[{"delta":{"reasoning":"think-2"}}]}`},
		{"tool-call", `{"choices":[{"delta":{"tool_calls":[{"id":"t1","function":{"name":"f","arguments":"{}"}}]}}]}`},
		{"invalid-json", `{"choices":[{"delta":`},
		{"other-no-payload", `{"choices":[{"delta":{"role":"user"}}]}`},
	}
	for _, s := range steps {
		if s.name == "invalid-json" {
			_, err := n.ParseOpenAIChunk([]byte(s.data))
			require.Error(t, err, "非法 JSON 必须报错（计 Unknown）")
			continue
		}
		_, err := n.ParseOpenAIChunk([]byte(s.data))
		require.NoError(t, err, "step %s", s.name)
	}

	parts := n.PartsHistogram()
	events := n.EventsHistogram()

	assert.Equal(t, 3, parts.Content)
	assert.Equal(t, 2, parts.Reasoning)
	assert.Equal(t, 1, parts.ToolCall)
	assert.Equal(t, 1, parts.Other)
	assert.Equal(t, 1, parts.Unknown)
	assert.Equal(t, 3, events.ChunkContent)
	assert.Equal(t, 2, events.ChunkReasoning)
	assert.Equal(t, 1, events.ToolCall)
}

func TestEngineAbnormalUpstreamOutcomeError(t *testing.T) {
	buf := captureEngineLog(t)

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		require.True(t, ok)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial-1\"}}]}\n\n")
		flusher.Flush()
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial-2\"}}]}\n\n")
		flusher.Flush()
		panic(http.ErrAbortHandler)
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
		Messages: []ChatMessage{{Role: "user", Content: "Hi"}},
		CallID:   "call-abrupt",
	}

	out := &bytes.Buffer{}
	encoder := NewAiSdkEncoder(out, &dummyFlusher{})
	err := engine.Stream(context.Background(), req, encoder)

	assert.Contains(t, out.String(), "partial-1")
	require.NoError(t, err)

	summary := buf.String()
	require.Equal(t, 1, strings.Count(summary, "parts={"), "断连收尾必须恰 1 条聚合 summary（单写账本）")
	assert.Contains(t, summary, "call=call-abrupt")
	assert.Contains(t, summary, "outcome=error", "中途断连的 summary 不得伪装 success（观测诚实性）")
}

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

// ─────────────────────────────────────────────────────────────
// 流式规整器时序补充（既有 llmstream_test.go 已覆盖编码格式、常规解析、
// 畸形帧分类与正常路径 engine 转发；本文件锁定）：
// 1. Frame-1 异常检测的时间维度：仅首帧告警（frameCounter==1 分支），
//    第 2+ 帧同形状不再触发（告警不刷屏）；
// 2. 横截面直方图守恒：content/reasoning/toolCall/other/unknown 分类
//    计数与输入帧逐类精确守恒（丢帧不丢计数）；
// 3. engine 异常收尾诚实性：上游中途断连 → 单行 summary 账本
//    outcome=error（修复前硬编码 success 的观测谎言）。
// ─────────────────────────────────────────────────────────────

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

	// 首帧：delta 存在但无 content/reasoning/tool/finish 任何有效载荷
	part, err := n.ParseOpenAIChunk([]byte(`{"choices":[{"delta":{"role":"assistant"}}]}`))
	require.NoError(t, err)
	assert.Equal(t, "other", part.Kind, "无效载荷帧归类 other（丢帧不阻断流）")
	assert.Contains(t, buf.String(), "FRAME_1_ANOMALY: call=call-f1", "首帧异常必须即刻告警（actual_keys 指认）")
	assert.Contains(t, buf.String(), "keys=[")

	// 第 2 帧：合法 content 正常通过
	part, err = n.ParseOpenAIChunk([]byte(`{"choices":[{"delta":{"content":"ok"}}]}`))
	require.NoError(t, err)
	assert.Equal(t, "content", part.Kind)

	// 第 3 帧：同形状异常但非首帧 → 不再走 frame-1 分支（告警仅一次）
	before := strings.Count(buf.String(), "FRAME_1_ANOMALY")
	part, err = n.ParseOpenAIChunk([]byte(`{"choices":[{"delta":{"role":"assistant"}}]}`))
	require.NoError(t, err)
	assert.Equal(t, "other", part.Kind)
	assert.Equal(t, before, strings.Count(buf.String(), "FRAME_1_ANOMALY"), "frame-1 告警不刷屏")
}

func TestNormalizerHistogramConservation(t *testing.T) {
	n := NewStreamNormalizer("call-hist")

	// 首帧用合法 content（避免 frame-1 告警噪音混入本用例）
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
		{"invalid-json", `{"choices":[{"delta":`}, // JSON 截断 → Unknown + error
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

	// parts_in 逐类精确守恒：3 content + 2 reasoning + 1 tool + 1 other + 1 unknown
	assert.Equal(t, 3, parts.Content)
	assert.Equal(t, 2, parts.Reasoning)
	assert.Equal(t, 1, parts.ToolCall)
	assert.Equal(t, 1, parts.Other)
	assert.Equal(t, 1, parts.Unknown)
	// events_out 与有效载荷帧 1:1（丢帧计入 other/unknown，不虚报事件）
	assert.Equal(t, 3, events.ChunkContent)
	assert.Equal(t, 2, events.ChunkReasoning)
	assert.Equal(t, 1, events.ToolCall)
}

func TestEngineAbnormalUpstreamOutcomeError(t *testing.T) {
	buf := captureEngineLog(t)

	// 假上游：发送 2 帧后中途断连（AbortHandler 掐断 chunked 响应 → 客户端
	// 读到 io.ErrUnexpectedEOF 而非正常 EOF）
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

	// 已产出内容照常转发（部分成果不回撤）
	assert.Contains(t, out.String(), "partial-1")
	// 断连不作为 Transport 级错误外抛（收尾走 WriteFinish + summary 账本）
	require.NoError(t, err)

	summary := buf.String()
	require.Equal(t, 1, strings.Count(summary, "parts={"), "断连收尾必须恰 1 条聚合 summary（单写账本）")
	assert.Contains(t, summary, "call=call-abrupt")
	assert.Contains(t, summary, "outcome=error", "中途断连的 summary 不得伪装 success（观测诚实性）")
}

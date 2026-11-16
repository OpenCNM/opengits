package llmstream

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// encoderWriteTimeout 单次协议帧写入截止时间（与 sse 包 writeTimeout 同口径）：
// 慢速/半开客户端停止读取时，裸写 ResponseWriter 会无限阻塞——ping 协程
// 持锁阻塞 + 引擎主循环阻塞在同一把锁上，watchdog 无法解除（双协程互锁
// 泄漏）。写截止时间让阻塞在 15s 内以写失败收敛，两循环随即退出。
const encoderWriteTimeout = 15 * time.Second

// deadlineWriter 每次写前刷新写截止时间。非 http.ResponseWriter（测试
// 注入的 buffer）不支持 SetWriteDeadline——原样透传，行为不变。
type deadlineWriter struct {
	w  io.Writer
	rc *http.ResponseController
}

func newDeadlineWriter(w io.Writer) io.Writer {
	if rw, ok := w.(http.ResponseWriter); ok {
		return &deadlineWriter{w: w, rc: http.NewResponseController(rw)}
	}
	return w
}

func (d *deadlineWriter) Write(p []byte) (int, error) {
	_ = d.rc.SetWriteDeadline(time.Now().Add(encoderWriteTimeout))
	return d.w.Write(p)
}

// StreamEncoder 定义跨前端协议的统一流式写入接口
type StreamEncoder interface {
	WriteTextDelta(text string) error
	WriteReasoningDelta(reasoning string) error
	WriteToolCall(id, name string, args any) error
	WriteFinish(finishReason string, usage StreamUsage) error
	WritePing() error
	WriteError(code, message string) error
	Flush()
}

// ─────────────────────────────────────────────────────────────
// 1. AI SDK Data-Stream 协议编码器（面向 @ai-sdk/react useChat）
// 格式规范：
// 0:"text delta"\n
// b:"reasoning delta"\n
// 9:{"toolCallId":"...","toolName":"...","args":{...}}\n
// d:{"finishReason":"...","usage":{...}}\n
// e:{"finishReason":"...","usage":{...},"isContinued":false}\n
// : ping\n\n (SSE 保活注释)
// ─────────────────────────────────────────────────────────────

type AiSdkEncoder struct {
	w       io.Writer
	flusher http.Flusher
	mu      sync.Mutex
}

func NewAiSdkEncoder(w io.Writer, flusher http.Flusher) *AiSdkEncoder {
	return &AiSdkEncoder{w: newDeadlineWriter(w), flusher: flusher}
}

func (e *AiSdkEncoder) WriteTextDelta(text string) error {
	if text == "" {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	b, err := json.Marshal(text)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "0:%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *AiSdkEncoder) WriteReasoningDelta(reasoning string) error {
	if reasoning == "" {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	b, err := json.Marshal(reasoning)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "b:%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *AiSdkEncoder) WriteToolCall(id, name string, args any) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	payload := map[string]any{
		"toolCallId": id,
		"toolName":   name,
		"args":       args,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "9:%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *AiSdkEncoder) WriteFinish(finishReason string, usage StreamUsage) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	stepPayload := map[string]any{
		"finishReason": finishReason,
		"usage": map[string]any{
			"promptTokens":     usage.PromptTokens,
			"completionTokens": usage.CompletionTokens,
		},
	}
	bStep, err := json.Marshal(stepPayload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "d:%s\n", string(bStep)); err != nil {
		return err
	}

	msgPayload := map[string]any{
		"finishReason": finishReason,
		"usage": map[string]any{
			"promptTokens":     usage.PromptTokens,
			"completionTokens": usage.CompletionTokens,
		},
		"isContinued": false,
	}
	bMsg, err := json.Marshal(msgPayload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "e:%s\n", string(bMsg)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *AiSdkEncoder) WritePing() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	// 采用标准 SSE 注释行保活，同时兼顾 AI SDK 数据协议
	if _, err := fmt.Fprintf(e.w, ": ping\n\n"); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *AiSdkEncoder) WriteError(code, message string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	payload := map[string]any{
		"code":    code,
		"message": message,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "3:%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *AiSdkEncoder) Flush() {
	if e.flusher != nil {
		e.flusher.Flush()
	}
}

// ─────────────────────────────────────────────────────────────
// 2. NDJSON 协议编码器（面向 Go Sidecar 内部执行客户端）
// 格式规范：
// {"type":"chunk","delta":"...","kind":"content"}\n
// {"type":"chunk","delta":"...","kind":"reasoning"}\n
// {"type":"ping"}\n
// {"type":"done","ok":true,...}\n
// {"type":"error","ok":false,...}\n
// ─────────────────────────────────────────────────────────────

type NdjsonEncoder struct {
	w       io.Writer
	flusher http.Flusher
	mu      sync.Mutex
}

func NewNdjsonEncoder(w io.Writer, flusher http.Flusher) *NdjsonEncoder {
	return &NdjsonEncoder{w: newDeadlineWriter(w), flusher: flusher}
}

func (e *NdjsonEncoder) WriteTextDelta(text string) error {
	if text == "" {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	payload := map[string]any{
		"type":  "chunk",
		"delta": text,
		"kind":  "content",
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *NdjsonEncoder) WriteReasoningDelta(reasoning string) error {
	if reasoning == "" {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	payload := map[string]any{
		"type":  "chunk",
		"delta": reasoning,
		"kind":  "reasoning",
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *NdjsonEncoder) WriteToolCall(id, name string, args any) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	payload := map[string]any{
		"type":       "chunk",
		"kind":       "tool_call",
		"toolCallId": id,
		"toolName":   name,
		"args":       args,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *NdjsonEncoder) WriteFinish(finishReason string, usage StreamUsage) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	payload := map[string]any{
		"type":         "done",
		"ok":           true,
		"finishReason": finishReason,
		"usage": map[string]any{
			"promptTokens":     usage.PromptTokens,
			"completionTokens": usage.CompletionTokens,
			"totalTokens":      usage.TotalTokens,
		},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *NdjsonEncoder) WritePing() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if _, err := fmt.Fprintf(e.w, "{\"type\":\"ping\"}\n"); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *NdjsonEncoder) WriteError(code, message string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	payload := map[string]any{
		"type":    "error",
		"ok":      false,
		"code":    code,
		"message": message,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "%s\n", string(b)); err != nil {
		return err
	}
	e.Flush()
	return nil
}

func (e *NdjsonEncoder) Flush() {
	if e.flusher != nil {
		e.flusher.Flush()
	}
}

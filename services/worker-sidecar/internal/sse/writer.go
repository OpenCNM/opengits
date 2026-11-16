package sse

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Writer 封装高并发 Server-Sent Events 流式写入
type Writer struct {
	w       http.ResponseWriter
	flusher http.Flusher
	mu      sync.Mutex
	closed  bool
}

// SSEWriter 是 Writer 的别名，保持完全向前兼容
type SSEWriter = Writer

// NewWriter 初始化 SSE 响应头并检查 Flusher 支持
func NewWriter(w http.ResponseWriter) (*Writer, error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, fmt.Errorf("streaming unsupported: ResponseWriter does not implement http.Flusher")
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")

	sw := &Writer{
		w:       w,
		flusher: flusher,
	}

	return sw, nil
}

// NewSSEWriter 是 NewWriter 的别名，保持完全向前兼容
func NewSSEWriter(w http.ResponseWriter) (*Writer, error) {
	return NewWriter(w)
}

// writeTimeout 单次 SSE 帧与心跳写入截止时间（防止慢速死锁客户端与僵尸半开连接挂死协程）
const writeTimeout = 15 * time.Second

func (s *Writer) applyWriteDeadline() {
	rc := http.NewResponseController(s.w)
	_ = rc.SetWriteDeadline(time.Now().Add(writeTimeout))
}

// SendRetry 发送重连时间间隔指令（如 retry: 3000）
func (s *Writer) SendRetry(ms int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("sse writer closed")
	}

	s.applyWriteDeadline()
	_, err := fmt.Fprintf(s.w, "retry: %d\n\n", ms)
	if err == nil {
		s.flusher.Flush()
	} else {
		s.closed = true
	}
	return err
}

// SendComment 发送心跳注释帧（如 : ping 或 : heartbeat）
func (s *Writer) SendComment(comment string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("sse writer closed")
	}

	s.applyWriteDeadline()
	_, err := fmt.Fprintf(s.w, ": %s\n\n", comment)
	if err == nil {
		s.flusher.Flush()
	} else {
		s.closed = true
	}
	return err
}

// SendEvent 发送标准化 SSE 帧（遵从 WHATWG EventSource 规范，支持多行 data 帧拆分）
func (s *Writer) SendEvent(id string, event string, data any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("sse writer closed")
	}

	var payload []byte
	switch v := data.(type) {
	case []byte:
		payload = v
	case string:
		payload = []byte(v)
	default:
		b, err := json.Marshal(data)
		if err != nil {
			return fmt.Errorf("json marshal error: %w", err)
		}
		payload = b
	}

	var buf bytes.Buffer
	if id != "" {
		buf.WriteString("id: " + id + "\n")
	}
	if event != "" {
		buf.WriteString("event: " + event + "\n")
	}

	if len(payload) == 0 {
		buf.WriteString("data: \n\n")
	} else {
		lines := bytes.Split(payload, []byte("\n"))
		for _, line := range lines {
			buf.WriteString("data: ")
			buf.Write(line)
			buf.WriteByte('\n')
		}
		buf.WriteByte('\n')
	}

	s.applyWriteDeadline()
	_, err := s.w.Write(buf.Bytes())
	if err == nil {
		s.flusher.Flush()
	} else {
		s.closed = true
	}
	return err
}

// Close 标记关闭
func (s *Writer) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
}

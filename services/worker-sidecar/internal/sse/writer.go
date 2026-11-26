package sse

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type Writer struct {
	w       http.ResponseWriter
	flusher http.Flusher
	mu      sync.Mutex
	closed  bool
}

type SSEWriter = Writer

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

func NewSSEWriter(w http.ResponseWriter) (*Writer, error) {
	return NewWriter(w)
}

// Enforce per-write deadlines so slow or half-open clients cannot pin broadcaster goroutines.
const writeTimeout = 15 * time.Second

func (s *Writer) applyWriteDeadline() {
	rc := http.NewResponseController(s.w)
	_ = rc.SetWriteDeadline(time.Now().Add(writeTimeout))
}

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

func (s *Writer) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
}

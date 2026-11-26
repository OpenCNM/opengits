package jobs

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

type eventWriter struct {
	jobId           string
	store           QueueStore
	flushCount      int
	flushMs         int
	maxEventsPerJob int

	mu         sync.Mutex
	closeMu    sync.RWMutex
	buffer     []JobEventEntry
	seqCounter int
	flushed    int
	timer      *time.Timer
	closed     bool

	flushCh chan flushReq
	wg      sync.WaitGroup
}

type flushReq struct {
	batch []JobEventEntry
	done  chan error
}

func (w *eventWriter) sendReq(req flushReq) bool {
	w.closeMu.RLock()
	defer w.closeMu.RUnlock()
	if w.closed {
		if req.done != nil {
			req.done <- nil
		}
		return false
	}
	w.flushCh <- req
	return true
}

func newEventWriter(jobId string, store QueueStore, cfg Config) *eventWriter {
	flushCount := cfg.EventFlushCount
	if flushCount <= 0 {
		flushCount = 50
	}
	flushMs := cfg.EventFlushMs
	if flushMs <= 0 {
		flushMs = 300
	}
	maxEvents := cfg.MaxEventsPerJob
	if maxEvents <= 0 {
		maxEvents = 1000
	}
	w := &eventWriter{
		jobId:           jobId,
		store:           store,
		flushCount:      flushCount,
		flushMs:         flushMs,
		maxEventsPerJob: maxEvents,
		buffer:          make([]JobEventEntry, 0, flushCount),
		flushCh:         make(chan flushReq, 256),
	}
	w.wg.Add(1)
	go w.worker()
	return w
}

// Flush on a single FIFO worker so SSE cursors never observe out-of-order writes.
func (w *eventWriter) worker() {
	defer w.wg.Done()
	for req := range w.flushCh {
		if len(req.batch) == 0 {
			if req.done != nil {
				req.done <- nil
			}
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := w.store.InsertJobEvents(ctx, w.jobId, req.batch)
		cancel()
		if req.done != nil {
			req.done <- err
		}
		if err != nil {
			metrics.Inc("jobs.event_flush_failed")
			log.Printf("[job-event-writer] flush failed for job %s: %v", w.jobId, err)
		}
	}
}

func (w *eventWriter) Push(eventType string, payload map[string]any) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}

	// Never drop terminal done/error events under per-job storm throttling.
	if w.flushed+len(w.buffer) >= w.maxEventsPerJob && eventType != "done" && eventType != "error" {
		w.mu.Unlock()
		metrics.Inc("jobs.event_storm_dropped")
		return
	}

	entry := JobEventEntry{
		Seq:     w.seqCounter,
		Type:    eventType,
		Payload: payload,
	}
	w.seqCounter++
	w.buffer = append(w.buffer, entry)

	if len(w.buffer) >= w.flushCount {
		if w.timer != nil {
			w.timer.Stop()
			w.timer = nil
		}
		batchToSend := w.buffer
		w.buffer = make([]JobEventEntry, 0, w.flushCount)
		w.flushed += len(batchToSend)
		w.sendReq(flushReq{batch: batchToSend})
	} else if w.timer == nil {
		w.timer = time.AfterFunc(time.Duration(w.flushMs)*time.Millisecond, func() {
			var timerBatch []JobEventEntry
			w.mu.Lock()
			w.timer = nil
			if len(w.buffer) == 0 || w.closed {
				w.mu.Unlock()
				return
			}
			timerBatch = w.buffer
			w.buffer = make([]JobEventEntry, 0, w.flushCount)
			w.flushed += len(timerBatch)
			if len(timerBatch) > 0 {
				w.sendReq(flushReq{batch: timerBatch})
			}
			w.mu.Unlock()
		})
	}
	w.mu.Unlock()
}

func (w *eventWriter) Flush(ctx context.Context) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	batch := w.buffer
	w.buffer = make([]JobEventEntry, 0, w.flushCount)
	w.flushed += len(batch)
	w.mu.Unlock()

	if len(batch) == 0 {
		return nil
	}

	done := make(chan error, 1)
	w.closeMu.RLock()
	if w.closed {
		w.closeMu.RUnlock()
		return nil
	}
	select {
	case w.flushCh <- flushReq{batch: batch, done: done}:
		w.closeMu.RUnlock()
	case <-ctx.Done():
		w.closeMu.RUnlock()
		return ctx.Err()
	}

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *eventWriter) Close(ctx context.Context) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	batch := w.buffer
	w.buffer = nil
	w.flushed += len(batch)
	w.mu.Unlock()

	w.closeMu.Lock()
	if len(batch) > 0 {
		select {
		case w.flushCh <- flushReq{batch: batch}:
		case <-ctx.Done():
			close(w.flushCh)
			w.closeMu.Unlock()
			return ctx.Err()
		}
	}
	close(w.flushCh)
	w.closeMu.Unlock()

	waitCh := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(waitCh)
	}()

	select {
	case <-waitCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

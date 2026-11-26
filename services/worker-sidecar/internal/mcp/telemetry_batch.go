package mcp

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

// Drop telemetry on queue-full instead of backpressuring requests; quota ledger stays synchronous for limit accuracy.

var (
	telemetryQueueSize    = 4096
	telemetryBatchSize    = 500
	telemetryFlushTimeout = 500 * time.Millisecond
)

type telemetryBatcher struct {
	mu    sync.Mutex
	ch    chan CallLogEntry
	stop  chan struct{}
	done  chan struct{}
	flush func(entries []CallLogEntry)
}

func startTelemetryBatcher(flush func(entries []CallLogEntry)) *telemetryBatcher {
	b := &telemetryBatcher{
		ch:    make(chan CallLogEntry, telemetryQueueSize),
		stop:  make(chan struct{}),
		done:  make(chan struct{}),
		flush: flush,
	}
	go b.run()
	return b
}

func (b *telemetryBatcher) run() {
	defer close(b.done)
	buf := make([]CallLogEntry, 0, telemetryBatchSize)
	ticker := time.NewTicker(telemetryFlushTimeout)
	defer ticker.Stop()
	for {
		select {
		case e := <-b.ch:
			buf = append(buf, e)
			if len(buf) >= telemetryBatchSize {
				b.flush(buf)
				buf = buf[:0]
			}
		case <-ticker.C:
			if len(buf) > 0 {
				b.flush(buf)
				buf = buf[:0]
			}
		case <-b.stop:

			for {
				select {
				case e := <-b.ch:
					buf = append(buf, e)
					if len(buf) >= telemetryBatchSize {
						b.flush(buf)
						buf = buf[:0]
					}
				default:
					if len(buf) > 0 {
						b.flush(buf)
					}
					return
				}
			}
		}
	}
}

func (b *telemetryBatcher) enqueue(e CallLogEntry) {
	select {
	case b.ch <- e:
	default:
		metrics.Inc("mcp.telemetry_dropped")
	}
}

func (b *telemetryBatcher) Stop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	select {
	case <-b.stop:
		return
	default:
		close(b.stop)
	}
	<-b.done
}

func (s *pgxStore) startTelemetry() {
	s.batcher = startTelemetryBatcher(s.flushTelemetryBatch)
}

func (s *pgxStore) StopTelemetryBatcher() {
	if s == nil || s.batcher == nil {
		return
	}
	s.batcher.Stop()
}

func (s *pgxStore) flushTelemetryBatch(entries []CallLogEntry) {
	if len(entries) == 0 || s.pool == nil {
		return
	}
	metrics.Inc("mcp.telemetry_flush")

	type entryJSON struct {
		ToolName       string `json:"toolName"`
		UserID         string `json:"userId"`
		ClientName     string `json:"clientName"`
		RepositoryID   string `json:"repositoryId"`
		Dimension      string `json:"dimension"`
		Status         string `json:"status"`
		ResultCount    int    `json:"resultCount"`
		ResponseTimeMs int64  `json:"responseTimeMs"`
	}
	rows := make([]entryJSON, len(entries))
	counts := make(map[string]int, len(entries))
	for i, e := range entries {
		rows[i] = entryJSON{
			ToolName: e.ToolName, UserID: e.UserID, ClientName: e.ClientName,
			RepositoryID: e.RepositoryID, Dimension: e.Dimension, Status: e.Status,
			ResultCount: e.ResultCount, ResponseTimeMs: e.ResponseTimeMs,
		}
		if e.RepositoryID != "" {
			counts[e.RepositoryID]++
		}
	}
	entriesJSON, err := json.Marshal(rows)
	if err != nil {
		log.Printf("[mcp-telemetry] marshal entries failed: %v", err)
		return
	}
	incs := make([]map[string]any, 0, len(counts))
	for id, n := range counts {
		incs = append(incs, map[string]any{"id": id, "n": n})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	q := db.New(s.pool)
	if err := q.MCPInsertCallLogs(ctx, entriesJSON); err != nil {
		log.Printf("[mcp-telemetry] batch insert failed (%d entries): %v", len(entries), err)
	}
	if len(incs) > 0 {
		incsJSON, _ := json.Marshal(incs)
		if err := q.MCPIncrementRepoCallsBatch(ctx, incsJSON); err != nil {
			log.Printf("[mcp-telemetry] batch counter update failed (%d repos): %v", len(incs), err)
		}
	}
}

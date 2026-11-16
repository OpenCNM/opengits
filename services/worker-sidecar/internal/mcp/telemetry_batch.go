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

// ── 遥测批量写（写放大收敛）──
//
// 原实现：每次计量调用 spawn 一个 goroutine，串行两次 DB 往返
// （InsertCallLog + IncrementRepoCalls）——576 rps 饱和时约 1700+ 次零散写/秒。
// 现实现：InsertCallLog 变为非阻塞入队；后台 flusher 按「定量（500 条）或
// 定时（500ms）」聚合批量落库——调用日志一条 jsonb 批插，仓库计数在内存
// 聚合后一条 UPDATE。配额账本（LedgerIncrement）刻意保持同步：它是限流
// 语义而非遥测，且限流器已有进程内 delta 兜底。
//
// 丢弃红线：队列满即丢（计数进 metrics），绝不阻塞请求路径——遥测可丢，
// 请求不可等。硬停机至多损失一个 flush 窗口（500ms）内的条目，不劣于原
// per-call goroutine 的在途丢失面。

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
			// 优雅关闭：排空在途条目后落库
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

// enqueue 非阻塞入队；满则丢弃并计数（遥测永不反压请求）。
func (b *telemetryBatcher) enqueue(e CallLogEntry) {
	select {
	case b.ch <- e:
	default:
		metrics.Inc("mcp.telemetry_dropped")
	}
}

// Stop 优雅排空并终止（幂等）。
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

// startTelemetry 批量写启动钩子（构造函数调用）。
func (s *pgxStore) startTelemetry() {
	s.batcher = startTelemetryBatcher(s.flushTelemetryBatch)
}

// StopTelemetryBatcher 优雅关闭钩子（MCPServer.Shutdown 尽力调用）。
func (s *pgxStore) StopTelemetryBatcher() {
	if s == nil || s.batcher == nil {
		return
	}
	s.batcher.Stop()
}

// flushTelemetryBatch 批量落库：调用日志一条 jsonb 批插 + 仓库计数内存聚合后一条 UPDATE。
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

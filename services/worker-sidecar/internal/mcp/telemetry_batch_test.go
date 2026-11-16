package mcp

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 telemetryBatcher：定量触发 / 定时触发 / 满丢弃 / 优雅排空（table-driven 覆盖四象限）
func TestTelemetryBatcher(t *testing.T) {
	origTimeout := telemetryFlushTimeout
	telemetryFlushTimeout = 30 * time.Millisecond
	t.Cleanup(func() { telemetryFlushTimeout = origTimeout })

	entry := func(name string) CallLogEntry { return CallLogEntry{ToolName: name, RepositoryID: "r1"} }

	t.Run("定时触发：未达批量上限也按 flush 窗口落库", func(t *testing.T) {
		var mu sync.Mutex
		var flushed [][]CallLogEntry
		b := startTelemetryBatcher(func(es []CallLogEntry) {
			cp := make([]CallLogEntry, len(es))
			copy(cp, es)
			mu.Lock()
			flushed = append(flushed, cp)
			mu.Unlock()
		})
		t.Cleanup(b.Stop)
		b.enqueue(entry("a"))
		require.Eventually(t, func() bool {
			mu.Lock()
			defer mu.Unlock()
			return len(flushed) == 1 && flushed[0][0].ToolName == "a"
		}, 2*time.Second, 5*time.Millisecond)
	})

	t.Run("定量触发：达到批量上限立即 flush 不等窗口", func(t *testing.T) {
		origSize := telemetryBatchSize
		telemetryBatchSize = 3
		t.Cleanup(func() { telemetryBatchSize = origSize })

		var mu sync.Mutex
		var flushed [][]CallLogEntry
		b := startTelemetryBatcher(func(es []CallLogEntry) {
			cp := make([]CallLogEntry, len(es))
			copy(cp, es)
			mu.Lock()
			flushed = append(flushed, cp)
			mu.Unlock()
		})
		t.Cleanup(b.Stop)
		for i := 0; i < 3; i++ {
			b.enqueue(entry("e"))
		}
		require.Eventually(t, func() bool {
			mu.Lock()
			defer mu.Unlock()
			return len(flushed) == 1 && len(flushed[0]) == 3
		}, 2*time.Second, 2*time.Millisecond)
	})

	t.Run("满丢弃：队列打满后 enqueue 不阻塞（超时即证明）", func(t *testing.T) {
		// 不启动消费的 flusher：用极小队列验证非阻塞语义
		small := telemetryQueueSize
		telemetryQueueSize = 2
		b := &telemetryBatcher{ch: make(chan CallLogEntry, telemetryQueueSize)}
		telemetryQueueSize = small
		b.enqueue(entry("x"))
		b.enqueue(entry("x"))
		done := make(chan struct{})
		go func() {
			b.enqueue(entry("overflow")) // 队列已满：必须立即丢弃返回
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(500 * time.Millisecond):
			t.Fatal("enqueue 在队列满时阻塞了——遥测丢弃红线被违反")
		}
	})

	t.Run("优雅关闭：Stop 前排空在途条目", func(t *testing.T) {
		var mu sync.Mutex
		var flushed [][]CallLogEntry
		b := startTelemetryBatcher(func(es []CallLogEntry) {
			mu.Lock()
			flushed = append(flushed, es)
			mu.Unlock()
		})
		b.enqueue(entry("drain-me"))
		b.Stop()
		b.Stop() // 幂等
		mu.Lock()
		defer mu.Unlock()
		total := 0
		for _, es := range flushed {
			total += len(es)
		}
		assert.GreaterOrEqual(t, total, 1, "Stop 必须排空在途条目")
	})

	t.Run("pgxStore 钩子：nil batcher 的 Stop 不 panic", func(t *testing.T) {
		s := &pgxStore{}
		assert.NotPanics(t, s.StopTelemetryBatcher)
		assert.NotPanics(t, func() { _ = s.InsertCallLog(context.Background(), CallLogEntry{}) })
	})
}

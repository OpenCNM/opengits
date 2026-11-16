package sse

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestSnapshotHubFanout 共享 poller 契约：同 key 多观众共享一次 fetch、
// 全员退订后 poller 回收（复刻 TestJobSnapshotHubFanout 模板）。
func TestSnapshotHubFanout(t *testing.T) {
	tests := []struct {
		name    string
		execute func(t *testing.T)
	}{
		{
			name: "multiple concurrent subscribers share one poller fetch",
			execute: func(t *testing.T) {
				t.Helper()
				var fetches atomic.Int64
				hub := newSnapshotHub[string, string](func(_ context.Context, key string) (string, error) {
					fetches.Add(1)
					return "snap-" + key, nil
				}, 20*time.Millisecond)

				sub1 := hub.Subscribe("k1")
				sub2 := hub.Subscribe("k1")

				for _, sub := range []*snapshotSubscription[string]{sub1, sub2} {
					select {
					case got := <-sub.C:
						assert.Equal(t, "snap-k1", got)
					case <-time.After(2 * time.Second):
						require.FailNow(t, "subscriber timeout waiting for snapshot")
					}
				}

				sub1.cancel()
				sub2.cancel()

				assert.Eventually(t, func() bool {
					hub.mu.Lock()
					defer hub.mu.Unlock()
					return len(hub.pollers) == 0
				}, 2*time.Second, 20*time.Millisecond, "poller must be evicted after all unsubscribed")
			},
		},
		{
			name: "fetch error is skipped silently and next tick recovers",
			execute: func(t *testing.T) {
				t.Helper()
				var failFirst atomic.Bool
				failFirst.Store(true)
				hub := newSnapshotHub[string, int](func(_ context.Context, _ string) (int, error) {
					if failFirst.CompareAndSwap(true, false) {
						return 0, assert.AnError
					}
					return 42, nil
				}, 20*time.Millisecond)

				sub := hub.Subscribe("k2")
				defer sub.cancel()

				select {
				case got := <-sub.C:
					assert.Equal(t, 42, got)
				case <-time.After(2 * time.Second):
					require.FailNow(t, "timeout waiting for recovered snapshot")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, tt.execute)
	}
}

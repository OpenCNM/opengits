package metrics

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMetrics(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T)
	}{
		{name: "Inc 与首次引用注册", run: func(t *testing.T) {
			assert.Equal(t, uint64(0), Get("test.absent"))
			Inc("test.counter")
			Inc("test.counter")
			Add("test.counter", 8)
			assert.Equal(t, uint64(10), Get("test.counter"))
		}},
		{name: "标签展开", run: func(t *testing.T) {
			IncLabel("test.kind", "skipped")
			IncLabel("test.kind", "skipped")
			IncLabel("test.kind", "fallback")
			assert.Equal(t, uint64(2), Get("test.kind{skipped}"))
			assert.Equal(t, uint64(1), Get("test.kind{fallback}"))
		}},
		{name: "Snapshot 确定性", run: func(t *testing.T) {
			Inc("test.snap.b")
			Inc("test.snap.a")
			snap := Snapshot()
			require.Contains(t, snap, "test.snap.a")
			require.Contains(t, snap, "test.snap.b")
		}},
		{name: "并发自增无丢失", run: func(t *testing.T) {
			const workers = 16
			const each = 1000
			var wg sync.WaitGroup
			for i := 0; i < workers; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for j := 0; j < each; j++ {
						Inc("test.race")
					}
				}()
			}
			wg.Wait()
			assert.Equal(t, uint64(workers*each), Get("test.race"))
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, tt.run)
	}
}

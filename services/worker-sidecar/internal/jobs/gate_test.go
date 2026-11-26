package jobs

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockMemoryObserver struct {
	limit uint64
	usage uint64
}

func (m *mockMemoryObserver) GetMemoryLimit() (uint64, error) {
	return m.limit, nil
}

func (m *mockMemoryObserver) GetMemoryUsage() (uint64, error) {
	return m.usage, nil
}

func TestCalculateJobWeight(t *testing.T) {
	gate := NewMemoryGate(MemoryGateConfig{
		ReservedHeadroomBytes: 512 * 1024 * 1024,
		TokenUnitBytes:        128 * 1024 * 1024,
		MinCapacityTokens:     4,
		MaxCapacityTokens:     32,
		HighWatermarkRatio:    0.85,
		StarvationThreshold:   15 * time.Second,
	}, &mockMemoryObserver{limit: 2 * 1024 * 1024 * 1024})

	tests := []struct {
		name       string
		nodes      int
		isCode     bool
		wantWeight int
	}{
		{name: "zero nodes code", nodes: 0, isCode: true, wantWeight: 1},
		{name: "boundary S lower code", nodes: 50, isCode: true, wantWeight: 1},
		{name: "boundary S upper code", nodes: 149, isCode: true, wantWeight: 1},
		{name: "boundary M lower code", nodes: 150, isCode: true, wantWeight: 2},
		{name: "boundary M middle code", nodes: 500, isCode: true, wantWeight: 2},
		{name: "boundary M upper code", nodes: 999, isCode: true, wantWeight: 2},
		{name: "boundary L lower code", nodes: 1000, isCode: true, wantWeight: 4},
		{name: "boundary L upper code", nodes: 4999, isCode: true, wantWeight: 4},
		{name: "boundary XL lower code", nodes: 5000, isCode: true, wantWeight: 8},
		{name: "giant repo code", nodes: 20000, isCode: true, wantWeight: 8},

		{name: "small text repo", nodes: 100, isCode: false, wantWeight: 1},
		{name: "medium text repo", nodes: 500, isCode: false, wantWeight: 1},
		{name: "large text repo", nodes: 2000, isCode: false, wantWeight: 2},
		{name: "giant text repo", nodes: 10000, isCode: false, wantWeight: 4},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := gate.CalculateJobWeight(tt.nodes, tt.isCode)
			assert.Equal(t, tt.wantWeight, got)
		})
	}
}

func TestMemoryGate_CapacityCalculation(t *testing.T) {
	tests := []struct {
		name         string
		limitMB      uint64
		headroomMB   uint64
		unitMB       uint64
		minTokens    int
		maxTokens    int
		wantCapacity int
	}{
		{
			name:         "1GB memory container",
			limitMB:      1024,
			headroomMB:   512,
			unitMB:       128,
			minTokens:    4,
			maxTokens:    32,
			wantCapacity: 4,
		},
		{
			name:         "2GB memory container",
			limitMB:      2048,
			headroomMB:   512,
			unitMB:       128,
			minTokens:    4,
			maxTokens:    32,
			wantCapacity: 12,
		},
		{
			name:         "4GB memory machine",
			limitMB:      4096,
			headroomMB:   512,
			unitMB:       128,
			minTokens:    4,
			maxTokens:    32,
			wantCapacity: 28,
		},
		{
			name:         "small container clamp to minTokens",
			limitMB:      512,
			headroomMB:   512,
			unitMB:       128,
			minTokens:    4,
			maxTokens:    32,
			wantCapacity: 4,
		},
		{
			name:         "huge machine clamp to maxTokens",
			limitMB:      16384,
			headroomMB:   512,
			unitMB:       128,
			minTokens:    4,
			maxTokens:    16,
			wantCapacity: 16,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := MemoryGateConfig{
				ReservedHeadroomBytes: tt.headroomMB * 1024 * 1024,
				TokenUnitBytes:        tt.unitMB * 1024 * 1024,
				MinCapacityTokens:     tt.minTokens,
				MaxCapacityTokens:     tt.maxTokens,
				HighWatermarkRatio:    0.85,
			}
			gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: tt.limitMB * 1024 * 1024})
			assert.Equal(t, tt.wantCapacity, gate.TotalCapacity())
		})
	}
}

func TestMemoryGate_AcquireAndRelease(t *testing.T) {
	cfg := MemoryGateConfig{
		ReservedHeadroomBytes: 512 * 1024 * 1024,
		TokenUnitBytes:        128 * 1024 * 1024,
		MinCapacityTokens:     4,
		MaxCapacityTokens:     4,
		HighWatermarkRatio:    0.85,
		StarvationThreshold:   10 * time.Second,
	}
	gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: 1024 * 1024 * 1024})
	require.Equal(t, 4, gate.TotalCapacity())
	require.Equal(t, 4, gate.AvailableTokens())

	ctx := context.Background()

	err := gate.Acquire(ctx, 2)
	require.NoError(t, err)
	assert.Equal(t, 2, gate.UsedTokens())
	assert.Equal(t, 2, gate.AvailableTokens())

	err = gate.Acquire(ctx, 2)
	require.NoError(t, err)
	assert.Equal(t, 4, gate.UsedTokens())
	assert.Equal(t, 0, gate.AvailableTokens())

	var acquired int32
	go func() {
		wErr := gate.Acquire(ctx, 1)
		if wErr == nil {
			atomic.StoreInt32(&acquired, 1)
		}
	}()

	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&acquired), "满载时应该阻塞")

	gate.Release(2)

	assert.Eventually(t, func() bool {
		return atomic.LoadInt32(&acquired) == 1
	}, 1*time.Second, 20*time.Millisecond, "释放后排队协程应该获得准入")

	assert.Equal(t, 3, gate.UsedTokens())

	gate.Release(2)
	gate.Release(1)
	assert.Equal(t, 0, gate.UsedTokens())
	assert.Equal(t, 4, gate.AvailableTokens())
}

func TestMemoryGate_ContextCancellation(t *testing.T) {
	cfg := MemoryGateConfig{
		MinCapacityTokens:   2,
		MaxCapacityTokens:   2,
		HighWatermarkRatio:  0.85,
		StarvationThreshold: 10 * time.Second,
	}
	gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: 512 * 1024 * 1024})

	ctx := context.Background()
	err := gate.Acquire(ctx, 2)
	require.NoError(t, err)

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	err = gate.Acquire(timeoutCtx, 1)
	elapsed := time.Since(start)

	assert.ErrorIs(t, err, context.DeadlineExceeded)
	assert.True(t, elapsed >= 50*time.Millisecond)

	gate.Release(2)
	assert.Equal(t, 0, gate.UsedTokens())
}

func TestMemoryGate_AntiStarvation(t *testing.T) {
	cfg := MemoryGateConfig{
		MinCapacityTokens:   4,
		MaxCapacityTokens:   4,
		HighWatermarkRatio:  0.85,
		StarvationThreshold: 100 * time.Millisecond,
	}
	gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: 1024 * 1024 * 1024})

	ctx := context.Background()
	require.NoError(t, gate.Acquire(ctx, 4))

	var bigJobAcquired int32
	go func() {
		if err := gate.Acquire(ctx, 4); err == nil {
			atomic.StoreInt32(&bigJobAcquired, 1)
		}
	}()

	time.Sleep(150 * time.Millisecond)

	var smallJobAcquired int32
	go func() {
		if err := gate.Acquire(ctx, 1); err == nil {
			atomic.StoreInt32(&smallJobAcquired, 1)
		}
	}()

	time.Sleep(50 * time.Millisecond)

	gate.Release(2)

	time.Sleep(100 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&smallJobAcquired), "大仓饥饿蓄能期间，小仓不得插队")
	assert.Equal(t, int32(0), atomic.LoadInt32(&bigJobAcquired), "大仓需要 4 Tokens，目前只有 2，继续等待")

	gate.Release(2)

	assert.Eventually(t, func() bool {
		return atomic.LoadInt32(&bigJobAcquired) == 1
	}, 1*time.Second, 20*time.Millisecond, "大仓凑齐容量后应该优先准入")

	gate.Release(4)
	assert.Eventually(t, func() bool {
		return atomic.LoadInt32(&smallJobAcquired) == 1
	}, 1*time.Second, 20*time.Millisecond, "大仓释放后，小仓准入")

	gate.Release(1)
	assert.Equal(t, 0, gate.UsedTokens())
}

func TestMemoryGate_HighWatermark(t *testing.T) {
	mockObs := &mockMemoryObserver{
		limit: 1000 * 1024 * 1024,
		usage: 500 * 1024 * 1024,
	}
	cfg := MemoryGateConfig{
		MinCapacityTokens:  4,
		MaxCapacityTokens:  4,
		HighWatermarkRatio: 0.80,
	}
	gate := NewMemoryGate(cfg, mockObs)

	assert.False(t, gate.IsHighWatermark())
	assert.Equal(t, 4, gate.ClaimableSlots(0))

	mockObs.usage = 850 * 1024 * 1024
	gate.refreshSampleForced()
	assert.True(t, gate.IsHighWatermark())
	assert.Equal(t, 0, gate.ClaimableSlots(0), "高水位时 ClaimableSlots 应该降为 0 暂停认领")
}

func TestMemoryGate_SingleGiantJobCapacityCap(t *testing.T) {
	cfg := MemoryGateConfig{
		MinCapacityTokens: 4,
		MaxCapacityTokens: 4,
	}
	gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: 1024 * 1024 * 1024})

	ctx := context.Background()
	err := gate.Acquire(ctx, 8)
	require.NoError(t, err)
	assert.Equal(t, 4, gate.UsedTokens())

	gate.Release(8)
	assert.Equal(t, 0, gate.UsedTokens())
}

func TestMemoryGate_ConcurrentStress(t *testing.T) {
	cfg := MemoryGateConfig{
		MinCapacityTokens:  8,
		MaxCapacityTokens:  8,
		HighWatermarkRatio: 0.90,
	}
	gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: 2048 * 1024 * 1024})

	var wg sync.WaitGroup
	workers := 20
	iterations := 10

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			weight := (workerID % 3) + 1
			for j := 0; j < iterations; j++ {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				err := gate.Acquire(ctx, weight)
				if err == nil {
					used := gate.UsedTokens()
					assert.True(t, used <= gate.TotalCapacity(), "并发期间已用 Tokens 突破总容量: %d > %d", used, gate.TotalCapacity())
					time.Sleep(5 * time.Millisecond)
					gate.Release(weight)
				}
				cancel()
			}
		}(i)
	}

	wg.Wait()
	assert.Equal(t, 0, gate.UsedTokens())
}

func TestMemoryGate_CancelAdmitRaceNoTokenLeak(t *testing.T) {
	cfg := MemoryGateConfig{
		MinCapacityTokens:   2,
		MaxCapacityTokens:   2,
		HighWatermarkRatio:  0.85,
		StarvationThreshold: time.Hour,
	}
	gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: 512 * 1024 * 1024})
	bg := context.Background()

	const iterations = 500
	for i := 0; i < iterations; i++ {
		require.NoError(t, gate.Acquire(bg, 2), "iter %d: gate must be fillable — leak detected above", i)

		ctx, cancel := context.WithCancel(bg)
		errCh := make(chan error, 1)
		go func() { errCh <- gate.Acquire(ctx, 1) }()

		require.Eventually(t, func() bool {
			gate.mu.Lock()
			defer gate.mu.Unlock()
			return len(gate.waiters) == 1
		}, 2*time.Second, 100*time.Microsecond, "iter %d: waiter never queued", i)

		cancel()
		gate.Release(2)

		select {
		case err := <-errCh:
			if err == nil {
				gate.Release(1)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("iter %d: Acquire neither admitted nor cancelled — gate deadlock from leaked tokens", i)
		}

		gate.mu.Lock()
		used := gate.usedTokens
		waiters := len(gate.waiters)
		gate.mu.Unlock()
		require.Zerof(t, used, "iter %d: token leaked (used=%d)", i, used)
		require.Zerof(t, waiters, "iter %d: waiter leaked", i)
	}
}

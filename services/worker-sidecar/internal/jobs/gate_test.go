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

		// 纯文档仓：降权 50% 且保底 1
		{name: "small text repo", nodes: 100, isCode: false, wantWeight: 1},
		{name: "medium text repo", nodes: 500, isCode: false, wantWeight: 1},  // 2 / 2 = 1
		{name: "large text repo", nodes: 2000, isCode: false, wantWeight: 2},  // 4 / 2 = 2
		{name: "giant text repo", nodes: 10000, isCode: false, wantWeight: 4}, // 8 / 2 = 4
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
			wantCapacity: 4, // (1024-512)/128 = 4
		},
		{
			name:         "2GB memory container",
			limitMB:      2048,
			headroomMB:   512,
			unitMB:       128,
			minTokens:    4,
			maxTokens:    32,
			wantCapacity: 12, // (2048-512)/128 = 12
		},
		{
			name:         "4GB memory machine",
			limitMB:      4096,
			headroomMB:   512,
			unitMB:       128,
			minTokens:    4,
			maxTokens:    32,
			wantCapacity: 28, // (4096-512)/128 = 28
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
	// 512MB headroom, 128MB unit, 1024MB limit -> 4 Tokens total
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

	// 1. 申请 2 Tokens
	err := gate.Acquire(ctx, 2)
	require.NoError(t, err)
	assert.Equal(t, 2, gate.UsedTokens())
	assert.Equal(t, 2, gate.AvailableTokens())

	// 2. 再申请 2 Tokens，达到上限 4
	err = gate.Acquire(ctx, 2)
	require.NoError(t, err)
	assert.Equal(t, 4, gate.UsedTokens())
	assert.Equal(t, 0, gate.AvailableTokens())

	// 3. 异步尝试申请 1 Token，当前满载应该阻塞
	var acquired int32
	go func() {
		wErr := gate.Acquire(ctx, 1)
		if wErr == nil {
			atomic.StoreInt32(&acquired, 1)
		}
	}()

	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&acquired), "满载时应该阻塞")

	// 4. 释放 2 Tokens，被阻塞的协程应该被成功唤醒
	gate.Release(2)

	assert.Eventually(t, func() bool {
		return atomic.LoadInt32(&acquired) == 1
	}, 1*time.Second, 20*time.Millisecond, "释放后排队协程应该获得准入")

	// 当前已使用：原有 2 + 新增 1 = 3
	assert.Equal(t, 3, gate.UsedTokens())

	// 释放剩下的
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
	// 先占满 2 个 Tokens
	err := gate.Acquire(ctx, 2)
	require.NoError(t, err)

	// 带超时的 context 尝试申请
	timeoutCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	err = gate.Acquire(timeoutCtx, 1)
	elapsed := time.Since(start)

	assert.ErrorIs(t, err, context.DeadlineExceeded)
	assert.True(t, elapsed >= 50*time.Millisecond)

	// 验证超时的任务从队列清理，释放后状态干净
	gate.Release(2)
	assert.Equal(t, 0, gate.UsedTokens())
}

func TestMemoryGate_AntiStarvation(t *testing.T) {
	// 容量 4
	cfg := MemoryGateConfig{
		MinCapacityTokens:   4,
		MaxCapacityTokens:   4,
		HighWatermarkRatio:  0.85,
		StarvationThreshold: 100 * time.Millisecond, // 快速模拟饥饿
	}
	gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: 1024 * 1024 * 1024})

	ctx := context.Background()
	// 先占满 4 Tokens
	require.NoError(t, gate.Acquire(ctx, 4))

	// 队首：一个大仓申请 4 Tokens，进入阻塞等待
	var bigJobAcquired int32
	go func() {
		if err := gate.Acquire(ctx, 4); err == nil {
			atomic.StoreInt32(&bigJobAcquired, 1)
		}
	}()

	// 等待让大仓排在队首并超过饥饿阈值
	time.Sleep(150 * time.Millisecond)

	// 此时尝试插入一个小仓（权重 1）
	var smallJobAcquired int32
	go func() {
		if err := gate.Acquire(ctx, 1); err == nil {
			atomic.StoreInt32(&smallJobAcquired, 1)
		}
	}()

	time.Sleep(50 * time.Millisecond)

	// 释放 2 个 Token（当前剩余 2，不足大仓的 4，但足够小仓的 1）
	gate.Release(2)

	// 因为大仓已饥饿触发防饥饿排空模式，小仓禁止抢占放行！
	time.Sleep(100 * time.Millisecond)
	assert.Equal(t, int32(0), atomic.LoadInt32(&smallJobAcquired), "大仓饥饿蓄能期间，小仓不得插队")
	assert.Equal(t, int32(0), atomic.LoadInt32(&bigJobAcquired), "大仓需要 4 Tokens，目前只有 2，继续等待")

	// 再释放 2 个 Token（凑齐 4 Tokens）
	gate.Release(2)

	// 大仓应该成功被放行
	assert.Eventually(t, func() bool {
		return atomic.LoadInt32(&bigJobAcquired) == 1
	}, 1*time.Second, 20*time.Millisecond, "大仓凑齐容量后应该优先准入")

	// 此时大仓占满了 4 Tokens，小仓继续等；大仓释放后小仓才准入
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
		usage: 500 * 1024 * 1024, // 50%
	}
	cfg := MemoryGateConfig{
		MinCapacityTokens:  4,
		MaxCapacityTokens:  4,
		HighWatermarkRatio: 0.80, // 80%
	}
	gate := NewMemoryGate(cfg, mockObs)

	assert.False(t, gate.IsHighWatermark())
	assert.Equal(t, 4, gate.ClaimableSlots(0))

	// 模拟内存突破高水位（水位判定走 ≤500ms 采样，测试显式强制刷新）
	mockObs.usage = 850 * 1024 * 1024 // 85% > 80%
	gate.refreshSampleForced()
	assert.True(t, gate.IsHighWatermark())
	assert.Equal(t, 0, gate.ClaimableSlots(0), "高水位时 ClaimableSlots 应该降为 0 暂停认领")
}

func TestMemoryGate_SingleGiantJobCapacityCap(t *testing.T) {
	// 系统容量为 4，但是来了一个需要 8 Tokens 的超巨型任务
	// 验证三大红线之“能力不倒退”：权重被收敛为 4，单仓独占整机顺利跑完，绝不拒收报错
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
	// 高并发多协程竞争测试
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
			weight := (workerID % 3) + 1 // 权重 1, 2, 3
			for j := 0; j < iterations; j++ {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				err := gate.Acquire(ctx, weight)
				if err == nil {
					// 临界区验证：已使用 Tokens 任何时刻绝不超出容量上限
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

// 竞态回退回归：ctx 取消与 scheduleNextLocked 放行同时就绪时，Acquire 的
// select 随机选中取消分支——旧实现 token 已记账却无人 Release，容量慢性
// 泄漏直至闸门死锁。500 轮 50/50 随机足够覆盖该窗口。
func TestMemoryGate_CancelAdmitRaceNoTokenLeak(t *testing.T) {
	cfg := MemoryGateConfig{
		MinCapacityTokens:   2,
		MaxCapacityTokens:   2,
		HighWatermarkRatio:  0.85,
		StarvationThreshold: time.Hour, // 关闭防饥饿排空，聚焦常态准入路径
	}
	gate := NewMemoryGate(cfg, &mockMemoryObserver{limit: 512 * 1024 * 1024})
	bg := context.Background()

	const iterations = 500
	for i := 0; i < iterations; i++ {
		require.NoError(t, gate.Acquire(bg, 2), "iter %d: gate must be fillable — leak detected above", i)

		ctx, cancel := context.WithCancel(bg)
		errCh := make(chan error, 1)
		go func() { errCh <- gate.Acquire(ctx, 1) }()

		// 等 waiter 真正入队（闸门已满，不会被提前放行）
		require.Eventually(t, func() bool {
			gate.mu.Lock()
			defer gate.mu.Unlock()
			return len(gate.waiters) == 1
		}, 2*time.Second, 100*time.Microsecond, "iter %d: waiter never queued", i)

		// 先取消、再释放：两通道同时就绪，Acquire 内 select 50/50 随机
		cancel()
		gate.Release(2)

		select {
		case err := <-errCh:
			if err == nil {
				gate.Release(1) // ready 分支胜出：调用方正常持有后归还
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

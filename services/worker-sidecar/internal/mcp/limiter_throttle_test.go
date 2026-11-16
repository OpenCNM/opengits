package mcp

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// throttleFakeStore 计数两种记账形态（单增/批量增），可控失败；
// 嵌入 fakeStore 补齐 Store 接口其余面
type throttleFakeStore struct {
	*fakeStore
	mu        sync.Mutex
	batches   []int
	failBatch bool
}

func (f *throttleFakeStore) LedgerIncrement(ctx context.Context, userID, day string) error {
	return nil // 记账走 By 路径；单增留位给失败断言
}

func (f *throttleFakeStore) LedgerIncrementBy(_ context.Context, _, _ string, n int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failBatch {
		return errors.New("db down")
	}
	f.batches = append(f.batches, n)
	return nil
}

func (f *throttleFakeStore) batchSum() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := 0
	for _, n := range f.batches {
		s += n
	}
	return s
}

// 🧪 账本持久化节流：首刷立即 / 窗口合并 / 失败回滚重试 / 优雅排空
func TestLedgerPersistThrottle(t *testing.T) {
	orig := ledgerPersistInterval
	ledgerPersistInterval = 80 * time.Millisecond
	t.Cleanup(func() { ledgerPersistInterval = orig })

	day := "2026-10-13"

	t.Run("首个请求立即落账，窗口内后续合并", func(t *testing.T) {
		store := &throttleFakeStore{fakeStore: newFakeStore()}
		r := NewRateLimiter(store)
		r.persistLedgerThrottled(context.Background(), "u1", day)
		assert.Equal(t, 1, store.batchSum(), "首刷必须立即持久化（与旧行为观测面一致）")
		// 窗口内再记 5 笔：不落库
		for i := 0; i < 5; i++ {
			r.persistLedgerThrottled(context.Background(), "u1", day)
		}
		assert.Equal(t, 1, store.batchSum(), "窗口内不得重复落账")
		time.Sleep(120 * time.Millisecond)
		r.persistLedgerThrottled(context.Background(), "u1", day)
		require.Eventually(t, func() bool { return store.batchSum() == 7 }, time.Second, 5*time.Millisecond,
			"窗口到期后应把累积的 5 笔 + 触发笔一次性增量落账（1 首刷 + 6 快照 = 7）")
	})

	t.Run("失败回滚：DB 故障时计数不丢，恢复后重试", func(t *testing.T) {
		store := &throttleFakeStore{fakeStore: newFakeStore(), failBatch: true}
		r := NewRateLimiter(store)
		r.persistLedgerThrottled(context.Background(), "u2", day)
		assert.Equal(t, 0, store.batchSum())
		time.Sleep(100 * time.Millisecond)
		store.mu.Lock()
		store.failBatch = false
		store.mu.Unlock()
		r.persistLedgerThrottled(context.Background(), "u2", day)
		require.Eventually(t, func() bool { return store.batchSum() == 2 }, time.Second, 5*time.Millisecond,
			"失败的 1 笔必须回滚 pending，与恢复后的新 1 笔一并落库")
	})

	t.Run("FlushPending 排空在途增量", func(t *testing.T) {
		store := &throttleFakeStore{fakeStore: newFakeStore()}
		r := NewRateLimiter(store)
		r.persistLedgerThrottled(context.Background(), "u3", day) // 首刷
		for i := 0; i < 3; i++ {
			r.persistLedgerThrottled(context.Background(), "u3", day) // pending
		}
		r.FlushPending()
		assert.Equal(t, 4, store.batchSum(), "优雅关闭必须排空 pending")
	})

	t.Run("无批量接口的替身回落为单增循环", func(t *testing.T) {
		minimal := &singlesOnlyStore{fakeStore: newFakeStore()}
		r := NewRateLimiter(minimal)
		r.persistLedgerThrottled(context.Background(), "u4", day)
		assert.Equal(t, 1, minimal.count, "回落路径应逐笔单增（观测面与旧实现一致）")
	})
}

type singlesOnlyStore struct {
	*fakeStore
	count int
}

func (s *singlesOnlyStore) LedgerIncrement(_ context.Context, _, _ string) error {
	s.count++
	return nil
}

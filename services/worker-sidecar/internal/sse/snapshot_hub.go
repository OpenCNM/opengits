package sse

import (
	"context"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────
// 泛型 keyed 快照多路复用总线。
//
// 生命周期模型复刻 JobSnapshotHub（同 key 多观众共享一条 poller、
// 最后观众退订即停、广播满缓冲丢弃等下轮），但无需终态宽限——
// 供 MCP 活跃客户端流 / 通知流 / repo ingest 流接入：此前三条流
// 每连接独立轮询 DB，同 key 的 N 个观众产生 N×重复查询。
// 快照 diff 判定保留在各 handler（每观众持自己的 last 快照比较）。
// ─────────────────────────────────────────────────────────────

// snapshotSubscription 单观众订阅项。
type snapshotSubscription[S any] struct {
	C      chan S
	cancel func()
}

// snapshotPoller 单 key 的共享轮询器。
type snapshotPoller[K comparable, S any] struct {
	key         K
	subscribers map[chan S]struct{}
	stopCh      chan struct{}
}

// snapshotHub 泛型 keyed 快照总线。
type snapshotHub[K comparable, S any] struct {
	fetch    func(ctx context.Context, key K) (S, error)
	interval time.Duration

	mu      sync.Mutex
	pollers map[K]*snapshotPoller[K, S]
}

func newSnapshotHub[K comparable, S any](fetch func(ctx context.Context, key K) (S, error), interval time.Duration) *snapshotHub[K, S] {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	return &snapshotHub[K, S]{
		fetch:    fetch,
		interval: interval,
		pollers:  make(map[K]*snapshotPoller[K, S]),
	}
}

// Subscribe 订阅指定 key 的共享快照流（无则启动 poller）。
func (h *snapshotHub[K, S]) Subscribe(key K) *snapshotSubscription[S] {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch := make(chan S, 16)
	poller, exists := h.pollers[key]
	if !exists {
		poller = &snapshotPoller[K, S]{
			key:         key,
			subscribers: make(map[chan S]struct{}),
			stopCh:      make(chan struct{}),
		}
		h.pollers[key] = poller
		go h.runPoller(poller)
	}

	poller.subscribers[ch] = struct{}{}

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(poller.subscribers, ch)
			empty := len(poller.subscribers) == 0
			if empty && h.pollers[key] == poller {
				delete(h.pollers, key)
			}
			h.mu.Unlock()
			if empty {
				select {
				case <-poller.stopCh:
				default:
					close(poller.stopCh)
				}
			}
		})
	}

	return &snapshotSubscription[S]{C: ch, cancel: cancel}
}

func (h *snapshotHub[K, S]) runPoller(p *snapshotPoller[K, S]) {
	ticker := time.NewTicker(h.interval)
	defer ticker.Stop()

	for {
		select {
		case <-p.stopCh:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			snap, err := h.fetch(ctx, p.key)
			cancel()
			if err != nil {
				continue // 查询失败静默跳过，等下轮（与每连接轮询行为一致）
			}
			h.broadcast(p, snap)
		}
	}
}

func (h *snapshotHub[K, S]) broadcast(p *snapshotPoller[K, S], snap S) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range p.subscribers {
		select {
		case ch <- snap:
		default:
			// 观众缓冲满时跳过，依赖观众自己的 diff/last 追平
		}
	}
}

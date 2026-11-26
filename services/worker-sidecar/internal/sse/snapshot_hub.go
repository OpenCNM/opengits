package sse

import (
	"context"
	"sync"
	"time"
)

type snapshotSubscription[S any] struct {
	C      chan S
	cancel func()
}

type snapshotPoller[K comparable, S any] struct {
	key         K
	subscribers map[chan S]struct{}
	stopCh      chan struct{}
}

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
				continue
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
			// Drop frames for slow subscribers; per-subscriber diff state catches up on the next tick.
		}
	}
}

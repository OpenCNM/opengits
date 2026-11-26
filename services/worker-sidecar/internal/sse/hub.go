package sse

import (
	"context"
	"sync"
	"time"
)

type JobSnapshotBundle struct {
	Job           *ImportJobSnapshot
	QueuePosition int
	Events        []ImportJobEventDTO
	Err           error
}

type JobSubscription struct {
	C      chan *JobSnapshotBundle
	cancel func()
}

type JobSnapshotHub struct {
	store Store
	mu    sync.Mutex
	jobs  map[string]*jobPoller

	queuedRankMu    sync.Mutex
	queuedRankMap   map[time.Time]int
	queuedRankBuilt time.Time
}

const queuedRankTTL = 1 * time.Second

// Cache global queued-rank map for 1s across all pollers to avoid N per-job COUNT queries per second.
func (h *JobSnapshotHub) queuedPosition(ctx context.Context, createdAt time.Time) int {
	h.queuedRankMu.Lock()
	if h.queuedRankMap != nil && time.Since(h.queuedRankBuilt) < queuedRankTTL {
		pos, ok := h.queuedRankMap[createdAt]
		h.queuedRankMu.Unlock()
		if ok {
			return pos
		}
		return 0
	}
	h.queuedRankMu.Unlock()

	createds, err := h.store.ListQueuedJobCreatedAts(ctx)
	if err != nil {
		pos, perr := h.store.GetQueuedJobPosition(ctx, createdAt)
		if perr != nil {
			return 0
		}
		return pos
	}
	rank := make(map[time.Time]int, len(createds))
	before := 0
	for _, c := range createds {
		rank[c] = before
		before++
	}
	h.queuedRankMu.Lock()
	h.queuedRankMap = rank
	h.queuedRankBuilt = time.Now()
	h.queuedRankMu.Unlock()
	if pos, ok := rank[createdAt]; ok {
		return pos
	}
	return 0
}

type jobPoller struct {
	jobId       string
	subscribers map[chan *JobSnapshotBundle]struct{}
	stopCh      chan struct{}
	lastSeq     int
	events      []ImportJobEventDTO
}

func NewJobSnapshotHub(store Store) *JobSnapshotHub {
	return &JobSnapshotHub{
		store: store,
		jobs:  make(map[string]*jobPoller),
	}
}

func (h *JobSnapshotHub) Subscribe(jobId string) *JobSubscription {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch := make(chan *JobSnapshotBundle, 16)
	poller, exists := h.jobs[jobId]
	if !exists {
		poller = &jobPoller{
			jobId:       jobId,
			subscribers: make(map[chan *JobSnapshotBundle]struct{}),
			stopCh:      make(chan struct{}),
		}
		h.jobs[jobId] = poller
		go h.runPoller(poller)
	}

	poller.subscribers[ch] = struct{}{}

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()

			delete(poller.subscribers, ch)
			close(ch)

			if len(poller.subscribers) == 0 {
				select {
				case <-poller.stopCh:
				default:
					close(poller.stopCh)
				}
				if h.jobs[jobId] == poller {
					delete(h.jobs, jobId)
				}
			}
		})
	}

	return &JobSubscription{
		C:      ch,
		cancel: cancel,
	}
}

func (h *JobSnapshotHub) runPoller(p *jobPoller) {
	ticker := time.NewTicker(1000 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-p.stopCh:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			bundle := h.fetchSnapshot(ctx, p)
			cancel()

			h.broadcast(p, bundle)

			// Wait up to 6s grace after terminal job state so deferred flush writes done/error events before closing.
			if bundle.Job != nil && (bundle.Job.Status == "COMPLETED" || bundle.Job.Status == "FAILED") {
				deadline := time.Now().Add(6 * time.Second)
				graceTicker := time.NewTicker(250 * time.Millisecond)
				defer graceTicker.Stop()
			grace:
				for {
					select {
					case <-p.stopCh:
						return
					case <-graceTicker.C:
						gctx, gcancel := context.WithTimeout(context.Background(), 3*time.Second)
						gbundle := h.fetchSnapshot(gctx, p)
						gcancel()
						h.broadcast(p, gbundle)
						if hasTerminalEvent(p.events) || !time.Now().Before(deadline) {
							break grace
						}
					}
				}
				h.mu.Lock()
				if h.jobs[p.jobId] == p {
					delete(h.jobs, p.jobId)
				}
				h.mu.Unlock()
				return
			}
		}
	}
}

func (h *JobSnapshotHub) broadcast(p *jobPoller, bundle *JobSnapshotBundle) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range p.subscribers {
		select {
		case ch <- bundle:
		default:
			// Drop snapshot frame when subscriber buffer is full; the next poll reconciles cumulative state.
		}
	}
}

func hasTerminalEvent(events []ImportJobEventDTO) bool {
	for _, e := range events {
		if e.Type == "done" || e.Type == "error" {
			return true
		}
	}
	return false
}

func (h *JobSnapshotHub) fetchSnapshot(ctx context.Context, p *jobPoller) *JobSnapshotBundle {
	jobId := p.jobId
	job, err := h.store.GetImportJobSnapshot(ctx, jobId)
	if err != nil || job == nil {
		return &JobSnapshotBundle{Err: err}
	}

	pos := 0
	if job.Status == "QUEUED" {
		pos = h.queuedPosition(ctx, job.CreatedAt)
	}

	// Fetch only delta events (seq > cursor) per tick to avoid re-reading full job logs.
	if fresh, _ := h.store.GetImportJobEvents(ctx, jobId, p.lastSeq); len(fresh) > 0 {
		p.events = append(p.events, fresh...)
		p.lastSeq = fresh[len(fresh)-1].Seq
	}

	return &JobSnapshotBundle{
		Job:           job,
		QueuePosition: pos,
		Events:        p.events,
	}
}

type SessionAuthCache struct {
	mu      sync.RWMutex
	entries map[string]sessionCacheEntry
	stop    chan struct{}
}

type sessionCacheEntry struct {
	userId    string
	expiresAt time.Time
}

func NewSessionAuthCache() *SessionAuthCache {
	c := &SessionAuthCache{
		entries: make(map[string]sessionCacheEntry),
		stop:    make(chan struct{}),
	}
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-c.stop:
				return
			case <-ticker.C:
				c.gc()
			}
		}
	}()
	return c
}

func (c *SessionAuthCache) Close() {
	if c == nil || c.stop == nil {
		return
	}
	select {
	case <-c.stop:
	default:
		close(c.stop)
	}
}

func (c *SessionAuthCache) Get(tokenHash string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	entry, ok := c.entries[tokenHash]
	if !ok || time.Now().After(entry.expiresAt) {
		return "", false
	}
	return entry.userId, true
}

func (c *SessionAuthCache) Set(tokenHash, userId string, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries[tokenHash] = sessionCacheEntry{
		userId:    userId,
		expiresAt: time.Now().Add(ttl),
	}
}

func (c *SessionAuthCache) gc() {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	for k, v := range c.entries {
		if now.After(v.expiresAt) {
			delete(c.entries, k)
		}
	}
}

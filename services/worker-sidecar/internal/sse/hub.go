package sse

import (
	"context"
	"sync"
	"time"
)

// JobSnapshotBundle 单次轮询快照包
type JobSnapshotBundle struct {
	Job           *ImportJobSnapshot
	QueuePosition int
	Events        []ImportJobEventDTO
	Err           error
}

// JobSubscription 单观众订阅项
type JobSubscription struct {
	C      chan *JobSnapshotBundle
	cancel func()
}

// JobSnapshotHub 进程内扇出总线：同 Job 多观众共享一条轮询，DB 查询不随观众数增长
type JobSnapshotHub struct {
	store Store
	mu    sync.Mutex
	jobs  map[string]*jobPoller

	// queuedRank 队位 rank map（1s 粒度）：全部排队 job 的 poller 共享
	// 一次 ListQueuedJobCreatedAts 查询——此前每个排队 poller 每秒各做
	// 一次全表 COUNT（N 排队 = N 次/秒）。
	queuedRankMu    sync.Mutex
	queuedRankMap   map[time.Time]int
	queuedRankBuilt time.Time
}

// queuedRankTTL rank map 复用窗口（与 poller 1s 周期同级，位置滞后无感）。
const queuedRankTTL = 1 * time.Second

// queuedPosition 查询排队位（优先读 1s rank map，过期则单飞重建；
// 重建失败回退逐 job COUNT 保旧语义）。
func (h *JobSnapshotHub) queuedPosition(ctx context.Context, createdAt time.Time) int {
	h.queuedRankMu.Lock()
	if h.queuedRankMap != nil && time.Since(h.queuedRankBuilt) < queuedRankTTL {
		pos, ok := h.queuedRankMap[createdAt]
		h.queuedRankMu.Unlock()
		if ok {
			return pos
		}
		// map 未命中：createdAt 不在当前排队集（刚被认领），位次按 0 处理
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
	// 事件游标增量读取（WP-J：此前每秒全表重读）+ 累积列表（广播契约不变）
	lastSeq int
	events  []ImportJobEventDTO
}

// NewJobSnapshotHub 创建多路复用总线
func NewJobSnapshotHub(store Store) *JobSnapshotHub {
	return &JobSnapshotHub{
		store: store,
		jobs:  make(map[string]*jobPoller),
	}
}

// Subscribe 订阅指定 Job 的实时快照流
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

			if bundle.Job != nil && (bundle.Job.Status == "COMPLETED" || bundle.Job.Status == "FAILED") {
				// 终态宽限（WP-J）：runner 的终态事件经 deferred flush 落库（预算 5s）——
				// 此前固定 500ms 自毁会抢跑，真实 done/error 行未达观众即合成帧顶替。
				// 轮询至真实终态事件出现或 6s 宽限耗尽
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
			// 观众缓冲区满时跳过，依赖下一轮快照追平
		}
	}
}

// hasTerminalEvent 真实终态事件行（done/error）已抵达。
func hasTerminalEvent(events []ImportJobEventDTO) bool {
	for _, e := range events {
		if e.Type == "done" || e.Type == "error" {
			return true
		}
	}
	return false
}

// fetchSnapshot 增量读取（seq > 游标）并入 poller 累积列表——广播契约
// （全量事件）不变，DB 每轮只读新增行。
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

// SessionAuthCache 内存线程安全 TTL 会话缓存
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
	// 定期清理过期项
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

// Close 停止后台清理协程并释放定时器资源。
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

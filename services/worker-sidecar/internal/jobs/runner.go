package jobs

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/policy"
)

// ─────────────────────────────────────────────────────────────
// ImportJob 并发闸门调度器（逐字移植 import-job-store.ts pumpScheduler + main.ts tick）：
// - maxConcurrent 封顶同进程 RUNNING 数；超出者保持 QUEUED FIFO 排队；
// - 孤儿 QUEUED 由 tick 收养续跑（在 DB、不在内存记账）；
// - 100% Zero-Node Worker：全域 Go 单写者编排，拒绝任何 Node 兜底 fallback，
//   执行拒绝一律 Fail-Closed 打标 FAILED；
// - 与 Node worker 混跑安全（SKIP LOCKED 天然多消费者）。
// ─────────────────────────────────────────────────────────────

// Config 调度器配置。
type Config struct {
	ImportJobExecutor  string
	SchedulerTickMs    int
	MaxConcurrent      int
	MaxWallMs          int
	StaleAfterMs       int
	ReapIntervalMs     int
	FinishedJobTtlDays int
	HeartbeatMs        int
	EventFlushMs       int
	EventFlushCount    int
	MaxEventsPerJob    int
}

// InternalJobAPI job 层 web 端点（Zero-Node Worker 收官：execute 已移除）。
type InternalJobAPI interface {
}

// BodyExecutor Go 编排执行体接口。
type BodyExecutor interface {
	RunBody(ctx context.Context, cfg Config, job JobRow, emit func(eventType string, payload map[string]any)) bool
	WebClient() InternalJobAPI
}

// Runner 任务并发闸门调度器。
type Runner struct {
	cfg       Config
	store     QueueStore
	startTime time.Time

	mu              sync.Mutex
	active          map[string]bool // claim 成功才入账（activeRunners）
	guard           map[string]bool // 同一 tick 内防重复派发（startingGuard）
	pumping         bool            // 泵互斥：杜绝 boot pump 与 tick 泵交错派发
	lastReap        time.Time
	lastGc          time.Time
	retryingRewards bool
	stop            chan struct{}
	wg              sync.WaitGroup
	pumpCh          chan struct{} // 完成即刻补位（不等 tick）

	bodyExecutor BodyExecutor
	webClient    InternalJobAPI
	gwPolicy     *policy.GatewayPolicy
	gate         *MemoryGate
}

// NewRunner 创建任务并发闸门调度器。
func NewRunner(cfg Config, store QueueStore) *Runner {
	return &Runner{
		cfg:       cfg,
		store:     store,
		startTime: time.Now().UTC(),
		active:    map[string]bool{},
		guard:     map[string]bool{},
		stop:      make(chan struct{}),
		pumpCh:    make(chan struct{}, 1),
		gwPolicy:  policy.NewGatewayPolicy(),
	}
}

// SetGate 注入两阶段加权内存准入闸门。
func (r *Runner) SetGate(g *MemoryGate) { r.gate = g }

// Gate 获取两阶段加权内存准入闸门。
func (r *Runner) Gate() *MemoryGate { return r.gate }

// SetWebClient 注入 Web 端点客户端（Zero-Node Worker 微端点调用）。
func (r *Runner) SetWebClient(w InternalJobAPI) { r.webClient = w }

// SetBodyDeps 注入 Go 编排执行体依赖。
func (r *Runner) SetBodyDeps(d BodyExecutor) {
	r.bodyExecutor = d
	if r.webClient == nil && d != nil && d.WebClient() != nil {
		r.webClient = d.WebClient()
	}
}

// SetSafeMode 设置避震安全模式（发生崩溃风暴时限制并发为 1）
func (r *Runner) SetSafeMode(enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if enabled && r.cfg.MaxConcurrent > 1 {
		log.Printf("[job-runner] Safe Mode enabled: clamping MaxConcurrent from %d to 1", r.cfg.MaxConcurrent)
		r.cfg.MaxConcurrent = 1
	}
}

// heartbeatIntervalMs 心跳间隔（ms）SSOT：runJob 租约心跳与 BootSweep 收割阈值
// 回退窗口共用，杜绝两处默认值漂移（对齐 Node heartbeatMs 默认 10s）。
func (r *Runner) heartbeatIntervalMs() int {
	if r.cfg.HeartbeatMs > 0 {
		return r.cfg.HeartbeatMs
	}
	return 10000
}

// BootSweepOrphanedJobs 启动期主动收割上一代进程硬崩溃遗留的 RUNNING 孤儿任务，
// 防止其陷入 60s 超时死锁，立即将其置为 FAILED 并释放锁。
// 阈值锚定本进程启动时刻 startTime，防止多实例滚动重启误杀邻居实例心跳正常的任务；
// 再回退两个心跳周期——邻居存活任务的最近一次心跳可能落在本进程启动前一个心跳
// 间隔内，直接以 startTime 为界仍会误杀跨界任务；真孤儿的心戳只会
// 更旧，回退窗口不会放过它们。
func (r *Runner) BootSweepOrphanedJobs(ctx context.Context) (int64, error) {
	if r == nil || r.store == nil {
		return 0, nil
	}
	sctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	threshold := r.startTime
	if threshold.IsZero() {
		threshold = time.Now().UTC()
	}
	threshold = threshold.Add(-2 * time.Duration(r.heartbeatIntervalMs()) * time.Millisecond)
	n, err := r.store.ReapStaleImportJobs(sctx, threshold)
	if err != nil {
		log.Printf("[job-runner] boot sweep failed: %v", err)
		return 0, err
	}
	if n > 0 {
		log.Printf("[job-runner] boot sweep reaped %d orphaned RUNNING jobs to FAILED", n)
	}
	return n, nil
}

func (r *Runner) Start() {
	// 启动立即主动排毒：收割上一代进程硬崩溃遗留的孤儿 RUNNING 任务
	bctx, bcancel := context.WithTimeout(context.Background(), 15*time.Second)
	_, _ = r.BootSweepOrphanedJobs(bctx)
	bcancel()

	// 启动立即一轮：收养上一进程遗留的孤儿 QUEUED（boot pump）
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		r.pump()
	}()
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		tickMs := r.cfg.SchedulerTickMs
		if tickMs <= 0 {
			tickMs = 3000
		}
		ticker := time.NewTicker(time.Duration(tickMs) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-r.stop:
				return
			case <-ticker.C:
				r.pump()
			case <-r.pumpCh:
				r.pump()
			}
		}
	}()
	log.Printf("[job-runner] scheduler started (tick=%dms maxConcurrent=%d wall=%dmin)",
		r.cfg.SchedulerTickMs, r.cfg.MaxConcurrent, r.cfg.MaxWallMs/60000)
}

func (r *Runner) Stop() {
	close(r.stop)
	r.wg.Wait()
}

// TriggerPump 主动唤醒调度泵（入队即时拾取；缓冲满则忽略——泵已在跑，tick 兜底）。
func (r *Runner) TriggerPump() {
	if r == nil || r.pumpCh == nil {
		return
	}
	select {
	case r.pumpCh <- struct{}{}:
	default:
	}
}

// maybeReap 进程级节流 reap（窗口 reapIntervalMs，默认 20s）+ GC（10min 节流）。
func (r *Runner) maybeReap() {
	now := time.Now().UTC() // Prisma DateTime = naive UTC；本地时区会误判新鲜任务为过期
	r.mu.Lock()
	due := now.Sub(r.lastReap) >= time.Duration(r.cfg.ReapIntervalMs)*time.Millisecond
	gcDue := now.Sub(r.lastGc) >= 10*time.Minute
	if due {
		r.lastReap = now
	}
	if gcDue {
		r.lastGc = now
	}
	r.mu.Unlock()
	if due {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		n, err := r.store.ReapStaleImportJobs(ctx, now.Add(-time.Duration(r.cfg.StaleAfterMs)*time.Millisecond))
		cancel()
		if err != nil {
			log.Printf("[job-runner] reap failed: %v", err)
		} else if n > 0 {
			log.Printf("[job-runner] reaped %d stale RUNNING jobs", n)
		}
	}
	if gcDue {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		n, err := r.store.GcFinishedImportJobs(ctx, now.Add(-time.Duration(r.cfg.FinishedJobTtlDays)*24*time.Hour))
		cancel()
		if err != nil {
			log.Printf("[job-runner] gc failed: %v", err)
		} else if n > 0 {
			log.Printf("[job-runner] gc deleted %d finished jobs", n)
		}
	}
}

type rewardRetryStore interface {
	ClaimPendingImportRewardJobs(context.Context, int, time.Time) ([]string, error)
	RetryImportReward(context.Context, string) error
}

// One bounded batch per existing scheduler pump; never replay ingestion on callback failure.
func (r *Runner) retryPendingRewards() {
	store, ok := r.store.(rewardRetryStore)
	if !ok {
		return
	}
	r.mu.Lock()
	if r.retryingRewards {
		r.mu.Unlock()
		return
	}
	r.retryingRewards = true
	r.mu.Unlock()
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		defer func() {
			if p := recover(); p != nil {
				log.Printf("[job-runner] retryPendingRewards panicked: %v", p)
			}
			r.mu.Lock()
			r.retryingRewards = false
			r.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), rewardCallbackTimeout)
		defer cancel()
		ids, err := store.ClaimPendingImportRewardJobs(ctx, max(1, r.cfg.MaxConcurrent), time.Now().UTC().Add(-rewardCallbackTimeout))
		if err != nil {
			log.Printf("[job-runner] reward retry claim failed: %v", err)
			return
		}
		for _, id := range ids {
			if ctx.Err() != nil {
				return
			}
			if err := store.RetryImportReward(ctx, id); err != nil {
				log.Printf("[job-runner] reward callback pending for %s: %v", id, err)
			}
		}
	}()
}

func (r *Runner) pump() {
	// 泵互斥：boot pump 与 ticker/pumpCh 并发进入时，两轮 claim/dispatch
	// 交错会使后到者撞上容量重查——被 break 的任务已在 DB 翻成 RUNNING
	// 却无 goroutine 执行，stale 后被 reap 成不可恢复的假 FAILED。
	r.mu.Lock()
	if r.pumping {
		r.mu.Unlock()
		return
	}
	r.pumping = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.pumping = false
		r.mu.Unlock()
	}()

	r.maybeReap()

	// 紧急只读熔断单点：停止认领即停掉全部导入执行（策略库故障 fail-open 继续跑）
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	emergency := r.gwPolicy.IsEmergencyReadOnly(ctx, r.store)
	cancel()
	if emergency {
		return
	}
	r.retryPendingRewards()

	r.mu.Lock()
	slots := r.cfg.MaxConcurrent - (len(r.active) + len(r.guard))
	activeCount := len(r.active) + len(r.guard)
	guard := make([]string, 0, len(r.guard))
	for id := range r.guard {
		guard = append(guard, id)
	}
	r.mu.Unlock()
	if r.gate != nil {
		gateSlots := r.gate.ClaimableSlots(activeCount)
		if gateSlots < slots {
			slots = gateSlots
		}
	}
	if slots <= 0 {
		return
	}

	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Second)
	claimed, err := r.store.ClaimNextQueuedJobs(ctx2, slots, guard)
	cancel2()
	if err != nil {
		log.Printf("[job-runner] claim failed: %v", err)
		return
	}
	for _, jobId := range claimed {
		// 容量不变式：claimed ≤ slots = MaxConcurrent - len(active)（锁内计算），
		// 同批 goroutine 的 active 注册全部来自本循环派发的任务——全量派发
		// 后 active ≤ MaxConcurrent，无需也无法中途重查（被 break 的已认领
		// 任务就是无执行者的 RUNNING 孤儿）。
		r.mu.Lock()
		r.guard[jobId] = true // 先占坑再异步启动，防同 tick 双发
		r.mu.Unlock()
		r.wg.Add(1)
		go func(id string) {
			defer r.wg.Done()
			r.runJob(id)
		}(jobId)
	}
}

func (r *Runner) runJob(jobId string) {
	writer := newEventWriter(jobId, r.store, r.cfg)
	defer func() {
		flushCtx, flushCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer flushCancel()
		_ = writer.Close(flushCtx)
	}()

	defer func() {
		if p := recover(); p != nil {
			panicMsg := fmt.Sprintf("执行异常: %v", p)
			log.Printf("[job-runner] job %s panicked: %v", jobId, p)
			writer.Push("error", map[string]any{"message": panicMsg})
			if _, ferr := r.failJobWithTimeout(jobId, panicMsg); ferr != nil {
				log.Printf("[job-runner] fail write on panic failed for %s: %v", jobId, ferr)
			}
		}
		// 闸门记账：释放槽位并立即补位放行下一个排队任务
		r.mu.Lock()
		delete(r.active, jobId)
		delete(r.guard, jobId)
		r.mu.Unlock()
		select {
		case r.pumpCh <- struct{}{}:
		default:
		}
	}()

	// 独立的 Lease Heartbeat goroutine：每隔 cfg.HeartbeatMs 刷新一次 lastHeartbeatAt
	hbStop := make(chan struct{})
	var hbWg sync.WaitGroup
	defer func() {
		close(hbStop)
		hbWg.Wait()
	}()

	hbInterval := r.heartbeatIntervalMs()
	hbWg.Add(1)
	go func() {
		defer hbWg.Done()
		defer func() {
			if p := recover(); p != nil {
				log.Printf("[job-runner] heartbeat goroutine panicked for %s: %v", jobId, p)
			}
		}()
		ticker := time.NewTicker(time.Duration(hbInterval) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-hbStop:
				return
			case <-ticker.C:
				hbCtx, hbCancel := context.WithTimeout(context.Background(), 10*time.Second)
				if err := r.store.HeartbeatImportJob(hbCtx, jobId); err != nil {
					log.Printf("[job-runner] heartbeat failed for %s: %v", jobId, err)
				}
				hbCancel()
			}
		}
	}()

	r.mu.Lock()
	r.active[jobId] = true // markJobActive：active 入账、guard 解除
	delete(r.guard, jobId)
	r.mu.Unlock()

	log.Printf("[job-runner] job %s claimed", jobId)

	maxWall := r.cfg.MaxWallMs
	if maxWall <= 0 {
		maxWall = 30 * 60 * 1000
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(maxWall)*time.Millisecond)
	defer cancel()

	var lastErrMsg string
	emit := func(eventType string, payload map[string]any) {
		if eventType == "error" && payload != nil {
			if msg, ok := payload["message"].(string); ok && msg != "" {
				lastErrMsg = msg
			}
		}
		writer.Push(eventType, payload)
	}

	if r.cfg.ImportJobExecutor == "go" && r.bodyExecutor != nil {
		jobRow, err := r.store.GetImportJob(ctx, jobId)
		if err != nil {
			failMsg := fmt.Sprintf("读取任务行失败: %v", err)
			log.Printf("[job-runner] failed to load job %s: %v (fail-closed)", jobId, err)
			writer.Push("error", map[string]any{"message": failMsg})
			_, _ = r.failJobWithTimeout(jobId, failMsg)
			return
		}
		if jobRow == nil {
			failMsg := "导入任务不存在或已清理"
			log.Printf("[job-runner] job %s not found (fail-closed)", jobId)
			writer.Push("error", map[string]any{"message": failMsg})
			_, _ = r.failJobWithTimeout(jobId, failMsg)
			return
		}
		// 派发间隙终态复查（对齐 Node import-job-runner.ts:45-49：claim 后
		// 任务可能已被 reap 或人工置终态——绝不重复执行已终态任务）
		if jobRow.Status != "RUNNING" {
			log.Printf("[job-runner] job %s already terminal (%s) after claim, skip body", jobId, jobRow.Status)
			writer.Push("done", map[string]any{"jobId": jobId})
			return
		}
		if r.bodyExecutor.RunBody(ctx, r.cfg, *jobRow, emit) {
			writer.Push("done", map[string]any{"jobId": jobId})
			log.Printf("[job-runner] job %s completed via Go orchestrator", jobId)
			return
		}
		// Settlement may have completed before its callback failed. Never replay
		// ingestion or enter failure/cleanup paths for that completed job.
		latest, loadErr := r.store.GetImportJob(ctx, jobId)
		if loadErr != nil {
			log.Printf("[job-runner] post-body status unavailable for %s: %v", jobId, loadErr)
			return
		}
		if latest != nil && latest.Status == "COMPLETED" {
			writer.Push("done", map[string]any{"jobId": jobId})
			return // durable pending callback is retried by the scheduler tick
		}
		// 100% Zero-Node Worker：Go 编排体拒绝该任务即显式失败（Fail-Closed，无 Node fallback）
		failMsg := "导入执行失败：Go 编排体拒绝该任务（能力缺口或落库/结算异常），请查看任务日志或缩小导入范围后重试"
		// 墙钟超时优先归类（对齐 Node 专用文案——巨仓 30min 上限不应伪装成能力缺口）
		if ctx.Err() == context.DeadlineExceeded {
			failMsg = fmt.Sprintf("导入超过墙钟上限（%d 分钟）被强制终止；仓库较大或上游过慢，请重试或缩小选定目录", maxWall/60000)
			if lastErrMsg == "" {
				writer.Push("error", map[string]any{"message": failMsg})
			}
			// body 已 push 过具体错误时不再重复推送（双报防御）；落库文案仍以墙钟归类为准
		} else if lastErrMsg != "" {
			failMsg = lastErrMsg
			// 已在 body 执行期间 push 过了，不再重复 push
		} else {
			writer.Push("error", map[string]any{"message": failMsg})
		}
		ok, ferr := r.failJobWithTimeout(jobId, failMsg)
		if ferr != nil {
			log.Printf("[job-runner] fail write failed for %s: %v", jobId, ferr)
		} else if ok {
			log.Printf("[job-runner] job %s failed: go body rejected (fail-closed, no node fallback)", jobId)
		}
		return
	}

	// fail-closed：Go 执行体未配置——显式失败而非静默挂起
	failMsg := "导入执行体未配置，请联系管理员"
	writer.Push("error", map[string]any{"message": failMsg})
	ok, err := r.failJobWithTimeout(jobId, failMsg)
	if err != nil {
		log.Printf("[job-runner] fail write failed for %s: %v", jobId, err)
	} else if ok {
		log.Printf("[job-runner] job %s failed: no executor configured", jobId)
	}
}

func (r *Runner) failJobWithTimeout(jobId, failMsg string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return r.store.FailImportJob(ctx, jobId, failMsg)
}

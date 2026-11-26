package jobs

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/platform/policy"
)

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

type InternalJobAPI interface {
}

type BodyExecutor interface {
	RunBody(ctx context.Context, cfg Config, job JobRow, emit func(eventType string, payload map[string]any)) bool
	WebClient() InternalJobAPI
}

type Runner struct {
	cfg       Config
	store     QueueStore
	startTime time.Time

	mu              sync.Mutex
	active          map[string]bool
	guard           map[string]bool
	pumping         bool
	lastReap        time.Time
	lastGc          time.Time
	retryingRewards bool
	stop            chan struct{}
	wg              sync.WaitGroup
	pumpCh          chan struct{}

	bodyExecutor BodyExecutor
	webClient    InternalJobAPI
	gwPolicy     *policy.GatewayPolicy
	gate         *MemoryGate
}

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

func (r *Runner) SetGate(g *MemoryGate) { r.gate = g }

func (r *Runner) Gate() *MemoryGate { return r.gate }

func (r *Runner) SetWebClient(w InternalJobAPI) { r.webClient = w }

func (r *Runner) SetBodyDeps(d BodyExecutor) {
	r.bodyExecutor = d
	if r.webClient == nil && d != nil && d.WebClient() != nil {
		r.webClient = d.WebClient()
	}
}

func (r *Runner) SetSafeMode(enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if enabled && r.cfg.MaxConcurrent > 1 {
		log.Printf("[job-runner] Safe Mode enabled: clamping MaxConcurrent from %d to 1", r.cfg.MaxConcurrent)
		r.cfg.MaxConcurrent = 1
	}
}

func (r *Runner) heartbeatIntervalMs() int {
	if r.cfg.HeartbeatMs > 0 {
		return r.cfg.HeartbeatMs
	}
	return 10000
}

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
	// Anchor BootSweep cutoff to startTime minus 2 heartbeats so rolling-restart neighbors are not reaped.
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
	bctx, bcancel := context.WithTimeout(context.Background(), 15*time.Second)
	_, _ = r.BootSweepOrphanedJobs(bctx)
	bcancel()

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

func (r *Runner) TriggerPump() {
	if r == nil || r.pumpCh == nil {
		return
	}
	select {
	case r.pumpCh <- struct{}{}:
	default:
	}
}

func (r *Runner) maybeReap() {
	// Compare in UTC because Prisma stores timestamp without time zone.
	now := time.Now().UTC()
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

// Serialize pump loops so concurrent boot and tick pumps cannot leave claimed RUNNING jobs orphaned.
func (r *Runner) pump() {
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
		r.mu.Lock()
		r.guard[jobId] = true
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
		r.mu.Lock()
		delete(r.active, jobId)
		delete(r.guard, jobId)
		r.mu.Unlock()
		select {
		case r.pumpCh <- struct{}{}:
		default:
		}
	}()

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
	r.active[jobId] = true
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
			if encoded := encodeJobErrorPayloadForDb(payload); encoded != "" {
				lastErrMsg = encoded
			} else if msg, ok := payload["message"].(string); ok && msg != "" {
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
		// Re-check terminal status post-claim because a job may be reaped or finalized mid-dispatch.
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
		latest, loadErr := r.store.GetImportJob(ctx, jobId)
		if loadErr != nil {
			log.Printf("[job-runner] post-body status unavailable for %s: %v", jobId, loadErr)
			return
		}
		// Never replay ingestion or enter failure paths after settlement if only the reward callback failed.
		if latest != nil && latest.Status == "COMPLETED" {
			writer.Push("done", map[string]any{"jobId": jobId})
			return
		}
		failMsg := "导入执行失败：Go 编排体拒绝该任务（能力缺口或落库/结算异常），请查看任务日志或缩小导入范围后重试"
		if ctx.Err() == context.DeadlineExceeded {
			failMsg = fmt.Sprintf("导入超过墙钟上限（%d 分钟）被强制终止；仓库较大或上游过慢，请重试或缩小选定目录", maxWall/60000)
			if lastErrMsg == "" {
				writer.Push("error", map[string]any{"message": failMsg})
			}
		} else if lastErrMsg != "" {
			failMsg = lastErrMsg
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

func encodeJobErrorPayloadForDb(payload map[string]any) string {
	code, _ := payload["code"].(string)
	if code == "" {
		return ""
	}
	meta := client.StructuredErrorPayload{Code: code}
	if v, ok := payload["provider"].(string); ok {
		meta.Provider = v
	}
	if v, ok := payload["model"].(string); ok {
		meta.Model = v
	}
	switch v := payload["upstreamStatus"].(type) {
	case int:
		meta.UpstreamStatus = v
	case float64:
		meta.UpstreamStatus = int(v)
	}
	if v, ok := payload["upstreamCode"].(string); ok {
		meta.UpstreamCode = v
	}
	if v, ok := payload["upstreamMessage"].(string); ok && v != "" {
		meta.Message = v
	} else if v, ok := payload["message"].(string); ok {
		meta.Message = v
	}
	return client.EncodeStructuredDbErrorFromMeta(meta, client.MaxStructuredDbErrLen)
}

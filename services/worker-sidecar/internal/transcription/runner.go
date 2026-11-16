package transcription

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
	"github.com/opengits/worker-sidecar/internal/platform/policy"
)

// ─────────────────────────────────────────────────────────────
// 转录消费循环（逐字移植 worker main.ts 的 transcription loop 语义）：
// - poll 周期 TRANSCRIPTION_POLL_MS（默认 5s）；进程内串行——上轮未完成时本轮跳过
//   （兑现 maxPerCycle 作为进程内 LLM 并发软上限的承诺；DB 层 SKIP LOCKED 兜底）；
// - 每轮先 reap RUNNING 孤儿（置回 QUEUED 断点续接），再认领并由 Go 原生编排执行体
//   RunBody 闭环执行（失败 Fail-Closed；Node 转发微端点彻底物理退役）。
// ─────────────────────────────────────────────────────────────

// MemoryWatermarkChecker 物理内存高水位探针接口。
type MemoryWatermarkChecker interface {
	IsHighWatermark() bool
}

type TranscriptionRunner struct {
	cfg   Config
	store QueueStore

	mu          sync.Mutex
	inFly       bool // 进程内串行（Node in-flight 布尔同语义）
	stop        chan struct{}
	pumpCh      chan struct{} // 空闲槽位就绪/新任务入队即时驱动泵
	wg          sync.WaitGroup
	activeCount int32 // 并发模式下的活跃 worker 计数

	// bodyDeps Go 编排执行体依赖（TRANSCRIPTION_EXECUTOR=go 时由 main 注入；单测可覆盖）
	bodyDeps  *BodyDeps
	webClient InternalWebAPI
	gate      MemoryWatermarkChecker
}

func NewTranscriptionRunner(cfg Config, store QueueStore) *TranscriptionRunner {
	return &TranscriptionRunner{
		cfg:    cfg,
		store:  store,
		stop:   make(chan struct{}),
		pumpCh: make(chan struct{}, 1),
	}
}

// TriggerPump 主动唤醒调度器泵拉取新任务（如入队或槽位释放）。
func (r *TranscriptionRunner) TriggerPump() {
	if r == nil || r.pumpCh == nil {
		return
	}
	select {
	case r.pumpCh <- struct{}{}:
	default:
	}
}

// SetMemoryGate 注入内存高水位探针。
func (r *TranscriptionRunner) SetMemoryGate(g MemoryWatermarkChecker) { r.gate = g }

// SetWebClient 注入 Web 端点客户端（Zero-Node Worker 微端点调用）。
func (r *TranscriptionRunner) SetWebClient(w InternalWebAPI) { r.webClient = w }

// SetBodyDeps 注入 Go 执行体依赖（web/llm 客户端 + body store）。
func (r *TranscriptionRunner) SetBodyDeps(d BodyDeps) {
	r.bodyDeps = &d
	if r.webClient == nil && d.Web != nil {
		r.webClient = d.Web
	}
}

// SetSafeMode 设置避震安全模式（发生崩溃风暴时限制并发为 1）
func (r *TranscriptionRunner) SetSafeMode(enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if enabled && r.cfg.TranscriptionConcurrency > 1 {
		log.Printf("[transcription] Safe Mode enabled: clamping TranscriptionConcurrency from %d to 1", r.cfg.TranscriptionConcurrency)
		r.cfg.TranscriptionConcurrency = 1
	}
}

// BootSweep 启动期主动排毒：扫描并收割上一代进程遗留的 RUNNING 孤儿任务，
// 递增 attempts 并对重试超限毒丸任务执行级联 FAILED 隔离。
func (r *TranscriptionRunner) BootSweep(ctx context.Context) (int64, error) {
	if r == nil || r.store == nil {
		return 0, nil
	}
	sctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	n, err := r.store.ReapStaleTranscriptionJobs(sctx, time.Now().UTC())
	if err != nil {
		log.Printf("[transcription] boot sweep failed: %v", err)
		return 0, err
	}
	if n > 0 {
		log.Printf("[transcription] boot sweep reaped %d orphaned in-flight jobs", n)
	}
	return n, nil
}

func (r *TranscriptionRunner) Start() {
	// 启动立即执行一次主动排毒，收割上一代进程硬崩溃遗留的孤儿
	bctx, bcancel := context.WithTimeout(context.Background(), 15*time.Second)
	_, _ = r.BootSweep(bctx)
	bcancel()

	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		poll := time.Duration(r.cfg.TranscriptionPollMs) * time.Millisecond
		ticker := time.NewTicker(poll)
		defer ticker.Stop()
		for {
			select {
			case <-r.stop:
				return
			case <-ticker.C:
				if r.cfg.TranscriptionConcurrency > 1 {
					r.pumpConcurrent()
				} else {
					r.cycleOnce()
				}
			case <-r.pumpCh:
				if r.cfg.TranscriptionConcurrency > 1 {
					r.pumpConcurrent()
				} else {
					r.cycleOnce()
				}
			}
		}
	}()
	log.Printf("[transcription] scheduler started (poll=%dms maxPerCycle=%d concurrency=%d)",
		r.cfg.TranscriptionPollMs, r.cfg.TranscriptionMaxPerCycle, r.cfg.TranscriptionConcurrency)
}

func (r *TranscriptionRunner) Stop() { close(r.stop); r.wg.Wait() }

func (r *TranscriptionRunner) cycleOnce() {
	r.mu.Lock()
	if r.inFly {
		r.mu.Unlock()
		return // 上轮未完成（LLM 长调用 > pollMs）：本轮跳过
	}
	r.inFly = true
	r.mu.Unlock()
	defer func() {
		if p := recover(); p != nil {
			log.Printf("[transcription] cycle panicked: %v", p)
		}
		r.mu.Lock()
		r.inFly = false
		r.mu.Unlock()
	}()

	ctx := context.Background()

	// RUNNING 孤儿回收（每轮，对齐 runTranscriptionCycleOnce 首行；0=关闭）
	if r.cfg.TranscriptionStaleMs > 0 {
		rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		n, err := r.store.ReapStaleTranscriptionJobs(rctx, time.Now().UTC().Add(-time.Duration(r.cfg.TranscriptionStaleMs)*time.Millisecond))
		cancel()
		if err != nil {
			log.Printf("[transcription] reap failed: %v", err)
		} else if n > 0 {
			log.Printf("[transcription] reaped %d stale RUNNING jobs back to QUEUED", n)
		}
	}

	// 紧急只读熔断：跳过本轮认领（策略库故障 fail-open 继续跑）
	roCtx, roCancel := context.WithTimeout(ctx, 10*time.Second)
	emergencyRO := policy.IsEmergencyReadOnly(roCtx, r.store)
	roCancel()
	if emergencyRO {
		return
	}

	// 物理高水位熔断：系统内存紧张时跳过本轮转录认领，优先保障正在跑的导入与转录平稳收敛
	if r.gate != nil && r.gate.IsHighWatermark() {
		log.Printf("[transcription] system memory is at high watermark, skipping transcription cycle")
		return
	}

	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	jobs, err := r.store.ClaimNextTranscriptionJobs(cctx, r.cfg.TranscriptionMaxPerCycle)
	cancel()
	if err != nil {
		log.Printf("[transcription] claim failed: %v", err)
		return
	}
	if len(jobs) == 0 {
		return
	}

	concurrency := r.cfg.TranscriptionConcurrency
	if concurrency <= 1 {
		done, failed := 0, 0
		for _, job := range jobs {
			wctx, wcancel := context.WithTimeout(ctx, time.Duration(r.cfg.TranscriptionMaxWallMs)*time.Millisecond)
			outcome := r.runClaimed(wctx, job)
			wcancel()
			switch outcome {
			case claimDone:
				done++
			case claimCrashed:
				// 子进程异常退出/墙钟超时：attempts 达上限置 FAILED，否则回 QUEUED 续跑
				fctx, fcancel := context.WithTimeout(ctx, 15*time.Second)
				ok, err := r.store.FailTranscriptionJobExhausted(fctx, job.ID,
					"转录执行异常（可能因超时或服务重启），已回队续跑")
				fcancel()
				if err != nil {
					log.Printf("[transcription] crash fallback failed for %s: %v", job.ID, err)
				} else if ok {
					log.Printf("[transcription] job %s failed after repeated crashes", job.ID)
				}
				failed++
			case claimDeferred:
				// 预算不足：回 QUEUED 延后（不计 attempts）——终态落库已在 body 内完成
				r.deferJob(ctx, job.ID)
			}
		}
		metrics.Add("transcription.cycle_crashed", uint64(failed))
		log.Printf("[transcription] cycle: claimed=%d done=%d crashed=%d", len(jobs), done, failed)
		if done > 0 {
			r.TriggerPump()
		}
		return
	}

	// 并发执行分支：通过带容量缓冲信道作为信号量，防止压垮网络与连接池
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	var doneCount, failedCount int32

	for _, job := range jobs {
		sem <- struct{}{}
		wg.Add(1)
		go func(j TranscriptionClaim) {
			defer func() {
				if p := recover(); p != nil {
					log.Printf("[transcription] worker panicked for %s: %v", j.ID, p)
					fctx, fcancel := context.WithTimeout(context.Background(), 15*time.Second)
					_, _ = r.store.FailTranscriptionJobExhausted(fctx, j.ID, fmt.Sprintf("转录协程异常崩溃: %v", p))
					fcancel()
					atomic.AddInt32(&failedCount, 1)
				}
				<-sem
				wg.Done()
			}()

			wctx, wcancel := context.WithTimeout(ctx, time.Duration(r.cfg.TranscriptionMaxWallMs)*time.Millisecond)
			outcome := r.runClaimed(wctx, j)
			wcancel()
			switch outcome {
			case claimDone:
				atomic.AddInt32(&doneCount, 1)
			case claimCrashed:
				fctx, fcancel := context.WithTimeout(ctx, 15*time.Second)
				ok, err := r.store.FailTranscriptionJobExhausted(fctx, j.ID,
					"转录执行异常（可能因超时或服务重启），已回队续跑")
				fcancel()
				if err != nil {
					log.Printf("[transcription] crash fallback failed for %s: %v", j.ID, err)
				} else if ok {
					log.Printf("[transcription] job %s failed after repeated crashes", j.ID)
				}
				atomic.AddInt32(&failedCount, 1)
			case claimDeferred:
				r.deferJob(ctx, j.ID)
			}
		}(job)
	}
	wg.Wait()
	log.Printf("[transcription] cycle (concurrent): claimed=%d done=%d crashed=%d", len(jobs), doneCount, failedCount)
}

// pumpConcurrent 高吞吐平滑流水线泵：
// 彻底打破批次阻塞屏障（No Batch Barrier），以槽位为导向（Slot-Driven）：
// 空闲槽位 = Concurrency - activeCount。只要有空闲槽位且队列有任务，就立即认领并以
// 独立 goroutine 异步推进，绝不因个别超长思考/生成任务阻塞整个调度队列。
func (r *TranscriptionRunner) pumpConcurrent() {
	r.mu.Lock()
	if r.inFly {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()

	ctx := context.Background()

	// 1. RUNNING 孤儿回收
	if r.cfg.TranscriptionStaleMs > 0 {
		rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		n, err := r.store.ReapStaleTranscriptionJobs(rctx, time.Now().UTC().Add(-time.Duration(r.cfg.TranscriptionStaleMs)*time.Millisecond))
		cancel()
		if err != nil {
			log.Printf("[transcription] reap failed: %v", err)
		} else if n > 0 {
			log.Printf("[transcription] reaped %d stale RUNNING jobs back to QUEUED", n)
		}
	}

	// 2. 紧急只读熔断
	roCtx, roCancel := context.WithTimeout(ctx, 10*time.Second)
	emergencyRO := policy.IsEmergencyReadOnly(roCtx, r.store)
	roCancel()
	if emergencyRO {
		return
	}

	// 3. 物理高水位熔断
	if r.gate != nil && r.gate.IsHighWatermark() {
		log.Printf("[transcription] system memory is at high watermark, skipping transcription pump")
		return
	}

	// 4. 计算当前可用槽位
	concurrency := r.cfg.TranscriptionConcurrency
	currentActive := int(atomic.LoadInt32(&r.activeCount))
	freeSlots := concurrency - currentActive
	if freeSlots <= 0 {
		return
	}

	claimLimit := freeSlots
	if claimLimit > r.cfg.TranscriptionMaxPerCycle {
		claimLimit = r.cfg.TranscriptionMaxPerCycle
	}

	// 5. 非阻塞认领空闲槽位任务
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	jobs, err := r.store.ClaimNextTranscriptionJobs(cctx, claimLimit)
	cancel()
	if err != nil {
		log.Printf("[transcription] claim failed: %v", err)
		return
	}
	if len(jobs) == 0 {
		return
	}

	log.Printf("[transcription] pumped %d new jobs (active: %d -> %d, maxConcurrency: %d)",
		len(jobs), currentActive, currentActive+len(jobs), concurrency)

	// 6. 异步并行派发，释放调度器主循环
	for _, job := range jobs {
		atomic.AddInt32(&r.activeCount, 1)
		r.wg.Add(1)
		go func(j TranscriptionClaim) {
			defer func() {
				if p := recover(); p != nil {
					log.Printf("[transcription] worker panicked for %s: %v", j.ID, p)
					fctx, fcancel := context.WithTimeout(context.Background(), 15*time.Second)
					_, _ = r.store.FailTranscriptionJobExhausted(fctx, j.ID, fmt.Sprintf("转录协程异常崩溃: %v", p))
					fcancel()
				}
				atomic.AddInt32(&r.activeCount, -1)
				r.wg.Done()
				r.TriggerPump()
			}()

			wctx, wcancel := context.WithTimeout(context.Background(), time.Duration(r.cfg.TranscriptionMaxWallMs)*time.Millisecond)
			outcome := r.runClaimed(wctx, j)
			wcancel()
			switch outcome {
			case claimDone:
				// success
			case claimCrashed:
				fctx, fcancel := context.WithTimeout(context.Background(), 15*time.Second)
				ok, err := r.store.FailTranscriptionJobExhausted(fctx, j.ID,
					"转录执行异常（可能因超时或服务重启），已回队续跑")
				fcancel()
				if err != nil {
					log.Printf("[transcription] crash fallback failed for %s: %v", j.ID, err)
				} else if ok {
					log.Printf("[transcription] job %s failed after repeated crashes", j.ID)
				}
			case claimDeferred:
				r.deferJob(context.Background(), j.ID)
			}
		}(job)
	}
}

// claimOutcome 单个已认领任务的执行结果。
type claimOutcome int

const (
	claimDone claimOutcome = iota
	claimCrashed
	claimDeferred
	claimFailed // body 显式失败已落库（attempts 语义），无需再写
)

// runClaimed 按执行模式派发：go=Go 编排执行体（纯 Go 原生闭环；失败显式终态 +
// 成功 DONE 落库；非预期执行 Fail-Closed）。
func (r *TranscriptionRunner) runClaimed(ctx context.Context, job TranscriptionClaim) claimOutcome {
	if r.cfg.TranscriptionExecutor == "go" && r.bodyDeps != nil {
		outcome, errMsg := RunBody(ctx, r.cfg, *r.bodyDeps, job.ID, job.DocumentID, job.RequestedBy, job.Options)
		switch outcome {
		case BodyDone:
			if err := r.store.CompleteTranscriptionJob(ctx, job.ID); err != nil {
				// DONE 写失败不重跑转录（成品已落库）：任务滞留 RUNNING 由孤儿
				// 回收重扫，prepare noop 短路后再次到达此处——自愈幂等
				log.Printf("[transcription] complete write failed for %s: %v", job.ID, err)
				return claimCrashed
			}
			return claimDone
		case BodyDeferred:
			return claimDeferred
		case BodyFailed:
			fctx, fcancel := context.WithTimeout(ctx, 15*time.Second)
			_, err := r.store.FailTranscriptionJobExhausted(fctx, job.ID, truncate(errMsg, 500))
			fcancel()
			if err != nil {
				log.Printf("[transcription] fail write failed for %s: %v", job.ID, err)
			}
			return claimFailed
		default:
			log.Printf("[transcription] job %s unexpected outcome %v, failing closed", job.ID, outcome)
			fctx, fcancel := context.WithTimeout(ctx, 15*time.Second)
			_, _ = r.store.FailTranscriptionJobExhausted(fctx, job.ID, "unexpected outcome")
			fcancel()
			return claimFailed
		}
	}

	// Fail-closed：无执行体可派发，直接显式终态失败
	log.Printf("[transcription] executor not available for job %s, failing closed", job.ID)
	fctx, fcancel := context.WithTimeout(ctx, 15*time.Second)
	_, _ = r.store.FailTranscriptionJobExhausted(fctx, job.ID, "executor not available")
	fcancel()
	return claimFailed
}

// deferJob 预算延迟：回 QUEUED（与子进程 deferred 落库同款）。
func (r *TranscriptionRunner) deferJob(ctx context.Context, jobId string) {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, err := r.store.DeferTranscriptionJob(dctx, jobId); err != nil {
		log.Printf("[transcription] defer write failed for %s: %v", jobId, err)
	}
}

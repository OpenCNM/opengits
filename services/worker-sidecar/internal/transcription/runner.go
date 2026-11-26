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

type MemoryWatermarkChecker interface {
	IsHighWatermark() bool
}

type TranscriptionRunner struct {
	cfg   Config
	store QueueStore

	mu          sync.Mutex
	inFly       bool
	safeMode    bool
	lastEffConc int
	stop        chan struct{}
	pumpCh      chan struct{}
	wg          sync.WaitGroup
	activeCount int32

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

func (r *TranscriptionRunner) TriggerPump() {
	if r == nil || r.pumpCh == nil {
		return
	}
	select {
	case r.pumpCh <- struct{}{}:
	default:
	}
}

func (r *TranscriptionRunner) SetMemoryGate(g MemoryWatermarkChecker) { r.gate = g }

func (r *TranscriptionRunner) SetWebClient(w InternalWebAPI) { r.webClient = w }

func (r *TranscriptionRunner) SetBodyDeps(d BodyDeps) {
	r.bodyDeps = &d
	if r.webClient == nil && d.Web != nil {
		r.webClient = d.Web
	}
}

// Crash-storm safe mode clamps concurrency to 1 and overrides dynamic runtime policy.
func (r *TranscriptionRunner) SetSafeMode(enabled bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.safeMode = enabled
	if enabled && r.cfg.TranscriptionConcurrency > 1 {
		log.Printf("[transcription] Safe Mode enabled: clamping TranscriptionConcurrency from %d to 1", r.cfg.TranscriptionConcurrency)
		r.cfg.TranscriptionConcurrency = 1
	}
}

type RuntimeStateSnapshot struct {
	EmergencyReadOnly             bool `json:"emergencyReadOnly"`
	TranscriptionConcurrency      int  `json:"transcriptionConcurrency"`
	TranscriptionChunkConcurrency int  `json:"transcriptionChunkConcurrency"`
	ActiveTranscriptions          int  `json:"activeTranscriptions"`
	SafeMode                      bool `json:"safeMode"`
}

func (r *TranscriptionRunner) resolveRuntimePolicy(ctx context.Context) (emergencyRO bool, concurrency int, chunkConcurrency int, safeMode bool) {
	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	rt := policy.GetRuntimePolicy(pctx, r.store)
	cancel()

	r.mu.Lock()
	baseConc := r.cfg.TranscriptionConcurrency
	safeMode = r.safeMode
	prev := r.lastEffConc
	if baseConc < 1 {
		baseConc = 1
	}
	concurrency = policy.ResolveTranscriptionConcurrency(rt.TranscriptionConcurrency, baseConc)
	if safeMode {
		concurrency = 1
	}
	if prev > 0 && prev != concurrency {
		log.Printf("[transcription] runtime concurrency updated dynamically: %d -> %d", prev, concurrency)
	}
	r.lastEffConc = concurrency
	r.mu.Unlock()

	chunkConcurrency = policy.ResolveTranscriptionChunkConcurrency(rt.TranscriptionChunkConcurrency, chunkConcurrencyFromEnv())
	return rt.EmergencyReadOnly, concurrency, chunkConcurrency, safeMode
}

func (r *TranscriptionRunner) SnapshotRuntimeState(ctx context.Context) RuntimeStateSnapshot {
	ro, conc, chunkConc, safeMode := r.resolveRuntimePolicy(ctx)
	return RuntimeStateSnapshot{
		EmergencyReadOnly:             ro,
		TranscriptionConcurrency:      conc,
		TranscriptionChunkConcurrency: chunkConc,
		ActiveTranscriptions:          int(atomic.LoadInt32(&r.activeCount)),
		SafeMode:                      safeMode,
	}
}

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
				r.pumpConcurrent()
			case <-r.pumpCh:
				r.pumpConcurrent()
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
		return
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

	roCtx, roCancel := context.WithTimeout(ctx, 10*time.Second)
	emergencyRO := policy.IsEmergencyReadOnly(roCtx, r.store)
	roCancel()
	if emergencyRO {
		return
	}

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

// Slot-driven dispatcher avoids batch barriers so slow LLM jobs never stall free worker slots.
func (r *TranscriptionRunner) pumpConcurrent() {
	r.mu.Lock()
	if r.inFly {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()

	ctx := context.Background()

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

	emergencyRO, concurrency, _, _ := r.resolveRuntimePolicy(ctx)
	if emergencyRO {
		return
	}

	if r.gate != nil && r.gate.IsHighWatermark() {
		log.Printf("[transcription] system memory is at high watermark, skipping transcription pump")
		return
	}

	currentActive := int(atomic.LoadInt32(&r.activeCount))
	freeSlots := concurrency - currentActive
	if freeSlots <= 0 {
		return
	}

	maxPerCycle := r.cfg.TranscriptionMaxPerCycle
	if maxPerCycle < concurrency {
		maxPerCycle = concurrency
	}
	claimLimit := freeSlots
	if claimLimit > maxPerCycle {
		claimLimit = maxPerCycle
	}

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

type claimOutcome int

const (
	claimDone claimOutcome = iota
	claimCrashed
	claimDeferred
	claimFailed
)

func (r *TranscriptionRunner) runClaimed(ctx context.Context, job TranscriptionClaim) claimOutcome {
	if r.cfg.TranscriptionExecutor == "go" && r.bodyDeps != nil {
		outcome, errMsg := RunBody(ctx, r.cfg, *r.bodyDeps, job.ID, job.DocumentID, job.RequestedBy, job.Options)
		switch outcome {
		case BodyDone:
			if err := r.store.CompleteTranscriptionJob(ctx, job.ID); err != nil {
				// Leaves job RUNNING on DONE-write failure so orphan reaping and prepare noop recover idempotently.
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

	log.Printf("[transcription] executor not available for job %s, failing closed", job.ID)
	fctx, fcancel := context.WithTimeout(ctx, 15*time.Second)
	_, _ = r.store.FailTranscriptionJobExhausted(fctx, job.ID, "executor not available")
	fcancel()
	return claimFailed
}

func (r *TranscriptionRunner) deferJob(ctx context.Context, jobId string) {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, err := r.store.DeferTranscriptionJob(dctx, jobId); err != nil {
		log.Printf("[transcription] defer write failed for %s: %v", jobId, err)
	}
}

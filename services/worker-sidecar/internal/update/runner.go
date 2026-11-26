package update

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/market"
)

type WebAPI interface {
	RunMarketEngineTick(ctx context.Context) error
}

type Runner struct {
	cfg   Config
	store Store

	stop chan struct{}
	wg   sync.WaitGroup

	mu      sync.Mutex
	running bool

	webClient      WebAPI
	OnIndexRefresh func(repoId string)
	ValleyGate     func() bool
}

func NewRunner(cfg Config, store Store) *Runner {
	return &Runner{cfg: cfg, store: store, stop: make(chan struct{})}
}

func (r *Runner) SetWebClient(w WebAPI) { r.webClient = w }

func (r *Runner) SetValleyGate(g func() bool) { r.ValleyGate = g }

// Gate only periodic ticks with ValleyGate; manual HTTP triggers bypass off-peak checks.
func (r *Runner) inValley() bool {
	return r.ValleyGate == nil || r.ValleyGate()
}

// Stagger initial run behind upstream-check's 60s tick so upstream flags populate first.
const AutoUpdateInitialStagger = 90 * time.Second

func (r *Runner) Start() {
	interval := time.Duration(envIntervalMinOr("AUTO_UPDATE_INTERVAL_MIN", 60)) * time.Minute
	log.Printf("[auto-update] scheduler started (interval=%dmin)", int(interval.Minutes()))
	r.wg.Add(2)
	go func() {
		defer r.wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-r.stop:
				return
			case <-ticker.C:
				if !r.inValley() {
					log.Printf("[auto-update] 读路径低谷窗口外，跳过本轮 tick")
					continue
				}
				r.RunOnce()
			}
		}
	}()
	go func() {
		defer r.wg.Done()
		select {
		case <-r.stop:
			return
		case <-time.After(AutoUpdateInitialStagger):
			if !r.inValley() {
				log.Printf("[auto-update] 读路径低谷窗口外，跳过开机首轮")
				return
			}
			r.RunOnce()
		}
	}()
}

func (r *Runner) Stop() {
	close(r.stop)
	r.wg.Wait()
	if r.store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		releaseLease(ctx, r.store, "auto-update")
	}
}

func (r *Runner) RunOnce() {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		log.Printf("[auto-update] cycle already running in this process, skip this trigger")
		return
	}
	r.running = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.running = false
		r.mu.Unlock()
	}()

	defer func() {
		if p := recover(); p != nil {
			log.Printf("[auto-update] cycle panicked: %v", p)
		}
	}()
	if gs, ok := r.store.(interface {
		EmergencyReadOnly(ctx context.Context) (bool, error)
	}); ok {
		roCtx, roCancel := context.WithTimeout(context.Background(), 10*time.Second)
		ro, err := gs.EmergencyReadOnly(roCtx)
		roCancel()
		// Halt all update mutations during EmergencyReadOnly (fail-open on policy store errors).
		if err == nil && ro {
			log.Printf("[auto-update] emergency read-only active, write paths halted this cycle")
			return
		}
	}
	maxWallMs := r.cfg.AutoUpdateMaxWallMs
	if maxWallMs <= 0 {
		maxWallMs = 60 * 60 * 1000
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(maxWallMs)*time.Millisecond)
	defer cancel()

	interval := time.Duration(envIntervalMinOr("AUTO_UPDATE_INTERVAL_MIN", 60)) * time.Minute
	if r.store != nil && !acquireLease(ctx, r.store, "auto-update", leaseTtlFromInterval(interval)) {
		log.Printf("[auto-update] lease held elsewhere, skip this cycle")
		return
	}

	if s, ok := r.store.(market.Sweeper); ok {
		sweepCtx, sweepCancel := context.WithTimeout(ctx, 30*time.Second)
		market.SweepMarketTimeouts(sweepCtx, s)
		sweepCancel()
	}
	if s, ok := r.store.(market.Store); ok {
		settleCtx, settleCancel := context.WithTimeout(ctx, 60*time.Second)
		swapped, rejected := market.SettleExpiredMarketTrials(settleCtx, r.cfg.MarketConfig(), s, r.OnIndexRefresh)
		settleCancel()
		if swapped+rejected > 0 {
			log.Printf("[auto-update] market settled: swapped=%d rejected=%d", swapped, rejected)
		}
	}
	if s, ok := r.store.(CycleStore); ok {
		RunAutoUpdateDeterministicCycle(ctx, r.cfg, s)
	}

	if r.webClient == nil {
		log.Printf("[auto-update] no engine executor configured, skipping engine tick")
		return
	}
	if err := r.webClient.RunMarketEngineTick(ctx); err != nil {
		log.Printf("[auto-update] engine tick failed: %v", err)
	}
}

func (r *Runner) runOnce() {
	r.RunOnce()
}

var leaseOwner = func() string {
	b := make([]byte, 2)
	if _, err := rand.Read(b); err != nil {
		log.Fatal("[lease] rand read failed:", err)
	}
	return fmt.Sprintf("worker-go-%d-%s", os.Getpid(), hex.EncodeToString(b))
}()

func acquireLease(ctx context.Context, store LeaseStore, key string, ttl time.Duration) bool {
	until := time.Now().Add(ttl).UTC()
	n, err := store.LeaseUpdateIfHeldOrExpired(ctx, key, leaseOwner, until)
	if err == nil && n == 1 {
		return true
	}
	if err != nil {
		log.Printf("[lease] acquire (fast path) failed for %s (skip this cycle): %v", key, err)
		return false
	}
	if err := store.LeaseInsert(ctx, key, leaseOwner, until); err != nil {
		log.Printf("[lease] acquire failed for %s (skip this cycle): %v", key, err)
		return false
	}
	return true
}

func releaseLease(ctx context.Context, store LeaseStore, key string) {
	if err := store.LeaseDelete(ctx, key, leaseOwner); err != nil {
		log.Printf("[lease] release failed for %s: %v", key, err)
	}
}

func envIntervalMinOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func leaseTtlFromInterval(interval time.Duration) time.Duration {
	ttl := interval * 2
	if ttl < 2*time.Minute {
		ttl = 2 * time.Minute
	}
	return ttl
}

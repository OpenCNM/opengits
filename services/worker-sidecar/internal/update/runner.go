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

// ─────────────────────────────────────────────────────────────
// auto-update 调度（D组端点6c：确定性周期 Go 进程内单实现）。
//
// 语义对齐 scheduler/auto-update.ts 的 startAutoUpdateScheduler：
//   - 租约 key 同名 'auto-update'（TTL = 周期×2），与 Node 侧混跑互斥；
//   - 确定性超时清扫（回池+坏任务终态化）Go 直跑（CAS 幂等）；
//   - 过期标记/候选集/建单/基线推进 Go 进程内直跑（cycle.go，
//     消除 Go→Node→Go 候选集 ping-pong）；
//   - 投票结算（换入/否决 + postSwap 重建 + re-audit）Go 直跑
//     （market 模块）；
//   - web 微端点仅剩维护者兜底转录（BYOK 引擎——Node 锚定语义）。
// ─────────────────────────────────────────────────────────────

// WebAPI 市场引擎 tick 执行接口。
type WebAPI interface {
	RunMarketEngineTick(ctx context.Context) error
}

// Runner coordinates periodic auto-update cycles.
type Runner struct {
	cfg   Config
	store Store

	stop chan struct{}
	wg   sync.WaitGroup

	mu      sync.Mutex
	running bool

	webClient WebAPI
	// OnIndexRefresh 换入后 OGIS 索引去抖重建钩子（main 注入；nil=未启用）
	OnIndexRefresh func(repoId string)
	// ValleyGate 低谷门控钩子（main 注入；nil=未启用，调度行为同旧）。
	// 仅门控定时 tick 与开机首轮——HTTP 手动触发不门控（人工触发即人工已择时）
	ValleyGate func() bool
}

// NewRunner creates a new AutoUpdateRunner instance.
func NewRunner(cfg Config, store Store) *Runner {
	return &Runner{cfg: cfg, store: store, stop: make(chan struct{})}
}

// SetWebClient 注入 Web 端点客户端（main 恒定注入——执行体唯一形态）。
func (r *Runner) SetWebClient(w WebAPI) { r.webClient = w }

// SetValleyGate 注入低谷门控（daemon 装配期注入；须在 Start 前调用）。
func (r *Runner) SetValleyGate(g func() bool) { r.ValleyGate = g }

// inValley tick 前门控判定；未启用恒真（保持旧调度行为）。
func (r *Runner) inValley() bool {
	return r.ValleyGate == nil || r.ValleyGate()
}

// AutoUpdateInitialStagger 错开 upstream-check 的 60s 首轮，红点先就绪再消费
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
	// 首轮延迟 90s：错开 upstream-check 的 60s 首轮，红点先就绪再消费
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
	// 应急只读熔断（对齐 Node auto-update.ts:46-49：过期标记/建任务/换入等
	// 写路径全停；读取失败 fail-open 继续运行）——付费换入与基线推进绝不能
	// 在维修声明期照常执行
	if gs, ok := r.store.(interface {
		EmergencyReadOnly(ctx context.Context) (bool, error)
	}); ok {
		roCtx, roCancel := context.WithTimeout(context.Background(), 10*time.Second)
		ro, err := gs.EmergencyReadOnly(roCtx)
		roCancel()
		if err == nil && ro {
			log.Printf("[auto-update] emergency read-only active, write paths halted this cycle")
			return
		}
	}
	// 单轮互斥（进程内防 tick 与手动触发并发重入）
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

	// 确定性周期 Go 直跑：清扫 → 投票结算（换入/否决）→ 过期标记/建单/基线推进
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

	// 维护者兜底引擎 tick（BYOK 转录，Node 锚定语义——D组后续刀 1 后端点仅剩此职责）；
	// fail-closed：无 web 执行体（配置残缺）即跳过，租约到期自愈
	if r.webClient == nil {
		log.Printf("[auto-update] no engine executor configured, skipping engine tick")
		return
	}
	if err := r.webClient.RunMarketEngineTick(ctx); err != nil {
		log.Printf("[auto-update] engine tick failed: %v", err)
	}
}

// runOnce private alias for RunOnce.
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

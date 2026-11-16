package scheduler

import (
	"context"
	"log"
	"time"

	"github.com/opengits/worker-sidecar/internal/market"
)

// ─────────────────────────────────────────────────────────────
// 全站后台孤儿任务与超时回收守护器（Orphan Sweeper）
//
// 彻底消除全站后台定时调度与任务回收的“过渡态裂脑”与双端租约竞争：
// 1. ImportJob：按 StaleAfterMs（默认 60s，IMPORT_JOB_STALE_AFTER_MS）回收心跳超时的 RUNNING 任务至 FAILED；按 FinishedJobTtlDays（默认 30 天）清理完工旧 Job；
// 2. TranscriptionJob：按 TranscriptionStaleMs（默认 10m）回收认领超时的 RUNNING 任务回 QUEUED（保留断点续接）；
// 3. ChapterUpdateJob：回收市场超租约 CLAIMED ➔ PENDING（清认领与冻结）；坏 TRIAL ➔ FAILED；若具备 market.Store 能力则联动 SettleExpiredMarketTrials 结算超期 TRIAL；
// 4. SchedulerLease：物理清理过期超过 24 小时的孤儿租约记录，防止租约表无界膨胀；
// 5. 分布式互斥：runner.go 挂载 orphan-sweeper，由 PostgreSQL SchedulerLease 进行互斥（key="orphan-sweeper"）。
// ─────────────────────────────────────────────────────────────

// OrphanSweeperStore 孤儿清扫所需最小数据访问契约（pgxStore 单实现；单测 fake）。
type OrphanSweeperStore interface {
	ReapStaleImportJobs(ctx context.Context, staleBefore time.Time) (int64, error)
	GcFinishedImportJobs(ctx context.Context, ttlBefore time.Time) (int64, error)
	ReapStaleTranscriptionJobs(ctx context.Context, staleBefore time.Time) (int64, error)
	ReleaseExpiredClaims(ctx context.Context) (int64, error)
	FailTrialsWithoutStaging(ctx context.Context) (int64, error)
	CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error)
}

// OrphanSweepReport 统一清扫结果报表。
type OrphanSweepReport struct {
	ReapedImportJobs        int64 `json:"reapedImportJobs"`
	GcImportJobs            int64 `json:"gcImportJobs"`
	ReapedTranscriptionJobs int64 `json:"reapedTranscriptionJobs"`
	ReleasedMarketClaims    int64 `json:"releasedMarketClaims"`
	FailedMarketTrials      int64 `json:"failedMarketTrials"`
	SwappedMarketTrials     int64 `json:"swappedMarketTrials"`
	RejectedMarketTrials    int64 `json:"rejectedMarketTrials"`
	ExpiredLeasesCleaned    int64 `json:"expiredLeasesCleaned"`
	DurationMs              int64 `json:"durationMs"`
}

// SweeperSummary 别名兼容导出
type SweeperSummary = OrphanSweepReport

// RunOrphanSweep 执行一次全量孤儿与超时任务回收并返回统计报告。
func RunOrphanSweep(ctx context.Context, store OrphanSweeperStore, cfg Config, onIndexRefresh ...func(string)) (*OrphanSweepReport, error) {
	start := time.Now()
	report := &OrphanSweepReport{}
	defer func() {
		report.DurationMs = time.Since(start).Milliseconds()
	}()

	if err := ctx.Err(); err != nil {
		return report, err
	}

	now := time.Now().UTC()

	// 1. ImportJob 心跳超时回收与超期完工 GC
	staleAfterMs := cfg.StaleAfterMs
	if staleAfterMs <= 0 {
		staleAfterMs = 5 * 60 * 1000 // 默认 5 分钟
	}
	importStaleBefore := now.Add(-time.Duration(staleAfterMs) * time.Millisecond)
	if n, err := store.ReapStaleImportJobs(ctx, importStaleBefore); err != nil {
		log.Printf("[orphan-sweeper] reap stale import jobs error: %v", err)
	} else {
		report.ReapedImportJobs = n
		if n > 0 {
			log.Printf("[orphan-sweeper] reaped %d stale import jobs (heartbeat expired)", n)
		}
	}

	if err := ctx.Err(); err != nil {
		return report, err
	}

	ttlDays := cfg.FinishedJobTtlDays
	if ttlDays <= 0 {
		ttlDays = 30 // 默认 30 天
	}
	importTtlBefore := now.Add(-time.Duration(ttlDays) * 24 * time.Hour)
	if n, err := store.GcFinishedImportJobs(ctx, importTtlBefore); err != nil {
		log.Printf("[orphan-sweeper] gc finished import jobs error: %v", err)
	} else {
		report.GcImportJobs = n
	}

	if err := ctx.Err(); err != nil {
		return report, err
	}

	// 2. TranscriptionJob 认领超时回收（回 QUEUED 供断点续接）
	txStaleMs := cfg.TranscriptionStaleMs
	if txStaleMs <= 0 {
		txStaleMs = 10 * 60 * 1000 // 默认 10 分钟
	}
	txStaleBefore := now.Add(-time.Duration(txStaleMs) * time.Millisecond)
	if n, err := store.ReapStaleTranscriptionJobs(ctx, txStaleBefore); err != nil {
		log.Printf("[orphan-sweeper] reap stale transcription jobs error: %v", err)
	} else {
		report.ReapedTranscriptionJobs = n
		if n > 0 {
			log.Printf("[orphan-sweeper] reaped %d stale transcription jobs back to QUEUED (Dead Man's Switch)", n)
		}
	}

	if err := ctx.Err(); err != nil {
		return report, err
	}

	// 3. 更新市场超时清扫：CLAIMED ➔ PENDING, 坏 TRIAL ➔ FAILED
	if n, err := store.ReleaseExpiredClaims(ctx); err != nil {
		log.Printf("[orphan-sweeper] release expired market claims error: %v", err)
	} else {
		report.ReleasedMarketClaims = n
	}

	if err := ctx.Err(); err != nil {
		return report, err
	}

	if n, err := store.FailTrialsWithoutStaging(ctx); err != nil {
		log.Printf("[orphan-sweeper] fail trials without staging error: %v", err)
	} else {
		report.FailedMarketTrials = n
	}

	if err := ctx.Err(); err != nil {
		return report, err
	}

	// 若 store 支持结算面，则联动 SettleExpiredMarketTrials 批量裁定与换入
	if ms, ok := store.(market.Store); ok {
		var refreshCb func(string)
		if len(onIndexRefresh) > 0 && onIndexRefresh[0] != nil {
			refreshCb = onIndexRefresh[0]
		}
		swapped, rejected := market.SettleExpiredMarketTrials(ctx, cfg.Market, ms, refreshCb)
		report.SwappedMarketTrials = int64(swapped)
		report.RejectedMarketTrials = int64(rejected)
	}

	if err := ctx.Err(); err != nil {
		return report, err
	}

	// 4. 清理过期超过 24 小时的孤儿 SchedulerLease 记录
	leaseExpiredBefore := now.Add(-24 * time.Hour)
	if n, err := store.CleanExpiredLeases(ctx, leaseExpiredBefore); err != nil {
		log.Printf("[orphan-sweeper] clean expired leases error: %v", err)
	} else {
		report.ExpiredLeasesCleaned = n
	}

	return report, ctx.Err()
}

// RunOrphanSweeperOnce 单轮互斥执行（对齐 runner 各周期任务）。
func RunOrphanSweeperOnce(ctx context.Context, cfg Config, store TaskStore, onIndexRefresh ...func(string)) {
	if store == nil {
		return
	}
	intervalSec := envIntOr("ORPHAN_SWEEPER_INTERVAL_SEC", 60)
	if intervalSec <= 0 {
		intervalSec = 60
	}
	ttl := leaseTtlFromInterval(time.Duration(intervalSec) * time.Second)
	if ttl < 30*time.Second {
		ttl = 30 * time.Second
	}

	if !acquireLease(ctx, store, "orphan-sweeper", ttl) {
		log.Printf("[orphan-sweeper] lease held elsewhere, skip this cycle")
		return
	}

	sweeperStore, ok := store.(OrphanSweeperStore)
	if !ok {
		log.Printf("[orphan-sweeper] store does not implement OrphanSweeperStore")
		return
	}

	report, err := RunOrphanSweep(ctx, sweeperStore, cfg, onIndexRefresh...)
	if err != nil {
		log.Printf("[orphan-sweeper] cycle error: %v", err)
		return
	}
	log.Printf("[orphan-sweeper] sweep completed in %dms (import: reaped=%d gc=%d, tx: reaped=%d, market: claims=%d failed=%d swapped=%d rejected=%d, leases=%d)",
		report.DurationMs, report.ReapedImportJobs, report.GcImportJobs, report.ReapedTranscriptionJobs,
		report.ReleasedMarketClaims, report.FailedMarketTrials, report.SwappedMarketTrials, report.RejectedMarketTrials,
		report.ExpiredLeasesCleaned)
}

func runOrphanSweeperOnce(ctx context.Context, cfg Config, store TaskStore, onIndexRefresh ...func(string)) {
	RunOrphanSweeperOnce(ctx, cfg, store, onIndexRefresh...)
}

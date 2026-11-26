package scheduler

import (
	"context"
	"log"
	"time"

	"github.com/opengits/worker-sidecar/internal/market"
)

type OrphanSweeperStore interface {
	ReapStaleImportJobs(ctx context.Context, staleBefore time.Time) (int64, error)
	GcFinishedImportJobs(ctx context.Context, ttlBefore time.Time) (int64, error)
	ReapStaleTranscriptionJobs(ctx context.Context, staleBefore time.Time) (int64, error)
	ReleaseExpiredClaims(ctx context.Context) (int64, error)
	FailTrialsWithoutStaging(ctx context.Context) (int64, error)
	CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error)
}

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

type SweeperSummary = OrphanSweepReport

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

	staleAfterMs := cfg.StaleAfterMs
	if staleAfterMs <= 0 {
		staleAfterMs = 5 * 60 * 1000
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
		ttlDays = 30
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

	txStaleMs := cfg.TranscriptionStaleMs
	if txStaleMs <= 0 {
		txStaleMs = 10 * 60 * 1000
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

	leaseExpiredBefore := now.Add(-24 * time.Hour)
	if n, err := store.CleanExpiredLeases(ctx, leaseExpiredBefore); err != nil {
		log.Printf("[orphan-sweeper] clean expired leases error: %v", err)
	} else {
		report.ExpiredLeasesCleaned = n
	}

	return report, ctx.Err()
}

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

package scheduler

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

// ─────────────────────────────────────────────────────────────
// 流水表保留期清理（原移植自 TS prune-telemetry.ts runPruneOnce；TS 原体已退役，本包为唯一实现）。
// 各段独立容错，单段失败不影响其余段；分批删除避免长事务锁全表。
// 顺序：runRetentionPrune（5 流水表 + 过期 Session）→ assets 孤儿清扫 →
// 孤儿内容层回收 → 章节版本 GC → 配额日志 7 天清理。
// ─────────────────────────────────────────────────────────────

const quotaLogRetentionDays = 7

// RunPruneOnce 执行一轮流水表、孤儿资源与版本 GC 清理。
func RunPruneOnce(ctx context.Context, cfg Config, store TaskStore) {
	intervalMin := envIntervalMinOr("PRUNE_INTERVAL_MIN", 1440)
	// leader 租约：与 Node prune-telemetry 同 key——两侧混跑时同一轮全局单执行
	if !acquireLease(ctx, store, "prune-telemetry", leaseTtlFromInterval(time.Duration(intervalMin)*time.Minute)) {
		log.Printf("[prune] lease held elsewhere, skip this cycle")
		return
	}
	runRetentionPrune(ctx, cfg, store)
	sweepOrphanAssetDirs(ctx, cfg, store)
	orphanContentGcOnce(ctx, cfg, store)
	staleVersionGcOnce(ctx, cfg, store)
	if _, err := store.DeleteQuotaLogsBefore(ctx, time.Now().UTC().Add(-quotaLogRetentionDays*24*time.Hour)); err != nil {
		log.Printf("[prune] quota log cleanup failed: %v", err)
	}
}

func runPruneOnce(ctx context.Context, cfg Config, store TaskStore) {
	RunPruneOnce(ctx, cfg, store)
}

// DeleteInBatches 对齐 Node deleteInBatches：每轮选主键再按主键删，count < rows 终止。
func DeleteInBatches(ctx context.Context, store TaskStore, table string, cutoff time.Time, batchSize int) (int, error) {
	if batchSize <= 0 {
		batchSize = 500
	}
	total := 0
	for {
		ids, err := store.PickIdsBefore(ctx, table, "createdAt", cutoff, batchSize)
		if err != nil {
			return total, err
		}
		if len(ids) == 0 {
			break
		}
		n, err := store.DeleteIds(ctx, table, ids)
		if err != nil {
			return total, err
		}
		total += int(n)
		if int(n) < len(ids) {
			break // 并发写入被删，保守终止
		}
	}
	return total, nil
}

func deleteInBatches(ctx context.Context, store TaskStore, table string, cutoff time.Time, batchSize int) (int, error) {
	return DeleteInBatches(ctx, store, table, cutoff, batchSize)
}

func deleteColdDissectionCacheInBatches(ctx context.Context, store TaskStore, cutoff time.Time, maxHits int, batchSize int) (int, error) {
	if batchSize <= 0 {
		batchSize = 500
	}
	total := 0
	for {
		ids, err := store.PickColdDissectionCacheIds(ctx, cutoff, maxHits, batchSize)
		if err != nil {
			return total, err
		}
		if len(ids) == 0 {
			break
		}
		n, err := store.DeleteIds(ctx, "DissectionCache", ids)
		if err != nil {
			return total, err
		}
		total += int(n)
		if int(n) < len(ids) {
			break
		}
	}
	return total, nil
}

// RunRetentionPrune 执行流水表保留期清理并返回各表清理统计。
func RunRetentionPrune(ctx context.Context, cfg Config, store TaskStore) map[string]int {
	daysAgo := func(days int) time.Time { return time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour) }
	report := map[string]int{}

	steps := []struct {
		key string
		run func() (int, error)
	}{
		{"episodicEvent", func() (int, error) {
			return deleteInBatches(ctx, store, "EpisodicEvent", daysAgo(cfg.RetentionEpisodicDays), cfg.PruneBatchSize)
		}},
		{"monitorEvent", func() (int, error) {
			return deleteInBatches(ctx, store, "MonitorEvent", daysAgo(cfg.RetentionMonitorDays), cfg.PruneBatchSize)
		}},
		{"mcpCallLog", func() (int, error) {
			return deleteInBatches(ctx, store, "McpCallLog", daysAgo(cfg.RetentionMcpCallLogDays), cfg.PruneBatchSize)
		}},
		{"tokenUsageLog", func() (int, error) {
			return deleteInBatches(ctx, store, "TokenUsageLog", daysAgo(cfg.RetentionTokenUsageDays), cfg.PruneBatchSize)
		}},
		{"adminAuditLog", func() (int, error) {
			return deleteInBatches(ctx, store, "AdminAuditLog", daysAgo(cfg.RetentionAdminAuditDays), cfg.PruneBatchSize)
		}},
		{"gatewaySecurityEvent", func() (int, error) {
			return deleteInBatches(ctx, store, "GatewaySecurityEvent", daysAgo(cfg.RetentionGatewayEvDays), cfg.PruneBatchSize)
		}},
		{"daemonTaskRun", func() (int, error) {
			days := cfg.RetentionDaemonTaskRunDays
			if days <= 0 {
				days = 7
			}
			return deleteInBatches(ctx, store, "DaemonTaskRun", daysAgo(days), cfg.PruneBatchSize)
		}},
		{"importJobEvent", func() (int, error) {
			days := cfg.RetentionImportJobEventDays
			if days <= 0 {
				days = 14
			}
			return deleteInBatches(ctx, store, "ImportJobEvent", daysAgo(days), cfg.PruneBatchSize)
		}},
		{"coldDissectionCache", func() (int, error) {
			days := cfg.RetentionDissectionCacheDays
			if days <= 0 {
				days = 30
			}
			return deleteColdDissectionCacheInBatches(ctx, store, daysAgo(days), 5, cfg.PruneBatchSize)
		}},
		{"sessionExpired", func() (int, error) {
			return deleteSessions(ctx, store)
		}},
	}
	for _, step := range steps {
		n, err := step.run()
		if err != nil {
			log.Printf("[TelemetryPrune] Failed to prune %s: %v", step.key, err)
			report[step.key] = -1
			continue
		}
		report[step.key] = n
	}
	out, _ := json.Marshal(report)
	log.Printf("[TelemetryPrune] retention prune report: %s", out)
	return report
}

func runRetentionPrune(ctx context.Context, cfg Config, store TaskStore) map[string]int {
	return RunRetentionPrune(ctx, cfg, store)
}

func deleteSessions(ctx context.Context, store TaskStore) (int, error) {
	n, err := store.DeleteExpiredSessions(ctx)
	return int(n), err
}

// ── assets 孤儿清扫（local 分支；对齐 storage/assets-gc.ts sweepOrphanAssetDirs）──
// 非 local 存储驱动本轮跳过（对象存储分支留 Node；部署面 STORAGE_DRIVER 决定归属）。

type SweepReport struct {
	DryRun         bool `json:"dryRun"`
	ScannedDirs    int  `json:"scannedDirs"`
	RemovedDirs    int  `json:"removedDirs"`
	SkippedByGrace int  `json:"skippedByGrace"`
}

// SweepOrphanAssetDirs 执行本地 assets 孤儿目录清扫。
func SweepOrphanAssetDirs(ctx context.Context, cfg Config, store TaskStore) {
	if cfg.StorageDriver != "local" {
		log.Printf("[prune] assets gc skipped: non-local storage driver (%s) — handled by Node side", cfg.StorageDriver)
		return
	}
	report := SweepReport{DryRun: cfg.AssetsGcDryRun}
	active, err := store.ActiveRepoKeys(ctx)
	if err != nil {
		log.Printf("[prune] assets gc failed: %v", err)
		return
	}
	graceCutoff := time.Duration(cfg.AssetsOrphanGraceDays) * 24 * time.Hour

	owners, err := os.ReadDir(cfg.AssetsRoot)
	if err != nil {
		// 根目录不存在 = 空仓布局，非错误（对齐 Node fs.readdir catch → []）
		log.Printf("[prune] assets gc: root unreadable (%v), nothing to sweep", err)
		return
	}
	for _, o := range owners {
		if !o.IsDir() {
			continue
		}
		repos, err := os.ReadDir(filepath.Join(cfg.AssetsRoot, o.Name()))
		if err != nil {
			continue
		}
		for _, r := range repos {
			if !r.IsDir() {
				continue
			}
			report.ScannedDirs++
			key := o.Name() + "/" + r.Name()
			if active[key] {
				continue // 活跃仓整体跳过
			}
			repoDir := filepath.Join(cfg.AssetsRoot, o.Name(), r.Name())
			st, err := os.Stat(repoDir)
			if err != nil {
				continue
			}
			if time.Since(st.ModTime()) <= graceCutoff {
				report.SkippedByGrace++
				continue
			}
			if report.DryRun {
				report.RemovedDirs++ // dry-run：统计"将删除"
				continue
			}
			if err := os.RemoveAll(repoDir); err != nil {
				// 单目录失败不中断整轮
				continue
			}
			report.RemovedDirs++
		}
	}
	out, _ := json.Marshal(report)
	log.Printf("[prune] assets sweep report: %s", out)
}

func sweepOrphanAssetDirs(ctx context.Context, cfg Config, store TaskStore) {
	SweepOrphanAssetDirs(ctx, cfg, store)
}

// ── 孤儿内容层回收（对齐 content-addressing.ts orphanContentGcOnce）──
// 无 Document 薄行指针且无 ChapterVersion 引用、超宽限的 DocumentContent 真删；
// 版本行删除后其内容行自然回流到本清扫（grace 期内可被复用）。

// OrphanContentGcOnce 回收孤儿 DocumentContent。
func OrphanContentGcOnce(ctx context.Context, cfg Config, store TaskStore) {
	cutoff := time.Now().UTC().Add(-time.Duration(cfg.OrphanContentGraceDays) * 24 * time.Hour)
	scanned, removed := 0, 0
	for {
		if removed >= cfg.OrphanGcMaxPerRun {
			break
		}
		ids, err := store.PickOrphanContentIds(ctx, cutoff, cfg.OrphanGcBatch)
		if err != nil {
			log.Printf("[prune] content gc failed: %v", err)
			return
		}
		if len(ids) == 0 {
			break
		}
		scanned += len(ids)
		n, err := store.DeleteIds(ctx, "DocumentContent", ids)
		if err != nil {
			log.Printf("[prune] content gc failed: %v", err)
			return
		}
		removed += int(n)
		if int(n) < len(ids) {
			break // 并发被引用，保守终止
		}
	}
	log.Printf("[ContentGC] orphan sweep done: scanned=%d removed=%d graceDays=%d", scanned, removed, cfg.OrphanContentGraceDays)
}

func orphanContentGcOnce(ctx context.Context, cfg Config, store TaskStore) {
	OrphanContentGcOnce(ctx, cfg, store)
}

// ── 章节版本 GC（原对齐 TS staleVersionGcOnce；TS 原体已随单写者下沉退役）──

// StaleVersionGcOnce 回收过期或陈旧 ChapterVersion。
func StaleVersionGcOnce(ctx context.Context, cfg Config, store TaskStore) {
	publicCutoff := time.Now().UTC().Add(-time.Duration(cfg.VersionGcDays) * 24 * time.Hour)
	privateCutoff := time.Now().UTC().Add(-time.Duration(cfg.PrivateVersionGcDays) * 24 * time.Hour)

	removedPublic, err := store.DeleteStalePublicVersions(ctx, publicCutoff)
	if err != nil {
		log.Printf("[prune] version gc failed (public): %v", err)
		return
	}
	removedPrivate, err := store.DeleteExpiredPrivateVersions(ctx, privateCutoff)
	if err != nil {
		log.Printf("[prune] version gc failed (private): %v", err)
		return
	}
	if n := removedPublic + removedPrivate; n > 0 {
		log.Printf("[version-gc] removed %d stale versions (public=%d, private=%d)", n, removedPublic, removedPrivate)
	}
}

func staleVersionGcOnce(ctx context.Context, cfg Config, store TaskStore) {
	StaleVersionGcOnce(ctx, cfg, store)
}

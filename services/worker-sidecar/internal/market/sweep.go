package market

import (
	"context"
	"log"
)

// ─────────────────────────────────────────────────────────────
// 更新市场超时清扫的确定性段（M3 尾刀，逐字对齐 update-market/jobs.ts
// resolveTimeouts 的两段纯 updateMany）：CLAIMED 超租约回池 + TRIAL 坏任务
// 终态化。TRIAL 换入/否决由结算段处理，CAS 保证幂等。
// ─────────────────────────────────────────────────────────────

// Sweeper 清扫两段最小接口（pgxStore 实现；单测 fake）。
type Sweeper interface {
	ReleaseExpiredClaims(ctx context.Context) (int64, error)
	FailTrialsWithoutStaging(ctx context.Context) (int64, error)
}

// SweepMarketTimeouts Go 侧前置清扫（auto-update runner 每轮 spawn 前执行；
// 与子进程内 resolveTimeouts 幂等共存——两段均为 CAS updateMany）。
func SweepMarketTimeouts(ctx context.Context, s Sweeper) {
	if n, err := s.ReleaseExpiredClaims(ctx); err == nil && n > 0 {
		log.Printf("[auto-update] go sweep: released %d expired claims", n)
	}
	if n, err := s.FailTrialsWithoutStaging(ctx); err == nil && n > 0 {
		log.Printf("[auto-update] go sweep: terminalized %d bad TRIAL jobs", n)
	}
}

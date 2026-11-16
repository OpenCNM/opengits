package scheduler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"time"
)

// ─────────────────────────────────────────────────────────────
// 调度器 leader 租约（逐字移植 apps/client/src/lib/scheduler/lease.ts）。
//
// 为什么不用 pg_advisory_lock：session 锁在连接池下跨查询不可靠；
// xact 锁要求整个调度周期持有连接（upstream-check 单轮分钟级）。
//
// 租约语义（CAS + 唯一约束兜底）：
// - 抢租/续租：UPDATE WHERE key AND (自己持有 OR 已过期)；
//   未命中则 INSERT（唯一键冲突 = 他人持有未过期 → false）。
// - 到期自愈：持有者崩溃后 lockedUntil 过期，任意实例可抢。
// - 同实例续租幂等：ownerId 匹配即续。
// 已知局限（fencing）：任务轮执行体超过 TTL 时互斥退化为双跑——
// 任务体自身幂等或控制单轮时长 < TTL（当前任务均满足）。
// ─────────────────────────────────────────────────────────────

// leaseOwner 形如 Node 侧 `worker-${pid}-${hex}`，加 go 段便于运维区分执行端。
var leaseOwner = func() string {
	b := make([]byte, 2)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败不可恢复，直接让进程起不来
		log.Fatal("[lease] rand read failed:", err)
	}
	return fmt.Sprintf("worker-go-%d-%s", os.Getpid(), hex.EncodeToString(b))
}()

// LeaseOwner 返回当前进程的租约持有者标识。
func LeaseOwner() string {
	return leaseOwner
}

// AcquireLeaseWithOwner 尝试获取/续租某任务的 leader 租约，支持外部指定 owner 标识（如 Node 侧调用）。
func AcquireLeaseWithOwner(ctx context.Context, store TaskStore, key, owner string, ttl time.Duration) bool {
	if owner == "" {
		owner = leaseOwner
	}
	until := time.Now().Add(ttl).UTC()
	n, err := store.LeaseUpdateIfHeldOrExpired(ctx, key, owner, until)
	if err == nil && n == 1 {
		return true
	}
	if err != nil {
		log.Printf("[lease] acquire (fast path) failed for %s (skip this cycle): %v", key, err)
		return false
	}
	if err := store.LeaseInsert(ctx, key, owner, until); err != nil {
		// 唯一键冲突 = 他人健康持有中；其他异常（DB 抖动）同样跳过本轮
		log.Printf("[lease] acquire failed for %s (skip this cycle): %v", key, err)
		return false
	}
	return true
}

// AcquireLease 尝试获取/续租某任务的 leader 租约。
// key 与 Node task-registry name 一致（两侧混跑时同一互斥域）。
// 任何 DB 异常按未获锁处理——宁可跳过一轮也不双跑。
func AcquireLease(ctx context.Context, store TaskStore, key string, ttl time.Duration) bool {
	return AcquireLeaseWithOwner(ctx, store, key, leaseOwner, ttl)
}

func acquireLease(ctx context.Context, store TaskStore, key string, ttl time.Duration) bool {
	return AcquireLease(ctx, store, key, ttl)
}

// LeaseTtlFromInterval 由调度周期推导租约 TTL（周期 × 2）。
func LeaseTtlFromInterval(d time.Duration) time.Duration { return d * 2 }

func leaseTtlFromInterval(d time.Duration) time.Duration { return LeaseTtlFromInterval(d) }

// ReleaseLeaseWithOwner 释放指定 owner 持有的租约。
func ReleaseLeaseWithOwner(ctx context.Context, store TaskStore, key, owner string) {
	if owner == "" {
		owner = leaseOwner
	}
	_ = store.LeaseDelete(ctx, key, owner)
}

// ReleaseLease 释放本进程持有的租约（ownerId 限定——只会释放自己的）。
// 优雅退出时调用，避免重启后新 owner 抢不到导致调度空转至 TTL 耗尽。
func ReleaseLease(ctx context.Context, store TaskStore, key string) {
	ReleaseLeaseWithOwner(ctx, store, key, leaseOwner)
}

func releaseLease(ctx context.Context, store TaskStore, key string) {
	ReleaseLease(ctx, store, key)
}

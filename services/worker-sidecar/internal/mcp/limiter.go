package mcp

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

// 语义对齐 rate-limiter.ts McpRateLimiter.checkLimit：
// 封禁 403 → RPM 滑窗 429 → 日配额（DB 账本）429 → 记账（内存窗口 + ledger increment）。
// RPM 为进程内滑窗（单实例精确；Go 边缘接管后限流点从 Node 收敛到这里）。
type RateLimiter struct {
	store Store

	mu    sync.Mutex
	stats map[string][]int64 // userId → 60s 窗口内时间戳

	// ledgerCache 日配额计数短 TTL 缓存（含本进程增量）：消除每请求一次
	// 账本读往返。计费敏感——Increment 仍逐请求落账本；缓存仅作用于
	// Check 的读路径，计数达配额 90% 强制回源收敛超配窗口。
	ledgerMu    sync.Mutex
	ledgerCache map[string]ledgerCacheEntry
}

// ledgerCacheTTL 账本读缓存窗口（超配容忍窗口 = TTL × RPM 上限）。
const ledgerCacheTTL = 30 * time.Second

// ledgerPersistInterval 记账持久化节流窗口：限流判定走本地 delta（实时不受
// 影响），DB 落账降为每用户每秒至多一次增量写；进程硬停至多丢一个窗口计数。
var ledgerPersistInterval = time.Second

type ledgerCacheEntry struct {
	count    int
	delta    int // 本进程自加载以来的 LedgerIncrement 增量
	loadedAt time.Time

	// persist 节流落账状态（pending 尚未落库的增量；persistAt 上次落账时间；
	// flushing 防并发双记：快照式取走在途量，失败回滚重试）
	pending   int
	persistAt time.Time
	flushing  bool
}

func NewRateLimiter(store Store) *RateLimiter {
	return &RateLimiter{store: store, stats: make(map[string][]int64), ledgerCache: make(map[string]ledgerCacheEntry)}
}

type RateLimitResult struct {
	Allowed  bool
	Reason   string // BANNED / RPM_EXCEEDED / DAILY_QUOTA_EXCEEDED
	Status   int
	Headers  map[string]string
	ErrorFmt string // JSON-RPC 错误体（含 %s 占位的计数信息），空 = 允许
}

func (r *RateLimiter) Check(ctx context.Context, userID string, quota UserQuota, now time.Time) RateLimitResult {
	// Admins have unlimited access（对齐 Node：daily=0 无限，rpm 提至 600）
	if quota.Role == "ADMIN" || quota.Role == "SUPER_ADMIN" {
		quota.DailyLimit = 0
		quota.RpmLimit = 600
		quota.TokenCap = 32000
	}

	if quota.IsBanned {
		return RateLimitResult{
			Allowed: false, Reason: "BANNED", Status: 403,
			Headers:  map[string]string{"x-ratelimit-banned": "true"},
			ErrorFmt: `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Access Denied: Account is currently suspended by system administrator."},"id":null}`,
		}
	}

	day := utcDayKey(now)
	var dailyCount int
	if quota.DailyLimit > 0 {
		dailyCount = r.ledgerDailyCount(ctx, userID, day, quota.DailyLimit, now)
	}

	// RPM 滑动窗口
	windowStart := now.UnixMilli() - 60*1000
	r.mu.Lock()

	// 内存空窗口条目回收：当追踪用户数超过 512 时，清扫全表过期条目，彻底消除内存无界膨胀
	if len(r.stats) > 512 {
		for uid, tsList := range r.stats {
			if len(tsList) == 0 {
				delete(r.stats, uid)
				continue
			}
			allExpired := true
			for _, ts := range tsList {
				if ts > windowStart {
					allExpired = false
					break
				}
			}
			if allExpired {
				delete(r.stats, uid)
			}
		}
	}

	timestamps := r.stats[userID]
	kept := timestamps[:0]
	for _, ts := range timestamps {
		if ts > windowStart {
			kept = append(kept, ts)
		}
	}
	currentRpm := len(kept)
	rpmRemaining := max0(quota.RpmLimit - currentRpm)
	dailyRemaining := 999999
	if quota.DailyLimit > 0 {
		dailyRemaining = max0(quota.DailyLimit - dailyCount)
	}

	headers := map[string]string{
		"x-ratelimit-limit-rpm":       fmt.Sprint(quota.RpmLimit),
		"x-ratelimit-remaining-rpm":   fmt.Sprint(rpmRemaining),
		"x-ratelimit-limit-daily":     fmt.Sprint(quota.DailyLimit),
		"x-ratelimit-remaining-daily": fmt.Sprint(dailyRemaining),
		"x-ratelimit-tokencap":        fmt.Sprint(quota.TokenCap),
	}

	if quota.RpmLimit > 0 && currentRpm >= quota.RpmLimit {
		if len(kept) == 0 {
			delete(r.stats, userID)
		} else {
			r.stats[userID] = kept
		}
		r.mu.Unlock()
		h := cloneHeaders(headers)
		h["Retry-After"] = "60"
		return RateLimitResult{
			Allowed: false, Reason: "RPM_EXCEEDED", Status: 429, Headers: h,
			ErrorFmt: fmt.Sprintf(`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Rate limit exceeded: Requests Per Minute (RPM) limit reached (%d/%d RPM). Please slow down.","data":{"retryAfterSeconds":60,"limitType":"RPM"}},"id":null}`, currentRpm, quota.RpmLimit),
		}
	}

	if quota.DailyLimit > 0 && dailyCount >= quota.DailyLimit {
		if len(kept) == 0 {
			delete(r.stats, userID)
		} else {
			r.stats[userID] = kept
		}
		r.mu.Unlock()
		return RateLimitResult{
			Allowed: false, Reason: "DAILY_QUOTA_EXCEEDED", Status: 429, Headers: headers,
			ErrorFmt: fmt.Sprintf(`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Rate limit exceeded: Daily MCP tool quota reached (%d/%d requests/day). Please try again tomorrow.","data":{"limitType":"DAILY_QUOTA"}},"id":null}`, dailyCount, quota.DailyLimit),
		}
	}

	// 记账：内存窗口 + 本地 delta（实时）+ 节流持久化（每用户每秒至多一次落库）
	kept = append(kept, now.UnixMilli())
	r.stats[userID] = kept
	r.mu.Unlock()
	r.trackLedgerDelta(userID, day)
	r.persistLedgerThrottled(ctx, userID, day)

	postRpm := max0(quota.RpmLimit - len(kept))
	postDaily := 999999
	if quota.DailyLimit > 0 {
		postDaily = max0(quota.DailyLimit - dailyCount - 1)
	}
	return RateLimitResult{
		Allowed: true, Status: 200,
		Headers: map[string]string{
			"x-ratelimit-limit-rpm":       fmt.Sprint(quota.RpmLimit),
			"x-ratelimit-remaining-rpm":   fmt.Sprint(postRpm),
			"x-ratelimit-limit-daily":     fmt.Sprint(quota.DailyLimit),
			"x-ratelimit-remaining-daily": fmt.Sprint(postDaily),
			"x-ratelimit-tokencap":        fmt.Sprint(quota.TokenCap),
		},
	}
}

// persistLedgerThrottled 节流落账：窗口内只累积 pending，窗口到期一次性
// 增量写库（快照取走，失败回滚下窗口重试）。首个请求立即落账（persistAt 零值），
// 与旧行为的测试观测面一致。
func (r *RateLimiter) persistLedgerThrottled(ctx context.Context, userID, day string) {
	r.ledgerMu.Lock()
	e, ok := r.ledgerCache[userID+"|"+day]
	if !ok {
		e = ledgerCacheEntry{}
	}
	e.pending++
	if e.flushing || time.Since(e.persistAt) < ledgerPersistInterval {
		r.ledgerCache[userID+"|"+day] = e
		r.ledgerMu.Unlock()
		return
	}
	n := e.pending
	e.pending = 0
	e.persistAt = time.Now()
	e.flushing = true
	r.ledgerCache[userID+"|"+day] = e
	r.ledgerMu.Unlock()

	err := r.ledgerWrite(ctx, userID, day, n)

	r.ledgerMu.Lock()
	e = r.ledgerCache[userID+"|"+day]
	e.flushing = false
	if err != nil {
		e.pending += n // 失败回滚：下个窗口连同新增量一并重试
	}
	r.ledgerCache[userID+"|"+day] = e
	r.ledgerMu.Unlock()
}

// ledgerWrite 优先批量增量（pgxStore）；测试替身回落为 n 次单增（观测面不变）。
func (r *RateLimiter) ledgerWrite(ctx context.Context, userID, day string, n int) error {
	if lb, ok := r.store.(interface {
		LedgerIncrementBy(ctx context.Context, userID, day string, n int) error
	}); ok {
		return lb.LedgerIncrementBy(ctx, userID, day, n)
	}
	for i := 0; i < n; i++ {
		if err := r.store.LedgerIncrement(ctx, userID, day); err != nil {
			return err
		}
	}
	return nil
}

// FlushPending 优雅关闭钩子：排空全部在途 pending（同步）。
func (r *RateLimiter) FlushPending() {
	type flushJob struct {
		userID, day string
		n           int
	}
	r.ledgerMu.Lock()
	jobs := make([]flushJob, 0, len(r.ledgerCache))
	for k, e := range r.ledgerCache {
		if e.pending > 0 && !e.flushing {
			jobs = append(jobs, flushJob{userID: k[:strings.Index(k, "|")], day: k[strings.Index(k, "|")+1:], n: e.pending})
			e.pending = 0
			r.ledgerCache[k] = e
		}
	}
	r.ledgerMu.Unlock()
	for _, j := range jobs {
		_ = r.ledgerWrite(context.Background(), j.userID, j.day, j.n)
	}
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

// ledgerDailyCount 日配额计数：TTL 内走缓存值+本进程增量；达配额 90%
// 强制回源（超配窗口收敛到一次往返）；读失败 fail-open 同旧路径。
func (r *RateLimiter) ledgerDailyCount(ctx context.Context, userID, day string, limit int, now time.Time) int {
	key := userID + "|" + day
	r.ledgerMu.Lock()
	if e, ok := r.ledgerCache[key]; ok && now.Sub(e.loadedAt) < ledgerCacheTTL {
		counted := e.count + e.delta
		r.ledgerMu.Unlock()
		if limit > 0 && counted*10 >= limit*9 {
			metrics.Inc("mcp.ledger_cache_near_quota_reload")
			return r.reloadLedgerCount(ctx, key, userID, day, now)
		}
		return counted
	}
	r.ledgerMu.Unlock()
	return r.reloadLedgerCount(ctx, key, userID, day, now)
}

func (r *RateLimiter) reloadLedgerCount(ctx context.Context, key, userID, day string, now time.Time) int {
	count, err := r.store.LedgerCount(ctx, userID, day)
	if err != nil {
		// fail-open：账本读失败不阻断（计数意义大于一致性）
		return 0
	}
	r.ledgerMu.Lock()
	// 空间回收：表超限时清掉过期与跨日条目
	if len(r.ledgerCache) > 512 {
		for k, e := range r.ledgerCache {
			if now.Sub(e.loadedAt) >= ledgerCacheTTL {
				delete(r.ledgerCache, k)
			}
		}
	}
	r.ledgerCache[key] = ledgerCacheEntry{count: count, loadedAt: now}
	r.ledgerMu.Unlock()
	return count
}

// trackLedgerDelta 记录本进程自缓存加载以来的增量（缓存值+delta 即有效计数）。
func (r *RateLimiter) trackLedgerDelta(userID, day string) {
	key := userID + "|" + day
	r.ledgerMu.Lock()
	if e, ok := r.ledgerCache[key]; ok {
		e.delta++
		r.ledgerCache[key] = e
	}
	r.ledgerMu.Unlock()
}

func cloneHeaders(h map[string]string) map[string]string {
	out := make(map[string]string, len(h))
	for k, v := range h {
		out[k] = v
	}
	return out
}

// TrackedUsersCount returns the count of users currently tracked in memory.

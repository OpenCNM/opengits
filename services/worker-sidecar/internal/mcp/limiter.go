package mcp

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

type RateLimiter struct {
	store Store

	mu    sync.Mutex
	stats map[string][]int64

	// Cache ledger reads in memory and bypass cache at >=90% quota to bound over-allocation within one round-trip.
	ledgerMu    sync.Mutex
	ledgerCache map[string]ledgerCacheEntry
}

const ledgerCacheTTL = 30 * time.Second

// Throttle ledger DB persistence to <=1 write/user/sec while tracking real-time deltas in memory.
var ledgerPersistInterval = time.Second

type ledgerCacheEntry struct {
	count    int
	delta    int
	loadedAt time.Time

	pending   int
	persistAt time.Time
	flushing  bool
}

func NewRateLimiter(store Store) *RateLimiter {
	return &RateLimiter{store: store, stats: make(map[string][]int64), ledgerCache: make(map[string]ledgerCacheEntry)}
}

type RateLimitResult struct {
	Allowed  bool
	Reason   string
	Status   int
	Headers  map[string]string
	ErrorFmt string
}

func (r *RateLimiter) Check(ctx context.Context, userID string, quota UserQuota, now time.Time) RateLimitResult {

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

	windowStart := now.UnixMilli() - 60*1000
	r.mu.Lock()

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
		e.pending += n // Re-credit failed flush deltas so the next window retries them cleanly.
	}
	r.ledgerCache[userID+"|"+day] = e
	r.ledgerMu.Unlock()
}

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

		return 0
	}
	r.ledgerMu.Lock()

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

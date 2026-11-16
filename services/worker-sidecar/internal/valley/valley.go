// Package valley 读路径流量低谷窗口分析器。
//
// 信号源（第一性原理）：McpCallLog 是系统里唯一逐请求、带时间戳的读路径
// 事实表。低谷 = 按本地时区小时聚合后总流量最小的连续时段（环形跨午夜），
// 每日重算——流量画像漂移（用户增长/时区结构变化）时窗口自适应。
//
// Fail-Closed 语义：样本不足（< MinSamples）或查询失败且无历史窗口时，
// 一律回落保守默认窗口（00:00–05:00），绝不因数据缺失放开通行。
package valley

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	// 容器镜像无 tzdata 时兜底内嵌 IANA 时区库，LoadLocation 恒可用
	_ "time/tzdata"
)

// Window 低谷窗口（本地墙钟小时制；LenHours 跨午夜取环形语义）。
type Window struct {
	StartHour int // 0-23
	LenHours  int // 1-12
}

// Contains 判断 t（调用方已换算到目标时区）是否落在窗口内。
func (w Window) Contains(t time.Time) bool {
	off := (t.Hour() - w.StartHour + 24) % 24
	return off < w.LenHours
}

func (w Window) String() string {
	end := (w.StartHour + w.LenHours) % 24
	cross := ""
	if end <= w.StartHour {
		cross = "（跨午夜）"
	}
	return fmt.Sprintf("%02d:00–%02d:00%s", w.StartHour, end, cross)
}

// FindWindow 环形连续窗口搜索：平均流量（和/时长）最低者胜，均值并列取更长
// 窗口——净低谷段取满，均匀安静夜自动扩到时长上限（与 scripts/valley-runner.mjs
// 同语义，两处算法保持一致）。纯函数。
func FindWindow(hours [24]int, minH, maxH int) Window {
	if minH < 1 {
		minH = 1
	}
	if maxH > 24 {
		maxH = 24
	}
	if minH > maxH {
		minH = maxH
	}
	best := Window{0, minH}
	bestSum := -1
	for l := minH; l <= maxH; l++ {
		for s := 0; s < 24; s++ {
			sum := 0
			for k := 0; k < l; k++ {
				sum += hours[(s+k)%24]
			}
			// 均值比较交叉相乘避免除法；均值更低 或 均值并列但更长 才替换
			if bestSum == -1 || sum*best.LenHours < bestSum*l ||
				(sum*best.LenHours == bestSum*l && l > best.LenHours) {
				bestSum = sum
				best = Window{s, l}
			}
		}
	}
	return best
}

// Store 流量画像数据源（daemon 注入 pgx 实现；测试注入桩）。
type Store interface {
	HourlyCallCounts(ctx context.Context, since time.Time, tzOffsetMinutes int) ([24]int, error)
}

const (
	DefaultLookbackDays = 14
	DefaultMinHours     = 2
	DefaultMaxHours     = 6
	MinSamples          = 500
	recomputeInterval   = 24 * time.Hour
	retryInterval       = time.Hour
)

// Analyzer 每日重算低谷窗口。Window() 带缓存：成功后 24h 内直接命中，
// 失败按 1h 有限重试；并发安全。
type Analyzer struct {
	store    Store
	loc      *time.Location
	lookback time.Duration
	minH     int
	maxH     int
	fallback Window

	mu          sync.Mutex
	window      Window
	samples     int
	thin        bool
	nextAttempt time.Time
}

// NewAnalyzer 构造低谷分析器。loc 为判窗目标时区（nil=UTC）；
// 非法参数回落默认值而非拒绝（调度器可用性优先）。
func NewAnalyzer(store Store, loc *time.Location, lookbackDays, minH, maxH int) *Analyzer {
	if loc == nil {
		loc = time.UTC
	}
	if lookbackDays <= 0 {
		lookbackDays = DefaultLookbackDays
	}
	if minH <= 0 {
		minH = DefaultMinHours
	}
	if maxH < minH {
		maxH = minH
	}
	if maxH > 12 {
		maxH = 12
	}
	return &Analyzer{
		store:    store,
		loc:      loc,
		lookback: time.Duration(lookbackDays) * 24 * time.Hour,
		minH:     minH,
		maxH:     maxH,
		fallback: Window{StartHour: 0, LenHours: 5},
		window:   Window{StartHour: 0, LenHours: 5},
	}
}

// Snapshot 窗口画像快照（观测端点用；Window() 已含重算逻辑，此处仅读缓存）。
type Snapshot struct {
	WindowLabel  string
	LookbackDays int
	Location     string
}

// Window 返回当前低谷窗口（过期则重算）。
func (a *Analyzer) Window(ctx context.Context, now time.Time) (Window, int, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.nextAttempt.IsZero() && now.Before(a.nextAttempt) {
		return a.window, a.samples, a.thin
	}
	// McpCallLog.createdAt 为无时区 UTC 墙钟；以重算时刻的目标时区偏移平移
	// （DST 时区按该时刻偏移取值，误差 ≤1h 且 DST 切换日次日自愈）
	_, offSec := now.In(a.loc).Zone()
	hours, err := a.store.HourlyCallCounts(ctx, now.Add(-a.lookback), offSec/60)
	if err != nil {
		// 失败保旧窗口（首败回落 fallback 已在构造期生效），1h 后重试
		a.nextAttempt = now.Add(retryInterval)
		log.Printf("[valley] 流量画像查询失败，沿用窗口 %s（1h 后重试）: %v", a.window, err)
		return a.window, a.samples, a.thin
	}
	total := 0
	for _, n := range hours {
		total += n
	}
	thin := total < MinSamples
	w := FindWindow(hours, a.minH, a.maxH)
	if thin {
		w = a.fallback
	}
	changed := w != a.window
	a.window, a.samples, a.thin = w, total, thin
	a.nextAttempt = now.Add(recomputeInterval)
	if changed {
		if thin {
			log.Printf("[valley] 样本不足（%d < %d），回落保守窗口 %s", total, MinSamples, w)
		} else {
			log.Printf("[valley] 低谷窗口更新: %s（近 %d 天 %d 次调用）", w, int(a.lookback.Hours()/24), total)
		}
	}
	return a.window, a.samples, a.thin
}

// InWindow 门控判定入口（gate 闭包每 tick 调用；带缓存，未过期不发查询）。
func (a *Analyzer) InWindow(ctx context.Context, now time.Time) bool {
	w, _, _ := a.Window(ctx, now)
	return w.Contains(now.In(a.loc))
}

// Snapshot 返回观测快照（不触发查询）。
func (a *Analyzer) Snapshot() Snapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	return Snapshot{
		WindowLabel:  a.window.String(),
		LookbackDays: int(a.lookback.Hours() / 24),
		Location:     a.loc.String(),
	}
}

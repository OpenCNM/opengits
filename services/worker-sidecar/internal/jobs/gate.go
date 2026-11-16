package jobs

import (
	"bufio"
	"context"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

// MemoryObserver 物理资源探针接口（解耦操作系统物理差异与容器 cgroup）。
type MemoryObserver interface {
	GetMemoryLimit() (uint64, error)
	GetMemoryUsage() (uint64, error)
}

// defaultMemoryObserver 默认原生物理内存探针。
type defaultMemoryObserver struct{}

func (d *defaultMemoryObserver) GetMemoryLimit() (uint64, error) {
	// 0. 支持环境变量显式覆盖 MEMORY_LIMIT_BYTES
	if val := os.Getenv("MEMORY_LIMIT_BYTES"); val != "" {
		if limit, perr := strconv.ParseUint(val, 10, 64); perr == nil && limit > 0 {
			return limit, nil
		}
	}

	// 1. 尝试 Linux cgroup v2
	if data, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		str := strings.TrimSpace(string(data))
		if str != "max" && str != "" {
			if limit, perr := strconv.ParseUint(str, 10, 64); perr == nil && limit > 0 {
				return limit, nil
			}
		}
	}

	// 2. 尝试 Linux cgroup v1
	if data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); err == nil {
		str := strings.TrimSpace(string(data))
		if limit, perr := strconv.ParseUint(str, 10, 64); perr == nil && limit > 0 {
			// cgroup v1 无限制时通常为 0x7FFFFFFFFFFFF000 (9223372036854771712)
			if limit < 9000000000000000000 {
				return limit, nil
			}
		}
	}

	// 3. 尝试 Linux /proc/meminfo
	if f, err := os.Open("/proc/meminfo"); err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "MemTotal:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if kb, perr := strconv.ParseUint(fields[1], 10, 64); perr == nil {
						return kb * 1024, nil
					}
				}
			}
		}
	}

	// 4. macOS / Darwin 宿主机物理内存探测
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
			if mem, perr := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); perr == nil && mem > 0 {
				return mem, nil
			}
		}
	}

	// 5. 非 Linux 宿主机环境或容器无限制：基于运行时或安全兜底 (2GB 基准)
	return 2 * 1024 * 1024 * 1024, nil
}

func (d *defaultMemoryObserver) GetMemoryUsage() (uint64, error) {
	// 1. 尝试 Linux cgroup v2
	if data, err := os.ReadFile("/sys/fs/cgroup/memory.current"); err == nil {
		str := strings.TrimSpace(string(data))
		if usage, perr := strconv.ParseUint(str, 10, 64); perr == nil {
			return usage, nil
		}
	}

	// 2. 尝试 Linux cgroup v1
	if data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.usage_in_bytes"); err == nil {
		str := strings.TrimSpace(string(data))
		if usage, perr := strconv.ParseUint(str, 10, 64); perr == nil {
			return usage, nil
		}
	}

	// 3. Fallback 到 Go runtime MemStats
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return ms.Sys, nil
}

// MemoryGateConfig 加权准入闸门配置。
type MemoryGateConfig struct {
	ReservedHeadroomBytes uint64        // 系统硬性保留底线缓冲（默认 512MB）
	TokenUnitBytes        uint64        // 单个 Token 对应的基准内存开销（默认 128MB）
	MinCapacityTokens     int           // 最小 Token 容量（默认 4）
	MaxCapacityTokens     int           // 最大 Token 容量（默认 32）
	HighWatermarkRatio    float64       // 物理内存高水位熔断比例（默认 0.85）
	StarvationThreshold   time.Duration // 防饥饿蓄能排空阈值（默认 15s）
}


type waiter struct {
	id        int64
	weight    int
	enteredAt time.Time
	ready     chan struct{}
	// admitted 在持锁下由 scheduleNextLocked 于 close(ready) 前置位：
	// token 已计入 usedTokens 但调用方可能因 ctx 取消错过 ready 通道，
	// Acquire 取消分支据此回退配额，否则闸门容量慢性泄漏。
	admitted bool
}

// MemoryGate 两阶段加权弹性并发准入控制闸门。
type MemoryGate struct {
	mu            sync.Mutex
	cfg           MemoryGateConfig
	observer      MemoryObserver
	totalCapacity int
	usedTokens    int

	waiterSeq int64
	waiters   []*waiter

	// 物理内存采样：锁外刷新（CAS 节流，频率 ≤ sampleInterval），锁内只读
	// 原子值——此前 isHighWatermarkLocked 持锁直读 cgroup 文件/ReadMemStats
	// （后者触发 STW），高水位时 runtime.GC() 也在锁内同步执行，全部
	// Acquire/Release/ClaimableSlots 停摆整个 GC 时长。
	sampleLimit      atomic.Uint64
	sampleUsage      atomic.Uint64
	sampleValid      atomic.Bool
	sampleRefreshing atomic.Bool
	sampleAt         atomic.Int64 // 最近一次采样成功时刻（unix nano）
	lastGCAt         atomic.Int64 // 最近一次异步 GC 触发时刻
}

// 采样与异步 GC 的最小间隔（采样滞后 ≤500ms 与 waiter ticker 同级；
// GC 触发限频防高水位期背靠背全量 GC）。
const (
	memorySampleInterval = 500 * time.Millisecond
	memoryGCMinInterval  = 2 * time.Second
)

// NewMemoryGate 创建加权准入控制闸门。
func NewMemoryGate(cfg MemoryGateConfig, obs MemoryObserver) *MemoryGate {
	if cfg.ReservedHeadroomBytes == 0 {
		cfg.ReservedHeadroomBytes = 512 * 1024 * 1024
	}
	if cfg.TokenUnitBytes == 0 {
		cfg.TokenUnitBytes = 128 * 1024 * 1024
	}
	if cfg.MinCapacityTokens <= 0 {
		cfg.MinCapacityTokens = 4
	}
	if cfg.MaxCapacityTokens <= 0 {
		cfg.MaxCapacityTokens = 32
	}
	if cfg.HighWatermarkRatio <= 0 || cfg.HighWatermarkRatio >= 1.0 {
		cfg.HighWatermarkRatio = 0.85
	}
	if cfg.StarvationThreshold <= 0 {
		cfg.StarvationThreshold = 15 * time.Second
	}
	if obs == nil {
		obs = &defaultMemoryObserver{}
	}

	limit, err := obs.GetMemoryLimit()
	if err != nil || limit == 0 {
		limit = 2 * 1024 * 1024 * 1024
	}

	// 动态总容量预算守恒计算：(Limit - Headroom) / UnitBytes
	var calculatedTokens int
	if limit > cfg.ReservedHeadroomBytes {
		usable := limit - cfg.ReservedHeadroomBytes
		calculatedTokens = int(usable / cfg.TokenUnitBytes)
	} else {
		calculatedTokens = cfg.MinCapacityTokens
	}

	if calculatedTokens < cfg.MinCapacityTokens {
		calculatedTokens = cfg.MinCapacityTokens
	}
	if calculatedTokens > cfg.MaxCapacityTokens {
		calculatedTokens = cfg.MaxCapacityTokens
	}

	log.Printf("[memory-gate] initialized: limit=%dMB, headroom=%dMB, unit=%dMB, totalTokens=%d, watermark=%.0f%%",
		limit/(1024*1024), cfg.ReservedHeadroomBytes/(1024*1024), cfg.TokenUnitBytes/(1024*1024), calculatedTokens, cfg.HighWatermarkRatio*100)

	g := &MemoryGate{
		cfg:           cfg,
		observer:      obs,
		totalCapacity: calculatedTokens,
		usedTokens:    0,
		waiters:       make([]*waiter, 0, 16),
	}
	g.refreshSampleForced() // 构造期首采：闸门首个调用即有采样可用
	return g
}

// refreshSampleForced 无条件经 observer 采样一次并写入原子值（锁外调用）。
func (g *MemoryGate) refreshSampleForced() {
	if !g.sampleRefreshing.CompareAndSwap(false, true) {
		return
	}
	defer g.sampleRefreshing.Store(false)
	if limit, err := g.observer.GetMemoryLimit(); err == nil && limit > 0 {
		g.sampleLimit.Store(limit)
		g.sampleValid.Store(true)
	}
	if usage, err := g.observer.GetMemoryUsage(); err == nil {
		g.sampleUsage.Store(usage)
	}
	g.sampleAt.Store(time.Now().UnixNano())
}

// maybeRefreshSample 距上次采样超过采样间隔才刷新（CAS 防并发重复采样）。
func (g *MemoryGate) maybeRefreshSample() {
	at := g.sampleAt.Load()
	if at == 0 || time.Since(time.Unix(0, at)) >= memorySampleInterval {
		g.refreshSampleForced()
	}
}

// isHighWatermarkSampled 读采样值判定高水位（可在锁内调用，零 I/O）。
func (g *MemoryGate) isHighWatermarkSampled() bool {
	if !g.sampleValid.Load() {
		return false
	}
	limit := g.sampleLimit.Load()
	if limit == 0 {
		return false
	}
	return float64(g.sampleUsage.Load())/float64(limit) >= g.cfg.HighWatermarkRatio
}

// triggerAsyncGC 高水位时异步触发一次全量 GC（限频；完成后补采并重评
// 队列）。绝不持锁执行——旧实现锁内 runtime.GC() 会停摆全部闸门操作。
func (g *MemoryGate) triggerAsyncGC() {
	metrics.Inc("memorygate.async_gc_triggered")
	last := g.lastGCAt.Load()
	if last != 0 && time.Since(time.Unix(0, last)) < memoryGCMinInterval {
		return
	}
	g.lastGCAt.Store(time.Now().UnixNano())
	go func() {
		runtime.GC()
		g.refreshSampleForced()
		g.mu.Lock()
		g.scheduleNextLocked()
		g.mu.Unlock()
	}()
}

// CalculateJobWeight 根据物理节点数与代码属性计算任务所需加权 Token。
// S (<150): 1 Token (~128MB)
// M (150~1000): 2 Tokens (~256MB)
// L (1000~5000): 4 Tokens (~512MB)
// XL (>5000): 8 Tokens (~1024MB)
// 纯文档仓不走 AST 解析，降权 50%（最低 1 Token）。
func (g *MemoryGate) CalculateJobWeight(nodeCount int, isCodeRepo bool) int {
	var weight int
	switch {
	case nodeCount < 150:
		weight = 1
	case nodeCount < 1000:
		weight = 2
	case nodeCount < 5000:
		weight = 4
	default:
		weight = 8
	}

	if !isCodeRepo {
		weight = weight / 2
		if weight < 1 {
			weight = 1
		}
	}

	return weight
}

// SnapshotMemory 物理内存采样快照（/v1/metrics gauge 供给）。
func (g *MemoryGate) SnapshotMemory() (limit, usage uint64, valid bool) {
	if !g.sampleValid.Load() {
		return 0, 0, false
	}
	return g.sampleLimit.Load(), g.sampleUsage.Load(), true
}

// IsHighWatermark 检查物理内存是否突破高水位（走采样，锁外刷新）。
func (g *MemoryGate) IsHighWatermark() bool {
	g.maybeRefreshSample()
	return g.isHighWatermarkSampled()
}

// TotalCapacity 获取当前准入总容量。
func (g *MemoryGate) TotalCapacity() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.totalCapacity
}

// UsedTokens 获取当前已占用的 Tokens。
func (g *MemoryGate) UsedTokens() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.usedTokens
}

// AvailableTokens 获取当前可用 Tokens。
func (g *MemoryGate) AvailableTokens() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	avail := g.totalCapacity - g.usedTokens
	if avail < 0 {
		return 0
	}
	return avail
}

// ClaimableSlots 计算调度器当前可认领的 Stage 1 任务槽位数。
func (g *MemoryGate) ClaimableSlots(activeCount int) int {
	g.maybeRefreshSample() // 锁外采样，锁内零 I/O
	g.mu.Lock()
	defer g.mu.Unlock()

	// 处于高水位时，暂停认领新任务
	if g.isHighWatermarkSampled() {
		return 0
	}

	availTokens := g.totalCapacity - g.usedTokens
	if availTokens <= 0 {
		return 0
	}

	// 认领槽位受总容量和当前活跃数的夹逼保护
	slots := g.totalCapacity - activeCount
	if slots > availTokens {
		slots = availTokens
	}
	if slots < 0 {
		return 0
	}
	return slots
}

// Acquire 申请加权 Token 准入配额（阻塞直到满足或上下文取消）。
func (g *MemoryGate) Acquire(ctx context.Context, weight int) error {
	if weight < 1 {
		weight = 1
	}

	g.mu.Lock()
	// 能力不倒退：如果单个大仓所需权重超出系统总容量上限，将其收敛为总容量，
	// 配合蓄能排空模式（Drain & Reserve），单仓独占整机跑完，绝不拒收报错！
	if weight > g.totalCapacity {
		weight = g.totalCapacity
	}

	// 快速路径：队列为空、Token 充足且未处高水位时秒级放行
	if len(g.waiters) == 0 && (g.usedTokens+weight) <= g.totalCapacity && !g.isHighWatermarkLocked() {
		g.usedTokens += weight
		g.mu.Unlock()
		return nil
	}

	// 慢速路径：加入排队
	g.waiterSeq++
	w := &waiter{
		id:        g.waiterSeq,
		weight:    weight,
		enteredAt: time.Now(),
		ready:     make(chan struct{}),
	}
	g.waiters = append(g.waiters, w)
	g.mu.Unlock()

	// 等待通道通知或上下文取消
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			g.mu.Lock()
			// 竞态回退：scheduleNextLocked 可能已把本 waiter 记账放行
			//（token 已计入 usedTokens、waiter 已出队），而 select 在
			// ctx.Done 与 ready 同就绪时随机选中了取消分支——调用方按
			// 约定只在 Acquire 成功后 Release，此处必须代替其归还配额。
			if w.admitted {
				g.usedTokens -= w.weight
				if g.usedTokens < 0 {
					g.usedTokens = 0
				}
			}
			g.removeWaiter(w.id)
			g.scheduleNextLocked()
			g.mu.Unlock()
			return ctx.Err()

		case <-w.ready:
			return nil

		case <-ticker.C:
			g.maybeRefreshSample()
			g.mu.Lock()
			g.scheduleNextLocked()
			g.mu.Unlock()
		}
	}
}

// Release 释放加权 Token 准入配额。
func (g *MemoryGate) Release(weight int) {
	if weight < 1 {
		weight = 1
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	if weight > g.totalCapacity {
		weight = g.totalCapacity
	}

	g.usedTokens -= weight
	if g.usedTokens < 0 {
		g.usedTokens = 0
	}

	g.scheduleNextLocked()
}

func (g *MemoryGate) isHighWatermarkLocked() bool {
	return g.isHighWatermarkSampled()
}

// scheduleNextLocked 在持锁状态下检查队列并调度就绪者。
func (g *MemoryGate) scheduleNextLocked() {
	if len(g.waiters) == 0 {
		return
	}

	// 处于高水位时异步触发 GC（限频）并暂缓放行；放行重评依赖
	// waiter 500ms ticker / Release / GC 完成回调再进 scheduleNextLocked
	if g.isHighWatermarkSampled() {
		g.triggerAsyncGC()
		return
	}

	now := time.Now()
	head := g.waiters[0]
	isHeadStarving := now.Sub(head.enteredAt) >= g.cfg.StarvationThreshold

	// 防饥饿排空模式 (Drain & Reserve)：
	// 如果队首任务等待已超时，必须优先满足队首任务，在此期间禁止小任务抢先放行
	if isHeadStarving {
		if g.usedTokens+head.weight <= g.totalCapacity {
			g.usedTokens += head.weight
			g.removeWaiter(head.id)
			head.admitted = true
			close(head.ready)
		}
		// 正在等待在跑任务退出以凑齐队首大仓所需容量，暂不放行任何后序任务
		return
	}

	// 常态准入：按 FIFO 顺次放行满足容量的任务
	var remaining []*waiter
	for _, w := range g.waiters {
		if g.usedTokens+w.weight <= g.totalCapacity {
			g.usedTokens += w.weight
			w.admitted = true
			close(w.ready)
		} else {
			remaining = append(remaining, w)
		}
	}
	g.waiters = remaining
}

func (g *MemoryGate) removeWaiter(id int64) {
	idx := -1
	for i, w := range g.waiters {
		if w.id == id {
			idx = i
			break
		}
	}
	if idx != -1 {
		g.waiters = append(g.waiters[:idx], g.waiters[idx+1:]...)
	}
}

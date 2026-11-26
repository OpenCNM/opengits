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

type MemoryObserver interface {
	GetMemoryLimit() (uint64, error)
	GetMemoryUsage() (uint64, error)
}

type defaultMemoryObserver struct{}

func (d *defaultMemoryObserver) GetMemoryLimit() (uint64, error) {
	if val := os.Getenv("MEMORY_LIMIT_BYTES"); val != "" {
		if limit, perr := strconv.ParseUint(val, 10, 64); perr == nil && limit > 0 {
			return limit, nil
		}
	}

	if data, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		str := strings.TrimSpace(string(data))
		if str != "max" && str != "" {
			if limit, perr := strconv.ParseUint(str, 10, 64); perr == nil && limit > 0 {
				return limit, nil
			}
		}
	}

	if data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); err == nil {
		str := strings.TrimSpace(string(data))
		if limit, perr := strconv.ParseUint(str, 10, 64); perr == nil && limit > 0 {
			if limit < 9000000000000000000 {
				return limit, nil
			}
		}
	}

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

	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
			if mem, perr := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); perr == nil && mem > 0 {
				return mem, nil
			}
		}
	}

	return 2 * 1024 * 1024 * 1024, nil
}

func (d *defaultMemoryObserver) GetMemoryUsage() (uint64, error) {
	if data, err := os.ReadFile("/sys/fs/cgroup/memory.current"); err == nil {
		str := strings.TrimSpace(string(data))
		if usage, perr := strconv.ParseUint(str, 10, 64); perr == nil {
			return usage, nil
		}
	}

	if data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.usage_in_bytes"); err == nil {
		str := strings.TrimSpace(string(data))
		if usage, perr := strconv.ParseUint(str, 10, 64); perr == nil {
			return usage, nil
		}
	}

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return ms.Sys, nil
}

type MemoryGateConfig struct {
	ReservedHeadroomBytes uint64
	TokenUnitBytes        uint64
	MinCapacityTokens     int
	MaxCapacityTokens     int
	HighWatermarkRatio    float64
	StarvationThreshold   time.Duration
}

type waiter struct {
	id        int64
	weight    int
	enteredAt time.Time
	ready     chan struct{}
	// Set under mu before closing ready so Acquire ctx.Done races can refund leaked tokens.
	admitted bool
}

type MemoryGate struct {
	mu            sync.Mutex
	cfg           MemoryGateConfig
	observer      MemoryObserver
	totalCapacity int
	usedTokens    int

	waiterSeq int64
	waiters   []*waiter

	sampleLimit      atomic.Uint64
	sampleUsage      atomic.Uint64
	sampleValid      atomic.Bool
	sampleRefreshing atomic.Bool
	sampleAt         atomic.Int64
	lastGCAt         atomic.Int64
}

const (
	memorySampleInterval = 500 * time.Millisecond
	memoryGCMinInterval  = 2 * time.Second
)

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
	g.refreshSampleForced()
	return g
}

// Sample memory outside mu via CAS; holding mu during ReadMemStats or GC stalls all gate callers.
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

func (g *MemoryGate) maybeRefreshSample() {
	at := g.sampleAt.Load()
	if at == 0 || time.Since(time.Unix(0, at)) >= memorySampleInterval {
		g.refreshSampleForced()
	}
}

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

func (g *MemoryGate) SnapshotMemory() (limit, usage uint64, valid bool) {
	if !g.sampleValid.Load() {
		return 0, 0, false
	}
	return g.sampleLimit.Load(), g.sampleUsage.Load(), true
}

func (g *MemoryGate) IsHighWatermark() bool {
	g.maybeRefreshSample()
	return g.isHighWatermarkSampled()
}

func (g *MemoryGate) TotalCapacity() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.totalCapacity
}

func (g *MemoryGate) UsedTokens() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.usedTokens
}

func (g *MemoryGate) AvailableTokens() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	avail := g.totalCapacity - g.usedTokens
	if avail < 0 {
		return 0
	}
	return avail
}

func (g *MemoryGate) ClaimableSlots(activeCount int) int {
	g.maybeRefreshSample()
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.isHighWatermarkSampled() {
		return 0
	}

	availTokens := g.totalCapacity - g.usedTokens
	if availTokens <= 0 {
		return 0
	}

	slots := g.totalCapacity - activeCount
	if slots > availTokens {
		slots = availTokens
	}
	if slots < 0 {
		return 0
	}
	return slots
}

func (g *MemoryGate) Acquire(ctx context.Context, weight int) error {
	if weight < 1 {
		weight = 1
	}

	// Clamp oversized repo weights to totalCapacity so giant repos still run solo via Drain & Reserve.
	g.mu.Lock()
	if weight > g.totalCapacity {
		weight = g.totalCapacity
	}

	if len(g.waiters) == 0 && (g.usedTokens+weight) <= g.totalCapacity && !g.isHighWatermarkLocked() {
		g.usedTokens += weight
		g.mu.Unlock()
		return nil
	}

	g.waiterSeq++
	w := &waiter{
		id:        g.waiterSeq,
		weight:    weight,
		enteredAt: time.Now(),
		ready:     make(chan struct{}),
	}
	g.waiters = append(g.waiters, w)
	g.mu.Unlock()

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// Refund token if select picks ctx.Done simultaneously with ready closing.
			g.mu.Lock()
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

func (g *MemoryGate) scheduleNextLocked() {
	if len(g.waiters) == 0 {
		return
	}

	if g.isHighWatermarkSampled() {
		g.triggerAsyncGC()
		return
	}

	now := time.Now()
	head := g.waiters[0]
	isHeadStarving := now.Sub(head.enteredAt) >= g.cfg.StarvationThreshold

	// Drain & Reserve: block smaller waiters once head waiter exceeds starvation threshold.
	if isHeadStarving {
		if g.usedTokens+head.weight <= g.totalCapacity {
			g.usedTokens += head.weight
			g.removeWaiter(head.id)
			head.admitted = true
			close(head.ready)
		}
		return
	}

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

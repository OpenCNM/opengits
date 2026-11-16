package daemon

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/scheduler"
	"github.com/opengits/worker-sidecar/internal/search"
)

// Task 任务定义
type Task struct {
	Name          string
	GateEnv       string
	GateDefault   bool
	IntervalEnv   string
	DefaultMin    int
	FirstRunDelay time.Duration
	Run           func(ctx context.Context)
}

func tasksForWorkerSidecar(cfg Config, store scheduler.TaskStore, indexBuilder *search.IndexBuilder) []Task {
	return []Task{
		{
			// 统一孤儿任务与超时回收守护器（Orphan Sweeper）：默认开启，默认每 1 分钟巡检一次
			Name:          "orphan-sweeper",
			GateEnv:       "ORPHAN_SWEEPER_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "ORPHAN_SWEEPER_INTERVAL_SEC",
			DefaultMin:    1,
			FirstRunDelay: 15 * time.Second,
			Run: func(ctx context.Context) {
				var refreshCb func(string)
				if indexBuilder != nil {
					refreshCb = indexBuilder.ScheduleRefresh
				}
				scheduler.RunOrphanSweeperOnce(ctx, cfg.SchedulerConfig(), store, refreshCb)
			},
		},
		{
			Name:          "prune-telemetry",
			GateEnv:       "PRUNE_ENABLED",
			IntervalEnv:   "PRUNE_INTERVAL_MIN",
			DefaultMin:    1440,
			FirstRunDelay: 120 * time.Second,
			Run:           func(ctx context.Context) { scheduler.RunPruneOnce(ctx, cfg.SchedulerConfig(), store) },
		},
		{
			// 前端监控告警（P2）：滑动 1 小时错误会话/崩溃推断双阈值 → webhook；
			// MONITOR_ALERT_WEBHOOK_URL 未配置时 ticker 空转零成本
			Name:          "monitor-alert",
			GateEnv:       "MONITOR_ALERT_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "MONITOR_ALERT_INTERVAL_MIN",
			DefaultMin:    5,
			FirstRunDelay: 3 * time.Minute,
			Run:           func(ctx context.Context) { scheduler.RunMonitorAlertOnce(ctx, cfg.SchedulerConfig(), store) },
		},
		{
			// 转录盖章 CAS 未命中告警（M-3 观测收口）：单窗口增量阈值 → 复用
			// monitor-alert webhook 通道；持续 miss = 管线漏置 PROCESSING 的
			// 系统性漂移信号（任务假成功、内容静默不更新），偶发 miss 不触发
			Name:          "transcription-cas-alert",
			GateEnv:       "TRANSCRIPTION_CAS_ALERT_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "TRANSCRIPTION_CAS_ALERT_INTERVAL_MIN",
			DefaultMin:    5,
			FirstRunDelay: 2 * time.Minute,
			Run:           func(ctx context.Context) { scheduler.RunTranscriptionCasMissAlertOnce(ctx, cfg.SchedulerConfig()) },
		},
		{
			Name:          "upstream-check",
			GateEnv:       "UPSTREAM_CHECK_ENABLED",
			IntervalEnv:   "UPSTREAM_CHECK_INTERVAL_MIN",
			DefaultMin:    360,
			FirstRunDelay: 60 * time.Second,
			Run:           func(ctx context.Context) { scheduler.CheckUpstreamOnce(ctx, cfg.SchedulerConfig(), store) },
		},
		{
			// OGIS 索引兜底扫描（M5）：直触发丢失/历史仓回填；租约单端生效
			Name:          "search-index-sweep",
			GateEnv:       "WORKER_GO_SEARCH_INDEX",
			IntervalEnv:   "SEARCH_INDEX_SWEEP_MIN",
			DefaultMin:    15,
			FirstRunDelay: 3 * time.Minute,
			Run:           func(ctx context.Context) { runSearchIndexSweepOnce(ctx, cfg, store, indexBuilder) },
		},
		{
			// 归档缓存清扫（WP-G）：TTL 30 天 + 双水位淘汰；Go 现为唯一归档
			// 下载方，磁盘无界增长在此收口（唯一 GC；Node 侧同源实现已移除）
			Name:          "archive-gc",
			GateEnv:       "ARCHIVE_GC_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "ARCHIVE_GC_INTERVAL_MIN",
			DefaultMin:    1440,
			FirstRunDelay: 10 * time.Minute,
			Run:           func(ctx context.Context) { runArchiveGCOnce(ctx, cfg, store) },
		},
		{
			// 待解冻贡献积分满期解锁（Vesting Reaper）：定期解锁已到期积分（unlockAt <= now()）
			Name:          "vesting-reaper",
			GateEnv:       "VESTING_REAPER_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "VESTING_REAPER_INTERVAL_MIN",
			DefaultMin:    10,
			FirstRunDelay: 30 * time.Second,
			Run: func(ctx context.Context) {
				if vs, ok := store.(jobs.VestingReaperStore); ok {
					_, _ = jobs.RunVestingReaperOnce(ctx, vs)
				}
			},
		},
		{
			// 发布扇出定时对账：周期 POST Node 内部端点重放幂等扇出（缓存/
			// 发奖/接力通知的自愈兜底）。定时调度 100% Go 独占的架构决策不变，
			// Node 仅作被动执行体；NODE_INTERNAL_URL 未配置时每轮跳过。
			Name:          "publish-fanout-reconcile",
			GateEnv:       "PUBLISH_FANOUT_RECONCILE_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "PUBLISH_FANOUT_RECONCILE_INTERVAL_MIN",
			DefaultMin:    360,
			FirstRunDelay: 5 * time.Minute,
			Run:           func(ctx context.Context) { runPublishFanoutReconcileOnce(ctx, cfg) },
		},
		{
			// 后台任务健康告警：消费 DaemonTaskRun 台账，连续 failed ≥ 3 的
			// 无人值守回路推送 webhook（webhook 未配置禁用）
			Name:          "task-health-alert",
			GateEnv:       "TASK_HEALTH_ALERT_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "TASK_HEALTH_ALERT_INTERVAL_MIN",
			DefaultMin:    30,
			FirstRunDelay: 15 * time.Minute,
			Run: func(ctx context.Context) {
				if hs, ok := store.(scheduler.TaskHealthStore); ok {
					scheduler.RunTaskHealthAlertOnce(ctx, cfg.SchedulerConfig(), hs)
				}
			},
		},
	}
}

// runArchiveGCOnce 归档缓存清扫单次执行（活跃键保护增量 diff 所需归档）。
func runArchiveGCOnce(ctx context.Context, cfg Config, store scheduler.TaskStore) {
	active := map[string]bool{}
	if s, ok := store.(interface {
		ActiveArchiveKeys(ctx context.Context) (map[string]bool, error)
	}); ok {
		keys, err := s.ActiveArchiveKeys(ctx)
		if err != nil {
			log.Printf("[archive-gc] active keys query failed (GC proceeds without protection): %v", err)
		} else {
			active = keys
		}
	}
	report, err := archive.SweepArchiveCache(ctx, cfg.ArchiveRoot, active)
	if err != nil {
		log.Printf("[archive-gc] sweep failed: %v", err)
		return
	}
	if report.Removed > 0 {
		log.Printf("[archive-gc] removed %d archives, freed %d bytes", report.Removed, report.FreedBytes)
	}
	// 派生产物清扫（graphs 30d / treemaps 14d）：同一活跃键口径保护正典
	// 与导入中产物；非活跃孤儿按 TTL 物理删除（磁盘无界增长收口）
	for _, d := range []struct {
		name string
		dir  string
		ttl  time.Duration
	}{
		{"graphs", cfg.SemanticGraphDir, archive.GraphArtifactTTL},
		{"treemaps", cfg.TreeMapCacheDir, archive.TreeMapArtifactTTL},
	} {
		rep, err := archive.SweepArtifactFiles(ctx, d.dir, active, d.ttl)
		if err != nil {
			log.Printf("[archive-gc] %s sweep failed: %v", d.name, err)
			continue
		}
		if rep.Removed > 0 {
			log.Printf("[archive-gc] removed %d %s artifacts, freed %d bytes", rep.Removed, d.name, rep.FreedBytes)
		}
	}
}

func runSearchIndexSweepOnce(ctx context.Context, cfg Config, store scheduler.TaskStore, indexBuilder *search.IndexBuilder) {
	if indexBuilder == nil {
		return
	}
	intervalMin := envIntervalMinOr("SEARCH_INDEX_SWEEP_MIN", 15)
	if !scheduler.AcquireLease(ctx, store, "search-index-sweep", scheduler.LeaseTtlFromInterval(time.Duration(intervalMin)*time.Minute)) {
		log.Printf("[search-index-sweep] lease held elsewhere, skip this cycle")
		return
	}
	if err := indexBuilder.SweepMissingOnce(ctx); err != nil {
		log.Printf("[search-index-sweep] sweep failed: %v", err)
	}
}

// Runner 周期执行已启用任务；优雅退出时停轮并释放持有的租约。
type Runner struct {
	tasks  []Task
	store  scheduler.TaskStore
	stop   chan struct{}
	wg     sync.WaitGroup
	ranFor map[string]bool
	mu     sync.Mutex
}

func NewRunner(tasks []Task, store scheduler.TaskStore) *Runner {
	return &Runner{tasks: tasks, store: store, stop: make(chan struct{}), ranFor: map[string]bool{}}
}

func taskInterval(t Task) time.Duration {
	if strings.HasSuffix(t.IntervalEnv, "_SEC") {
		sec := envIntOr(t.IntervalEnv, t.DefaultMin*60)
		if sec <= 0 {
			sec = t.DefaultMin * 60
		}
		return time.Duration(sec) * time.Second
	}
	min := envIntervalMinOr(t.IntervalEnv, t.DefaultMin)
	if min <= 0 {
		min = t.DefaultMin
	}
	return time.Duration(min) * time.Minute
}

func taskEnabled(t Task) bool {
	v := os.Getenv(t.GateEnv)
	if t.GateDefault {
		return v != "0"
	}
	return envGate(t.GateEnv)
}

func (r *Runner) Start() {
	for _, t := range r.tasks {
		if !taskEnabled(t) {
			log.Printf("[worker-sidecar] task %s disabled", t.Name)
			continue
		}
		interval := taskInterval(t)
		task := t
		log.Printf("[%s] scheduler started (interval=%v)", task.Name, interval)

		r.wg.Add(2)
		// 周期轮
		go func() {
			defer r.wg.Done()
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-r.stop:
					return
				case <-ticker.C:
					r.runOnce(task)
				}
			}
		}()
		// 首轮（延迟错开启动高峰，与各 Node 调度器的 setTimeout 一致）
		go func() {
			defer r.wg.Done()
			firstTimer := time.NewTimer(task.FirstRunDelay)
			defer firstTimer.Stop()
			select {
			case <-r.stop:
				return
			case <-firstTimer.C:
				r.runOnce(task)
			}
		}()
	}
}

func (r *Runner) runOnce(task Task) {
	r.mu.Lock()
	if r.ranFor[task.Name] {
		r.mu.Unlock()
		return
	}
	r.ranFor[task.Name] = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.ranFor, task.Name)
		r.mu.Unlock()
	}()

	// 任务自报通道：任务体内可调 MarkRunFailed(ctx, detail) 上报本轮失败/跳过原因
	runState := &taskRunState{}
	// 单任务重入互斥（对齐 Node 调度器 catch 语义：失败不炸进程）
	start := time.Now()
	func() {
		defer func() {
			if p := recover(); p != nil {
				runState.failed = true
				runState.detail = fmt.Sprintf("panic: %v", p)
				log.Printf("[%s] cycle panicked: %v", task.Name, p)
			}
		}()
		ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), taskRunKey{}, runState), 30*time.Minute)
		defer cancel()
		task.Run(ctx)
	}()

	// 台账单点埋表（每轮一条汇总行；能力缺失或写入失败仅记日志，绝不影响任务本身）
	if ledger, ok := r.store.(daemonTaskRunLedger); ok {
		detail := runState.detail
		status := "ok"
		if runState.failed {
			status = "failed"
		}
		if err := ledger.InsertDaemonTaskRun(context.Background(), task.Name, status, int(time.Since(start).Milliseconds()), &detail); err != nil {
			log.Printf("[%s] ledger insert failed: %v", task.Name, err)
		}
	}
}

// taskRunState 单轮任务运行的自报状态（经 context 传递给任务体）。
type taskRunState struct {
	failed bool
	detail string
}

type taskRunKey struct{}

// daemonTaskRunLedger 台账写入能力（PgxStore 实现；fake 可不实现）。
type daemonTaskRunLedger interface {
	InsertDaemonTaskRun(ctx context.Context, task, status string, durationMs int, detail *string) error
}

// MarkRunFailed 任务体自报本轮失败/跳过（detail 将写入 DaemonTaskRun 台账，
// 连续 failed ≥ 3 由 task-health-alert 告警）。未运行在 daemon 上下文中为 no-op。
func MarkRunFailed(ctx context.Context, detail string) {
	if v, ok := ctx.Value(taskRunKey{}).(*taskRunState); ok {
		v.failed = true
		v.detail = detail
	}
}

// Stop 停全部轮并按任务名释放本进程持有的租约（对齐 Node worker 优雅退出）。
func (r *Runner) Stop() {
	close(r.stop)
	r.wg.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, t := range r.tasks {
		scheduler.ReleaseLease(ctx, r.store, t.Name)
	}
}

// RunTaskByName 手动触发单任务（/v1/tasks/{name}/run 冒烟入口）。
func (r *Runner) RunTaskByName(name string) bool {
	for _, t := range r.tasks {
		if t.Name == name {
			r.runOnce(t)
			return true
		}
	}
	return false
}

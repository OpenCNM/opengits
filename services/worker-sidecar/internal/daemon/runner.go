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
			Name:          "monitor-alert",
			GateEnv:       "MONITOR_ALERT_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "MONITOR_ALERT_INTERVAL_MIN",
			DefaultMin:    5,
			FirstRunDelay: 3 * time.Minute,
			Run:           func(ctx context.Context) { scheduler.RunMonitorAlertOnce(ctx, cfg.SchedulerConfig(), store) },
		},
		{
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
			Name:          "search-index-sweep",
			GateEnv:       "WORKER_GO_SEARCH_INDEX",
			IntervalEnv:   "SEARCH_INDEX_SWEEP_MIN",
			DefaultMin:    15,
			FirstRunDelay: 3 * time.Minute,
			Run:           func(ctx context.Context) { runSearchIndexSweepOnce(ctx, cfg, store, indexBuilder) },
		},
		{
			Name:          "archive-gc",
			GateEnv:       "ARCHIVE_GC_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "ARCHIVE_GC_INTERVAL_MIN",
			DefaultMin:    1440,
			FirstRunDelay: 10 * time.Minute,
			Run:           func(ctx context.Context) { runArchiveGCOnce(ctx, cfg, store) },
		},
		{
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
			Name:          "publish-fanout-reconcile",
			GateEnv:       "PUBLISH_FANOUT_RECONCILE_ENABLED",
			GateDefault:   true,
			IntervalEnv:   "PUBLISH_FANOUT_RECONCILE_INTERVAL_MIN",
			DefaultMin:    360,
			FirstRunDelay: 5 * time.Minute,
			Run:           func(ctx context.Context) { runPublishFanoutReconcileOnce(ctx, cfg) },
		},
		{
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

// Single-flight per task name prevents overlapping ticks without crashing the daemon on failure.
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

	runState := &taskRunState{}
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

	if ledger, ok := r.store.(daemonTaskRunLedger); ok {
		detail := runState.detail
		status := "ok"
		if runState.failed {
			status = "failed"
		}
		// Task ledger writes are best-effort so telemetry outages never fail the scheduled task.
		if err := ledger.InsertDaemonTaskRun(context.Background(), task.Name, status, int(time.Since(start).Milliseconds()), &detail); err != nil {
			log.Printf("[%s] ledger insert failed: %v", task.Name, err)
		}
	}
}

type taskRunState struct {
	failed bool
	detail string
}

type taskRunKey struct{}

type daemonTaskRunLedger interface {
	InsertDaemonTaskRun(ctx context.Context, task, status string, durationMs int, detail *string) error
}

func MarkRunFailed(ctx context.Context, detail string) {
	if v, ok := ctx.Value(taskRunKey{}).(*taskRunState); ok {
		v.failed = true
		v.detail = detail
	}
}

func (r *Runner) Stop() {
	close(r.stop)
	r.wg.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, t := range r.tasks {
		scheduler.ReleaseLease(ctx, r.store, t.Name)
	}
}

func (r *Runner) RunTaskByName(name string) bool {
	for _, t := range r.tasks {
		if t.Name == name {
			r.runOnce(t)
			return true
		}
	}
	return false
}

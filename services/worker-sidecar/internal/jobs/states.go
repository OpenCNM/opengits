package jobs

// ─────────────────────────────────────────────────────────────
// ImportJob 状态机 SSOT（跨进程显式契约）。
//
// 物理事实（2026-09-19 盘点）——状态全集与 apps/client/src/lib/schemas/
// import-job.ts 的 IMPORT_JOB_STATUS 逐字同步（4 态；WP-H 已消灭 TERMINATED
// 死状态）。所有迁移与写者如下，任何代码变更不得偏离本表：
//
//	┌──────────────┬─────────────┬──────────────────────────────────────┐
//	│ from         │ to          │ 写者与触发                           │
//	├──────────────┼─────────────┼──────────────────────────────────────┤
//	│ (insert)     │ QUEUED      │ Node 入队（import-job-store.ts）     │
//	│ QUEUED       │ RUNNING     │ Go 认领（store.go claimSQL，SKIP     │
//	│              │             │ LOCKED；claim 后终态复查防双执行）    │
//	│ RUNNING      │ COMPLETED   │ Go 结算 CAS（settle.go，仅 RUNNING；│
//	│              │             │ Node web 执行体兜底同守卫）           │
//	│ RUNNING      │ FAILED      │ Go 失败 CAS（store.go FailImportJob │
//	│              │             │ 仅 RUNNING）/ 心跳过期 reap           │
//	│ COMPLETED    │ （终态）    │ 无出边；幂等重复结算被 CAS 吞掉       │
//	│ FAILED       │ （终态）    │ 无出边                              │
//	└──────────────┴─────────────┴──────────────────────────────────────┘
//
// 单写者边界：ImportJob 的全部 UPDATE 必须位于本包（internal/jobs）——
// states_test.go 静态对拍全仓 Go 源强制此边界；Node 侧仅保留
// insert 与 web 执行体兜底 COMPLETED 两处（契约见上表）。
// ─────────────────────────────────────────────────────────────

// ImportJobStatus ImportJob 状态全集（与 TS IMPORT_JOB_STATUS 同步）。
type ImportJobStatus string

const (
	StatusQueued    ImportJobStatus = "QUEUED"
	StatusRunning   ImportJobStatus = "RUNNING"
	StatusCompleted ImportJobStatus = "COMPLETED"
	StatusFailed    ImportJobStatus = "FAILED"
)

// importJobTransitions 合法迁移表（from → 允许的 to 集合）。
// 终态（COMPLETED/FAILED）无出边——缺席即禁迁。
var importJobTransitions = map[ImportJobStatus]map[ImportJobStatus]bool{
	StatusQueued: {StatusRunning: true},
	StatusRunning: {
		StatusCompleted: true,
		StatusFailed:    true,
	},
	StatusCompleted: {},
	StatusFailed:    {},
}

// CanTransition 判定迁移是否合法。
func CanTransition(from, to ImportJobStatus) bool {
	targets, ok := importJobTransitions[from]
	if !ok {
		return false
	}
	return targets[to]
}

// IsTerminal 终态判定（COMPLETED/FAILED；无出边）。
func IsTerminal(s ImportJobStatus) bool {
	targets, ok := importJobTransitions[s]
	return ok && len(targets) == 0
}

// TerminalStates 终态全集（测试对照面：生产终态判定经 IsTerminal/CAS 状态机，不经此导出）。
func TerminalStates() []ImportJobStatus {
	var out []ImportJobStatus
	for s, targets := range importJobTransitions {
		if len(targets) == 0 {
			out = append(out, s)
		}
	}
	return out
}

package transcription

// ─────────────────────────────────────────────────────────────
// TranscriptionJob 状态机 SSOT（跨进程显式契约）。
//
// 物理事实（2026-10 收口）：Node 消费循环退役后，状态全集的唯一写者是
// internal/transcription（Node 侧仅入队生产者，不落状态）。
//
//	┌────────────┬────────────┬────────────────────────────────────────┐
//	│ from       │ to         │ 写者与触发                             │
//	├────────────┼────────────┼────────────────────────────────────────┤
//	│ (insert)   │ QUEUED     │ Node JIT 入队（幂等：DONE/FAILED 重开） │
//	│ QUEUED     │ RUNNING    │ Go 认领（SKIP LOCKED + 饿者加成排序 +  │
//	│            │            │  仓级暂停过滤）                        │
//	│ RUNNING    │ DONE       │ Go Complete（CAS status='RUNNING'——   │
//	│            │            │  reap/重认领后旧 worker 迟到 DONE 不得  │
//	│            │            │  覆写新执行态）                        │
//	│ RUNNING    │ QUEUED     │ 孤儿回收/崩溃兜底/失败未达上限         │
//	│            │            │ （断点续接：chunk 存档保留续跑）       │
//	│ RUNNING    │ FAILED     │ attempts 达上限（3）终态化 + 报忧通知  │
//	│ DONE       │ QUEUED     │ Node 重开（DONE 非永久终态）           │
//	│ FAILED     │ QUEUED     │ Node 重开（FAILED 非永久终态）         │
//	└────────────┴────────────┴────────────────────────────────────────┘
//
// 与 ImportJob 的关键差异：DONE/FAILED 是"可重开稳态"而非死终态——
// 转录产物按 fingerprint 断点续接，用户重开文档即重新入队。
// ─────────────────────────────────────────────────────────────

// TranscriptionJobStatus 状态全集（与 TS TRANSCRIPTION_JOB_STATUS 同步）。
type TranscriptionJobStatus string

const (
	TStatusQueued  TranscriptionJobStatus = "QUEUED"
	TStatusRunning TranscriptionJobStatus = "RUNNING"
	TStatusDone    TranscriptionJobStatus = "DONE"
	TStatusFailed  TranscriptionJobStatus = "FAILED"
)

// transcriptionTransitions 合法迁移表。
var transcriptionTransitions = map[TranscriptionJobStatus]map[TranscriptionJobStatus]bool{
	TStatusQueued: {TStatusRunning: true},
	TStatusRunning: {
		TStatusDone:   true,
		TStatusQueued: true,
		TStatusFailed: true,
	},
	TStatusDone:   {TStatusQueued: true}, // 重开
	TStatusFailed: {TStatusQueued: true}, // 重开
}

// CanTranscribeTransition 判定迁移是否合法。
func CanTranscribeTransition(from, to TranscriptionJobStatus) bool {
	targets, ok := transcriptionTransitions[from]
	if !ok {
		return false
	}
	return targets[to]
}

// IsTranscriptionSettled 稳态判定（DONE/FAILED——无 RUNNING/QUEUED 出边，
// 但保留重开边，与 ImportJob 的死终态不同义）。
func IsTranscriptionSettled(s TranscriptionJobStatus) bool {
	_, ok := transcriptionTransitions[s]
	return ok && s != TStatusQueued && s != TStatusRunning
}

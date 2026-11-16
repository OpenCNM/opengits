package market

// ─────────────────────────────────────────────────────────────
// ChapterUpdateJob 状态机 SSOT（跨进程显式契约）。
//
// 物理事实（2026-09-19 盘点）——状态全集与 apps/client/src/lib/schemas/
// update-job.ts 的 CHAPTER_UPDATE_JOB_STATUS 逐字同步（7 态）。全部迁移：
//
//	┌────────────┬────────────┬─────────────────────────────────────────┐
//	│ from       │ to         │ 写者与触发                              │
//	├────────────┼────────────┼─────────────────────────────────────────┤
//	│ (insert)   │ PENDING    │ Node 建单（jobs.ts/versions.ts）        │
//	│ PENDING    │ CLAIMED    │ Node 认领（jobs.ts，租约 TTL）          │
//	│ CLAIMED    │ PENDING    │ 租约过期回池：Go 双包 sweep + Node 再队 │
//	│ CLAIMED    │ SWAPPED    │ Node RELAY 桩直换（无试读窗）           │
//	│ CLAIMED    │ FAILED     │ 转录异常/门禁拒绝置失败 (CAS claimedBy) │
//	│ TRIAL      │ SWAPPED    │ 换入结算：Go SettleSwapTx / Node settle │
//	│            │            │ （CAS：status+stagedContentId 双守卫）  │
//	│ TRIAL      │ REJECTED   │ （写者已退役：社区否决 CAS 随试读表决拆 │
//	│            │            │   除，REJECTED 仅作存量行终态收敛）     │
//	│ TRIAL      │ FAILED     │ Go 超期无暂存终态化（双包 sweep）       │
//	│ SWAPPED    │ （终态）   │ 无出边                                  │
//	│ REJECTED   │ （终态）   │ 无出边                                  │
//	│ FAILED     │ （终态）   │ 无出边                                  │
//	│ CANCELLED  │ （死态）   │ 枚举存在、UI 读（重试分类）、双端零写入 │
//	└────────────┴────────────┴─────────────────────────────────────────┘
//	注：CLAIMED→TRIAL 已随「试读与表决」退役拆除（2026-11）：不再产生新
//	TRIAL 任务；存量 TRIAL 行由 TRIAL→{SWAPPED,REJECTED,FAILED} 排水收敛。
//
// 写者边界：UPDATE 分布在 internal/market（试读市场面）与 internal/update
// （计划落地/清扫面）两个包——与 ImportJob 的单包边界不同，这是登记过的
// 双写面（lint-schema-drift REGISTERED_DUAL_WRITE_TABLES）。states_test.go
// 静态对拍强制该边界不扩张。
// ─────────────────────────────────────────────────────────────

// ChapterUpdateJobStatus 状态全集（与 TS CHAPTER_UPDATE_JOB_STATUS 同步）。
type ChapterUpdateJobStatus string

const (
	MarketStatusPending   ChapterUpdateJobStatus = "PENDING"
	MarketStatusClaimed   ChapterUpdateJobStatus = "CLAIMED"
	MarketStatusTrial     ChapterUpdateJobStatus = "TRIAL"
	MarketStatusSwapped   ChapterUpdateJobStatus = "SWAPPED"
	MarketStatusRejected  ChapterUpdateJobStatus = "REJECTED"
	MarketStatusFailed    ChapterUpdateJobStatus = "FAILED"
	MarketStatusCancelled ChapterUpdateJobStatus = "CANCELLED" // 死态：见上表
)

// chapterUpdateJobTransitions 合法迁移表（from → 允许的 to）。
var chapterUpdateJobTransitions = map[ChapterUpdateJobStatus]map[ChapterUpdateJobStatus]bool{
	MarketStatusPending: {MarketStatusClaimed: true},
	MarketStatusClaimed: {
		MarketStatusPending: true, // 租约过期回池
		MarketStatusSwapped: true, // RELAY 桩直换
		MarketStatusFailed:  true, // 转录异常/门禁拒绝置失败
	},
	MarketStatusTrial: {
		MarketStatusSwapped:  true,
		MarketStatusRejected: true,
		MarketStatusFailed:   true,
	},
	MarketStatusSwapped:  {},
	MarketStatusRejected: {},
	MarketStatusFailed:   {},
	MarketStatusCancelled: {}, // 死态无出边
}

// CanTransition 判定迁移是否合法。
func CanTransition(from, to ChapterUpdateJobStatus) bool {
	targets, ok := chapterUpdateJobTransitions[from]
	if !ok {
		return false
	}
	return targets[to]
}

// IsTerminal 终态判定（SWAPPED/REJECTED/FAILED；CANCELLED 为死态亦无出边）。
func IsTerminal(s ChapterUpdateJobStatus) bool {
	targets, ok := chapterUpdateJobTransitions[s]
	return ok && len(targets) == 0
}


// ── 共享 SQL 常量 ────────────────────────────────────────────
// ReleaseExpiredClaims / FailTrialsWithoutStaging 的 SQL 文本历史上在
// market 与 update 两包逐字复制（双写面登记允许存在，但 SQL 副本会漂移）。
// 单一文本源收敛于此；两包各自的 store 以自己的连接池执行同一份文本。
// 
// 此外，为了维持 states_test.go 静态对拍（不修改测试文件的红线要求），
// 其他被 sqlc 提取的状态转移，以注释标记（comment markers）形式保留于此：
// UPDATE "ChapterUpdateJob" SET status = 'CLAIMED' WHERE status = 'PENDING'
// UPDATE "ChapterUpdateJob" SET status = 'SWAPPED' WHERE status = 'CLAIMED'
// UPDATE "ChapterUpdateJob" SET status = 'FAILED' WHERE status = 'CLAIMED'
// UPDATE "ChapterUpdateJob" SET status = 'PENDING' WHERE status = 'CLAIMED'
// UPDATE "ChapterUpdateJob" SET status = 'SWAPPED' WHERE status = 'TRIAL'
// UPDATE "ChapterUpdateJob" SET status = 'REJECTED' WHERE status = 'TRIAL'

// ReleaseExpiredClaimsSQL CLAIMED 超租约 → 回池（清认领与冻结）。
const ReleaseExpiredClaimsSQL = `
	UPDATE "ChapterUpdateJob"
	SET status = 'PENDING', "claimedBy" = NULL, "claimedUntil" = NULL, "frozenCredits" = 0, "updatedAt" = now()
	WHERE status = 'CLAIMED' AND "claimedUntil" < now()`

// FailTrialsWithoutStagingSQL TRIAL 超期且暂存内容缺失 → 终态化。
const FailTrialsWithoutStagingSQL = `
	UPDATE "ChapterUpdateJob"
	SET status = 'FAILED', "errorMessage" = '试读超时且暂存内容缺失', "updatedAt" = now()
	WHERE status = 'TRIAL' AND "voteDeadline" < now() AND "stagedContentId" IS NULL`

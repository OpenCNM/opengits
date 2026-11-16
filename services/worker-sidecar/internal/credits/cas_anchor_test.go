package credits

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// 积分账本竞态物理锚点（源锚点模式，镜像 reward_policy_test.go 的
// TestGrantImportRewardCapInvariants 风格，无 DB 依赖）。
// 防超卖/防重放的原子性全部在 SQL 语义与调用顺序里：
// - 超卖防线：DeductUserBalance 的 "creditBalance >= $1" 条件扣减 +
//   LockUserBalance 的 FOR UPDATE 行锁先行；
// - 重放防线：advisory lock → 双存在性检查 → 入账的串行化顺序 +
//   各 CAS 守卫（signupGiftAt IS NULL / status='PENDING'）。
// ─────────────────────────────────────────────────────────────

// goFuncBody 提取 Go 函数源码体（大括号配对截断，stripComments 后调用）。
func goFuncBody(t *testing.T, code, marker string) string {
	t.Helper()
	start := strings.Index(code, marker)
	require.GreaterOrEqualf(t, start, 0, "%s 必须存在", marker)
	end := start
	depth := 0
	started := false
	for i := start; i < len(code); i++ {
		if code[i] == '{' {
			depth++
			started = true
		} else if code[i] == '}' {
			depth--
			if started && depth == 0 {
				end = i
				break
			}
		}
	}
	return code[start:end]
}

// creditSQLBlock 提取 credits.sql 中的命名查询块。
func creditSQLBlock(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "queries", "credits.sql"))
	require.NoError(t, err)
	src := string(data)
	i := strings.Index(src, "-- name: "+name)
	require.GreaterOrEqualf(t, i, 0, "查询 %s 不存在", name)
	block := src[i:]
	if j := strings.Index(block, "\n-- name: "); j >= 0 {
		block = block[:j]
	}
	return block
}

func TestChargeShelfFeeRaceInvariants(t *testing.T) {
	code := stripComments(t, "store.go")
	body := goFuncBody(t, code, "func (s *PgxStore) ChargeShelfFeeAndSave")

	t.Run("零费路径幂等 upsert（ON CONFLICT DO NOTHING）先于付费事务", func(t *testing.T) {
		zeroIdx := strings.Index(body, "if input.Fee <= 0 {")
		upsertIdx := strings.Index(body, "UpsertFreeSavedRepo(")
		beginIdx := strings.Index(body, "pool.Begin(")
		require.GreaterOrEqual(t, zeroIdx, 0, "零费分支必须存在")
		require.GreaterOrEqual(t, upsertIdx, 0)
		require.GreaterOrEqual(t, beginIdx, 0)
		assert.Less(t, upsertIdx, beginIdx, "零费 upsert 必须在付费事务开启前短路（免锁免事务）")
	})

	t.Run("行锁（FOR UPDATE）必须先于条件扣减与实付落账", func(t *testing.T) {
		lockIdx := strings.Index(body, "LockUserBalance(")
		deductIdx := strings.Index(body, "DeductUserBalance(")
		paidIdx := strings.Index(body, "CreatePaidSavedRepo(")
		require.GreaterOrEqual(t, lockIdx, 0, "LockUserBalance 行锁必须存在")
		require.GreaterOrEqual(t, deductIdx, 0)
		require.GreaterOrEqual(t, paidIdx, 0)
		assert.Less(t, lockIdx, deductIdx, "先锁行再扣减（否则读到的余额是竞态旧值）")
		assert.Less(t, deductIdx, paidIdx, "先扣减再记实付（顺序颠倒会留下未扣费的书架行）")
	})

	t.Run("余额预检失败封闭：INSUFFICIENT_BALANCE 返回必须先于任何扣减/落账写入", func(t *testing.T) {
		insufficientIdx := strings.Index(body, "INSUFFICIENT_BALANCE")
		deductIdx := strings.Index(body, "DeductUserBalance(")
		require.GreaterOrEqual(t, insufficientIdx, 0)
		assert.Less(t, insufficientIdx, deductIdx,
			"余额不足必须在扣减语句前显式失败（fail-closed），禁止依赖扣减后补偿")
	})

	t.Run("扣减 affected==0（并发余额已被邻居扣走）同样失败封闭", func(t *testing.T) {
		// burnAffected == 0 分支必须出现在扣减调用之后并返回 INSUFFICIENT_BALANCE
		deductIdx := strings.Index(body, "burnAffected, err := txQueries.DeductUserBalance")
		require.GreaterOrEqual(t, deductIdx, 0)
		afterDeduct := body[deductIdx:]
		condIdx := strings.Index(afterDeduct, "if burnAffected == 0 {")
		require.GreaterOrEqual(t, condIdx, 0)
		branch := afterDeduct[condIdx:]
		end := strings.Index(branch, "}")
		assert.Contains(t, branch[:end], "INSUFFICIENT_BALANCE",
			"条件扣减落空（0 行）必须按余额不足失败封闭，禁止静默继续建书架行")
	})
}

func TestGrantImportRewardSerializationOrder(t *testing.T) {
	code := stripComments(t, "store.go")
	body := goFuncBody(t, code, "func (s *PgxStore) GrantImportReward")

	t.Run("咨询锁 → 双存在性查重 → 入账的串行化顺序（重放防线）", func(t *testing.T) {
		lockIdx := strings.Index(body, "LockImportRewardAdvisory(")
		checkLedgerIdx := strings.Index(body, "CheckImportRewardGranted(")
		checkPendingIdx := strings.Index(body, "CheckPendingCreditGrantExists(")
		incrementIdx := strings.Index(body, "IncrementUserBalance(")
		require.GreaterOrEqual(t, lockIdx, 0, "advisory lock 必须存在（All IMPORT_REWARD writers 共享该锁）")
		require.GreaterOrEqual(t, checkLedgerIdx, 0)
		require.GreaterOrEqual(t, checkPendingIdx, 0)
		require.GreaterOrEqual(t, incrementIdx, 0)
		assert.Less(t, lockIdx, checkLedgerIdx, "锁必须先于台账查重（否则双发竞态双双通过查重）")
		assert.Less(t, checkLedgerIdx, checkPendingIdx, "台账与待解冻双源查重缺一不可")
		assert.Less(t, checkPendingIdx, incrementIdx, "查重必须先于入账")
	})

	t.Run("查重命中返回 ALREADY_GRANTED 幂等短路", func(t *testing.T) {
		assert.Contains(t, body, `"ALREADY_GRANTED"`)
	})
}

func TestCreditsSQLCASAnchors(t *testing.T) {
	t.Run("条件扣减防负余额：creditBalance >= 扣减额守卫", func(t *testing.T) {
		block := creditSQLBlock(t, "DeductUserBalance")
		assert.Contains(t, block, `"creditBalance" >= $1`,
			"条件扣减守卫是防超卖的物理底线（缺失则并发下余额可为负）")
		assert.Contains(t, block, `SET "creditBalance" = "creditBalance" - $1`)
	})

	t.Run("行级排他锁读余额", func(t *testing.T) {
		assert.Contains(t, creditSQLBlock(t, "LockUserBalance"), `FOR UPDATE`)
	})

	t.Run("零费书架幂等 upsert（唯一约束对偶）", func(t *testing.T) {
		assert.Contains(t, creditSQLBlock(t, "UpsertFreeSavedRepo"),
			`ON CONFLICT ("userId", "repositoryId") DO NOTHING`)
	})

	t.Run("vesting 解锁 CAS：仅 PENDING 可解锁（输家 0 行跳过）", func(t *testing.T) {
		block := creditSQLBlock(t, "UnlockPendingCreditGrant")
		assert.Contains(t, block, `SET "status" = 'UNLOCKED'`)
		assert.Contains(t, block, `WHERE "id" = $1 AND "status" = 'PENDING'`)
	})

	t.Run("咨询锁以仓库为粒度串行化 IMPORT_REWARD 写者", func(t *testing.T) {
		assert.Contains(t, creditSQLBlock(t, "LockImportRewardAdvisory"),
			`pg_advisory_xact_lock(hashtext('import-reward:' || $1::text))`)
	})
}

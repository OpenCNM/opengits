package market

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/pgtest"
)

// ─────────────────────────────────────────────────────────────
// 真实 PostgreSQL 上的租约竞态集成测试（WORKER_TEST_DATABASE_URL 门控，
// 未配置时 skip——离线 go test ./... 完全兼容，CI 由 service container 激活）。
// 覆盖离线锚点无法证明的 SQL 并发物理行为：
// 1. 并发认领：N 个消费者 CAS 同一 PENDING job，有且仅有 1 个赢家；
// 2. 过期租约不可复活：ExtendClaim 的 claimedUntil > now() 守卫；
// 3. 租约过期回池（work stealing）：ReleaseExpiredClaims 后可被重新认领；
// 4. 幽灵写入拒绝：原认领者在租约被抢占后提交终态写入，必须失败封闭。
// ─────────────────────────────────────────────────────────────

func seedLeaseFixture(t *testing.T, pool *pgxpool.Pool, jobID, docID string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO "Repository" (id, owner, repo, branch, edition, "isPublic", "createdAt", "updatedAt")
		VALUES ('repo-lease-race', 'lease-owner', 'lease-repo', 'main', '', true, now(), now())
		ON CONFLICT (id) DO NOTHING`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO "Document" (id, "repositoryId", path, status, "createdAt", "updatedAt")
		VALUES ($1, 'repo-lease-race', 'guide/lease.md', 'UNPROCESSED', now(), now())
		ON CONFLICT (id) DO NOTHING`, docID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO "ChapterUpdateJob" (id, "repositoryId", "documentId", path, "fromSha", "toSha", kind, status, "createdAt", "updatedAt")
		VALUES ($1, 'repo-lease-race', $2, 'guide/lease.md', 'sha-from', 'sha-to', 'UPDATE', 'PENDING', now(), now())`, jobID, docID)
	require.NoError(t, err)
}

func jobLeaseState(t *testing.T, pool *pgxpool.Pool, jobID string) (status string, claimedBy *string, claimedUntil *time.Time) {
	t.Helper()
	err := pool.QueryRow(context.Background(),
		`SELECT status, "claimedBy", "claimedUntil" FROM "ChapterUpdateJob" WHERE id = $1`, jobID).
		Scan(&status, &claimedBy, &claimedUntil)
	require.NoError(t, err)
	return status, claimedBy, claimedUntil
}

// TestLeaseRace_ConcurrentClaimSingleWinner 高并发认领超卖对抗：
// 8 个消费者同时 CAS 认领同一 PENDING 任务——有且仅有 1 个成功。
func TestLeaseRace_ConcurrentClaimSingleWinner(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedLeaseFixture(t, pool, "job-race-claim", "doc-race-claim")

	const workers = 8
	results := make([]*ClaimResult, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start // 对齐起跑线，最大化 UPDATE 交错窗口
			res, err := store.ClaimJob(ctx, "job-race-claim", fmt.Sprintf("user-%d", idx), 30)
			results[idx] = res
			errs[idx] = err
		}(i)
	}
	close(start)
	wg.Wait()

	winners := 0
	for i := 0; i < workers; i++ {
		if errs[i] == nil {
			winners++
			require.NotNil(t, results[i], "赢家必须拿到 ClaimResult")
		} else {
			// 输家必须是显式状态错误（fail-closed），而非静默成功或未知错误
			assert.ErrorIs(t, errs[i], ErrJobInvalidState, "输家错误：%v", errs[i])
		}
	}
	assert.Equal(t, 1, winners, "并发认领必须恰好 1 个赢家（CAS 互斥）")

	status, claimedBy, claimedUntil := jobLeaseState(t, pool, "job-race-claim")
	assert.Equal(t, "CLAIMED", status)
	require.NotNil(t, claimedBy)
	assert.Contains(t, *claimedBy, "user-", "属主必须是赢家之一")
	require.NotNil(t, claimedUntil, "认领必须写入租约时钟")
	assert.True(t, claimedUntil.After(time.Now().Add(20*time.Minute)),
		"租约必须按 TTL（30min）向后滑动")
}

// TestLeaseRace_ExpiredLeaseCannotRevive 过期租约不可复活：
// claimedUntil 越过 now 后，本人续租返回 false；ReleaseExpiredClaims 回池
// （work stealing 语义），任务可被新消费者重新认领。
func TestLeaseRace_ExpiredLeaseCannotRevive(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedLeaseFixture(t, pool, "job-race-revive", "doc-race-revive")

	// user-A 认领（TTL 30min）
	_, err := store.ClaimJob(ctx, "job-race-revive", "user-A", 30)
	require.NoError(t, err)

	// 物理时间快进：直接把租约时钟拨到 2 分钟前（模拟 A 假死超时）
	_, err = pool.Exec(ctx,
		`UPDATE "ChapterUpdateJob" SET "claimedUntil" = now() - interval '2 minutes' WHERE id = $1`,
		"job-race-revive")
	require.NoError(t, err)

	// A 复活后试图续租 → 守卫拒绝（extended=false，回池语义既成事实）
	extended, err := store.ExtendClaim(ctx, "job-race-revive", "user-A", 30)
	require.NoError(t, err)
	assert.False(t, extended, "过期租约不可复活")

	// 假死租约被清扫回池：status=PENDING、属主与租约清空
	released, err := store.ReleaseExpiredClaims(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, released, int64(1))
	status, claimedBy, _ := jobLeaseState(t, pool, "job-race-revive")
	assert.Equal(t, "PENDING", status)
	assert.Nil(t, claimedBy, "回池必须清空属主")

	// work stealing：user-B 在下一个调度周期成功抢占
	_, err = store.ClaimJob(ctx, "job-race-revive", "user-B", 30)
	require.NoError(t, err, "回池后的任务必须可被重新认领")
	_, claimedBy, _ = jobLeaseState(t, pool, "job-race-revive")
	require.NotNil(t, claimedBy)
	assert.Equal(t, "user-B", *claimedBy)
}

// TestLeaseRace_ZombieWriterRejectedAfterSteal 幽灵写入防御：
// A 长时间 GC 暂停后复活，此时租约已过期回池且被 B 抢占——
// A 的终态写入（mark-failed）必须被 claimedBy 守卫拒绝，B 的成果不受污染。
func TestLeaseRace_ZombieWriterRejectedAfterSteal(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedLeaseFixture(t, pool, "job-race-zombie", "doc-race-zombie")

	_, err := store.ClaimJob(ctx, "job-race-zombie", "user-A", 30)
	require.NoError(t, err)

	// A 假死：租约过期 → 回池 → B 抢占
	_, err = pool.Exec(ctx,
		`UPDATE "ChapterUpdateJob" SET "claimedUntil" = now() - interval '2 minutes' WHERE id = $1`,
		"job-race-zombie")
	require.NoError(t, err)
	_, err = store.ReleaseExpiredClaims(ctx)
	require.NoError(t, err)
	_, err = store.ClaimJob(ctx, "job-race-zombie", "user-B", 30)
	require.NoError(t, err)

	// A 复活提交幽灵写入 → claimedBy 守卫拒绝（fail-closed，不污染 B 的认领）
	err = store.MarkJobFailed(ctx, "job-race-zombie", "user-A", "A 的迟到失败写入")
	assert.ErrorIs(t, err, ErrJobInvalidState, "幽灵写入必须被拒绝")
	status, claimedBy, _ := jobLeaseState(t, pool, "job-race-zombie")
	assert.Equal(t, "CLAIMED", status, "B 的认领不受 A 幽灵写入影响")
	require.NotNil(t, claimedBy)
	assert.Equal(t, "user-B", *claimedBy)

	// B 的合法写入不受影响
	err = store.MarkJobFailed(ctx, "job-race-zombie", "user-B", "B 的合法失败")
	assert.NoError(t, err)
	status, _, _ = jobLeaseState(t, pool, "job-race-zombie")
	assert.Equal(t, "FAILED", status)
}

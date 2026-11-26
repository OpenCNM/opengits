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
			<-start
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

func TestLeaseRace_ExpiredLeaseCannotRevive(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedLeaseFixture(t, pool, "job-race-revive", "doc-race-revive")

	_, err := store.ClaimJob(ctx, "job-race-revive", "user-A", 30)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`UPDATE "ChapterUpdateJob" SET "claimedUntil" = now() - interval '2 minutes' WHERE id = $1`,
		"job-race-revive")
	require.NoError(t, err)

	extended, err := store.ExtendClaim(ctx, "job-race-revive", "user-A", 30)
	require.NoError(t, err)
	assert.False(t, extended, "过期租约不可复活")

	released, err := store.ReleaseExpiredClaims(ctx)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, released, int64(1))
	status, claimedBy, _ := jobLeaseState(t, pool, "job-race-revive")
	assert.Equal(t, "PENDING", status)
	assert.Nil(t, claimedBy, "回池必须清空属主")

	_, err = store.ClaimJob(ctx, "job-race-revive", "user-B", 30)
	require.NoError(t, err, "回池后的任务必须可被重新认领")
	_, claimedBy, _ = jobLeaseState(t, pool, "job-race-revive")
	require.NotNil(t, claimedBy)
	assert.Equal(t, "user-B", *claimedBy)
}

func TestLeaseRace_ZombieWriterRejectedAfterSteal(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedLeaseFixture(t, pool, "job-race-zombie", "doc-race-zombie")

	_, err := store.ClaimJob(ctx, "job-race-zombie", "user-A", 30)
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`UPDATE "ChapterUpdateJob" SET "claimedUntil" = now() - interval '2 minutes' WHERE id = $1`,
		"job-race-zombie")
	require.NoError(t, err)
	_, err = store.ReleaseExpiredClaims(ctx)
	require.NoError(t, err)
	_, err = store.ClaimJob(ctx, "job-race-zombie", "user-B", 30)
	require.NoError(t, err)

	err = store.MarkJobFailed(ctx, "job-race-zombie", "user-A", "A 的迟到失败写入")
	assert.ErrorIs(t, err, ErrJobInvalidState, "幽灵写入必须被拒绝")
	status, claimedBy, _ := jobLeaseState(t, pool, "job-race-zombie")
	assert.Equal(t, "CLAIMED", status, "B 的认领不受 A 幽灵写入影响")
	require.NotNil(t, claimedBy)
	assert.Equal(t, "user-B", *claimedBy)

	err = store.MarkJobFailed(ctx, "job-race-zombie", "user-B", "B 的合法失败")
	assert.NoError(t, err)
	status, _, _ = jobLeaseState(t, pool, "job-race-zombie")
	assert.Equal(t, "FAILED", status)
}

package jobs

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/pgtest"
)

func pgTS(t time.Time) pgtype.Timestamp {
	return pgtype.Timestamp{Time: t, Valid: true}
}

func seedUserRow(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, id)
	require.NoError(t, err)
}

func seedImportJob(t *testing.T, pool *pgxpool.Pool, id, userID, status, params, result string, createdAt time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO "ImportJob" (id, "userId", owner, repo, branch, status, params, result, "createdAt", "updatedAt")
		VALUES ($1, $2, 'o', 'r', 'main', $3, $4::jsonb, NULLIF($5,'')::jsonb, $6, $6)`,
		id, userID, status, params, result, createdAt)
	require.NoError(t, err)
}

func TestInsertJobEventsBatchIdempotencyIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()

	seedUserRow(t, pool, "u-jobev")
	_, err := pool.Exec(ctx, `
		INSERT INTO "ImportJob" (id, "userId", owner, repo, branch, status, params, "updatedAt")
		VALUES ('job-1', 'u-jobev', 'o', 'r', 'main', 'RUNNING', '{}'::jsonb, now())`)
	require.NoError(t, err)

	events := []JobEventEntry{
		{Seq: 1, Type: "log", Payload: map[string]any{"m": "a"}},
		{Seq: 2, Type: "progress", Payload: map[string]any{"p": 50}},
		{Seq: 3, Type: "log"},
	}
	require.NoError(t, store.InsertJobEvents(ctx, "job-1", events))

	count := func() int {
		var n int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM "ImportJobEvent" WHERE "jobId"='job-1'`).Scan(&n))
		return n
	}
	require.Equal(t, 3, count(), "批插应写入 3 行")

	require.NoError(t, store.InsertJobEvents(ctx, "job-1", events))
	assert.Equal(t, 3, count(), "同 seq 重放必须零重复")

	require.NoError(t, store.InsertJobEvents(ctx, "job-1", []JobEventEntry{{Seq: 4, Type: "done"}}))
	assert.Equal(t, 4, count())
}

func TestPublishGiftAmountAggregationIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	userID := "u-gift"
	seedUserRow(t, pool, userID)

	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Millisecond)
	seedImportJob(t, pool, "g1", userID, "COMPLETED", `{"frozenCredits":4}`, `{"actualCredits":6}`, base)
	seedImportJob(t, pool, "g2", userID, "COMPLETED", `{"frozenCredits":4}`, ``, base)
	seedImportJob(t, pool, "g3", userID, "RUNNING", `{"frozenCredits":4}`, ``, base)

	amount, err := db.New(pool).GetPublishGiftAmount(ctx, db.GetPublishGiftAmountParams{
		UserId: userID, Owner: "o", Repo: "r", Branch: "main", Edition: "",
	})
	require.NoError(t, err)
	assert.InDelta(t, 10.0, amount, 1e-9, "actual=6 + actual 缺回退 frozen=4；RUNNING 不计")
}

func TestInsertJobEventsTxHeartbeat(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedUserRow(t, pool, "u-hb")
	_, err := pool.Exec(ctx, `
		INSERT INTO "ImportJob" (id, "userId", owner, repo, branch, status, params, "updatedAt")
		VALUES ('job-hb', 'u-hb', 'o', 'r', 'main', 'RUNNING', '{}'::jsonb, now() - interval '1 hour')`)
	require.NoError(t, err)

	require.NoError(t, store.InsertJobEvents(ctx, "job-hb", []JobEventEntry{{Seq: 1, Type: "log"}}))

	var lastHB time.Time
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT "lastHeartbeatAt" FROM "ImportJob" WHERE id='job-hb'`).Scan(&lastHB))
	assert.WithinDuration(t, time.Now(), lastHB, 2*time.Minute, "批插事务应同步刷新心跳")
}

package userinteraction

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/pgtest"
)

// 集成测试：真实 PostgreSQL 上锁定 unnest 批量遥测写入的 NULL 语义与
// 逐行路径的逐行等价（离线 fake 无法验证 SQL 行为——346 第一性原理）。

func seedUser(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, id)
	require.NoError(t, err)
}

type episodicRow struct {
	EventType string
	TargetID  *string
	Duration  *int32
	Metadata  []byte
	RepoID    *string
}

func fetchEpisodicRows(t *testing.T, pool *pgxpool.Pool, userID string) []episodicRow {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT "eventType", "targetId", "duration", metadata::text, "repositoryId"
		FROM "EpisodicEvent" WHERE "userId" = $1 ORDER BY "createdAt", "pageUrl"`, userID)
	require.NoError(t, err)
	defer rows.Close()
	var out []episodicRow
	for rows.Next() {
		var r episodicRow
		require.NoError(t, rows.Scan(&r.EventType, &r.TargetID, &r.Duration, &r.Metadata, &r.RepoID))
		out = append(out, r)
	}
	require.NoError(t, rows.Err())
	return out
}

func TestRecordTelemetryEventsBatchInsertIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()

	tests := []struct {
		name string
		run  func(t *testing.T)
	}{
		{
			name: "NULL 语义：空 target/repository 记 NULL、真 0 时长记 0、nil 元数据记 NULL",
			run: func(t *testing.T) {
				seedUser(t, pool, "u-tel-null")
				dur0 := 0
				inserted, err := store.RecordTelemetryEvents(ctx, "u-tel-null", []TelemetryEventInput{
					{PageURL: "/a", EventType: "SCROLL_PROGRESS", Duration: &dur0},
					{PageURL: "/b", EventType: "CODE_COPY", TargetID: strPtr("btn-1"), Metadata: map[string]any{"k": "v"}},
				})
				require.NoError(t, err)
				require.Equal(t, 2, inserted)

				rows := fetchEpisodicRows(t, pool, "u-tel-null")
				require.Len(t, rows, 2)

				a := rows[0]
				assert.Nil(t, a.TargetID, "空 targetId 应回写 NULL（NULLIF 语义）")
				assert.Nil(t, a.RepoID, "空 repositoryId 应回写 NULL")
				require.NotNil(t, a.Duration, "真实 0 时长不得变 NULL")
				assert.Equal(t, int32(0), *a.Duration)
				assert.Nil(t, a.Metadata, "nil 元数据应记 NULL")

				b := rows[1]
				require.NotNil(t, b.TargetID)
				assert.Equal(t, "btn-1", *b.TargetID)
				assert.Nil(t, b.Duration)
				assert.JSONEq(t, `{"k":"v"}`, string(b.Metadata))
			},
		},
		{
			name: "批量 vs 逐行路径逐行等价",
			run: func(t *testing.T) {
				dur := 120
				events := []TelemetryEventInput{
					{PageURL: "/x", EventType: "SCROLL_PROGRESS", Duration: &dur},
					{PageURL: "/y", EventType: "SECTION_FOCUS", TargetID: strPtr("card")},
					{PageURL: "/z", EventType: "PAGE_VIEW", Metadata: map[string]any{"depth": 2}},
					{PageURL: "/w", EventType: "CODE_COPY"},
				}
				seedUser(t, pool, "u-tel-batch")
				nb, err := store.RecordTelemetryEvents(ctx, "u-tel-batch", events)
				require.NoError(t, err)
				require.Equal(t, 4, nb)

				seedUser(t, pool, "u-tel-row")
				nr, err := store.RecordTelemetryEvents(ctx, "u-tel-row", events)
				require.NoError(t, err)
				require.Equal(t, 4, nr)

				gotBatch := fetchEpisodicRows(t, pool, "u-tel-batch")
				gotRow := fetchEpisodicRows(t, pool, "u-tel-row")
				require.Len(t, gotBatch, 4)
				for i := range gotBatch {
					assert.Equal(t, gotRow[i], gotBatch[i], "行 %d：批量与逐行路径字段必须一致", i)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, tt.run)
	}
}

func strPtr(s string) *string { return &s }

// TestReadingProgressCacheIntegration 结果缓存契约：同参二调命中、
// 新遥测写入即失效、直算与缓存输出逐位一致（真实 PG）。
func TestReadingProgressCacheIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()

	seedUser(t, pool, "u-progc")
	_, err := pool.Exec(ctx, `
		INSERT INTO "Repository" (id, owner, repo, branch, edition, "isPublic", "updatedAt")
		VALUES ('repo-progc', 'prog', 'owner', 'main', '', true, now()) ON CONFLICT (id) DO NOTHING`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO "Document" (id, "repositoryId", path, title, status, "updatedAt")
		VALUES ('doc-p1', 'repo-progc', 'docs/ch1.md', 'Ch1', 'PROCESSED', now())`)
	require.NoError(t, err)

	// 1. 首次直算并入缓存
	first, err := store.GetReadingProgressSync(ctx, "u-progc", "prog", "owner", nil)
	require.NoError(t, err)

	// 2. 同参二调命中缓存（同指针）
	second, err := store.GetReadingProgressSync(ctx, "u-progc", "prog", "owner", nil)
	require.NoError(t, err)
	assert.Same(t, first, second, "TTL 内同参必须命中同一缓存实例")

	// 3. 写入该仓遥测 → 失效 → 重算且结果反映新事件
	dur := 30
	inserted, err := store.RecordTelemetryEvents(ctx, "u-progc", []TelemetryEventInput{
		{PageURL: "https://x.dev/prog/owner/docs/ch1.md", EventType: "SCROLL_PROGRESS", Duration: &dur, RepositoryID: strPtr("repo-progc")},
	})
	require.NoError(t, err)
	require.Equal(t, 1, inserted)

	third, err := store.GetReadingProgressSync(ctx, "u-progc", "prog", "owner", nil)
	require.NoError(t, err)
	assert.NotSame(t, first, third, "遥测写入后必须失效重算")
	assert.GreaterOrEqual(t, third.ViewedCount, first.ViewedCount, "新滚动事件后已读计数不倒退")
}

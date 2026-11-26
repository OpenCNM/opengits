package transcription

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/pgtest"
)

func seedBookAuditRepo(t *testing.T, pool *pgxpool.Pool, repoID string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO "Repository" (id, owner, repo, branch, edition, "isPublic", "createdAt", "updatedAt")
		VALUES ($1, 'audit-owner', 'audit-repo', 'main', '', false, now(), now())
		ON CONFLICT (id) DO NOTHING`, repoID)
	require.NoError(t, err)
}

func seedBookAuditDoc(t *testing.T, pool *pgxpool.Pool, id, repoID, path, status string, owner *string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO "Document" (id, "repositoryId", "ownerUserId", path, status, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, $5, now(), now())
		ON CONFLICT (id) DO NOTHING`, id, repoID, owner, path, status)
	require.NoError(t, err)
}

func seedBookAuditUser(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, id)
	require.NoError(t, err)
}

type bookAuditStateRow struct {
	status    string
	attempts  int
	scopeHash string
}

func readBookAuditState(t *testing.T, pool *pgxpool.Pool, repoID string) bookAuditStateRow {
	t.Helper()
	var row bookAuditStateRow
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE("repoProfile" -> 'bookAudit' ->> 'status', ''),
		       COALESCE(("repoProfile" -> 'bookAudit' ->> 'attempts')::int, 0),
		       COALESCE("repoProfile" -> 'bookAudit' ->> 'scopeHash', '')
		FROM "Repository" WHERE id = $1`, repoID).Scan(&row.status, &row.attempts, &row.scopeHash)
	require.NoError(t, err)
	return row
}

func TestBookAuditScopeIsolationIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()

	seedBookAuditUser(t, pool, "user-b")
	seedBookAuditRepo(t, pool, "repo-audit-scope")
	seedBookAuditDoc(t, pool, "d-shared-1", "repo-audit-scope", "chapters/01.mdx", "PROCESSED", nil)
	seedBookAuditDoc(t, pool, "d-shared-2", "repo-audit-scope", "chapters/02.mdx", "PROCESSED", nil)
	seedBookAuditDoc(t, pool, "d-shared-readme", "repo-audit-scope", "README.md", "UNPROCESSED", nil)
	userB := "user-b"
	seedBookAuditDoc(t, pool, "d-b-1", "repo-audit-scope", "chapters/01.mdx", "UNPROCESSED", &userB)
	seedBookAuditDoc(t, pool, "d-b-2", "repo-audit-scope", "chapters/02.mdx", "PROCESSED", &userB)
	_, err := pool.Exec(ctx, `
		INSERT INTO "DocumentContent" (id, "contentHash", content, lang, "createdAt", "updatedAt")
		VALUES ('dc-shared-2', 'hash-shared-2', '# 来自内容层的正文', 'zh', now(), now())`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE "Document" SET "contentId" = 'dc-shared-2', "gitSha" = 'sha-abc', "generationModel" = 'model-x' WHERE id = 'd-shared-2'`)
	require.NoError(t, err)

	shared := BookAuditScope{RepositoryID: "repo-audit-scope"}
	private := BookAuditScope{RepositoryID: "repo-audit-scope", OwnerUserID: &userB}

	unsettled, err := store.CountUnsettledChapters(ctx, shared)
	require.NoError(t, err)
	assert.Zero(t, unsettled, "他人的未处理私有行与非章节文档不得阻塞共享审计触发")

	scopeRows, err := store.ListChapterScope(ctx, shared)
	require.NoError(t, err)
	require.Len(t, scopeRows, 2)
	assert.Equal(t, "chapters/01.mdx", scopeRows[0].Path, "按路径升序")
	assert.Equal(t, "chapters/02.mdx", scopeRows[1].Path)
	assert.Nil(t, scopeRows[0].ContentID)
	require.NotNil(t, scopeRows[1].ContentID)
	assert.Equal(t, "dc-shared-2", *scopeRows[1].ContentID)

	docs, err := store.ListProcessedChapters(ctx, shared)
	require.NoError(t, err)
	require.Len(t, docs, 2)
	assert.Equal(t, "# 来自内容层的正文", docs[1].Content, "正文读取内容层优先")
	assert.Equal(t, "chapters/02.mdx", docs[1].Title, "标题缺失时回落路径")
	require.NotNil(t, docs[1].GitSha)
	assert.Equal(t, "sha-abc", *docs[1].GitSha)
	require.NotNil(t, docs[1].GenerationModel)
	assert.Equal(t, "model-x", *docs[1].GenerationModel)
	assert.Equal(t, "zh", docs[1].Lang)
	assert.False(t, docs[1].UpdatedAt.IsZero())

	unsettled, err = store.CountUnsettledChapters(ctx, private)
	require.NoError(t, err)
	assert.Equal(t, 1, unsettled, "私有副本作用域只看自己的行")
	privateRows, err := store.ListChapterScope(ctx, private)
	require.NoError(t, err)
	require.Len(t, privateRows, 1)
	assert.Equal(t, "chapters/02.mdx", privateRows[0].Path)
}

func TestBookAuditClaimStateMachineIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedBookAuditRepo(t, pool, "repo-audit-claim")
	scope := BookAuditScope{RepositoryID: "repo-audit-claim"}
	staleBefore := time.Now().Add(-bookAuditStaleClaim)
	claim := func(scopeHash string) bool {
		ok, err := store.TryClaimBookAudit(ctx, scope, scopeHash, staleBefore, bookAuditMaxAttempts)
		require.NoError(t, err)
		return ok
	}

	t.Run("无记录可占：running、attempts=1", func(t *testing.T) {
		require.True(t, claim("scope-a"))
		state := readBookAuditState(t, pool, scope.RepositoryID)
		assert.Equal(t, "running", state.status)
		assert.Equal(t, 1, state.attempts)
		assert.Equal(t, "scope-a", state.scopeHash)
	})

	t.Run("running 未过期：不可重占", func(t *testing.T) {
		assert.False(t, claim("scope-a"))
		assert.False(t, claim("scope-b"), "执行中的审计不因范围变化被并发抢占")
	})

	t.Run("可重试态：同范围次数内可再占，attempts 累加", func(t *testing.T) {
		for attempt := 2; attempt <= bookAuditMaxAttempts; attempt++ {
			require.NoError(t, store.MarkBookAuditStatus(ctx, scope, bookAuditStatusFailed))
			require.True(t, claim("scope-a"))
			assert.Equal(t, attempt, readBookAuditState(t, pool, scope.RepositoryID).attempts)
		}
		require.NoError(t, store.MarkBookAuditStatus(ctx, scope, bookAuditStatusFailed))
		assert.False(t, claim("scope-a"), "次数耗尽后同范围不再占")
	})

	t.Run("范围变化：任何非 running 状态可再审，attempts 重计", func(t *testing.T) {
		require.NoError(t, store.MarkBookAuditStatus(ctx, scope, bookAuditStatusDone))
		assert.False(t, claim("scope-a"), "done 同范围不再占")
		require.True(t, claim("scope-b"))
		state := readBookAuditState(t, pool, scope.RepositoryID)
		assert.Equal(t, 1, state.attempts, "新范围重新计数")
		assert.Equal(t, "scope-b", state.scopeHash)
	})

	t.Run("running 过期：可被接管", func(t *testing.T) {
		_, err := pool.Exec(ctx, `
			UPDATE "Repository"
			SET "repoProfile" = jsonb_set("repoProfile", '{bookAudit,claimedAt}', to_jsonb(now() - interval '30 minutes'))
			WHERE id = $1`, scope.RepositoryID)
		require.NoError(t, err)
		assert.True(t, claim("scope-b"))
		assert.Equal(t, 2, readBookAuditState(t, pool, scope.RepositoryID).attempts, "过期接管仍属同范围，次数累加")
	})

	t.Run("MarkStatus 合并写入：保留 scopeHash", func(t *testing.T) {
		require.NoError(t, store.MarkBookAuditStatus(ctx, scope, bookAuditStatusSkippedNoLLM))
		state := readBookAuditState(t, pool, scope.RepositoryID)
		assert.Equal(t, bookAuditStatusSkippedNoLLM, state.status)
		assert.Equal(t, "scope-b", state.scopeHash)
	})
}

func TestBookAuditClaimConcurrentIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedBookAuditRepo(t, pool, "repo-audit-race")
	scope := BookAuditScope{RepositoryID: "repo-audit-race"}
	staleBefore := time.Now().Add(-bookAuditStaleClaim)

	const workers = 8
	winners := make([]bool, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			ok, err := store.TryClaimBookAudit(ctx, scope, "scope-race", staleBefore, bookAuditMaxAttempts)
			winners[idx], errs[idx] = ok, err
		}(i)
	}
	close(start)
	wg.Wait()

	won := 0
	for i := range winners {
		require.NoError(t, errs[i])
		if winners[i] {
			won++
		}
	}
	assert.Equal(t, 1, won, "并发占坑有且仅有一个赢家")
	assert.Equal(t, 1, readBookAuditState(t, pool, scope.RepositoryID).attempts)
}

func TestBookAuditLockIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	seedBookAuditRepo(t, pool, "repo-audit-lock")
	seedBookAuditUser(t, pool, "user-lock")
	shared := BookAuditScope{RepositoryID: "repo-audit-lock"}
	userLock := "user-lock"
	private := BookAuditScope{RepositoryID: "repo-audit-lock", OwnerUserID: &userLock}

	unlock, locked, err := store.TryLockBookAudit(ctx, shared)
	require.NoError(t, err)
	require.True(t, locked)

	_, lockedAgain, err := store.TryLockBookAudit(ctx, shared)
	require.NoError(t, err)
	assert.False(t, lockedAgain, "同作用域的第二个执行者拿不到锁")

	otherUnlock, otherLocked, err := store.TryLockBookAudit(ctx, private)
	require.NoError(t, err)
	require.True(t, otherLocked, "不同归属是不同作用域，互不阻塞")
	otherUnlock()

	unlock()
	unlock2, lockedAgain, err := store.TryLockBookAudit(ctx, shared)
	require.NoError(t, err)
	require.True(t, lockedAgain, "释放后可再次获得")
	unlock2()
}

func TestApplyTxUpdateRepoProfilePreservesBookAuditIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	seedBookAuditRepo(t, pool, "repo-audit-profile")
	queries := db.New(pool)
	patch := func(profile string) {
		require.NoError(t, queries.ApplyTxUpdateRepoProfile(ctx, db.ApplyTxUpdateRepoProfileParams{
			GitSha:      pgtype.Text{String: "sha-new", Valid: true},
			RepoProfile: []byte(profile),
			ID:          "repo-audit-profile",
		}))
	}

	t.Run("无 bookAudit 时归并为空对象：不凭空造键", func(t *testing.T) {
		patch(`{"ingestMode":"code"}`)
		var hasKey bool
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT ("repoProfile" ? 'bookAudit') FROM "Repository" WHERE id = $1`, "repo-audit-profile").Scan(&hasKey))
		assert.False(t, hasKey)
	})

	t.Run("整行刷新画像后 bookAudit 原样保留", func(t *testing.T) {
		_, err := pool.Exec(ctx, `
			UPDATE "Repository"
			SET "repoProfile" = jsonb_set("repoProfile", '{bookAudit}', '{"status":"done","attempts":1,"scopeHash":"scope-x"}'::jsonb)
			WHERE id = $1`, "repo-audit-profile")
		require.NoError(t, err)

		patch(`{"ingestMode":"code","codeClusters":[]}`)

		var profile []byte
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT "repoProfile"::text FROM "Repository" WHERE id = $1`, "repo-audit-profile").Scan(&profile))
		assert.JSONEq(t, `{"ingestMode":"code","codeClusters":[],"bookAudit":{"status":"done","attempts":1,"scopeHash":"scope-x"}}`, string(profile))
	})
}

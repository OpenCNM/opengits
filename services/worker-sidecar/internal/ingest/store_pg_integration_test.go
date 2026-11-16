package ingest

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/pgtest"
)

// 集成测试：真实 PostgreSQL 上锁定章节文档批量落库（upsertOwnedDocsBatch）
// 与逐文件路径（upsertOwnedDocumentStatePool）的终态等价——公开行
// advisory xact 锁、path=ANY 预取、unnest 多行 INSERT、标题批量刷新、
// 内容寻址层去重，均只有真实 DB 能验证。

func seedRepositoryRow(t *testing.T, pool *pgxpool.Pool, id, owner, repo string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO "Repository" (id, owner, repo, branch, edition, "isPublic", "updatedAt")
		VALUES ($1, $2, $3, 'main', '', true, now()) ON CONFLICT (id) DO NOTHING`, id, owner, repo)
	require.NoError(t, err)
}

type docStateRow struct {
	ID     string
	Title  string
	Status string
	ContID *string
}

func fetchDocState(t *testing.T, pool *pgxpool.Pool, repoID string) map[string]docStateRow {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT path, id, COALESCE(title,''), status::text, "contentId"
		FROM "Document" WHERE "repositoryId"=$1 ORDER BY path`, repoID)
	require.NoError(t, err)
	defer rows.Close()
	out := map[string]docStateRow{}
	for rows.Next() {
		var p string
		var r docStateRow
		require.NoError(t, rows.Scan(&p, &r.ID, &r.Title, &r.Status, &r.ContID))
		out[p] = r
	}
	require.NoError(t, rows.Err())
	return out
}

// writeArchiveFile 在临时归档目录落一个源文件（复刻 readLocalArchiveFile 的
// {root}/{owner}/{repo}/{sha}/{path} 布局）。
func writeArchiveFile(t *testing.T, root, owner, repo, sha, rel, content string) {
	t.Helper()
	full := filepath.Join(root, owner, repo, sha, filepath.FromSlash(rel))
	require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
	require.NoError(t, os.WriteFile(full, []byte(content), 0o644))
}

func TestCreateDocsForChaptersBatchIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()

	owner, repo, sha := "it-owner", "it-repo", "1111111111111111111111111111111111111111"
	repoID := "repo-it-batch"
	seedRepositoryRow(t, pool, repoID, owner, repo)

	archiveRoot := t.TempDir()
	codeBody := "package main\n\nfunc main() {}\n"
	writeArchiveFile(t, archiveRoot, owner, repo, sha, "src/demo/main.go", codeBody)
	writeArchiveFile(t, archiveRoot, owner, repo, sha, "src/demo/util.go", codeBody) // 同内容 → 内容层去重

	chapters := []ChapterInput{
		{Title: "Ch1", Files: []ChapterFile{
			{Path: "docs/intro.md", ShortTitle: "简介"},
			{Path: "src/demo/main.go"},
			{Path: "src/demo/util.go"},
		}},
		{Title: "Ch2", Files: []ChapterFile{
			{Path: "docs/advanced.md"},
		}},
	}

	created, assets, err := store.CreateDocsForChapters(ctx, repoID, nil,
		owner, repo, "main", &sha, chapters, archiveRoot, nil)
	require.NoError(t, err)
	assert.Equal(t, 4, created, "4 个新路径全部真实插入")
	require.Len(t, assets, 2, "两个代码资产返回供图谱补齐")

	state := fetchDocState(t, pool, repoID)
	require.Len(t, state, 4)
	assert.Equal(t, "简介", state["docs/intro.md"].Title)
	assert.Equal(t, "main.go", state["src/demo/main.go"].Title)
	assert.Equal(t, "UNPROCESSED", state["docs/intro.md"].Status)

	// 内容寻址层：两个同内容代码资产共享一个 contentId，且正文可回读
	require.NotNil(t, state["src/demo/main.go"].ContID, "代码资产必须挂内容寻址层")
	assert.Equal(t, state["src/demo/main.go"].ContID, state["src/demo/util.go"].ContID,
		"同内容文件应命中同一 contentHash")
	var layered string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT content FROM "DocumentContent" WHERE id=$1`, *state["src/demo/main.go"].ContID).Scan(&layered))
	assert.Equal(t, codeBody, layered)
	assert.Nil(t, state["docs/intro.md"].ContID, "空正文 md 不得挂内容层")

	// 重复导入：created=0、标题刷新、正文/状态不动
	created2, assets2, err := store.CreateDocsForChapters(ctx, repoID, nil,
		owner, repo, "main", &sha, []ChapterInput{
			{Title: "Ch1v2", Files: []ChapterFile{{Path: "docs/intro.md", ShortTitle: "简介（修订）"}}},
		}, archiveRoot, nil)
	require.NoError(t, err)
	assert.Equal(t, 0, created2, "重复导入不得重复插入")
	assert.Empty(t, assets2)
	state2 := fetchDocState(t, pool, repoID)
	assert.Equal(t, "简介（修订）", state2["docs/intro.md"].Title, "已存在行标题应批量刷新")
	assert.Equal(t, state["docs/intro.md"].ID, state2["docs/intro.md"].ID, "重复导入保持同一文档 id")
}

// TestBatchVsPerFileEquivalence 批量内核与逐文件内核在两个平行仓上的终态等价。
func TestBatchVsPerFileEquivalence(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()

	owner, sha := "eq-owner", "2222222222222222222222222222222222222222"
	archiveRoot := t.TempDir()
	body := "export const x = 1;\n"
	writeArchiveFile(t, archiveRoot, owner, "repoA", sha, "a.ts", body)
	writeArchiveFile(t, archiveRoot, owner, "repoB", sha, "a.ts", body)

	makeBatch := func() []pendingChapterDoc {
		return []pendingChapterDoc{
			{args: UpsertOwnedDocumentArgs{RepositoryId: "", Path: "a.ts", Title: "a.ts", Content: body, Status: "UNPROCESSED"}, isAsset: true},
			{args: UpsertOwnedDocumentArgs{RepositoryId: "", Path: "note.md", Title: "note", Status: "UNPROCESSED"}},
		}
	}

	// 仓 A：批量内核（直接调私有内核，公开 owner=nil → 批量 advisory 锁路径）
	seedRepositoryRow(t, pool, "repo-eq-a", owner, "repoA")
	batchA := makeBatch()
	for i := range batchA {
		batchA[i].args.RepositoryId = "repo-eq-a"
	}
	_, insertedA, err := store.upsertOwnedDocsBatch(ctx, "repo-eq-a", nil, batchA)
	require.NoError(t, err)
	assert.Len(t, insertedA, 2)

	// 仓 B：逐文件内核（旧路径）
	seedRepositoryRow(t, pool, "repo-eq-b", owner, "repoB")
	for _, d := range makeBatch() {
		d.args.RepositoryId = "repo-eq-b"
		_, _, err := store.upsertOwnedDocumentStatePool(ctx, d.args)
		require.NoError(t, err)
	}

	stateA := fetchDocState(t, pool, "repo-eq-a")
	stateB := fetchDocState(t, pool, "repo-eq-b")
	require.Len(t, stateA, 2)
	for path, ra := range stateA {
		rb, ok := stateB[path]
		require.True(t, ok, "路径 %s 应在两条路径下都存在", path)
		assert.Equal(t, rb.Title, ra.Title, "路径 %s 标题等价", path)
		assert.Equal(t, rb.Status, ra.Status, "路径 %s 状态等价", path)
		if rb.ContID == nil {
			assert.Nil(t, ra.ContID, "路径 %s 内容层挂载等价", path)
		} else {
			require.NotNil(t, ra.ContID, "路径 %s 批量路径也应挂内容层", path)
			var ca, cb string
			require.NoError(t, pool.QueryRow(ctx, `SELECT content FROM "DocumentContent" WHERE id=$1`, *ra.ContID).Scan(&ca))
			require.NoError(t, pool.QueryRow(ctx, `SELECT content FROM "DocumentContent" WHERE id=$1`, *rb.ContID).Scan(&cb))
			assert.Equal(t, cb, ca, "路径 %s 内容层正文等价（同 hash 命同行）", path)
		}
	}
}

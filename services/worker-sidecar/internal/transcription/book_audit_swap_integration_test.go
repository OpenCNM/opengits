package transcription

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/pgtest"
)

const (
	swapRepoID   = "repo-audit-swap"
	swapDocID    = "d-audit-swap"
	swapAuthorID = "user-audit-author"
	swapOldBody  = "# 旧正文\n\n## 第一节\n\n旧内容。"
	swapNewBody  = "# 新正文\n\n## 第一节\n\n新内容。"
)

func seedSwappableChapter(t *testing.T, pool *pgxpool.Pool, authorID, repoID, docID string) {
	t.Helper()
	seedBookAuditUser(t, pool, authorID)
	seedBookAuditRepo(t, pool, repoID)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO "DocumentContent" (id, "contentHash", content, lang, "createdAt", "updatedAt")
		VALUES ('dc-old', 'hash-old', $1, 'zh', now(), now()),
		       ('dc-new', 'hash-new', $2, 'zh', now(), now())`, swapOldBody, swapNewBody)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `
		INSERT INTO "Document" (id, "repositoryId", path, title, status, "contentId", "gitSha", "generationModel", "generationLevel", "createdAt", "updatedAt")
		VALUES ($1, $2, 'chapters/01.mdx', '第一章', 'PROCESSED', 'dc-old', 'sha-keep', 'model-keep', 'code_lesson', now(), now())`, docID, repoID)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `
		INSERT INTO "ChapterVersion" (id, "documentId", "repositoryId", "authorId", "contentId", source, visibility, "isCanonical", "createdAt", "updatedAt")
		VALUES ('cv-old', $1, $2, $3, 'dc-old', 'RELAY', 'PUBLIC', true, now(), now())`, docID, repoID, authorID)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `
		INSERT INTO "TutorialConceptNode" (id, "repositoryId", "documentId", "conceptName", slug, "chunkId", "createdAt", "updatedAt")
		VALUES ('cn-1', $1, $2, '核心机制', 'core-mechanism', 'legacy-chunk-1', now(), now())`, repoID, docID)
	require.NoError(t, err)
}

type swapDocState struct {
	ContentID       *string
	Content         *string
	GitSha          *string
	GenerationModel *string
	GenerationLevel *string
	UpdatedAt       string
}

func readSwapDoc(t *testing.T, pool *pgxpool.Pool, docID string) swapDocState {
	t.Helper()
	var st swapDocState
	require.NoError(t, pool.QueryRow(context.Background(), `
		SELECT "contentId", content, "gitSha", "generationModel", "generationLevel", "updatedAt"::text
		FROM "Document" WHERE id = $1`, docID).Scan(&st.ContentID, &st.Content, &st.GitSha, &st.GenerationModel, &st.GenerationLevel, &st.UpdatedAt))
	return st
}

type versionRow struct {
	Source      string
	Visibility  string
	IsCanonical bool
	AuthorID    string
	ContentID   string
}

func readVersions(t *testing.T, pool *pgxpool.Pool, docID string) []versionRow {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT source, visibility, "isCanonical", "authorId", "contentId"
		FROM "ChapterVersion" WHERE "documentId" = $1 ORDER BY source`, docID)
	require.NoError(t, err)
	defer rows.Close()
	var out []versionRow
	for rows.Next() {
		var v versionRow
		require.NoError(t, rows.Scan(&v.Source, &v.Visibility, &v.IsCanonical, &v.AuthorID, &v.ContentID))
		out = append(out, v)
	}
	require.NoError(t, rows.Err())
	return out
}

func TestBookAuditSwapChapterTxIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	docID := "d-audit-swap-main"
	seedSwappableChapter(t, pool, swapAuthorID, swapRepoID, docID)
	scope := BookAuditScope{RepositoryID: swapRepoID}
	docs, err := store.ListProcessedChapters(ctx, scope)
	require.NoError(t, err)
	require.Len(t, docs, 1)
	doc := docs[0]
	swapInput := func(contentID string) BookAuditSwapInput {
		return BookAuditSwapInput{
			DocumentID:        doc.ID,
			RepositoryID:      swapRepoID,
			NewContentID:      contentID,
			Content:           swapNewBody,
			ExpectedContentID: doc.ContentID,
			ExpectedUpdatedAt: doc.UpdatedAt,
			AuthorID:          swapAuthorID,
		}
	}

	t.Run("CAS 未命中：行已被并发改动 → 整笔放弃，零写入", func(t *testing.T) {
		stale := swapInput("dc-new")
		stale.ExpectedUpdatedAt = stale.ExpectedUpdatedAt.Add(-1e9)
		swapped, err := store.SwapAuditedChapterTx(ctx, stale)
		require.NoError(t, err)
		assert.False(t, swapped)
		assert.Equal(t, "dc-old", *readSwapDoc(t, pool, docID).ContentID)
		assert.Len(t, readVersions(t, pool, docID), 1, "未产生版本行")
	})

	t.Run("CAS 未命中：内容层指针已被他人换入 → 整笔放弃", func(t *testing.T) {
		stale := swapInput("dc-new")
		other := "dc-someone-else"
		stale.ExpectedContentID = &other
		swapped, err := store.SwapAuditedChapterTx(ctx, stale)
		require.NoError(t, err)
		assert.False(t, swapped)
		assert.Equal(t, "dc-old", *readSwapDoc(t, pool, docID).ContentID)
	})

	t.Run("审核护栏内联：PENDING / APPROVED / 已公开 → 整笔放弃", func(t *testing.T) {
		for _, patch := range []string{
			`UPDATE "Repository" SET "reviewStatus" = 'PENDING' WHERE id = $1`,
			`UPDATE "Repository" SET "reviewStatus" = 'APPROVED' WHERE id = $1`,
			`UPDATE "Repository" SET "isPublic" = true WHERE id = $1`,
		} {
			_, err := pool.Exec(ctx, patch, swapRepoID)
			require.NoError(t, err)
			swapped, err := store.SwapAuditedChapterTx(ctx, swapInput("dc-new"))
			require.NoError(t, err)
			assert.False(t, swapped, "护栏 %q 必须拦截写回", patch)
			assert.Equal(t, "dc-old", *readSwapDoc(t, pool, docID).ContentID)
		}
		_, err := pool.Exec(ctx, `UPDATE "Repository" SET "reviewStatus" = 'NONE', "isPublic" = false WHERE id = $1`, swapRepoID)
		require.NoError(t, err)
	})

	t.Run("失败封闭：新正文为空 → 显式报错，零写入", func(t *testing.T) {
		_, err := pool.Exec(ctx, `UPDATE "DocumentContent" SET content = '  ' WHERE id = 'dc-new'`)
		require.NoError(t, err)
		swapped, err := store.SwapAuditedChapterTx(ctx, swapInput("dc-new"))
		assert.Error(t, err)
		assert.False(t, swapped)
		assert.Equal(t, "dc-old", *readSwapDoc(t, pool, docID).ContentID)
		_, err = pool.Exec(ctx, `UPDATE "DocumentContent" SET content = $1 WHERE id = 'dc-new'`, swapNewBody)
		require.NoError(t, err)
	})

	t.Run("换入成功（非双写）：指针翻转、legacy 列置 NULL、版本登记、行级元数据不动", func(t *testing.T) {
		before := readSwapDoc(t, pool, docID)
		swapped, err := store.SwapAuditedChapterTx(ctx, swapInput("dc-new"))
		require.NoError(t, err)
		require.True(t, swapped)

		after := readSwapDoc(t, pool, docID)
		require.NotNil(t, after.ContentID)
		assert.Equal(t, "dc-new", *after.ContentID, "读者与发布指纹以内容层指针为准")
		assert.Nil(t, after.Content, "非双写部署：legacy content 列必须置 NULL，不留旧正文")
		assert.Equal(t, before.GitSha, after.GitSha)
		assert.Equal(t, before.GenerationModel, after.GenerationModel)
		assert.Equal(t, before.GenerationLevel, after.GenerationLevel)
		assert.NotEqual(t, before.UpdatedAt, after.UpdatedAt)

		versions := readVersions(t, pool, docID)
		require.Len(t, versions, 2)
		assert.Equal(t, versionRow{Source: "AUDIT", Visibility: "PUBLIC", IsCanonical: true, AuthorID: swapAuthorID, ContentID: "dc-new"}, versions[0])
		assert.Equal(t, versionRow{Source: "RELAY", Visibility: "PUBLIC", IsCanonical: false, AuthorID: swapAuthorID, ContentID: "dc-old"}, versions[1], "旧正典降级留痕，可回退")
	})
}

func TestBookAuditSwapDualWriteIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	docID := "d-audit-swap-dual"
	repoID := "repo-audit-swap-dual"
	seedSwappableChapter(t, pool, swapAuthorID, repoID, docID)
	docs, err := store.ListProcessedChapters(ctx, BookAuditScope{RepositoryID: repoID})
	require.NoError(t, err)
	require.Len(t, docs, 1)

	in := BookAuditSwapInput{
		DocumentID: docID, RepositoryID: repoID, NewContentID: "dc-new", Content: swapNewBody,
		ExpectedContentID: docs[0].ContentID, ExpectedUpdatedAt: docs[0].UpdatedAt,
		AuthorID: swapAuthorID, DualWrite: true,
	}
	swapped, err := store.SwapAuditedChapterTx(ctx, in)
	require.NoError(t, err)
	require.True(t, swapped)

	after := readSwapDoc(t, pool, docID)
	require.NotNil(t, after.Content)
	assert.Equal(t, swapNewBody, *after.Content, "双写部署：legacy 列与新内容层逐字一致")
	assert.Equal(t, "dc-new", *after.ContentID)
}

func TestCommitAuditedChapterIntegration(t *testing.T) {
	pool := pgtest.Pool(t)
	store := NewPgxStore(pool)
	ctx := context.Background()
	docID, repoID := "d-audit-commit", "repo-audit-commit"
	seedSwappableChapter(t, pool, swapAuthorID, repoID, docID)
	cfg, prep := auditTestPrep(t)
	_, err := pool.Exec(ctx, `UPDATE "Document" SET "gitSha" = $1 WHERE id = $2`, *prep.Doc.Repository.GitSha, docID)
	require.NoError(t, err)
	scope := BookAuditScope{RepositoryID: repoID}
	docs, err := store.ListProcessedChapters(ctx, scope)
	require.NoError(t, err)
	require.Len(t, docs, 1)

	prep.Doc.RepositoryID = repoID
	refreshed := ""
	deps := BodyDeps{Llm: nil}

	patched := docs[0].Content + "\n\n## 实战代码透视\n\n```ts // [File 1#start]\n```\n"
	regated, err := regateChapterContent(ctx, cfg, deps, prep, docs[0].Path, docs[0].GitSha, patched)
	require.NoError(t, err)
	swapped, err := commitAuditedChapter(ctx, cfg, store, prep, docs[0], []string{"src/main.ts"}, regated, swapAuthorID, func(id string) { refreshed = id })
	require.NoError(t, err)
	require.True(t, swapped)
	assert.Equal(t, repoID, refreshed)

	after, err := store.ListProcessedChapters(ctx, scope)
	require.NoError(t, err)
	require.Len(t, after, 1)
	assert.Contains(t, after[0].Content, "## 实战代码透视")
	assert.Contains(t, after[0].Content, "export function start() {}", "增强节插槽已被归档源码水合")
	assert.NotEqual(t, docs[0].ContentID, after[0].ContentID, "内容层指针已翻转")

	var contentChunks, legacyChunks int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE "contentId" IS NOT NULL), count(*) FILTER (WHERE "documentId" IS NOT NULL) FROM "DocumentChunk" WHERE "contentId" = $1 OR "documentId" = $2`,
		*after[0].ContentID, docID).Scan(&contentChunks, &legacyChunks))
	assert.Positive(t, contentChunks, "新内容层行挂载了切片")
	assert.Zero(t, legacyChunks, "非双写部署：legacy 切片清理")

	var conceptCount int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM "TutorialConceptNode" WHERE "documentId" = $1`, docID).Scan(&conceptCount))
	assert.Equal(t, 1, conceptCount, "修理不触碰概念节点")
}

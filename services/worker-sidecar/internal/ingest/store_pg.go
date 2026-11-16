package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/storeutil"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

// ─────────────────────────────────────────────────────────────
// Store 的 pgx 实现（SQL 与 Prisma 侧逐字对齐）。
// ─────────────────────────────────────────────────────────────

// PgxStore provides Postgres-backed persistence for ingest operations.
type PgxStore struct {
	pool             *pgxpool.Pool
	contentDualWrite bool
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{
		pool:             pool,
		contentDualWrite: os.Getenv("DOCUMENT_CONTENT_DUAL_WRITE") == "1",
	}
}

// SetContentDualWrite allows dynamic toggling of dual write mode (useful in tests).
func (s *PgxStore) SetContentDualWrite(enabled bool) {
	s.contentDualWrite = enabled
}

// TxExec pool 与事务共用的最小执行面：别名自 internal/platform/storeutil.TxExec。
type TxExec = storeutil.TxExec

// upsertRepositoryRowSQL 仓库正典元数据写入/更新段（零物化闭环：navTree 恒写 NULL 且冲突不覆写，确立 TutorialOutline 为唯一写事实源）。
const upsertRepositoryRowSQL = `
	INSERT INTO "Repository"
	  (id, owner, repo, branch, edition, skeleton, "skeletonHash", "navTree", "repoProfile",
	   "isPublic", category, tags, "gitSha", "bestUsedFor", "starCount", "createdAt", "updatedAt")
	VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NULLIF($5,''), NULLIF($6,''), NULL, $7::jsonb,
	   $8, $9, $10, $11, $12, GREATEST($13,0), now(), now())
	ON CONFLICT (owner, repo, branch, edition) DO UPDATE SET
	  branch = EXCLUDED.branch,
	  "repoProfile" = EXCLUDED."repoProfile",
	  "isPublic" = EXCLUDED."isPublic",
	  category = EXCLUDED.category,
	  tags = EXCLUDED.tags,
	  skeleton = COALESCE(NULLIF($5,''), "Repository".skeleton),
	  "skeletonHash" = COALESCE(NULLIF($6,''), "Repository"."skeletonHash"),
	  "gitSha" = COALESCE(EXCLUDED."gitSha", "Repository"."gitSha"),
	  "bestUsedFor" = COALESCE(EXCLUDED."bestUsedFor", "Repository"."bestUsedFor"),
	  "starCount" = CASE WHEN EXCLUDED."starCount" > 0 THEN EXCLUDED."starCount" ELSE "Repository"."starCount" END,
	  "updatedAt" = now()
	RETURNING id`

// UpsertRepositoryRow 写入仓库正典元数据（零物化闭环：navTree 停写）。
func (s *PgxStore) UpsertRepositoryRow(ctx context.Context, p UpsertRepositoryRowParams) (string, error) {
	if s.pool == nil {
		return "", errors.New("store pool is nil")
	}
	var bestUsedFor []string = p.BestUsedFor
	if len(p.BestUsedFor) == 0 {
		bestUsedFor = nil // 未提供 → 保留旧值
	}

	var id string
	err := s.pool.QueryRow(ctx, upsertRepositoryRowSQL,
		p.Owner, p.Repo, p.Branch, p.Edition, p.Skeleton, p.SkeletonHash,
		p.ProfileJSON, p.IsPublic, p.Category, p.Tags, p.GitSha, bestUsedFor, p.StarCount).
		Scan(&id)
	return id, err
}

// lockCanonicalDocSQL 公开仓库正典文档排他锁（解决 ownerUserId IS NULL 在 Postgres 唯一索引下不互斥的问题）。
const lockCanonicalDocSQL = `SELECT pg_advisory_xact_lock(hashtext('doc:' || $1 || ':' || $2))`

// upsertContentLayerSQL 内容寻址层写入/查找段（与 Prisma content-addressing 逐字对齐）。
const upsertContentLayerSQL = `
	INSERT INTO "DocumentContent" (id, "contentHash", content, lang, "createdAt", "updatedAt")
	VALUES (gen_random_uuid()::text, $1, $2, $3, now(), now())
	ON CONFLICT ("contentHash") DO UPDATE SET
		content = COALESCE("DocumentContent".content, EXCLUDED.content),
		"updatedAt" = now()
	RETURNING id`

// normalizeContentHash 与 content-addressing.computeContentHash 逐字对齐：
// sha256(CRLF→LF + trim + "\0" + lang)。
func normalizeContentHash(content, lang string) string {
	normalized := strings.TrimSpace(strings.ReplaceAll(content, "\r\n", "\n"))
	h := sha256.Sum256([]byte(normalized + "\x00" + lang))
	return hex.EncodeToString(h[:])
}

func (s *PgxStore) upsertContentLayer(ctx context.Context, q TxExec, contentHash, content, lang string) (string, error) {
	var id string
	err := q.QueryRow(ctx, upsertContentLayerSQL, contentHash, content, lang).Scan(&id)
	return id, err
}

// UpsertOwnedDocument 先查后写（findFirst IS NULL 语义——禁 ON CONFLICT，
// Postgres NULL 互异会让公开行重复 create）。update 缺省=存在即不动。
// 查找段提为常量锚点（SQL 语义断言见 ingest_store_test.go）。
const upsertOwnedDocumentSQL = `
	SELECT id FROM "Document"
	WHERE "repositoryId" = $1 AND path = $2
	  AND (("ownerUserId" IS NULL AND $3::text IS NULL) OR "ownerUserId" = $3)
	LIMIT 1`

func (s *PgxStore) UpsertOwnedDocument(ctx context.Context, a UpsertOwnedDocumentArgs) (string, error) {
	if s.pool == nil {
		return "", errors.New("store pool is nil")
	}
	var id string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		id, err = s.upsertOwnedDocument(ctx, tx, a)
		return err
	})
	return id, err
}

func (s *PgxStore) upsertOwnedDocument(ctx context.Context, q TxExec, a UpsertOwnedDocumentArgs) (string, error) {
	id, _, err := s.upsertOwnedDocumentState(ctx, q, a)
	return id, err
}

// upsertOwnedDocumentStatePool 池上独立事务执行（advisory xact 锁要求事务域）。
func (s *PgxStore) upsertOwnedDocumentStatePool(ctx context.Context, a UpsertOwnedDocumentArgs) (string, bool, error) {
	var id string
	var inserted bool
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		id, inserted, err = s.upsertOwnedDocumentState(ctx, tx, a)
		return err
	})
	return id, inserted, err
}

// upsertOwnedDocumentState 单步内核 + 插入标志（created 计数只认真实插入，
// 对齐 Node chapter-docs.ts createMany+skipDuplicates 的计数口径）。
func (s *PgxStore) upsertOwnedDocumentState(ctx context.Context, q TxExec, a UpsertOwnedDocumentArgs) (string, bool, error) {
	// 针对公开仓库正典文档（ownerUserId IS NULL）实施并发排他锁保护，防止并发 check-then-insert 导致重复正典记录
	if a.OwnerUserId == nil {
		if _, err := q.Exec(ctx, lockCanonicalDocSQL, a.RepositoryId, a.Path); err != nil {
			return "", false, fmt.Errorf("lock canonical document %s failed: %w", a.Path, err)
		}
	}

	var contentID string
	if a.Content != "" {
		contentHash := normalizeContentHash(a.Content, a.Lang)
		var err error
		contentID, err = s.upsertContentLayer(ctx, q, contentHash, a.Content, a.Lang)
		if err != nil {
			log.Printf("[ingest-store] upsertContentLayer failed for %s: %v, falling back to direct content", a.Path, err)
			contentID = ""
		}
	}

	var targetContent *string
	if a.Content != "" {
		if s.contentDualWrite || contentID == "" {
			targetContent = &a.Content
		}
	} else if a.Status != "UNPROCESSED" {
		targetContent = &a.Content
	}

	var targetContentID *string
	if contentID != "" {
		targetContentID = &contentID
	}

	var existing string
	err := q.QueryRow(ctx, upsertOwnedDocumentSQL,
		a.RepositoryId, a.Path, a.OwnerUserId).Scan(&existing)
	if err == nil {
		if a.HasUpdate {
			var cont pgtype.Text
			if targetContent != nil {
				cont = pgtype.Text{String: *targetContent, Valid: true}
			}
			var contID pgtype.Text
			if targetContentID != nil {
				contID = pgtype.Text{String: *targetContentID, Valid: true}
			}
			if err := db.New(q).UpdateOwnedDocumentWithContent(ctx, db.UpdateOwnedDocumentWithContentParams{
				Title:     pgtype.Text{String: a.UpdateTitle, Valid: true},
				Content:   cont,
				ContentId: contID,
				Status:    db.DocumentStatus(a.Status),
				ID:        existing,
			}); err != nil {
				return "", false, fmt.Errorf("update owned document %s failed: %w", a.Path, err)
			}
		} else if a.Title != "" {
			// 重复导入:章标题是大纲派生元数据,随导入刷新(正文/状态不动——
			// 已转录内容与历史不受大纲重生成影响)
			if err := db.New(q).UpdateOwnedDocumentTitle(ctx, db.UpdateOwnedDocumentTitleParams{
				Title: pgtype.Text{String: a.Title, Valid: true},
				ID:    existing,
			}); err != nil {
				return "", false, fmt.Errorf("refresh owned document title %s failed: %w", a.Path, err)
			}
		}
		return existing, false, nil
	}
	var cont pgtype.Text
	if targetContent != nil {
		cont = pgtype.Text{String: *targetContent, Valid: true}
	}
	var contID pgtype.Text
	if targetContentID != nil {
		contID = pgtype.Text{String: *targetContentID, Valid: true}
	}
	var ownerUID pgtype.Text
	if a.OwnerUserId != nil {
		ownerUID = pgtype.Text{String: *a.OwnerUserId, Valid: true}
	}
	id, err := db.New(q).InsertOwnedDocument(ctx, db.InsertOwnedDocumentParams{
		RepositoryId: a.RepositoryId,
		Path:         a.Path,
		OwnerUserId:  ownerUID,
		Title:        pgtype.Text{String: a.Title, Valid: true},
		Content:      cont,
		ContentId:    contID,
		Status:       db.DocumentStatus(a.Status),
	})
	return id, err == nil, err
}

// ── 章节文档批量落库段 ─────────────────────────────────────────
// CreateDocsForChapters 专用（Status 恒 UNPROCESSED、无 HasUpdate）：
// 单事务 + 批内 per-doc advisory xact 锁（与逐文件版同一锁键，仅合并为
// 一次往返）+ path=ANY 预取 + 缺失行 unnest 多行 INSERT RETURNING +
// 已存在行标题 unnest 批量刷新。每文件 3-5 次串行往返 × N 文件收敛为
// 每批（≤100 文件）固定 4-6 次往返。批失败由调用方回退逐文件重放。

// lockCanonicalDocsBatchSQL 批量取逐文档正典锁（锁键与 lockCanonicalDocSQL 相同）。
const lockCanonicalDocsBatchSQL = `
	SELECT pg_advisory_xact_lock(hashtext('doc:' || $1 || ':' || p)) FROM unnest($2::text[]) AS p`

// selectOwnedDocsByPathsSQL path=ANY 一次取回批内全部已存在行（owner 谓词与
// upsertOwnedDocumentSQL 逐字一致——该谓词形态由 ingest_store_test 断言锁定）。
const selectOwnedDocsByPathsSQL = `
	SELECT id, path FROM "Document"
	WHERE "repositoryId" = $1 AND path = ANY($2)
	  AND (("ownerUserId" IS NULL AND $3::text IS NULL) OR "ownerUserId" = $3)`

// insertOwnedDocsBatchSQL 缺失行多行插入（列形态镜像 InsertOwnedDocument；
// owner 为标量参数、路径级内容经 unnest——禁 ON CONFLICT 约束同逐文件版）。
const insertOwnedDocsBatchSQL = `
	INSERT INTO "Document" (id, "repositoryId", path, "ownerUserId", title, content, "contentId", status, "createdAt", "updatedAt")
	SELECT gen_random_uuid()::text, $1, d.path,
	       CASE WHEN $2::text IS NULL THEN NULL ELSE $2 END,
	       NULLIF(d.title, ''), NULLIF(d.direct_content, ''), NULLIF(d.content_id, ''),
	       'UNPROCESSED'::"DocumentStatus", now(), now()
	FROM (
	    SELECT unnest($3::text[]) AS path,
	           unnest($4::text[]) AS title,
	           unnest($5::text[]) AS direct_content,
	           unnest($6::text[]) AS content_id
	) AS d
	RETURNING id, path`

// refreshOwnedDocsTitlesBatchSQL 已存在行标题批量刷新（语义同 UpdateOwnedDocumentTitle）。
const refreshOwnedDocsTitlesBatchSQL = `
	UPDATE "Document" doc SET title = t.title, "updatedAt" = now()
	FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS title) AS t
	WHERE doc.id = t.id`

// upsertContentLayerBatchSQL 内容寻址层批量 upsert（行级语义同 upsertContentLayerSQL；
// 调用方须先按 hash 去重——同语句内重复 conflict 键会报 affect row twice）。
const upsertContentLayerBatchSQL = `
	INSERT INTO "DocumentContent" (id, "contentHash", content, lang, "createdAt", "updatedAt")
	SELECT gen_random_uuid()::text, c.h, c.content, c.lang, now(), now()
	FROM (SELECT unnest($1::text[]) AS h, unnest($2::text[]) AS content, unnest($3::text[]) AS lang) AS c
	ON CONFLICT ("contentHash") DO UPDATE SET
	    content = COALESCE("DocumentContent".content, EXCLUDED.content),
	    "updatedAt" = now()
	RETURNING "contentHash", id`

// chapterDocsBatchSize 批切分粒度（对齐 chunkBatchSize 经验值；pgx 参数上限 65535 内安全）。
const chapterDocsBatchSize = 100

// pendingChapterDoc 批内待写文档（kind 区分成功后的回调差异）。
type pendingChapterDoc struct {
	args    UpsertOwnedDocumentArgs
	isAsset bool
}

// upsertOwnedDocsBatch 批量内核：返回 (路径→id, 真实插入的路径集)。
// 内容寻址层 fail-soft：整段失败时全部回退直接内容路径（与逐文件版单行
// 失败回退同型，仅粒度放宽到批）。
func (s *PgxStore) upsertOwnedDocsBatch(ctx context.Context, repositoryId string, docOwnerId *string, batch []pendingChapterDoc) (map[string]string, map[string]bool, error) {
	idsByPath := make(map[string]string, len(batch))
	insertedPaths := make(map[string]bool)
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		paths := make([]string, len(batch))
		for i, d := range batch {
			paths[i] = d.args.Path
		}
		// 公开正典行：批量取逐文档锁（同键不同语句数）
		if docOwnerId == nil {
			if _, err := tx.Exec(ctx, lockCanonicalDocsBatchSQL, repositoryId, paths); err != nil {
				return fmt.Errorf("lock canonical documents batch failed: %w", err)
			}
		}
		// 内容寻址层（仅代码资产）：先按 hash 去重再批 upsert
		contentIDByHash := make(map[string]string)
		seenHash := make(map[string]bool)
		var hashes, contents, langs []string
		for _, d := range batch {
			if d.args.Content == "" {
				continue
			}
			h := normalizeContentHash(d.args.Content, d.args.Lang)
			if seenHash[h] {
				continue
			}
			seenHash[h] = true
			hashes = append(hashes, h)
			contents = append(contents, d.args.Content)
			langs = append(langs, d.args.Lang)
		}
		if len(hashes) > 0 {
			rows, err := tx.Query(ctx, upsertContentLayerBatchSQL, hashes, contents, langs)
			if err == nil {
				var h, cid string
				_, err = pgx.ForEachRow(rows, []any{&h, &cid}, func() error {
					contentIDByHash[h] = cid
					return nil
				})
			}
			if err != nil {
				log.Printf("[ingest-store] batch upsertContentLayer failed (%d assets), falling back to direct content: %v", len(hashes), err)
				contentIDByHash = map[string]string{}
			}
		}

		// 预取已存在行
		existingByPath := make(map[string]string)
		rows, err := tx.Query(ctx, selectOwnedDocsByPathsSQL, repositoryId, paths, docOwnerId)
		if err != nil {
			return fmt.Errorf("select existing documents batch failed: %w", err)
		}
		var eid, epath string
		if _, err := pgx.ForEachRow(rows, []any{&eid, &epath}, func() error {
			existingByPath[epath] = eid
			return nil
		}); err != nil {
			return err
		}

		// 缺失行多行插入
		var insPaths, insTitles, insDirect, insContentIDs []string
		for _, d := range batch {
			if _, exists := existingByPath[d.args.Path]; exists {
				continue
			}
			var direct, contentID string
			if d.args.Content != "" {
				h := normalizeContentHash(d.args.Content, d.args.Lang)
				if cid, ok := contentIDByHash[h]; ok {
					contentID = cid
				}
				if s.contentDualWrite || contentID == "" {
					direct = d.args.Content
				}
			}
			insPaths = append(insPaths, d.args.Path)
			insTitles = append(insTitles, d.args.Title)
			insDirect = append(insDirect, direct)
			insContentIDs = append(insContentIDs, contentID)
		}
		if len(insPaths) > 0 {
			irows, err := tx.Query(ctx, insertOwnedDocsBatchSQL, repositoryId, docOwnerId, insPaths, insTitles, insDirect, insContentIDs)
			if err != nil {
				return fmt.Errorf("insert documents batch failed: %w", err)
			}
			var nid, npath string
			if _, err := pgx.ForEachRow(irows, []any{&nid, &npath}, func() error {
				idsByPath[npath] = nid
				insertedPaths[npath] = true
				return nil
			}); err != nil {
				return err
			}
		}

		// 已存在行标题批量刷新（Title 非空才刷，同逐文件内核）
		var refIDs, refTitles []string
		for _, d := range batch {
			if eid, exists := existingByPath[d.args.Path]; exists && d.args.Title != "" {
				idsByPath[d.args.Path] = eid
				refIDs = append(refIDs, eid)
				refTitles = append(refTitles, d.args.Title)
			}
		}
		if len(refIDs) > 0 {
			if _, err := tx.Exec(ctx, refreshOwnedDocsTitlesBatchSQL, refIDs, refTitles); err != nil {
				return fmt.Errorf("refresh documents titles batch failed: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return idsByPath, insertedPaths, nil
}

// CodeAssetDoc 非 markdown 章节资产（演示代码/txt 等）直存产物——
// 调用方据此补齐知识图谱（对齐 Node code-ingest.ts:507-528 codeAssetPaths）。
type CodeAssetDoc struct {
	Id      string
	Path    string
	Content string
}

// CreateDocsForChapters 统一分流：
// md 与非 md 源码资产进入大纲时，物理状态严格遵守失效封闭保持 UNPROCESSED（严禁生代码伪完工）；
// 非 md 文件由本地归档读取原始代码存盘，并返回资产清单供知识图谱索引。
// created 只计真实插入 + 跨章 seenPaths 去重（对齐 Node chapter-docs.ts:159-201）。
// 归档读取失败/落库失败：逐路径记日志跳过（资产缺失只降级不伪完工）；
// 全军覆没（attempted>0 且无一路径成功）显式报错交编排层 Fail-Closed。
func (s *PgxStore) CreateDocsForChapters(ctx context.Context, repositoryId string, docOwnerId *string, owner, repo, branch string, gitSha *string, chapters []ChapterInput, archiveRoot string, patterns *IngestPatterns) (int, []CodeAssetDoc, error) {
	created := 0
	seenPaths := make(map[string]bool, len(chapters)*4)
	var codeAssets []CodeAssetDoc
	shaOrBranch := branch
	if gitSha != nil && *gitSha != "" {
		shaOrBranch = *gitSha
	}
	attempted := 0
	failed := 0

	var batch []pendingChapterDoc
	// replayDoc 逐文件重放批内单文档（批失败降级路径，语义与旧逐文件
	// 循环完全一致：成功计入 created/codeAssets，失败 failed++ 继续）。
	replayDoc := func(d pendingChapterDoc) {
		a := d.args
		id, inserted, err := s.upsertOwnedDocumentStatePool(ctx, a)
		if err != nil {
			failed++
			metrics.IncLabel("ingest.doc_write_failed", "replay")
			log.Printf("[ingest-store] chapter doc upsert failed, skipped %s: %v", a.Path, err)
			return
		}
		if d.isAsset {
			codeAssets = append(codeAssets, CodeAssetDoc{Id: id, Path: a.Path, Content: a.Content})
		}
		if inserted {
			created++
		}
	}
	// flushBatch 批量落库；任何失败整批降级为逐文件重放（保住逐路径
	// fail-soft 计数与「全灭才报错」判定）。
	flushBatch := func() {
		if len(batch) == 0 {
			return
		}
		idsByPath, insertedPaths, err := s.upsertOwnedDocsBatch(ctx, repositoryId, docOwnerId, batch)
		if err != nil {
			metrics.Inc("ingest.batch_write_fallbacks")
			log.Printf("[ingest-store] batch write failed (%d docs), falling back to per-doc replay: %v", len(batch), err)
			for _, d := range batch {
				replayDoc(d)
			}
			batch = batch[:0]
			return
		}
		for _, d := range batch {
			if insertedPaths[d.args.Path] {
				created++
			}
			if d.isAsset {
				codeAssets = append(codeAssets, CodeAssetDoc{Id: idsByPath[d.args.Path], Path: d.args.Path, Content: d.args.Content})
			}
		}
		batch = batch[:0]
	}

	for _, chapter := range chapters {
		for _, file := range chapter.Files {
			if file.Path == "" {
				continue
			}
			cleanPath, anchor := mdpat.SplitPathAnchor(file.Path)
			if anchor == "" && file.Anchor != "" {
				anchor = file.Anchor
			}
			docPath := mdpat.JoinPathAnchor(cleanPath, anchor)
			if docPath == "" || seenPaths[docPath] {
				continue
			}
			seenPaths[docPath] = true
			isDoc := false
			if patterns != nil {
				isDoc = patterns.IsDocFile(cleanPath)
				if !isDoc {
					lower := lowerASCII(cleanPath)
					for _, ext := range patterns.Sniffer.MarkdownExtensions {
						if strings.HasSuffix(lower, lowerASCII(ext)) {
							isDoc = true
							break
						}
					}
				}
			} else {
				isDoc = mdpat.MdMarkdownExtRe.MatchString(cleanPath)
			}

			if !isDoc {
				attempted++
				raw, readErr := readLocalArchiveFile(archiveRoot, owner, repo, shaOrBranch, cleanPath)
				if readErr != nil {
					failed++
					log.Printf("[ingest-store] code asset archive read failed, skipped %s: %v", cleanPath, readErr)
					continue
				}
				if raw == "" {
					failed++
					log.Printf("[ingest-store] code asset empty in archive, skipped %s", cleanPath)
					continue
				}
				parts := strings.Split(cleanPath, "/")
				title := cleanPath
				if len(parts) > 0 && parts[len(parts)-1] != "" {
					title = parts[len(parts)-1]
				}
				if anchor != "" {
					title = fmt.Sprintf("%s (%s)", title, anchor)
				}
				batch = append(batch, pendingChapterDoc{
					args: UpsertOwnedDocumentArgs{
						RepositoryId: repositoryId, Path: docPath, OwnerUserId: docOwnerId,
						Title: title, Content: raw, Status: "UNPROCESSED",
					},
					isAsset: true,
				})
			} else {
				attempted++
				title := docFallbackTitle(cleanPath)
				if t := strings.TrimSpace(file.ShortTitle); t != "" {
					title = t
				} else if anchor != "" {
					title = anchor
				}
				batch = append(batch, pendingChapterDoc{
					args: UpsertOwnedDocumentArgs{
						RepositoryId: repositoryId, Path: docPath, OwnerUserId: docOwnerId,
						Title: title, Content: "", Status: "UNPROCESSED",
					},
				})
			}
			if len(batch) >= chapterDocsBatchSize {
				flushBatch()
			}
		}
	}
	flushBatch()
	if attempted > 0 && failed == attempted {
		return created, codeAssets, fmt.Errorf("all %d chapter document writes failed for %s/%s (archive or database unavailable)", attempted, owner, repo)
	}
	return created, codeAssets, nil
}

// registerResetSQL 全量回退段（SQL 语义断言锚点，见 store_test.go）。
const registerResetSQL = `
	UPDATE "Document" SET content = NULL, "contentId" = NULL, status = 'UNPROCESSED',
	    "errorMessage" = NULL, "gitSha" = NULL, "updatedAt" = now()
	WHERE "repositoryId" = $1 AND (("ownerUserId" IS NULL AND $2::text IS NULL) OR "ownerUserId" = $2)
	  AND (content IS NOT NULL OR "contentId" IS NOT NULL)`

// ResetDocumentsUnprocessed 重置指定路径或全部已处理文档为 UNPROCESSED 状态（同步清理 content 与 contentId，防止幽灵内容回显）。
func (s *PgxStore) ResetDocumentsUnprocessed(ctx context.Context, repositoryId string, docOwnerId *string, paths []string) (int64, error) {
	if s.pool == nil {
		return 0, errors.New("store pool is nil")
	}
	var count int64
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		count, err = s.resetDocumentsUnprocessed(ctx, tx, repositoryId, docOwnerId, paths)
		return err
	})
	return count, err
}

func (s *PgxStore) resetDocumentsUnprocessed(ctx context.Context, q TxExec, repositoryId string, docOwnerId *string, paths []string) (int64, error) {
	if len(paths) > 0 {
		var ownerUID pgtype.Text
		if docOwnerId != nil {
			ownerUID = pgtype.Text{String: *docOwnerId, Valid: true}
		}
		return db.New(q).ResetDocumentsUnprocessedPaths(ctx, db.ResetDocumentsUnprocessedPathsParams{
			RepositoryId: repositoryId,
			OwnerUserId:  ownerUID,
			Paths:        paths,
		})
	}
	tag, err := q.Exec(ctx, registerResetSQL, repositoryId, docOwnerId)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// RegisterImportSnapshot 三态：diff 增量（changed 重置/removed 删除）、
// 全量回退（content 非空行重置）、skip（仅推进 ImportRecord）。
// 只重置归属者自己的文档（真冻结）。
// DeleteRepositoryRow 首导失败回滚：四元范围删（级联清理半成品行，
// 对齐 Node import-job-runner.ts:161-179 的 repository.deleteMany 语义）。
func (s *PgxStore) DeleteRepositoryRow(ctx context.Context, owner, repo, branch, edition string) (int64, error) {
	return db.New(s.pool).DeleteRepositoryRow(ctx, db.DeleteRepositoryRowParams{
		Owner:   owner,
		Repo:    repo,
		Branch:  branch,
		Edition: edition,
	})
}

// PeekRepositoryForCommit 在 Upsert 前探测仓库既有状态与 gitSha，用于更新导入补偿回滚与活快照判定。
func (s *PgxStore) PeekRepositoryForCommit(ctx context.Context, owner, repo, branch, edition string) (*PeekRepoResult, error) {
	row, err := db.New(s.pool).PeekRepositoryForCommit(ctx, db.PeekRepositoryForCommitParams{
		Owner:   owner,
		Repo:    repo,
		Branch:  branch,
		Edition: edition,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	var sha *string
	if row.GitSha.Valid {
		v := row.GitSha.String
		sha = &v
	}
	return &PeekRepoResult{
		Id:     row.ID,
		GitSha: sha,
	}, nil
}

// RestoreRepositoryGitSha CAS 回滚 Repository 行的 gitSha（仅当行内 sha 仍等于本次
// 导入写入的 expectSha 时生效），使更新导入失败后 auto-update 可重新感知并自愈；
// 并发邻居任务已推进 sha 时不覆写（返回 0 行）。
func (s *PgxStore) RestoreRepositoryGitSha(ctx context.Context, repoId string, restoreSha, expectSha *string) (int64, error) {
	var restore, expect pgtype.Text
	if restoreSha != nil {
		restore = pgtype.Text{String: *restoreSha, Valid: true}
	}
	if expectSha != nil {
		expect = pgtype.Text{String: *expectSha, Valid: true}
	}
	return db.New(s.pool).RestoreRepositoryGitSha(ctx, db.RestoreRepositoryGitShaParams{
		ID:         repoId,
		RestoreSha: restore,
		ExpectSha:  expect,
	})
}

func (s *PgxStore) RegisterImportSnapshot(ctx context.Context, p RegisterSnapshotParams) (bool, error) {
	if p.UserId == "" || p.Sha == "" {
		return false, nil
	}

	var shaChanged bool
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var ierr error
		shaChanged, ierr = s.registerImportSnapshot(ctx, tx, p)
		return ierr
	})
	if err != nil {
		return shaChanged, err
	}
	return shaChanged, nil
}

func (s *PgxStore) registerImportSnapshot(ctx context.Context, tx TxExec, p RegisterSnapshotParams) (bool, error) {
	prev, err := db.New(tx).GetImportRecordSha(ctx, db.GetImportRecordShaParams{
		UserId:       p.UserId,
		RepositoryId: p.RepositoryId,
		Branch:       p.Branch,
	})
	shaChanged := err == nil && prev != "" && prev != p.Sha

	if shaChanged && !p.SkipReset {
		if err := s.resetSnapshotDocuments(ctx, tx, p); err != nil {
			return false, err
		}
	}

	err = db.New(tx).UpsertImportRecord(ctx, db.UpsertImportRecordParams{
		UserId:       p.UserId,
		RepositoryId: p.RepositoryId,
		Owner:        p.Owner,
		Repo:         p.Repo,
		Branch:       p.Branch,
		Sha:          p.Sha,
	})
	return shaChanged, err
}

func (s *PgxStore) resetSnapshotDocuments(ctx context.Context, tx TxExec, p RegisterSnapshotParams) error {
	if len(p.Changed) > 0 || len(p.Removed) > 0 {
		if len(p.Changed) > 0 {
			if _, err := s.resetDocumentsUnprocessed(ctx, tx, p.RepositoryId, p.DocOwnerId, p.Changed); err != nil {
				return err
			}
		}
		if len(p.Removed) > 0 {
			var ownerUID pgtype.Text
			if p.DocOwnerId != nil {
				ownerUID = pgtype.Text{String: *p.DocOwnerId, Valid: true}
			}
			if err := db.New(tx).DeleteDocumentsByPaths(ctx, db.DeleteDocumentsByPathsParams{
				RepositoryId: p.RepositoryId,
				OwnerUserId:  ownerUID,
				Paths:        p.Removed,
			}); err != nil {
				return err
			}
		}
		return nil
	}
	_, err := s.resetDocumentsUnprocessed(ctx, tx, p.RepositoryId, p.DocOwnerId, nil)
	return err
}

// StoreOutlineDraft 两步创建（Outline+Parts → Chapter+Nodes；版本号=最大+1）。
func (s *PgxStore) StoreOutlineDraft(ctx context.Context, repositoryId string, draft OutlineDraft, isActive bool) (string, error) {
	var outlineId string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var ierr error
		outlineId, ierr = StoreOutlineDraftTx(ctx, tx, repositoryId, draft, isActive)
		return ierr
	})
	if err != nil {
		return "", err
	}
	return outlineId, nil
}

// StoreOutlineDraftTx 大纲两步创建单一事实源内核：与 StoreOutlineDraft 语义
// 完全一致，供外部事务（如增量更新 apply 事务）在自己的 tx 内联复用，
// 消除 navTree→大纲派生落库的第二实现。
func StoreOutlineDraftTx(ctx context.Context, q TxExec, repositoryId string, draft OutlineDraft, isActive bool) (string, error) {
	maxVersion, err := db.New(q).GetMaxTutorialOutlineVersion(ctx, repositoryId)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	version := int(maxVersion) + 1

	outlineId, err := db.New(q).InsertTutorialOutline(ctx, db.InsertTutorialOutlineParams{
		RepositoryId: repositoryId,
		Version:      int32(version),
		IsActive:     isActive,
	})
	if err != nil {
		return "", err
	}

	if isActive {
		if err := db.New(q).DeactivateOtherOutlines(ctx, db.DeactivateOtherOutlinesParams{
			RepositoryId: repositoryId,
			ID:           outlineId,
		}); err != nil {
			return "", err
		}
	}

	partTitleToId := map[string]string{}
	for _, part := range draft.Parts {
		var summary pgtype.Text
		if part.Summary != nil && *part.Summary != "" {
			summary = pgtype.Text{String: *part.Summary, Valid: true}
		}
		partId, err := db.New(q).InsertOutlinePart(ctx, db.InsertOutlinePartParams{
			OutlineId:     outlineId,
			Title:         part.Title,
			Summary:       summary,
			TeachingOrder: int32(part.TeachingOrder),
		})
		if err != nil {
			return "", err
		}
		partTitleToId[part.Title] = partId
	}

	rows, err := db.New(q).GetDocumentIdsAndOwner(ctx, repositoryId)
	if err != nil {
		return "", err
	}
	pathToDocId := map[string]string{}
	for _, r := range rows {
		if _, exists := pathToDocId[r.Path]; !exists || !r.OwnerUserId.Valid {
			pathToDocId[r.Path] = r.ID
		}
	}

	for _, chapter := range draft.Chapters {
		var partId pgtype.Text
		if chapter.PartTitle != "" {
			if pid, ok := partTitleToId[chapter.PartTitle]; ok {
				partId = pgtype.Text{String: pid, Valid: true}
			}
		}
		var summary pgtype.Text
		if chapter.Summary != nil && *chapter.Summary != "" {
			summary = pgtype.Text{String: *chapter.Summary, Valid: true}
		}
		chapterId, err := db.New(q).InsertOutlineChapter(ctx, db.InsertOutlineChapterParams{
			OutlineId:     outlineId,
			PartId:        partId,
			Title:         chapter.Title,
			Summary:       summary,
			ChapterType:   chapter.ChapterType,
			TeachingOrder: int32(chapter.TeachingOrder),
		})
		if err != nil {
			return "", err
		}
		for idx, node := range chapter.Nodes {
			var docId pgtype.Text
			if id, ok := pathToDocId[node.SourcePath]; ok {
				docId = pgtype.Text{String: id, Valid: true}
			}
			nodeType := node.NodeType
			if nodeType == "" {
				nodeType = "doc"
			}
			if err := db.New(q).InsertOutlineNode(ctx, db.InsertOutlineNodeParams{
				ChapterId:     chapterId,
				DocumentId:    docId,
				Title:         node.Title,
				NodeType:      nodeType,
				TeachingOrder: int32(idx),
			}); err != nil {
				return "", err
			}
		}
	}
	return outlineId, nil
}

// ActivateOutline 激活指定大纲并使同仓其他大纲失效。
func (s *PgxStore) ActivateOutline(ctx context.Context, repositoryId, outlineId string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if repositoryId == "" || outlineId == "" {
		return errors.New("repositoryId and outlineId are required")
	}

	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := db.New(tx)
		if err := q.DeactivateOtherOutlines(ctx, db.DeactivateOtherOutlinesParams{
			RepositoryId: repositoryId,
			ID:           outlineId,
		}); err != nil {
			return fmt.Errorf("failed to deactivate other outlines: %w", err)
		}

		rowsAffected, err := q.ActivateOutline(ctx, outlineId)
		if err != nil {
			return fmt.Errorf("failed to activate outline: %w", err)
		}
		if rowsAffected == 0 {
			return errors.New("outline not found")
		}
		return nil
	})
}

// DeactivateAllOutlines 停用指定仓库的所有大纲。
func (s *PgxStore) DeactivateAllOutlines(ctx context.Context, repositoryId string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if repositoryId == "" {
		return errors.New("repositoryId is required")
	}

	return db.New(s.pool).DeactivateAllOutlines(ctx, repositoryId)
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

// ─────────────────────────────────────────────────────────────
// WebSync 增量同步数据访问面实现
// ─────────────────────────────────────────────────────────────

// GetRepositoryForWebSync 查询增量同步所需的目标仓库及已有文档所有者基线。
func (s *PgxStore) GetRepositoryForWebSync(ctx context.Context, owner, repo string) (*WebSyncRepoInfo, error) {
	if s.pool == nil {
		return nil, nil
	}
	row, err := db.New(s.pool).GetRepositoryForWebSync(ctx, db.GetRepositoryForWebSyncParams{
		Owner: strings.ToLower(owner),
		Repo:  strings.ToLower(repo),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("query repository for web sync failed: %w", err)
	}

	id := row.ID
	isPublic := row.IsPublic
	branch := row.Branch
	var upstreamEtag *string
	if row.UpstreamEtag.Valid {
		upstreamEtag = &row.UpstreamEtag.String
	}
	profileJSON := row.RepoProfile

	var docOwnerID *string
	existingOwner, docErr := db.New(s.pool).GetDocumentExistingOwner(ctx, id)
	if docErr == nil && existingOwner.Valid && existingOwner.String != "" {
		docOwnerID = &existingOwner.String
	}

	var profile struct {
		SourceType        string            `json:"sourceType"`
		OriginalURL       string            `json:"originalUrl"`
		SiteTitle         string            `json:"siteTitle"`
		SitemapLastModMap map[string]string `json:"sitemapLastModMap"`
		AllowedPrefixes   []string          `json:"allowedPrefixes"`
		ExcludePrefixes   []string          `json:"excludePrefixes"`
	}
	if len(profileJSON) > 0 {
		_ = json.Unmarshal(profileJSON, &profile)
	}
	if profile.SitemapLastModMap == nil {
		profile.SitemapLastModMap = make(map[string]string)
	}

	return &WebSyncRepoInfo{
		ID:                id,
		IsPublic:          isPublic,
		Branch:            branch,
		UpstreamEtag:      upstreamEtag,
		OriginalURL:       profile.OriginalURL,
		SiteTitle:         profile.SiteTitle,
		SourceType:        profile.SourceType,
		SitemapLastModMap: profile.SitemapLastModMap,
		DocOwnerID:        docOwnerID,
		AllowedPrefixes:   profile.AllowedPrefixes,
		ExcludePrefixes:   profile.ExcludePrefixes,
	}, nil
}

// TouchWebSyncNoChanges 0 变更时原子更新上游检测时间与 sitemap 缓存基线。
func (s *PgxStore) TouchWebSyncNoChanges(ctx context.Context, repoID, etag string, lastModMap map[string]string) error {
	if s.pool == nil {
		return nil
	}
	var patchJSON []byte
	if len(lastModMap) > 0 {
		patchJSON, _ = json.Marshal(map[string]any{"sitemapLastModMap": lastModMap})
	}
	var err error
	if len(patchJSON) > 0 {
		q := db.New(s.pool)
		err = q.UpdateRepositorySyncStatusWithProfile(ctx, db.UpdateRepositorySyncStatusWithProfileParams{
			ID:           repoID,
			UpstreamEtag: etag,
			ProfilePatch: patchJSON,
		})
	} else {
		q := db.New(s.pool)
		err = q.UpdateRepositorySyncStatus(ctx, db.UpdateRepositorySyncStatusParams{
			ID:           repoID,
			UpstreamEtag: etag,
		})
	}
	return err
}

// ExecuteWebSyncTx 在单个 pgx 事务中原子执行增量页面 upsert、删除移除页面、更新 Repository 行与登记快照。
func (s *PgxStore) ExecuteWebSyncTx(ctx context.Context, p WebSyncTxParams) ([]WebSyncSavedDoc, error) {
	if s.pool == nil {
		return nil, nil
	}
	var savedDocs []WebSyncSavedDoc
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// 1. 批量 upsert PROCESSED 文档（经 sanitizeWebDocMarkdown 清洗）
		for _, doc := range p.UpdatedDocs {
			cleaned := sanitizeWebDocMarkdown(doc.Path, doc.Markdown)
			docID, err := s.upsertOwnedDocument(ctx, tx, UpsertOwnedDocumentArgs{
				RepositoryId: p.RepositoryID,
				Path:         doc.Path,
				OwnerUserId:  p.DocOwnerID,
				Title:        doc.Title,
				Content:      cleaned,
				Status:       "PROCESSED",
				HasUpdate:    true,
				UpdateTitle:  doc.Title,
			})
			if err != nil {
				return fmt.Errorf("upsert owned document failed for %s: %w", doc.Path, err)
			}
			savedDocs = append(savedDocs, WebSyncSavedDoc{
				ID:      docID,
				Path:    doc.Path,
				Content: cleaned,
			})
		}

		// 2. 批量物理删除上游已移除的路径
		if len(p.RemovedPaths) > 0 {
			var ownerUID pgtype.Text
			if p.DocOwnerID != nil {
				ownerUID = pgtype.Text{String: *p.DocOwnerID, Valid: true}
			}
			err := db.New(tx).DeleteDocumentsByPaths(ctx, db.DeleteDocumentsByPathsParams{
				RepositoryId: p.RepositoryID,
				OwnerUserId:  ownerUID,
				Paths:        p.RemovedPaths,
			})
			if err != nil {
				return fmt.Errorf("delete removed documents failed: %w", err)
			}
		}

		// 3. 更新 Repository 行状态与 sitemapLastModMap
		profilePatch := map[string]any{
			"lastSyncedAt": time.Now().UTC().Format(time.RFC3339),
		}
		if p.SitemapLastModMap != nil {
			profilePatch["sitemapLastModMap"] = p.SitemapLastModMap
		}
		patchJSON, _ := json.Marshal(profilePatch)

		q := db.New(tx)
		err := q.UpdateRepositorySyncStatusWithProfile(ctx, db.UpdateRepositorySyncStatusWithProfileParams{
			ID:           p.RepositoryID,
			UpstreamEtag: p.ETag,
			ProfilePatch: patchJSON,
		})
		if err != nil {
			return fmt.Errorf("update repository row failed: %w", err)
		}

		// 4. RegisterImportSnapshot（带 skipDocumentReset = true）
		if p.UserID != "" && p.AggregateSha != "" {
			_, err = s.registerImportSnapshot(ctx, tx, RegisterSnapshotParams{
				UserId:       p.UserID,
				RepositoryId: p.RepositoryID,
				Owner:        strings.ToLower(p.Owner),
				Repo:         strings.ToLower(p.Repo),
				Branch:       p.Branch,
				Sha:          p.AggregateSha,
				DocOwnerId:   p.DocOwnerID,
				SkipReset:    true,
			})
			if err != nil {
				return fmt.Errorf("register import snapshot failed: %w", err)
			}
		}

		return nil
	})
	if err != nil {
		return nil, err
	}
	return savedDocs, nil
}

// DeleteOwnedDocumentsByPaths 批量物理删除指定归属的文档路径。
func (s *PgxStore) DeleteOwnedDocumentsByPaths(ctx context.Context, repoID string, docOwnerID *string, paths []string) error {
	if s.pool == nil || len(paths) == 0 {
		return nil
	}
	var ownerUID pgtype.Text
	if docOwnerID != nil {
		ownerUID = pgtype.Text{String: *docOwnerID, Valid: true}
	}
	return db.New(s.pool).DeleteDocumentsByPaths(ctx, db.DeleteDocumentsByPathsParams{
		RepositoryId: repoID,
		OwnerUserId:  ownerUID,
		Paths:        paths,
	})
}

// UpdateImportJobProgress 更新导入作业 options.progressInfo 动态流式进度（委托 internal/jobs 单写者内核）。
func (s *PgxStore) UpdateImportJobProgress(ctx context.Context, jobId string, step string, progress int) error {
	if s.pool == nil {
		return errors.New("store pool is nil")
	}
	return jobs.UpdateImportJobProgress(ctx, s.pool, jobId, step, progress)
}

// BatchEnqueueTranscription 批量将仓库下所有 UNPROCESSED 章节入队。
func (s *PgxStore) BatchEnqueueTranscription(ctx context.Context, repoId string, requestedBy string, options any) (int64, error) {
	if s.pool == nil {
		return 0, errors.New("store pool is nil")
	}
	optsJSON, err := json.Marshal(options)
	if err != nil || len(optsJSON) == 0 {
		optsJSON = []byte("{}")
	}
	if requestedBy == "" {
		requestedBy = "system"
	}
	return db.New(s.pool).TranscriptionBatchEnqueueJobs(ctx, db.TranscriptionBatchEnqueueJobsParams{
		RepositoryID: repoId,
		RequestedBy:  requestedBy,
		Options:      optsJSON,
	})
}

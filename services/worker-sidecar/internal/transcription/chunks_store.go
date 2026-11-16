package transcription

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

// ─────────────────────────────────────────────────────────────
// DocumentChunk 写库下沉（Chunker Phase 3）：Go 转录收尾链零内容搬运——
// 进程内切片 + 本库直写，web 只保留概念抽取/图谱边/摘要决策。
// 事务序与列语义与 chunker.ts chunkAndStoreDocs 逐字对齐。
// ─────────────────────────────────────────────────────────────

// ChunkWriteStore chunk 行落库（消费侧窄接口，单测 fake）。
type ChunkWriteStore interface {
	ReplaceDocumentChunks(ctx context.Context, documentId string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error)
}

// ReplaceChunksOpts 与 chunker.ts 元数据解析对齐的入参。
type ReplaceChunksOpts = webdoc.ReplaceChunksOpts

// documentChunkMetaSQL 镜像 chunker.ts:316-328 的元数据兜底解析。
const documentChunkMetaSQL = `
	SELECT d.path, r."semVerLabel", r.branch
	FROM "Document" d
	JOIN "Repository" r ON r.id = d."repositoryId"
	WHERE d.id = $1`

// insertDocumentChunkRowColumns 9 列逐字对齐 chunker.ts:409（searchVector 为
// DB 生成列绝不插入，与 TS raw INSERT 一致）。
const insertDocumentChunkRowColumns = `("id", "documentId", "heading", "headingPath", "contentType", "content", "order", "updatedAt", "semVerLabel")`

// chunkBatchSize 与 TS sqlBatchSize=100 同值。
const chunkBatchSize = 100

// mdxPathMarkerRe 与 chunker.ts:384 逐字一致（提取代码块标题内嵌文件路径）。
var mdxPathMarkerRe = regexp.MustCompile(`<!-- path:\s*(.*?)\s*-->`)

func nullableStrPtr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ResolveHeadingPath 与 chunker.ts:382-390 逐字对齐：
// 显式 headingPath 优先 → `path#heading` 默认 → `<!-- path: -->` 标记提取 → `📄 \“ 前缀。
// read_section 对代码块的寻址依赖后两条规则（load-bearing，不可简化）。
func ResolveHeadingPath(heading, headingPath, docPath string) string {
	resolved := headingPath
	if resolved == "" {
		if docPath != "" {
			resolved = fmt.Sprintf("%s#%s", docPath, heading)
		} else {
			resolved = heading
		}
	}
	if heading != "" && headingPath == "" {
		if m := mdxPathMarkerRe.FindStringSubmatch(heading); m != nil {
			resolved = m[1]
		} else if strings.HasPrefix(heading, "📄 `") {
			resolved = docPath
		}
	}
	return resolved
}

func resolveHeadingPath(heading, headingPath, docPath string) string {
	return ResolveHeadingPath(heading, headingPath, docPath)
}

// ResolveVersionLabel 与 chunker.ts:334-336 逐字对齐。
func ResolveVersionLabel(semVerLabel, branch, defaultBranch string) string {
	if semVerLabel != "" {
		return semVerLabel
	}
	if branch != "" && branch != defaultBranch {
		return branch
	}
	return ""
}

func resolveVersionLabel(semVerLabel, branch, defaultBranch string) string {
	return ResolveVersionLabel(semVerLabel, branch, defaultBranch)
}

type storedChunkRow struct {
	heading     string
	headingPath string
	contentType string
	content     string
	order       int
}

// buildChunkInsertBatch 拼装一批的多行 INSERT（id 由 gen_random_uuid() 在 SQL 内
// 生成，等价 TS randomUUID()）。独立纯函数以便单测锚定 SQL 形态。
func buildChunkInsertBatch(documentId string, rows []storedChunkRow, versionLabel string, startOrder int) (string, []any) {
	var sb strings.Builder
	sb.WriteString(`INSERT INTO "DocumentChunk" `)
	sb.WriteString(insertDocumentChunkRowColumns)
	sb.WriteString(` VALUES `)
	args := make([]any, 0, len(rows)*7)
	param := 1
	for i, r := range rows {
		if i > 0 {
			sb.WriteString(", ")
		}
		fmt.Fprintf(&sb, "(gen_random_uuid()::text, $%d, $%d, $%d, $%d, $%d, $%d, NOW(), $%d)",
			param, param+1, param+2, param+3, param+4, param+5, param+6)
		param += 7
		args = append(args,
			documentId,
			nullableStrPtr(r.heading),
			nullableStrPtr(r.headingPath),
			r.contentType,
			r.content,
			startOrder+i,
			nullableStrPtr(versionLabel),
		)
	}
	return sb.String(), args
}

// ReplaceDocumentChunks 重切落库：行锁（吞错）→ 概念 chunkId 置 null → 删旧 →
// 100/批插入。失败时事务回滚（旧行保留）+ 事务外兜底清理，与 chunker.ts:428-434
// 的防御语义一致。返回落库行数。
func (s *PgxStore) ReplaceDocumentChunks(ctx context.Context, documentId string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error) {
	if len(chunks) == 0 {
		return 0, nil
	}

	queries := db.New(s.pool)
	meta, err := queries.GetDocumentChunkMeta(ctx, documentId)
	if err != nil {
		return 0, fmt.Errorf("resolve chunk meta: %w", err)
	}

	docPath := meta.Path
	if docPath == "" {
		docPath = opts.DocPath
	}
	var semVerLabel string
	if meta.SemVerLabel.Valid {
		semVerLabel = meta.SemVerLabel.String
	}
	branch := meta.Branch
	versionLabel := ResolveVersionLabel(semVerLabel, branch, opts.DefaultBranch)

	var headings, headingPaths, contentTypes, contents []string
	var chunkOrders []int32
	for i, c := range chunks {
		hp := ResolveHeadingPath(c.Heading, derefStrPtr(c.HeadingPath), docPath)
		contentType := strings.TrimSpace(c.ContentType)
		if contentType == "" {
			contentType = chunker.ClassifyChunk(c.Content, hp, opts.BlueprintRole)
		}
		headings = append(headings, c.Heading)
		headingPaths = append(headingPaths, hp)
		contentTypes = append(contentTypes, contentType)
		contents = append(contents, c.Content)
		chunkOrders = append(chunkOrders, int32(i))
	}

	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		txQueries := db.New(tx)
		// 缩短排他锁窗口：在批量参数组装后再获取 Document 的行锁
		_, _ = txQueries.LockDocumentForUpdate(ctx, documentId)
		// 重切前清空本文档概念的旧 chunkId 引用
		if err := txQueries.ClearTutorialConceptChunkRef(ctx, pgtype.Text{String: documentId, Valid: documentId != ""}); err != nil {
			return err
		}
		if err := txQueries.ClearDocumentChunks(ctx, pgtype.Text{String: documentId, Valid: documentId != ""}); err != nil {
			return err
		}

		for start := 0; start < len(chunks); start += chunkBatchSize {
			end := start + chunkBatchSize
			if end > len(chunks) {
				end = len(chunks)
			}

			if err := txQueries.BatchInsertDocumentChunks(ctx, db.BatchInsertDocumentChunksParams{
				DocumentID:   documentId,
				SemVerLabel:  versionLabel,
				Headings:     headings[start:end],
				HeadingPaths: headingPaths[start:end],
				ContentTypes: contentTypes[start:end],
				Contents:     contents[start:end],
				ChunkOrders:  chunkOrders[start:end],
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		// 事务外兜底清理
		_ = queries.ClearDocumentChunks(ctx, pgtype.Text{String: documentId, Valid: documentId != ""})
		return 0, fmt.Errorf("replace document chunks: %w", err)
	}
	return len(chunks), nil
}

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

type ChunkWriteStore interface {
	ReplaceDocumentChunks(ctx context.Context, documentId string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error)
}

type ReplaceChunksOpts = webdoc.ReplaceChunksOpts

const documentChunkMetaSQL = `
	SELECT d.path, r."semVerLabel", r.branch
	FROM "Document" d
	JOIN "Repository" r ON r.id = d."repositoryId"
	WHERE d.id = $1`

// Omits searchVector (DB-generated column) to match raw INSERT semantics.
const insertDocumentChunkRowColumns = `("id", "documentId", "heading", "headingPath", "contentType", "content", "order", "updatedAt", "semVerLabel")`

const chunkBatchSize = 100

var mdxPathMarkerRe = regexp.MustCompile(`<!-- path:\s*(.*?)\s*-->`)

func nullableStrPtr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// Preserves <!-- path: --> and "📄 " fallbacks required by read_section chunk addressing.
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
		// Acquires document row lock after building batch params to minimize exclusive lock duration.
		_, _ = txQueries.LockDocumentForUpdate(ctx, documentId)
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
		_ = queries.ClearDocumentChunks(ctx, pgtype.Text{String: documentId, Valid: documentId != ""})
		return 0, fmt.Errorf("replace document chunks: %w", err)
	}
	return len(chunks), nil
}

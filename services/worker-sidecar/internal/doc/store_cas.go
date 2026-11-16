package doc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/chunker"
)

// UpsertContentInput holds parameters for CAS document content upsert.
type UpsertContentInput struct {
	ContentHash        string  `json:"contentHash"`
	RequestFingerprint *string `json:"requestFingerprint,omitempty"`
	Content            string  `json:"content"`
	Lang               string  `json:"lang"`
	GenerationModel    *string `json:"generationModel,omitempty"`
}

// OrphanContentGCInput holds parameters for orphan document content cleanup.
type OrphanContentGCInput struct {
	GraceDays int  `json:"graceDays"`
	DryRun    bool `json:"dryRun"`
	MaxPerRun int  `json:"maxPerRun"`
}

// OrphanContentGCResult holds outcome of orphan document content cleanup.
type OrphanContentGCResult struct {
	Scanned int  `json:"scanned"`
	Removed int  `json:"removed"`
	DryRun  bool `json:"dryRun"`
}

// StoreChunksInput holds payload to store chunks for a document or content layer.
type StoreChunksInput struct {
	DocumentID    string                  `json:"documentId,omitempty"`
	ContentID     string                  `json:"contentId,omitempty"`
	DocPath       string                  `json:"docPath,omitempty"`
	BlueprintRole string                  `json:"blueprintRole,omitempty"`
	SemVerLabel   string                  `json:"semVerLabel,omitempty"`
	Chunks        []chunker.MarkdownChunk `json:"chunks"`
}

// UpsertContent inserts or updates a DocumentContent row idempotently.
func (s *PgxStore) UpsertContent(ctx context.Context, input UpsertContentInput) (string, error) {
	if s == nil || s.pool == nil {
		return "", errors.New("db pool not configured")
	}
	if strings.TrimSpace(input.ContentHash) == "" {
		return "", errors.New("contentHash is required")
	}

	querier := db.New(s.pool)
	row, err := querier.FindContentHash(ctx, input.ContentHash)
	if err == nil {
		if !row.RequestFingerprint.Valid && input.RequestFingerprint != nil && *input.RequestFingerprint != "" {
			_ = querier.SetContentFingerprint(ctx, db.SetContentFingerprintParams{
				RequestFingerprint: pgtype.Text{String: *input.RequestFingerprint, Valid: true},
				ID:                 row.ID,
			})
		}
		return row.ID, nil
	}

	argFp := pgtype.Text{}
	if input.RequestFingerprint != nil && *input.RequestFingerprint != "" {
		argFp = pgtype.Text{String: *input.RequestFingerprint, Valid: true}
	}
	argModel := pgtype.Text{}
	if input.GenerationModel != nil && *input.GenerationModel != "" {
		argModel = pgtype.Text{String: *input.GenerationModel, Valid: true}
	}

	affected, err := querier.InsertContentHash(ctx, db.InsertContentHashParams{
		ContentHash:        input.ContentHash,
		RequestFingerprint: argFp,
		Content:            input.Content,
		Lang:               input.Lang,
		GenerationModel:    argModel,
	})
	if err != nil {
		return "", err
	}
	if affected > 0 {
		row, err := querier.FindContentHash(ctx, input.ContentHash)
		return row.ID, err
	}

	// 冲突①：同内容并发 → 重查赢家
	if row, err := querier.FindContentHash(ctx, input.ContentHash); err == nil && row.ID != "" {
		return row.ID, nil
	}

	// 冲突②：撞既有指纹的不同内容 → 去指纹落新行（首次为准）
	if input.RequestFingerprint != nil && *input.RequestFingerprint != "" {
		if _, err := querier.InsertContentHashFallback(ctx, db.InsertContentHashFallbackParams{
			ContentHash: input.ContentHash,
			Content:     input.Content,
			Lang:        input.Lang,
			GenerationModel:     argModel,
		}); err == nil {
			if row, err := querier.FindContentHash(ctx, input.ContentHash); err == nil && row.ID != "" {
				return row.ID, nil
			}
		}
	}

	return "", errors.New("content layer conflict unresolved")
}

// OrphanContentGC scans and purges unreferenced DocumentContent older than graceDays.
func (s *PgxStore) OrphanContentGC(ctx context.Context, input OrphanContentGCInput) (OrphanContentGCResult, error) {
	result := OrphanContentGCResult{DryRun: input.DryRun}
	if s == nil || s.pool == nil {
		return result, errors.New("db pool not configured")
	}

	graceDays := input.GraceDays
	if graceDays <= 0 {
		graceDays = 7
	}
	maxPerRun := input.MaxPerRun
	if maxPerRun <= 0 {
		maxPerRun = 50000
	}
	batchSize := 2000

	cutoff := time.Now().Add(-time.Duration(graceDays) * 24 * time.Hour)

	for {
		if !input.DryRun && result.Removed >= maxPerRun {
			break
		}

		querier := db.New(s.pool)
		orphanIDs, err := querier.FindOrphanContent(ctx, db.FindOrphanContentParams{
			UpdatedAt: pgtype.Timestamp{Time: cutoff, Valid: true},
			Limit:     int32(batchSize),
		})
		if err != nil {
			return result, fmt.Errorf("scan orphan content: %w", err)
		}

		if len(orphanIDs) == 0 {
			break
		}
		result.Scanned += len(orphanIDs)

		if input.DryRun {
			result.Removed += len(orphanIDs)
			if result.Removed > maxPerRun {
				result.Removed = maxPerRun
			}
			break
		}

		affected, err := querier.DeleteOrphanContent(ctx, orphanIDs)
		if err != nil {
			return result, fmt.Errorf("delete orphan content: %w", err)
		}
		deletedCount := int(affected)
		result.Removed += deletedCount
		if deletedCount < len(orphanIDs) {
			break
		}
	}

	return result, nil
}

// AttachChunks copies per-document chunks into contentId ownership.
func (s *PgxStore) AttachChunks(ctx context.Context, contentId, documentId string) (int, error) {
	if s == nil || s.pool == nil {
		return 0, errors.New("db pool not configured")
	}
	if contentId == "" || documentId == "" {
		return 0, errors.New("contentId and documentId are required")
	}

	var count int
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		querier := db.New(tx)
		if _, err := querier.DeleteContentChunks(ctx, pgtype.Text{String: contentId, Valid: true}); err != nil {
			return err
		}
		affected, err := querier.CopyDocumentChunksToContent(ctx, db.CopyDocumentChunksToContentParams{
			ContentId: pgtype.Text{String: contentId, Valid: true},
			DocumentId: pgtype.Text{String: documentId, Valid: true},
		})
		if err != nil {
			return err
		}
		count = int(affected)
		return nil
	})

	return count, err
}

// StoreDocumentChunks stores chunks atomically for documentId or contentId.
func (s *PgxStore) StoreDocumentChunks(ctx context.Context, input StoreChunksInput) (int, error) {
	if s == nil || s.pool == nil {
		return 0, errors.New("db pool not configured")
	}
	if input.DocumentID == "" && input.ContentID == "" {
		return 0, errors.New("either documentId or contentId is required")
	}

		var batches []db.InsertDocumentChunkParams

	if len(input.Chunks) > 0 {
		batchSize := 100
		for start := 0; start < len(input.Chunks); start += batchSize {
			end := start + batchSize
			if end > len(input.Chunks) {
				end = len(input.Chunks)
			}
			batch := input.Chunks[start:end]

			for i, c := range batch {
				idx := start + i
				heading := c.Heading
				var hpVal *string
				if c.HeadingPath != nil && *c.HeadingPath != "" {
					hpVal = c.HeadingPath
				}
				contentType := strings.TrimSpace(c.ContentType)
				if contentType == "" {
					contentType = "prose"
				}

				var docIDArg *string
				if input.DocumentID != "" {
					docIDArg = &input.DocumentID
				}
				var cntIDArg *string
				if input.ContentID != "" {
					cntIDArg = &input.ContentID
				}
				var semVerArg *string
				if input.SemVerLabel != "" {
					semVerArg = &input.SemVerLabel
				}

				argDoc := pgtype.Text{}
				if docIDArg != nil { argDoc = pgtype.Text{String: *docIDArg, Valid: true} }
				argCnt := pgtype.Text{}
				if cntIDArg != nil { argCnt = pgtype.Text{String: *cntIDArg, Valid: true} }
				
				argHp := pgtype.Text{}
				if hpVal != nil { argHp = pgtype.Text{String: *hpVal, Valid: true} }
				argSemVer := pgtype.Text{}
				if semVerArg != nil { argSemVer = pgtype.Text{String: *semVerArg, Valid: true} }
				batches = append(batches, db.InsertDocumentChunkParams{
					ArgDocumentId: argDoc,
					ArgContentId: argCnt,
					ArgHeading: heading,
					ArgHeadingPath: argHp,
					ArgContentType: contentType,
					ArgContent: c.Content,
					ArgOrder: int32(idx),
					ArgSemVerLabel: argSemVer,
				})
			}
		}
	}

	inserted := 0
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if input.DocumentID != "" {
			querier := db.New(tx)
			// 行级锁（吞错，与 Node 端一致）
			_, _ = querier.LockDocumentForUpdate(ctx, input.DocumentID)
			// 重切前清空本文档概念的旧 chunkId 引用
			if err := querier.UnlinkTutorialConceptNodeChunks(ctx, pgtype.Text{String: input.DocumentID, Valid: true}); err != nil {
				return err
			}
			if _, err := querier.DeleteDocumentChunks(ctx, pgtype.Text{String: input.DocumentID, Valid: true}); err != nil {
				return err
			}
		} else if input.ContentID != "" {
			querier := db.New(tx)
			if _, err := querier.DeleteContentChunks(ctx, pgtype.Text{String: input.ContentID, Valid: true}); err != nil {
				return err
			}
		}

		querier := db.New(tx)
		for _, b := range batches {
			affected, err := querier.InsertDocumentChunk(ctx, b)
			if err != nil {
				return fmt.Errorf("insert document chunk: %w", err)
			}
			inserted += int(affected)
		}
		return nil
	})

	return inserted, err
}


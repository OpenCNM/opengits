package transcription

import (
	"context"
	"log"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

// Drops fingerprint on collision with different content (first content owns the fingerprint).
func (s *PgxStore) UpsertContentLayer(ctx context.Context, contentHash, requestFingerprint, content, lang, model string) (string, error) {
	row, err := s.queries.GetContentByHash(ctx, contentHash)
	if err == nil {
		if !row.RequestFingerprint.Valid && requestFingerprint != "" {
			_ = s.queries.UpdateContentRequestFingerprint(ctx, db.UpdateContentRequestFingerprintParams{
				RequestFingerprint: pgtype.Text{String: requestFingerprint, Valid: true},
				ID:                 row.ID,
			})
		}
		return row.ID, nil
	}

	_, err = s.queries.InsertContentLayer(ctx, db.InsertContentLayerParams{
		ContentHash:        contentHash,
		RequestFingerprint: requestFingerprint,
		Content:            pgtype.Text{String: content, Valid: true},
		Lang:               lang,
		GenerationModel:    model,
	})
	if err != nil {
		return "", err
	}
	id, err := s.queries.GetContentIdByHash(ctx, contentHash)
	if err == nil && id != "" {
		return id, nil
	}

	if rid, err := s.queries.GetContentIdByHash(ctx, contentHash); err == nil && rid != "" {
		return rid, nil
	}

	if requestFingerprint != "" {
		_, err := s.queries.InsertContentLayerNoFingerprint(ctx, db.InsertContentLayerNoFingerprintParams{
			ContentHash:     contentHash,
			Content:         pgtype.Text{String: content, Valid: true},
			Lang:            lang,
			GenerationModel: model,
		})
		if err == nil {
			if rid, err := s.queries.GetContentIdByHash(ctx, contentHash); err == nil && rid != "" {
				return rid, nil
			}
		}
	}
	return "", errContentLayerConflict
}

var errContentLayerConflict = &simpleErr{"content layer conflict unresolved"}

type simpleErr struct{ msg string }

func (e *simpleErr) Error() string { return e.msg }

func (s *PgxStore) AttachContentChunks(ctx context.Context, contentId, documentId string) error {
	if err := s.queries.DeleteDocumentChunksByContentId(ctx, pgtype.Text{String: contentId, Valid: true}); err != nil {
		return err
	}
	return s.queries.TranscriptionCopyDocumentChunksToContent(ctx, db.TranscriptionCopyDocumentChunksToContentParams{
		ContentID:  contentId,
		DocumentID: documentId,
	})
}

func (s *PgxStore) DeleteLegacyChunks(ctx context.Context, documentId string) error {
	return s.queries.ClearDocumentChunks(ctx, pgtype.Text{String: documentId, Valid: true})
}

// CAS guard prevents late transcription from overwriting a concurrently swapped or promoted chapter.
func (s *PgxStore) StampProcessed(ctx context.Context, documentId, content string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error) {
	var gitShaStr string
	if gitSha != nil {
		gitShaStr = *gitSha
	}
	var contentIdStr string
	if contentId != nil {
		contentIdStr = *contentId
	}

	rows, err := s.queries.StampDocumentProcessed(ctx, db.StampDocumentProcessedParams{
		DualWrite:       dualWrite,
		Content:         content,
		GitSha:          gitShaStr,
		GenerationModel: model,
		GenerationLevel: generationLevel,
		ContentID:       contentIdStr,
		DocumentID:      documentId,
	})
	if err != nil {
		return false, err
	}
	if rows == 0 {
		metrics.Inc("transcription.stamp_cas_miss")
		log.Printf("[transcription] StampProcessed CAS miss for doc %s (content was swapped in or state drifted)", documentId)
		return false, nil
	}
	return true, nil
}

var knownTranscriptionModels sync.Map

func (s *PgxStore) RecordTranscriptionModel(ctx context.Context, repositoryId, model string) error {
	if repositoryId == "" || model == "" {
		return nil
	}
	if _, loaded := knownTranscriptionModels.LoadOrStore(repositoryId+"|"+model, struct{}{}); loaded {
		return nil
	}
	err := s.queries.RecordTranscriptionModel(ctx, db.RecordTranscriptionModelParams{
		Model:        model,
		RepositoryID: repositoryId,
	})
	if err != nil {
		knownTranscriptionModels.Delete(repositoryId + "|" + model)
	}
	return err
}

func (s *PgxStore) RecordTranscriptionTokens(ctx context.Context, repositoryId string, tokens int) error {
	if tokens <= 0 {
		return nil
	}
	return s.queries.RecordTranscriptionTokens(ctx, db.RecordTranscriptionTokensParams{
		Tokens:       int32(tokens),
		RepositoryID: repositoryId,
	})
}

func (s *PgxStore) SyncChapterTitleFromContent(ctx context.Context, documentId, title string) error {
	if documentId == "" || strings.TrimSpace(title) == "" {
		return nil
	}
	if err := s.queries.SyncDocumentTitleFromTranscription(ctx, db.SyncDocumentTitleFromTranscriptionParams{
		Title:      title,
		DocumentID: documentId,
	}); err != nil {
		return err
	}
	_, err := s.queries.SyncOutlineNodeTitleFromTranscription(ctx, db.SyncOutlineNodeTitleFromTranscriptionParams{
		Title:      title,
		DocumentID: documentId,
	})
	return err
}

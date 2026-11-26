package transcription

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// Nil OwnerUserID targets the shared repo edition; non-nil isolates a user's private copy without cross-blocking.
type BookAuditScope struct {
	RepositoryID string
	OwnerUserID  *string
}

func (s BookAuditScope) identity() string {
	if s.OwnerUserID == nil {
		return s.RepositoryID + "|shared"
	}
	return s.RepositoryID + "|user:" + *s.OwnerUserID
}

type BookAuditDoc struct {
	ID              string
	Path            string
	Title           string
	Content         string
	ContentID       *string
	UpdatedAt       time.Time
	GitSha          *string
	GenerationModel *string
	Lang            string
	OwnerUserID     *string
}

type ChapterScopeRow struct {
	Path      string
	ContentID *string
}

type BookAuditStore interface {
	CountUnsettledChapters(ctx context.Context, scope BookAuditScope) (int, error)
	ListChapterScope(ctx context.Context, scope BookAuditScope) ([]ChapterScopeRow, error)
	ListProcessedChapters(ctx context.Context, scope BookAuditScope) ([]BookAuditDoc, error)
	TryLockBookAudit(ctx context.Context, scope BookAuditScope) (unlock func(), ok bool, err error)
	TryClaimBookAudit(ctx context.Context, scope BookAuditScope, scopeHash string, staleBefore time.Time, maxAttempts int) (bool, error)
	MarkBookAuditStatus(ctx context.Context, scope BookAuditScope, status string) error
	RepositoryUnderReviewOrPublic(ctx context.Context, repositoryId string) (bool, error)
}

type BookAuditSwapInput struct {
	DocumentID        string
	RepositoryID      string
	NewContentID      string
	Content           string
	ExpectedContentID *string
	ExpectedUpdatedAt time.Time
	AuthorID          string
	DualWrite         bool
}

type BookAuditCommitStore interface {
	SwapAuditedChapterTx(ctx context.Context, in BookAuditSwapInput) (swapped bool, err error)
	UpsertContentLayer(ctx context.Context, contentHash, requestFingerprint, content, lang, model string) (string, error)
	AttachContentChunks(ctx context.Context, contentId, documentId string) error
	DeleteLegacyChunks(ctx context.Context, documentId string) error
	ReplaceDocumentChunks(ctx context.Context, documentId string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error)
}

func bookAuditPathPattern() string {
	return chapter.VirtualChapterPathPrefix + "%"
}

func nullableText(p *string) pgtype.Text {
	if p == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *p, Valid: true}
}

func textPtr(t pgtype.Text) *string {
	if !t.Valid || t.String == "" {
		return nil
	}
	s := t.String
	return &s
}

func countUnsettledParams(scope BookAuditScope) db.BookAuditCountUnsettledChaptersParams {
	return db.BookAuditCountUnsettledChaptersParams{
		RepositoryId: scope.RepositoryID,
		PathPrefix:   bookAuditPathPattern(),
		OwnerUserId:  nullableText(scope.OwnerUserID),
	}
}

func (s *PgxStore) CountUnsettledChapters(ctx context.Context, scope BookAuditScope) (int, error) {
	n, err := s.queries.BookAuditCountUnsettledChapters(ctx, countUnsettledParams(scope))
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

func (s *PgxStore) ListChapterScope(ctx context.Context, scope BookAuditScope) ([]ChapterScopeRow, error) {
	rows, err := s.queries.BookAuditListChapterScope(ctx, db.BookAuditListChapterScopeParams{
		RepositoryId: scope.RepositoryID,
		PathPrefix:   bookAuditPathPattern(),
		OwnerUserId:  nullableText(scope.OwnerUserID),
	})
	if err != nil {
		return nil, err
	}
	out := make([]ChapterScopeRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ChapterScopeRow{Path: r.Path, ContentID: textPtr(r.ContentId)})
	}
	return out, nil
}

func (s *PgxStore) ListProcessedChapters(ctx context.Context, scope BookAuditScope) ([]BookAuditDoc, error) {
	rows, err := s.queries.BookAuditListProcessedChapters(ctx, db.BookAuditListProcessedChaptersParams{
		RepositoryId: scope.RepositoryID,
		PathPrefix:   bookAuditPathPattern(),
		OwnerUserId:  nullableText(scope.OwnerUserID),
	})
	if err != nil {
		return nil, err
	}
	out := make([]BookAuditDoc, 0, len(rows))
	for _, r := range rows {
		out = append(out, BookAuditDoc{
			ID:              r.ID,
			Path:            r.Path,
			Title:           r.Title,
			Content:         r.Content,
			ContentID:       textPtr(r.ContentId),
			UpdatedAt:       r.UpdatedAt.Time,
			GitSha:          textPtr(r.GitSha),
			GenerationModel: textPtr(r.GenerationModel),
			Lang:            r.Lang,
			OwnerUserID:     textPtr(r.OwnerUserId),
		})
	}
	return out, nil
}

const bookAuditLockKeyPrefix = "book-audit:"

const bookAuditUnlockTimeout = 5 * time.Second

// Session-scoped pg_try_advisory_lock auto-releases on worker disconnect, needing no persisted lock cleanup.
func (s *PgxStore) TryLockBookAudit(ctx context.Context, scope BookAuditScope) (func(), bool, error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	key := bookAuditLockKeyPrefix + scope.identity()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1))`, key).Scan(&locked); err != nil {
		conn.Release()
		return nil, false, err
	}
	if !locked {
		conn.Release()
		return nil, false, nil
	}
	return func() {
		defer conn.Release()
		unlockCtx, cancel := context.WithTimeout(context.Background(), bookAuditUnlockTimeout)
		defer cancel()
		if _, err := conn.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtext($1))`, key); err != nil {
			log.Printf("[book-audit] advisory unlock degraded for %s: %v", key, err)
		}
	}, true, nil
}

func (s *PgxStore) TryClaimBookAudit(ctx context.Context, scope BookAuditScope, scopeHash string, staleBefore time.Time, maxAttempts int) (bool, error) {
	rows, err := s.queries.BookAuditTryClaim(ctx, db.BookAuditTryClaimParams{
		ScopeHash:         scopeHash,
		RepositoryId:      scope.RepositoryID,
		StaleBefore:       pgtype.Timestamptz{Time: staleBefore, Valid: true},
		RetryableStatuses: bookAuditRetryableStatuses,
		MaxAttempts:       int32(maxAttempts),
	})
	if err != nil {
		return false, err
	}
	return rows == 1, nil
}

func (s *PgxStore) MarkBookAuditStatus(ctx context.Context, scope BookAuditScope, status string) error {
	_, err := s.queries.BookAuditMarkStatus(ctx, db.BookAuditMarkStatusParams{
		Status:       status,
		RepositoryId: scope.RepositoryID,
	})
	return err
}

func (s *PgxStore) RepositoryUnderReviewOrPublic(ctx context.Context, repositoryId string) (bool, error) {
	under, err := s.queries.BookAuditRepoUnderReviewOrPublic(ctx, repositoryId)
	if err != nil {
		return false, err
	}
	return under.Valid && under.Bool, nil
}

const canonicalDocLockPrefix = "canonical-doc:"

var (
	errBookAuditSwapCasMiss        = errors.New("book-audit swap: cas miss")
	errBookAuditStagedContentEmpty = errors.New("book-audit swap: staged content empty")
)

// Serializes on canonicalDocLockPrefix, rejects empty content, and CAS-swaps only if pointer and review state match.
func (s *PgxStore) SwapAuditedChapterTx(ctx context.Context, in BookAuditSwapInput) (bool, error) {
	swapped := false
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		qtx := s.queries.WithTx(tx)
		if err := qtx.MarketAdvisoryLock(ctx, canonicalDocLockPrefix+in.DocumentID); err != nil {
			return err
		}
		staged, err := qtx.MarketLoadStagedContent(ctx, in.NewContentID)
		if err != nil {
			return err
		}
		if !staged.Valid || strings.TrimSpace(staged.String) == "" {
			return errBookAuditStagedContentEmpty
		}
		rows, err := qtx.BookAuditSwapChapter(ctx, db.BookAuditSwapChapterParams{
			ContentId:         pgtype.Text{String: in.NewContentID, Valid: true},
			DualWrite:         in.DualWrite,
			Content:           in.Content,
			DocumentId:        in.DocumentID,
			ExpectedContentId: nullableText(in.ExpectedContentID),
			ExpectedUpdatedAt: pgtype.Timestamp{Time: in.ExpectedUpdatedAt, Valid: true},
		})
		if err != nil {
			return err
		}
		if rows == 0 {
			return errBookAuditSwapCasMiss
		}
		if err := qtx.MarketSettleRelayTxUpdateVersion(ctx, in.DocumentID); err != nil {
			return err
		}
		if err := qtx.BookAuditInsertCanonicalVersion(ctx, db.BookAuditInsertCanonicalVersionParams{
			DocumentId:   in.DocumentID,
			RepositoryId: in.RepositoryID,
			AuthorId:     in.AuthorID,
			ContentId:    in.NewContentID,
		}); err != nil {
			return err
		}
		swapped = true
		return nil
	})
	if errors.Is(err, errBookAuditSwapCasMiss) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return swapped, nil
}

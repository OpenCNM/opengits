package doc

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/opengits/worker-sidecar/internal/platform/db"
)

// ResetDocInput holds input for ResetDocument.
type ResetDocInput struct {
	DocumentID string `json:"documentId"`
	Force      bool   `json:"force"`
}

type ResetDocResult struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Status string `json:"status"`
}

// BatchDeleteDocsInput holds input for BatchDeleteDocuments.
type BatchDeleteDocsInput struct {
	RepositoryID string   `json:"repositoryId"`
	OwnerUserID  *string  `json:"ownerUserId,omitempty"`
	Paths        []string `json:"paths,omitempty"`
	IDs          []string `json:"ids,omitempty"`
}

// DocRenameItem holds a rename pair.
type DocRenameItem struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// DocCreateItem holds item to create in mutation.
type DocCreateItem struct {
	Path    string  `json:"path"`
	Title   *string `json:"title,omitempty"`
	Content *string `json:"content,omitempty"`
	Status  string  `json:"status"`
}

// ApplyDocMutationsInput holds atomic mutation batch for update-applier.
type ApplyDocMutationsInput struct {
	RepositoryID string          `json:"repositoryId"`
	OwnerUserID  *string         `json:"ownerUserId,omitempty"`
	Renames      []DocRenameItem `json:"renames,omitempty"`
	Updates      []string        `json:"updates,omitempty"`
	Removes      []string        `json:"removes,omitempty"`
	Creates      []DocCreateItem `json:"creates,omitempty"`
}

type ApplyDocMutationsResult struct {
	Renamed        int             `json:"renamed"`
	Updated        int             `json:"updated"`
	Removed        int             `json:"removed"`
	Created        int             `json:"created"`
	AppliedRenames []DocRenameItem `json:"appliedRenames"`
}

// TransferOwnershipInput holds input for TransferOwnership.
type TransferOwnershipInput struct {
	RepositoryID string `json:"repositoryId"`
	UserID       string `json:"userId"`
}

type TransferOwnershipResult struct {
	Deleted     int `json:"deleted"`
	Transferred int `json:"transferred"`
}

// ResetDocument resets a document to UNPROCESSED with CAS guard.
func (s *PgxStore) ResetDocument(ctx context.Context, input ResetDocInput) (*ResetDocResult, int, error) {
	if s == nil || s.pool == nil {
		return nil, 500, errors.New("db pool not configured")
	}
	if strings.TrimSpace(input.DocumentID) == "" {
		return nil, 400, errors.New("documentId is required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, 500, err
	}
	defer tx.Rollback(ctx)

	querier := db.New(tx)
	currentStatus, err := querier.GetDocumentStatus(ctx, input.DocumentID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 404, errors.New("document not found")
		}
		return nil, 500, err
	}

	if !input.Force && currentStatus == "PROCESSING" {
		return nil, 409, errors.New("document is currently processing")
	}

	row, err := db.New(tx).ResetDocumentStatus(ctx, input.DocumentID)
	if err != nil {
		return nil, 500, err
	}
	_ = db.New(tx).ResetDocumentTranscriptionJob(ctx, input.DocumentID)

	res := ResetDocResult{
		ID:     row.ID,
		Path:   row.Path,
		Status: string(row.Status),
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, 500, err
	}

	return &res, 200, nil
}

// BatchDeleteDocuments removes documents matching criteria.
func (s *PgxStore) BatchDeleteDocuments(ctx context.Context, input BatchDeleteDocsInput) (int, error) {
	if s == nil || s.pool == nil {
		return 0, errors.New("db pool not configured")
	}
	if strings.TrimSpace(input.RepositoryID) == "" {
		return 0, errors.New("repositoryId is required")
	}

	querier := db.New(s.pool)
	argOwner := pgtype.Text{}
	if input.OwnerUserID != nil { argOwner = pgtype.Text{String: *input.OwnerUserID, Valid: true} }
	var affected int64
	var err error

	if len(input.IDs) > 0 {
		affected, err = querier.BatchDeleteDocsByIds(ctx, db.BatchDeleteDocsByIdsParams{
			RepositoryId: input.RepositoryID,
			Ids: input.IDs,
			OwnerUserId: argOwner,
		})
	} else if len(input.Paths) > 0 {
		affected, err = querier.BatchDeleteDocsByPathRows(ctx, db.BatchDeleteDocsByPathRowsParams{
			RepositoryId: input.RepositoryID,
			Paths: input.Paths,
			OwnerUserId: argOwner,
		})
	} else {
		return 0, errors.New("either ids or paths must be provided")
	}

	if err != nil {
		return 0, err
	}
	return int(affected), nil
}

// ApplyDocumentMutations executes renames, updates, removes and creates in a single transaction.
func (s *PgxStore) ApplyDocumentMutations(ctx context.Context, input ApplyDocMutationsInput) (ApplyDocMutationsResult, error) {
	result := ApplyDocMutationsResult{}
	if s == nil || s.pool == nil {
		return result, errors.New("db pool not configured")
	}
	if strings.TrimSpace(input.RepositoryID) == "" {
		return result, errors.New("repositoryId is required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)

	querier := db.New(tx)
	argOwner := pgtype.Text{}
	if input.OwnerUserID != nil { argOwner = pgtype.Text{String: *input.OwnerUserID, Valid: true} }
	
	// 1. Renames
	for _, r := range input.Renames {
		occupied, err := querier.CheckDocumentExistsByPath(ctx, db.CheckDocumentExistsByPathParams{
			RepositoryId: input.RepositoryID,
			Path: r.To,
			OwnerUserId: argOwner,
		})
		if err != nil {
			return result, err
		}
		if occupied {
			continue
		}

		affected, err := querier.RenameDocument(ctx, db.RenameDocumentParams{
			Path: r.To,
			RepositoryId: input.RepositoryID,
			Path_2: r.From,
			OwnerUserId: argOwner,
		})
		if err != nil {
			return result, err
		}
		if affected > 0 {
			result.Renamed += int(affected)
			result.AppliedRenames = append(result.AppliedRenames, r)
		}
	}

	// 2. Updates (mark UNPROCESSED)
	if len(input.Updates) > 0 {
		affected, err := querier.MarkDocumentsUnprocessed(ctx, db.MarkDocumentsUnprocessedParams{
			RepositoryId: input.RepositoryID,
			Paths: input.Updates,
			OwnerUserId: argOwner,
		})
		if err != nil {
			return result, err
		}
		result.Updated += int(affected)
	}

	// 3. Removes
	if len(input.Removes) > 0 {
		affected, err := querier.BatchDeleteDocsByPathRows(ctx, db.BatchDeleteDocsByPathRowsParams{
			RepositoryId: input.RepositoryID,
			Paths: input.Removes,
			OwnerUserId: argOwner,
		})
		if err != nil {
			return result, err
		}
		result.Removed += int(affected)
	}

	// 4. Creates
	for _, ch := range input.Creates {
		id := uuid.New().String()
		status := ch.Status
		if status == "" {
			status = "UNPROCESSED"
		}
		argTitle := pgtype.Text{}
		if ch.Title != nil { argTitle = pgtype.Text{String: *ch.Title, Valid: true} }
		argContent := pgtype.Text{}
		if ch.Content != nil { argContent = pgtype.Text{String: *ch.Content, Valid: true} }
		err := querier.InsertDocument(ctx, db.InsertDocumentParams{
			ID: id,
			RepositoryId: input.RepositoryID,
			Path: ch.Path,
			OwnerUserId: argOwner,
			Title: argTitle,
			Content: argContent,
			Status: status,
		})
		if err != nil {
			return result, err
		}
		result.Created++
	}

	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

// TransferOwnership moves user's private documents to shared repository level, deleting duplicates.
func (s *PgxStore) TransferOwnership(ctx context.Context, input TransferOwnershipInput) (TransferOwnershipResult, error) {
	result := TransferOwnershipResult{}
	if s == nil || s.pool == nil {
		return result, errors.New("db pool not configured")
	}
	if strings.TrimSpace(input.RepositoryID) == "" || strings.TrimSpace(input.UserID) == "" {
		return result, errors.New("repositoryId and userId are required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)

	// Find shared documents (ownerUserId is null)
	querier := db.New(tx)
	sharedPaths, err := querier.GetSharedDocumentPaths(ctx, input.RepositoryID)
	if err != nil {
		return result, err
	}

	if len(sharedPaths) > 0 {
		affected, err := querier.DeleteUserDocumentsByPaths(ctx, db.DeleteUserDocumentsByPathsParams{
			RepositoryId: input.RepositoryID,
			OwnerUserId: pgtype.Text{String: input.UserID, Valid: true},
			Paths: sharedPaths,
		})
		if err != nil {
			return result, err
		}
		result.Deleted = int(affected)
	}

	affected, err := querier.TransferUserDocumentsToShared(ctx, db.TransferUserDocumentsToSharedParams{
		RepositoryId: input.RepositoryID,
		OwnerUserId: pgtype.Text{String: input.UserID, Valid: true},
	})
	if err != nil {
		return result, err
	}
	result.Transferred = int(affected)

	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

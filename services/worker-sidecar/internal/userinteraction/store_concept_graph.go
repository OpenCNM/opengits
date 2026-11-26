package userinteraction

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type CanonicalConceptUpdate struct {
	IDs           []string `json:"ids"`
	CanonicalKey  *string  `json:"canonicalKey,omitempty"`
	CanonicalName string   `json:"canonicalName"`
}

type ConceptEdgeItem struct {
	SourceID string         `json:"sourceId"`
	TargetID string         `json:"targetId"`
	Type     string         `json:"type"`
	Weight   float64        `json:"weight"`
	Source   string         `json:"source,omitempty"`
	Meta     map[string]any `json:"meta,omitempty"`
}

type ReplaceConceptEdgesInput struct {
	RepositoryID string            `json:"repositoryId"`
	Source       string            `json:"source,omitempty"`
	Sources      []string          `json:"sources,omitempty"`
	Scope        string            `json:"scope,omitempty"`
	ConceptIDs   []string          `json:"conceptIds,omitempty"`
	Edges        []ConceptEdgeItem `json:"edges"`
}

func (s *PgxStore) ClearDocumentConceptChunks(ctx context.Context, documentId string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool is not initialized")
	}
	if documentId == "" {
		return errors.New("documentId cannot be empty")
	}

	return s.getQueries().ClearDocumentConceptChunks(ctx, pgtype.Text{String: documentId, Valid: true})
}

func (s *PgxStore) UpdateCanonicalConcepts(ctx context.Context, updates []CanonicalConceptUpdate) (int64, error) {
	if s.pool == nil {
		return 0, fmt.Errorf("database pool is not initialized")
	}
	if len(updates) == 0 {
		return 0, nil
	}

	var totalUpdated int64
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.getQueries().WithTx(tx)
		for _, u := range updates {
			if len(u.IDs) == 0 || u.CanonicalName == "" {
				continue
			}
			var canonicalKey pgtype.Text
			if u.CanonicalKey != nil {
				canonicalKey = pgtype.Text{String: *u.CanonicalKey, Valid: true}
			}
			rowsAffected, err := q.UpdateCanonicalConceptNamesAndKeys(ctx, db.UpdateCanonicalConceptNamesAndKeysParams{
				CanonicalName: pgtype.Text{String: u.CanonicalName, Valid: true},
				CanonicalKey:  canonicalKey,
				Column3:       u.IDs,
			})
			if err != nil {
				return fmt.Errorf("failed to update canonical concept: %w", err)
			}
			totalUpdated += rowsAffected
		}
		return nil
	})

	return totalUpdated, err
}

func (s *PgxStore) ReplaceConceptEdges(ctx context.Context, input ReplaceConceptEdgesInput) (int, error) {
	if s.pool == nil {
		return 0, fmt.Errorf("database pool is not initialized")
	}
	if input.RepositoryID == "" {
		return 0, errors.New("repositoryId cannot be empty")
	}

	sources := input.Sources
	if len(sources) == 0 && input.Source != "" {
		sources = []string{input.Source}
	}
	if len(sources) == 0 {
		return 0, errors.New("source or sources cannot be empty")
	}

	scope := input.Scope
	if scope == "" {
		scope = "both"
	}

	if scope != "repository" && len(input.ConceptIDs) == 0 {
		return 0, nil
	}

	inserted := 0
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.getQueries().WithTx(tx)
		if scope == "repository" {
			if err := q.AcquireAdvisoryLockHashtext(ctx, input.RepositoryID); err != nil {
				return fmt.Errorf("failed to acquire advisory lock: %w", err)
			}
			if err := q.DeleteConceptEdgesByRepository(ctx, db.DeleteConceptEdgesByRepositoryParams{
				RepositoryId: input.RepositoryID,
				Column2:      sources,
			}); err != nil {
				return fmt.Errorf("failed to delete old concept edges by repository: %w", err)
			}
		} else if scope == "target" || scope == "target_only" {
			if err := q.DeleteConceptEdgesByTarget(ctx, db.DeleteConceptEdgesByTargetParams{
				Column1: sources,
				Column2: input.ConceptIDs,
			}); err != nil {
				return fmt.Errorf("failed to delete old concept edges by target: %w", err)
			}
		} else {
			if err := q.DeleteConceptEdgesByBoth(ctx, db.DeleteConceptEdgesByBothParams{
				Column1: sources,
				Column2: input.ConceptIDs,
			}); err != nil {
				return fmt.Errorf("failed to delete old concept edges: %w", err)
			}
		}

		for _, e := range input.Edges {
			if e.SourceID == "" || e.TargetID == "" {
				continue
			}
			weight := e.Weight
			if weight <= 0 {
				weight = 1.0
			}
			edgeType := e.Type
			if edgeType == "" {
				edgeType = "related"
			}
			edgeSource := e.Source
			if edgeSource == "" {
				edgeSource = input.Source
				if edgeSource == "" && len(sources) > 0 {
					edgeSource = sources[0]
				}
			}

			metaJSON := []byte("{}")
			if e.Meta != nil {
				if b, err := json.Marshal(e.Meta); err == nil {
					metaJSON = b
				}
			}

			// InsertConceptEdge relies on ON CONFLICT ("sourceId", "targetId", "type") DO NOTHING (queries/concept_graph.sql) so duplicate edges skip idempotently.
			rowsAffected, err := q.InsertConceptEdge(ctx, db.InsertConceptEdgeParams{
				RepositoryId: input.RepositoryID,
				SourceId:     e.SourceID,
				TargetId:     e.TargetID,
				Type:         edgeType,
				Weight:       weight,
				Source:       edgeSource,
				Column7:      metaJSON,
			})
			if err != nil {
				return fmt.Errorf("failed to insert concept edge: %w", err)
			}
			inserted += int(rowsAffected)
		}
		return nil
	})

	return inserted, err
}

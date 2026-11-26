package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

func (s *PgxStore) SyncDocumentCooccurrenceEdges(ctx context.Context, repositoryId, docId string) error {
	queries := db.New(s.pool)

	nodes, err := queries.GetConceptNodesForCooccurrence(ctx, pgtype.Text{String: docId, Valid: docId != ""})
	if err != nil {
		return fmt.Errorf("query concepts for cooccurrence: %w", err)
	}

	var seeds []ConceptSeed
	var conceptIDs []string
	for _, n := range nodes {
		conceptIDs = append(conceptIDs, n.ID)
		var chunkID *string
		if n.ChunkId.Valid {
			chunkID = &n.ChunkId.String
		}
		seeds = append(seeds, ConceptSeed{
			ID:         n.ID,
			DocumentID: &docId,
			ChunkID:    chunkID,
		})
	}

	if len(seeds) == 0 {
		return nil
	}

	derived := DeriveCooccurrenceEdges(seeds)

	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		txQueries := db.New(tx)
		if err := txQueries.DeleteCooccurrenceEdges(ctx, conceptIDs); err != nil {
			return fmt.Errorf("delete old cooccurrence edges: %w", err)
		}

		if len(derived) == 0 {
			return nil
		}

		var sourceIDs, targetIDs, types, sources []string
		var weights []float64
		var metas [][]byte
		for _, e := range derived {
			sourceIDs = append(sourceIDs, e.SourceID)
			targetIDs = append(targetIDs, e.TargetID)
			types = append(types, e.Type)
			weights = append(weights, e.Weight)
			sources = append(sources, e.Source)
			metaBytes, err := json.Marshal(e.Meta)
			if err != nil || len(metaBytes) == 0 {
				metaBytes = []byte("{}")
			}
			metas = append(metas, metaBytes)
		}

		if err := txQueries.BatchInsertConceptEdges(ctx, db.BatchInsertConceptEdgesParams{
			RepositoryID: repositoryId,
			SourceIds:    sourceIDs,
			TargetIds:    targetIDs,
			Types:        types,
			Weights:      weights,
			Sources:      sources,
			Metas:        metas,
		}); err != nil {
			return fmt.Errorf("insert cooccurrence edge: %w", err)
		}
		return nil
	})
}

type navNodeJSON struct {
	Type     string        `json:"type"`
	Path     string        `json:"path"`
	Children []navNodeJSON `json:"children,omitempty"`
}

func flattenNavNodePaths(nodes []navNodeJSON, out *[]string, seen map[string]struct{}) {
	for _, n := range nodes {
		if n.Type == "file" && n.Path != "" {
			if _, exists := seen[n.Path]; !exists {
				seen[n.Path] = struct{}{}
				*out = append(*out, n.Path)
			}
		} else if len(n.Children) > 0 {
			flattenNavNodePaths(n.Children, out, seen)
		}
	}
}

func (s *PgxStore) resolveTeachingOrderPaths(ctx context.Context, repositoryId string) ([]string, error) {
	s.teachingOrderMu.Lock()
	if e, ok := s.teachingOrderCache[repositoryId]; ok && time.Since(e.loadedAt) < teachingOrderCacheTTL {
		paths := e.paths
		s.teachingOrderMu.Unlock()
		return paths, nil
	}
	s.teachingOrderMu.Unlock()

	paths, err := s.resolveTeachingOrderPathsUncached(ctx, repositoryId)
	if err != nil {
		return nil, err
	}
	s.teachingOrderMu.Lock()
	s.teachingOrderCache[repositoryId] = teachingOrderEntry{paths: paths, loadedAt: time.Now()}
	s.teachingOrderMu.Unlock()
	return paths, nil
}

func (s *PgxStore) resolveTeachingOrderPathsUncached(ctx context.Context, repositoryId string) ([]string, error) {
	queries := db.New(s.pool)
	paths, err := queries.GetActiveTutorialOutlinePaths(ctx, repositoryId)
	if err == nil && len(paths) > 0 {
		var uniquePaths []string
		seen := make(map[string]struct{})
		for _, p := range paths {
			if p != "" {
				if _, ok := seen[p]; !ok {
					seen[p] = struct{}{}
					uniquePaths = append(uniquePaths, p)
				}
			}
		}
		if len(uniquePaths) > 0 {
			return uniquePaths, nil
		}
	}

	rawNavTree, err := queries.GetRepositoryNavTree(ctx, repositoryId)
	if err != nil || len(rawNavTree) == 0 {
		return nil, nil
	}

	var nodes []navNodeJSON
	if jsonErr := json.Unmarshal(rawNavTree, &nodes); jsonErr != nil {
		return nil, nil
	}

	var parsedPaths []string
	seen := make(map[string]struct{})
	flattenNavNodePaths(nodes, &parsedPaths, seen)
	return parsedPaths, nil
}

func (s *PgxStore) SyncDocumentCurriculumEdge(ctx context.Context, repositoryId, docId string) error {
	queries := db.New(s.pool)
	navOrder, err := s.resolveTeachingOrderPaths(ctx, repositoryId)
	if err != nil || len(navOrder) == 0 {
		return nil
	}

	docPath, err := queries.GetDocumentPathById(ctx, docId)
	if err != nil || docPath == "" {
		return nil
	}

	docIdx := -1
	for i, p := range navOrder {
		if p == docPath {
			docIdx = i
			break
		}
	}
	if docIdx <= 0 {
		return nil
	}

	thisIds, err := queries.GetConceptIdsByDocId(ctx, pgtype.Text{String: docId, Valid: docId != ""})
	if err != nil || len(thisIds) == 0 {
		return nil
	}

	prevPaths := navOrder[:docIdx]
	docRows, err := queries.GetProcessedDocsByPaths(ctx, db.GetProcessedDocsByPathsParams{
		RepositoryId: repositoryId,
		Paths:        prevPaths,
	})
	if err != nil || len(docRows) == 0 {
		return nil
	}

	prevDocIdByPath := make(map[string]string)
	var prevDocIds []string
	for _, r := range docRows {
		prevDocIdByPath[r.Path] = r.ID
		prevDocIds = append(prevDocIds, r.ID)
	}

	docsHavingConceptsRows, err := queries.GetDocsHavingConcepts(ctx, db.GetDocsHavingConceptsParams{
		RepositoryId: repositoryId,
		DocumentIds:  prevDocIds,
	})
	if err != nil {
		return nil
	}

	docsHavingConcepts := make(map[string]struct{})
	for _, did := range docsHavingConceptsRows {
		if did.Valid {
			docsHavingConcepts[did.String] = struct{}{}
		}
	}

	var prevDocId string
	for i := docIdx - 1; i >= 0; i-- {
		p := navOrder[i]
		if id, ok := prevDocIdByPath[p]; ok {
			if _, has := docsHavingConcepts[id]; has {
				prevDocId = id
				break
			}
		}
	}
	if prevDocId == "" {
		return nil
	}

	prevConceptIds, err := queries.GetConceptIdsByDocId(ctx, pgtype.Text{String: prevDocId, Valid: prevDocId != ""})
	if err != nil || len(prevConceptIds) == 0 {
		return nil
	}

	derived := DeriveCurriculumOrderEdges([][]string{prevConceptIds, thisIds})

	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		txQueries := db.New(tx)
		if err := txQueries.DeleteCurriculumOrderEdges(ctx, thisIds); err != nil {
			return err
		}

		if len(derived) == 0 {
			return nil
		}

		var sourceIDs, targetIDs, types, sources []string
		var weights []float64
		var metas [][]byte
		for _, e := range derived {
			sourceIDs = append(sourceIDs, e.SourceID)
			targetIDs = append(targetIDs, e.TargetID)
			types = append(types, e.Type)
			weights = append(weights, e.Weight)
			sources = append(sources, e.Source)
			metaBytes, err := json.Marshal(e.Meta)
			if err != nil || len(metaBytes) == 0 {
				metaBytes = []byte("{}")
			}
			metas = append(metas, metaBytes)
		}

		if err := txQueries.BatchInsertConceptEdges(ctx, db.BatchInsertConceptEdgesParams{
			RepositoryID: repositoryId,
			SourceIds:    sourceIDs,
			TargetIds:    targetIDs,
			Types:        types,
			Weights:      weights,
			Sources:      sources,
			Metas:        metas,
		}); err != nil {
			return err
		}
		return nil
	})
}

func (s *PgxStore) ReplaceLlmConceptEdges(ctx context.Context, repositoryId, docId string, edges []LlmConceptEdgeInput) (int, error) {
	if len(edges) == 0 {
		return 0, nil
	}
	queries := db.New(s.pool)

	establishedRows, err := queries.GetEstablishedConceptEdges(ctx, repositoryId)
	if err != nil {
		return 0, err
	}
	var established []concept.EdgeRef
	for _, e := range establishedRows {
		established = append(established, concept.EdgeRef{
			SourceID: e.SourceId,
			TargetID: e.TargetId,
			Type:     e.Type,
		})
	}

	var candidates []concept.DerivedEdge
	for _, e := range edges {
		candidates = append(candidates, concept.DerivedEdge{
			SourceID: e.FromID, TargetID: e.ToID, Type: e.Type,
		})
	}
	filtered := concept.FilterPrerequisiteCandidates(candidates, established)
	allowed := make(map[string]bool, len(filtered.Kept))
	for _, k := range filtered.Kept {
		allowed[k.SourceID+"|"+k.TargetID] = true
	}

	kept := make([]LlmConceptEdgeInput, 0, len(edges))
	for _, e := range edges {
		if !allowed[e.FromID+"|"+e.ToID] {
			continue
		}
		kept = append(kept, e)
	}
	if len(kept) == 0 {
		return 0, nil
	}

	inserted := 0
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		txQueries := db.New(tx)
		if err := txQueries.DeleteLlmExtractedEdges(ctx, db.DeleteLlmExtractedEdgesParams{
			RepositoryId: repositoryId,
			ConceptIds:   conceptIDsOf(kept),
		}); err != nil {
			return err
		}

		var sourceIDs, targetIDs, types, sources []string
		var weights []float64
		var metas [][]byte
		for _, e := range kept {
			sourceIDs = append(sourceIDs, e.FromID)
			targetIDs = append(targetIDs, e.ToID)
			types = append(types, e.Type)
			weights = append(weights, e.Weight)
			sources = append(sources, "llm_extracted")
			metaBytes, _ := json.Marshal(map[string]any{"documentId": docId, "evidence": e.Evidence})
			metas = append(metas, metaBytes)
			inserted++
		}

		if len(sourceIDs) > 0 {
			if err := txQueries.BatchInsertLlmConceptEdges(ctx, db.BatchInsertLlmConceptEdgesParams{
				RepositoryID: repositoryId,
				SourceIds:    sourceIDs,
				TargetIds:    targetIDs,
				Types:        types,
				Weights:      weights,
				Sources:      sources,
				Metas:        metas,
			}); err != nil {
				return err
			}
		}

		return nil
	})
	if err != nil {
		return 0, err
	}
	return inserted, nil
}

func conceptIDsOf(edges []LlmConceptEdgeInput) []string {
	seen := map[string]bool{}
	var out []string
	for _, e := range edges {
		for _, id := range []string{e.FromID, e.ToID} {
			if !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	return out
}

func appendAuthorReflections(existing, addition string) string {
	if existing != "" {
		return existing + "\n\n" + addition
	}
	return addition
}

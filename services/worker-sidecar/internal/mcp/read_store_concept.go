package mcp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

func itoa(n int) string {
	return strconv.Itoa(n)
}

type ConceptRichNode struct {
	ID                string   `db:"id"`
	ConceptName       string   `db:"conceptName"`
	Category          string   `db:"category"`
	Slug              string   `db:"slug"`
	HeadingPath       *string  `db:"headingPath"`
	PrinciplesText    *string  `db:"principlesText"`
	AuthorReflections *string  `db:"authorReflections"`
	Summary           *string  `db:"summary"`
	SopSteps          []string `db:"sopSteps"`
	SubTopics         []string `db:"subTopics"`
	Tags              []string `db:"tags"`
	CanonicalKey      *string  `db:"canonicalKey"`
	DocumentPath      *string  `db:"path"`
	CanonicalName     *string  `db:"canonicalName"`
}

func textToPtr(t pgtype.Text) *string {
	if t.Valid {
		return &t.String
	}
	return nil
}

func toConceptRichNode(id, conceptName, category, slug string, hp, pt, ar, sum pgtype.Text, sop, sub, tags []string, ck, path, cn pgtype.Text) *ConceptRichNode {
	return &ConceptRichNode{
		ID:                id,
		ConceptName:       conceptName,
		Category:          category,
		Slug:              slug,
		HeadingPath:       textToPtr(hp),
		PrinciplesText:    textToPtr(pt),
		AuthorReflections: textToPtr(ar),
		Summary:           textToPtr(sum),
		SopSteps:          sop,
		SubTopics:         sub,
		Tags:              tags,
		CanonicalKey:      textToPtr(ck),
		DocumentPath:      textToPtr(path),
		CanonicalName:     textToPtr(cn),
	}
}

func (s *pgxStore) FindConceptForDoc(ctx context.Context, repositoryID, documentID string, headingPath *string) (*ConceptNodeLite, error) {
	q := db.New(s.pool)
	if headingPath != nil && *headingPath != "" {
		r, err := q.MCPFindConceptForDocWithHeading(ctx, db.MCPFindConceptForDocWithHeadingParams{
			RepositoryId: repositoryID,
			DocumentId:   pgtype.Text{String: documentID, Valid: true},
			HeadingPath:  pgtype.Text{String: *headingPath, Valid: true},
		})
		if errors.Is(err, pgx.ErrNoRows) || err != nil {
			return nil, nil
		}
		return &ConceptNodeLite{
			ID:           r.ID,
			ConceptName:  r.ConceptName,
			CanonicalKey: textToPtr(r.CanonicalKey),
			Category:     r.Category,
			DocumentPath: textToPtr(r.Path),
			DocumentID:   textToPtr(r.DocumentId),
		}, nil
	}

	r, err := q.MCPFindConceptForDocNoHeading(ctx, db.MCPFindConceptForDocNoHeadingParams{
		RepositoryId: repositoryID,
		DocumentId:   pgtype.Text{String: documentID, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) || err != nil {
		return nil, nil
	}
	return &ConceptNodeLite{
		ID:           r.ID,
		ConceptName:  r.ConceptName,
		CanonicalKey: textToPtr(r.CanonicalKey),
		Category:     r.Category,
		DocumentPath: textToPtr(r.Path),
		DocumentID:   textToPtr(r.DocumentId),
	}, nil
}

func (s *pgxStore) CanonicalMemberIDs(ctx context.Context, repositoryID, nodeID string) ([]string, error) {
	q := db.New(s.pool)
	ck, err := q.MCPCanonicalMemberIDsKey(ctx, db.MCPCanonicalMemberIDsKeyParams{
		ID:           nodeID,
		RepositoryId: repositoryID,
	})
	if errors.Is(err, pgx.ErrNoRows) || !ck.Valid || ck.String == "" || err != nil {
		return []string{nodeID}, nil
	}
	ids, err := q.MCPGetCanonicalMembers(ctx, db.MCPGetCanonicalMembersParams{
		RepositoryId: repositoryID,
		CanonicalKey: ck,
	})
	if err != nil || len(ids) == 0 {
		return []string{nodeID}, nil
	}
	return ids, nil
}

func (s *pgxStore) EdgesTouching(ctx context.Context, repositoryID string, memberIDs []string) ([]EdgeRef, error) {
	rows, err := db.New(s.pool).MCPEdgesTouching(ctx, db.MCPEdgesTouchingParams{
		RepositoryId: repositoryID,
		Column2:      memberIDs,
	})
	if err != nil {
		return nil, err
	}
	edges := make([]EdgeRef, 0, len(rows))
	for _, r := range rows {
		edges = append(edges, EdgeRef{
			SourceID: r.SourceId,
			TargetID: r.TargetId,
			Type:     r.Type,
			Weight:   r.Weight,
			Source:   r.Source,
		})
	}
	return edges, nil
}

func (s *pgxStore) NodesByIDs(ctx context.Context, repositoryID string, ids []string) ([]ConceptNodeLite, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := db.New(s.pool).MCPNodesByIDs(ctx, db.MCPNodesByIDsParams{
		RepositoryId: repositoryID,
		Column2:      ids,
	})
	if err != nil {
		return nil, err
	}
	nodes := make([]ConceptNodeLite, 0, len(rows))
	for _, r := range rows {
		nodes = append(nodes, ConceptNodeLite{
			ID:            r.ID,
			ConceptName:   r.ConceptName,
			CanonicalKey:  textToPtr(r.CanonicalKey),
			CanonicalName: textToPtr(r.CanonicalName),
			Category:      r.Category,
			DocumentPath:  textToPtr(r.Path),
		})
	}
	return nodes, nil
}

func (s *pgxStore) CoLocatedNodes(ctx context.Context, repositoryID, documentID string, excludeIDs []string, take int) ([]ConceptNodeLite, error) {
	rows, err := db.New(s.pool).MCPCoLocatedNodes(ctx, db.MCPCoLocatedNodesParams{
		RepositoryId: repositoryID,
		DocumentId:   pgtype.Text{String: documentID, Valid: true},
		Column3:      excludeIDs,
		Limit:        int32(take),
	})
	if err != nil {
		return nil, nil
	}
	nodes := make([]ConceptNodeLite, 0, len(rows))
	for _, r := range rows {
		nodes = append(nodes, ConceptNodeLite{
			ID:            r.ID,
			ConceptName:   r.ConceptName,
			CanonicalKey:  textToPtr(r.CanonicalKey),
			CanonicalName: textToPtr(r.CanonicalName),
			Category:      r.Category,
			DocumentPath:  textToPtr(r.Path),
		})
	}
	return nodes, nil
}

func (s *pgxStore) GetConceptDocumentID(ctx context.Context, repositoryID, nodeID string) (*string, error) {
	docID, err := db.New(s.pool).MCPGetConceptDocumentID(ctx, db.MCPGetConceptDocumentIDParams{
		ID:           nodeID,
		RepositoryId: repositoryID,
	})
	if errors.Is(err, pgx.ErrNoRows) || err != nil || !docID.Valid {
		return nil, nil
	}
	return &docID.String, nil
}

func (s *pgxStore) ListDocConcepts(ctx context.Context, repositoryID, documentID string, take int) ([]ConceptNodeLite, error) {
	rows, err := db.New(s.pool).MCPListDocConcepts(ctx, db.MCPListDocConceptsParams{
		RepositoryId: repositoryID,
		DocumentId:   pgtype.Text{String: documentID, Valid: true},
		Limit:        int32(take),
	})
	if err != nil {
		return nil, nil
	}
	out := make([]ConceptNodeLite, 0, len(rows))
	for _, r := range rows {
		out = append(out, ConceptNodeLite{
			ID:           r.ID,
			ConceptName:  r.ConceptName,
			CanonicalKey: textToPtr(r.CanonicalKey),
			Category:     r.Category,
			DocumentPath: textToPtr(r.Path),
			HeadingPath:  textToPtr(r.HeadingPath),
		})
	}
	return out, nil
}

func (s *pgxStore) TaxonomyNodes(ctx context.Context, repositoryID string, take int) ([]TaxonomyNode, error) {
	rows, err := db.New(s.pool).MCPTaxonomyNodes(ctx, db.MCPTaxonomyNodesParams{
		RepositoryId: repositoryID,
		Limit:        int32(take),
	})
	if err != nil {
		return nil, nil
	}
	out := make([]TaxonomyNode, 0, len(rows))
	for _, r := range rows {
		out = append(out, TaxonomyNode{
			ID:            r.ID,
			ConceptName:   r.ConceptName,
			CanonicalKey:  textToPtr(r.CanonicalKey),
			CanonicalName: textToPtr(r.CanonicalName),
			Category:      r.Category,
			HeadingPath:   textToPtr(r.HeadingPath),
			DocumentPath:  textToPtr(r.Path),
		})
	}
	return out, nil
}

func (s *pgxStore) PrereqEdges(ctx context.Context, repositoryID string) ([]EdgeRef, error) {
	rows, err := db.New(s.pool).MCPPrereqEdges(ctx, repositoryID)
	if err != nil {
		return nil, nil
	}
	out := make([]EdgeRef, 0, len(rows))
	for _, r := range rows {
		out = append(out, EdgeRef{
			SourceID: r.SourceId,
			TargetID: r.TargetId,
			Type:     r.Type,
			Weight:   r.Weight,
			Source:   r.Source,
		})
	}
	return out, nil
}

func (s *pgxStore) conceptFind(ctx context.Context, where string, args []any) (*ConceptRichNode, error) {
	q := `SELECT n.id, n."conceptName", n.category, n.slug, n."headingPath", n."principlesText",
	             n."authorReflections", n.summary, n."sopSteps", n."subTopics", n.tags, n."canonicalKey", d.path, n."canonicalName"
	      FROM "TutorialConceptNode" n LEFT JOIN "Document" d ON d.id = n."documentId"
	      WHERE ` + where + ` ORDER BY n."updatedAt" DESC LIMIT 1`
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	node, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[ConceptRichNode])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &node, nil
}

func (s *pgxStore) MatchConceptAll(ctx context.Context, repositoryID string, keywords []string) (*ConceptRichNode, error) {
	if len(keywords) == 0 {
		return nil, nil
	}
	var conds []string
	var args []any = []any{repositoryID}
	for _, kw := range keywords {
		args = append(args, "%"+kw+"%")
		idx := itoa(len(args))
		conds = append(conds, `(n."conceptName" ILIKE $`+idx+` OR n."canonicalName" ILIKE $`+idx+`)`)
	}
	return s.conceptFind(ctx, `n."repositoryId" = $1 AND `+strings.Join(conds, " AND "), args)
}

func (s *pgxStore) MatchConceptAny(ctx context.Context, repositoryID string, keywords []string) (*ConceptRichNode, error) {
	if len(keywords) == 0 {
		return nil, nil
	}
	var conds []string
	var args []any = []any{repositoryID}
	for _, kw := range keywords {
		args = append(args, "%"+kw+"%")
		idx := itoa(len(args))
		conds = append(conds, `n."conceptName" ILIKE $`+idx, `n."canonicalName" ILIKE $`+idx)
	}
	return s.conceptFind(ctx, `n."repositoryId" = $1 AND (`+strings.Join(conds, " OR ")+`)`, args)
}

func (s *pgxStore) MatchConceptBody(ctx context.Context, repositoryID string, keywords []string) (*ConceptRichNode, error) {
	if len(keywords) == 0 {
		return nil, nil
	}
	var conds []string
	var args []any = []any{repositoryID}
	for _, kw := range keywords {
		args = append(args, "%"+kw+"%")
		idx := itoa(len(args))
		conds = append(conds, `n."principlesText" ILIKE $`+idx, `n."authorReflections" ILIKE $`+idx, `n.summary ILIKE $`+idx)
	}
	return s.conceptFind(ctx, `n."repositoryId" = $1 AND (`+strings.Join(conds, " OR ")+`)`, args)
}

func (s *pgxStore) ConceptGramCandidates(ctx context.Context, repositoryID string, grams []string) ([]ConceptRichNode, error) {
	if len(grams) == 0 {
		return nil, nil
	}
	patterns := make([]string, 0, len(grams))
	for _, g := range grams {
		patterns = append(patterns, "%"+g+"%")
	}
	rows, err := db.New(s.pool).MCPConceptGramCandidates(ctx, db.MCPConceptGramCandidatesParams{
		RepositoryId: repositoryID,
		Column2:      patterns,
	})
	if err != nil {
		return nil, nil
	}
	out := make([]ConceptRichNode, 0, len(rows))
	for _, r := range rows {
		node := toConceptRichNode(r.ID, r.ConceptName, r.Category, r.Slug, r.HeadingPath, r.PrinciplesText, r.AuthorReflections, r.Summary, r.SopSteps, r.SubTopics, r.Tags, r.CanonicalKey, r.Path, r.CanonicalName)
		out = append(out, *node)
	}
	return out, nil
}

func (s *pgxStore) ConceptDependencyEdges(ctx context.Context, repositoryID string, memberIDs []string) ([]EdgeRef, error) {
	rows, err := db.New(s.pool).MCPConceptDependencyEdges(ctx, db.MCPConceptDependencyEdgesParams{
		RepositoryId: repositoryID,
		Column2:      memberIDs,
	})
	if err != nil {
		return nil, nil
	}
	out := make([]EdgeRef, 0, len(rows))
	for _, r := range rows {
		out = append(out, EdgeRef{
			SourceID: r.SourceId,
			TargetID: r.TargetId,
			Type:     r.Type,
			Weight:   r.Weight,
			Source:   r.Source,
		})
	}
	return out, nil
}

func (s *pgxStore) ResolveConceptNode(ctx context.Context, repositoryID, concept string) (*ConceptRichNode, error) {
	trimmed := strings.TrimSpace(concept)
	if trimmed == "" {
		return nil, nil
	}
	key := normalizeHeadingKey(trimmed)
	q := db.New(s.pool)
	if key != "" {
		r, err := q.MCPResolveConceptNodeStage1Key(ctx, db.MCPResolveConceptNodeStage1KeyParams{
			RepositoryId: repositoryID,
			Lower:        trimmed,
			CanonicalKey: pgtype.Text{String: key, Valid: true},
		})
		if err == nil {
			return toConceptRichNode(r.ID, r.ConceptName, r.Category, r.Slug, r.HeadingPath, r.PrinciplesText, r.AuthorReflections, r.Summary, r.SopSteps, r.SubTopics, r.Tags, r.CanonicalKey, r.Path, r.CanonicalName), nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			fmt.Fprintf(os.Stderr, "[mcp-sidecar] ResolveConceptNode stage1 error: %v\n", err)
		}
	} else {
		r, err := q.MCPResolveConceptNodeStage1NoKey(ctx, db.MCPResolveConceptNodeStage1NoKeyParams{
			RepositoryId: repositoryID,
			Lower:        trimmed,
		})
		if err == nil {
			return toConceptRichNode(r.ID, r.ConceptName, r.Category, r.Slug, r.HeadingPath, r.PrinciplesText, r.AuthorReflections, r.Summary, r.SopSteps, r.SubTopics, r.Tags, r.CanonicalKey, r.Path, r.CanonicalName), nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			fmt.Fprintf(os.Stderr, "[mcp-sidecar] ResolveConceptNode stage1 error: %v\n", err)
		}
	}

	escaped := escapeLikeWildcards(trimmed)
	r2, err2 := q.MCPResolveConceptNodeStage2(ctx, db.MCPResolveConceptNodeStage2Params{
		RepositoryId: repositoryID,
		Lower:        escaped + "%",
	})
	if err2 == nil {
		return toConceptRichNode(r2.ID, r2.ConceptName, r2.Category, r2.Slug, r2.HeadingPath, r2.PrinciplesText, r2.AuthorReflections, r2.Summary, r2.SopSteps, r2.SubTopics, r2.Tags, r2.CanonicalKey, r2.Path, r2.CanonicalName), nil
	}
	if !errors.Is(err2, pgx.ErrNoRows) {
		fmt.Fprintf(os.Stderr, "[mcp-sidecar] ResolveConceptNode stage2 error: %v\n", err2)
	}
	return nil, nil
}

var numericPrefixRE = mdpat.NumericHeadingPrefixRe

func normalizeHeadingKey(text string) string {
	if text == "" {
		return ""
	}
	clean := strings.ToLower(text)
	clean = strings.ReplaceAll(clean, "\n", " ")
	clean = markdownStripRE.ReplaceAllString(clean, "")
	clean = numericPrefixRE.ReplaceAllString(clean, "")
	clean = strings.ReplaceAll(clean, "-", " ")
	clean = strings.ReplaceAll(clean, "_", " ")
	for strings.Contains(clean, "  ") {
		clean = strings.ReplaceAll(clean, "  ", " ")
	}
	return strings.TrimSpace(clean)
}

var markdownStripRE = regexp.MustCompile("[*~`]")

func escapeLikeWildcards(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

func (s *pgxStore) LearningPathEdges(ctx context.Context, repositoryID string) ([]EdgeRef, error) {
	rows, err := db.New(s.pool).MCPLearningPathEdges(ctx, repositoryID)
	if err != nil {
		return nil, nil
	}
	out := make([]EdgeRef, 0, len(rows))
	for _, r := range rows {
		out = append(out, EdgeRef{
			SourceID: r.SourceId,
			TargetID: r.TargetId,
			Type:     r.Type,
			Weight:   r.Weight,
			Source:   r.Source,
		})
	}
	return out, nil
}

func (s *pgxStore) CountCanonicalMembers(ctx context.Context, repositoryID, canonicalKey string) int {
	cnt, err := db.New(s.pool).MCPCountCanonicalMembers(ctx, db.MCPCountCanonicalMembersParams{
		RepositoryId: repositoryID,
		CanonicalKey: pgtype.Text{String: canonicalKey, Valid: true},
	})
	if err != nil {
		return 1
	}
	return int(cnt)
}

type ChapterQuizRow struct {
	ID           string
	Question     string
	Options      []string
	CorrectIndex int32
	Explanation  string
	Order        int32
}

func (s *pgxStore) GetDocumentQuizzesByPath(ctx context.Context, repositoryID, docPath string) ([]ChapterQuizRow, error) {
	rows, err := db.New(s.pool).GetDocumentQuizzesByPath(ctx, db.GetDocumentQuizzesByPathParams{
		RepositoryId: repositoryID, Path: docPath,
	})
	if err != nil {
		return nil, err
	}
	out := make([]ChapterQuizRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ChapterQuizRow{
			ID: r.ID, Question: r.Question, Options: r.Options,
			CorrectIndex: r.CorrectIndex, Explanation: r.Explanation.String, Order: r.Order,
		})
	}
	return out, nil
}

type ConceptEditionRow struct {
	Edition        string
	ConceptName    string
	PrinciplesText string
	Summary        string
}

func (s *pgxStore) ConceptEditionCompare(ctx context.Context, owner, repo, concept string) ([]ConceptEditionRow, error) {
	rows, err := db.New(s.pool).MCPConceptEditionCompare(ctx, db.MCPConceptEditionCompareParams{
		Owner: owner, Repo: repo, Concept: concept,
	})
	if err != nil {
		return nil, err
	}
	out := make([]ConceptEditionRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ConceptEditionRow{
			Edition: r.RepoEdition, ConceptName: r.ConceptName,
			PrinciplesText: r.PrinciplesText.String, Summary: r.Summary.String,
		})
	}
	return out, nil
}

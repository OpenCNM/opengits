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

// ConceptRichNode 概念富化所需列（matchConceptNode + 卡片渲染）。
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
			return nil, nil // fail-soft
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
		return nil, nil // fail-soft
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
		return nil, nil // fail-soft
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

// GetConceptDocumentID 概念所在文档 id（同篇 co_located 补充定位用）。
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

// ListDocConcepts 文档概念段（orderBy updatedAt desc, take 20）。
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

// TaxonomyNodes 全仓概念分类输入（orderBy updatedAt desc, take rawTake=80）。
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

// PrereqEdges prerequisite/successor 边（computeConceptDepths 输入）。
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

// conceptFind Track B 动态关键词查询单行封装（updatedAt desc limit 1）。
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

// ConceptGramCandidates CJK 2-gram 兜底候选（take 40）。
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

// ConceptDependencyEdges 前置知识边（prerequisite/successor 入边，权重降序）。
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

// ResolveConceptNode 两阶段解析（对齐 concept-queries.ts resolveConceptNode）：
// ① exact-insensitive OR（slug/conceptName/canonicalName + 非空 canonicalKey=normalizeHeadingKey）
// ② conceptName 前缀（通配符转义）。
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

	// ② 前缀兜底（% _ 转义）
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

// numericPrefixRE 对齐 concept-extractor.ts 的 multiLevelNumericPrefixPattern（模式本体收编 mdpat SSOT）
var numericPrefixRE = mdpat.NumericHeadingPrefixRe

// normalizeHeadingKey 对齐 concept-extractor.ts：剥 markdown 标记/多级数字前缀、
// 连字符下划线转空格、折叠空白、小写。
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

// escapeLikeWildcards LIKE 模式中的 % 与 _ 转义（对齐 Prisma startsWith）。
func escapeLikeWildcards(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

// LearningPathEdges 全仓 prerequisite/successor 边（BFS 输入）。
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

// CountCanonicalMembers 归并组成员计数（details 的「同义 N 处」标注）。
func (s *pgxStore) CountCanonicalMembers(ctx context.Context, repositoryID, canonicalKey string) int {
	cnt, err := db.New(s.pool).MCPCountCanonicalMembers(ctx, db.MCPCountCanonicalMembersParams{
		RepositoryId: repositoryID,
		CanonicalKey: pgtype.Text{String: canonicalKey, Valid: true},
	})
	if err != nil {
		return 1 // 对齐 Node .catch(() => 1)
	}
	return int(cnt)
}

// ChapterQuizRow 结构化随堂测验行（explore_concept action=quiz 消费）。
type ChapterQuizRow struct {
	ID           string
	Question     string
	Options      []string
	CorrectIndex int32
	Explanation  string
	Order        int32
}

// GetDocumentQuizzesByPath 按 仓库+文档路径 取结构化随堂测验（order 升序；仅共享行）。
func (s *pgxStore) GetDocumentQuizzesByPath(ctx context.Context, repositoryID, docPath string) ([]ChapterQuizRow, error) {
	rows, err := db.New(s.pool).GetDocumentQuizzesByPath(ctx, db.GetDocumentQuizzesByPathParams{
		RepositoryId: repositoryID, Path:     docPath,
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


// ConceptEditionRow 跨讲法对照行（同 owner/repo 各讲法行的同名概念）。
type ConceptEditionRow struct {
	Edition       string
	ConceptName   string
	PrinciplesText string
	Summary       string
}

// ConceptEditionCompare 同 owner/repo（公开行）全部讲法行中的同名概念。
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

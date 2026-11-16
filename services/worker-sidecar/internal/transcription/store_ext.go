package transcription

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// ─────────────────────────────────────────────────────────────
// Document Metadata & Concept Graph 直写下沉（Zero-Web StoreChunks）
// 伴生概念抽取与落库、同 Chunk 强共现边、大纲序递进边与摘要直写入库。
// ─────────────────────────────────────────────────────────────

// 内部 concept 类型别名
type CompanionQuiz = concept.CompanionQuiz
type ExtractedConcept = concept.ExtractedConcept
type ExtractedManifestResult = concept.ExtractedManifestResult
type ConceptSeed = concept.ConceptSeed
type DerivedEdge = concept.DerivedEdge
type ChunkAnchorCandidate = concept.ChunkAnchorCandidate
type ChunkAnchorMatch = concept.ChunkAnchorMatch

func SlugifyConcept(name string) string      { return concept.SlugifyConcept(name) }
func NormalizeHeadingKey(text string) string { return concept.NormalizeHeadingKey(text) }
func MatchChunkAnchor(chunks []concept.ChunkAnchorCandidate, sourceHeading string) *concept.ChunkAnchorMatch {
	return concept.MatchChunkAnchor(chunks, sourceHeading)
}
func DeriveCooccurrenceEdges(concepts []concept.ConceptSeed) []concept.DerivedEdge {
	return concept.DeriveCooccurrenceEdges(concepts)
}
func DeriveCurriculumOrderEdges(orderedConceptIds [][]string) []concept.DerivedEdge {
	return concept.DeriveCurriculumOrderEdges(orderedConceptIds)
}

// SavedConceptNode represents a persisted concept node row.
type SavedConceptNode struct {
	ID          string  `json:"id"`
	Slug        string  `json:"slug"`
	ChunkID     *string `json:"chunkId,omitempty"`
	ConceptName string  `json:"conceptName"`
}

// TranscriptionMetadataStore handles direct storage of document metadata, concepts, and concept edges.
type TranscriptionMetadataStore interface {
	UpdateDocumentSummary(ctx context.Context, docId, summary string) error
	SaveDocumentConcepts(ctx context.Context, repositoryId, docId, docPath, content string, manifest ExtractedManifestResult) ([]SavedConceptNode, error)
	SyncDocumentCooccurrenceEdges(ctx context.Context, repositoryId, docId string) error
	SyncDocumentCurriculumEdge(ctx context.Context, repositoryId, docId string) error
	// SaveDocumentQuizzes 结构化随堂测验落库（幂等 delete+insert）；reflections 折叠保留（Web 语义不变）
	SaveDocumentQuizzes(ctx context.Context, repositoryId, docId string, quizzes []CompanionQuiz) error
	StoreDocumentMetadata(ctx context.Context, repositoryId, docId, docPath, content string, manifest ExtractedManifestResult, summary string) error
}

// DocStore combines chunk storage, metadata storage, and finalize storage for worker-sidecar doc handling.
type DocStore interface {
	ChunkWriteStore
	TranscriptionMetadataStore
	TranscriptionFinalizeStore
	GetDocumentRepositoryInfo(ctx context.Context, docId string) (repoId, docPath, branch string, err error)
}

// FormatQuizzes formats companion quizzes into reflection text (aligned with finalize.ts:115-117).
func FormatQuizzes(quizzes []CompanionQuiz) string {
	if len(quizzes) == 0 {
		return ""
	}
	parts := make([]string, len(quizzes))
	for idx, q := range quizzes {
		explanation := q.Explanation
		if explanation == "" {
			explanation = fmt.Sprintf("答案序号: %d", q.CorrectIndex)
		}
		parts[idx] = fmt.Sprintf("【测验 %d】%s\n选项: %s\n解析: %s",
			idx+1, q.Question, strings.Join(q.Options, " | "), explanation)
	}
	return strings.Join(parts, "\n\n")
}

// FormatTakeaways formats key takeaways into structured text (aligned with finalize.ts:148).
func FormatTakeaways(takeaways []string) string {
	if len(takeaways) == 0 {
		return ""
	}
	return fmt.Sprintf("【核心要点】\n- %s", strings.Join(takeaways, "\n- "))
}

// ApplyQuizzesAndTakeaways injects companion quizzes and takeaways into concepts (aligned with finalize.ts:114-170).
func ApplyQuizzesAndTakeaways(concepts []ExtractedConcept, quizzes []CompanionQuiz, takeaways []string, docPath string) []ExtractedConcept {
	manifestConcepts := make([]ExtractedConcept, len(concepts))
	copy(manifestConcepts, concepts)

	// 1. Quizzes -> reflections
	if len(quizzes) > 0 {
		quizFormatted := FormatQuizzes(quizzes)
		foundReflection := false
		for i := range manifestConcepts {
			if manifestConcepts[i].Category == "reflection" {
				manifestConcepts[i].AuthorReflections = appendAuthorReflections(manifestConcepts[i].AuthorReflections, quizFormatted)
				foundReflection = true
				break
			}
		}
		if !foundReflection {
			if len(manifestConcepts) > 0 {
				manifestConcepts[0].AuthorReflections = appendAuthorReflections(manifestConcepts[0].AuthorReflections, quizFormatted)
			} else {
				syntheticName := "随堂自测"
				pathSlug := mdpat.Slugify(docPath)
				manifestConcepts = append(manifestConcepts, ExtractedConcept{
					ConceptName:       syntheticName,
					Slug:              fmt.Sprintf("%s-%s", pathSlug, syntheticName),
					Category:          "reflection",
					PrinciplesText:    quizFormatted,
					AuthorReflections: quizFormatted,
					SopSteps:          []string{},
					Summary:           "伴生随堂自测与概念辨析",
					SubTopics:         []string{"reflection"},
					Tags:              []string{"quiz", "reflection"},
					SourceHeading:     syntheticName,
					AnchorText:        syntheticName,
				})
			}
		}
	}

	// 2. Takeaways -> primary concept reflections
	if len(takeaways) > 0 {
		takeawayText := FormatTakeaways(takeaways)
		if len(manifestConcepts) > 0 {
			if manifestConcepts[0].AuthorReflections != "" {
				manifestConcepts[0].AuthorReflections = takeawayText + "\n\n" + manifestConcepts[0].AuthorReflections
			} else {
				manifestConcepts[0].AuthorReflections = takeawayText
			}
		} else {
			syntheticName := "核心要点"
			pathSlug := mdpat.Slugify(docPath)
			manifestConcepts = append(manifestConcepts, ExtractedConcept{
				ConceptName:       syntheticName,
				Slug:              fmt.Sprintf("%s-%s", pathSlug, syntheticName),
				Category:          "principle",
				PrinciplesText:    takeawayText,
				AuthorReflections: takeawayText,
				SopSteps:          []string{},
				Summary:           strings.Join(takeaways, " "),
				SubTopics:         []string{"takeaways"},
				Tags:              []string{"takeaways", "principle"},
				SourceHeading:     syntheticName,
				AnchorText:        syntheticName,
			})
		}
	}

	if len(manifestConcepts) > 5 {
		manifestConcepts = manifestConcepts[:5]
	}

	return manifestConcepts
}

type DocChunkRow struct {
	ID          string
	Heading     *string
	HeadingPath *string
	Content     string
}

type docChunkRow = DocChunkRow

// ResolveConceptChunkAnchor resolves chunkId and headingPath using 5-level disambiguation.
func ResolveConceptChunkAnchor(item ExtractedConcept, chunks []DocChunkRow) (chunkID *string, headingPath *string, matchedChunk *DocChunkRow) {
	candidates := make([]ChunkAnchorCandidate, len(chunks))
	for i, c := range chunks {
		candidates[i] = ChunkAnchorCandidate{
			ID:          c.ID,
			Heading:     c.Heading,
			HeadingPath: c.HeadingPath,
		}
	}

	// 1. Exact / suffix match via sourceHeading
	if item.SourceHeading != "" {
		if hit := MatchChunkAnchor(candidates, item.SourceHeading); hit != nil {
			for i := range chunks {
				if chunks[i].ID == hit.ID {
					return &hit.ID, hit.HeadingPath, &chunks[i]
				}
			}
			return &hit.ID, hit.HeadingPath, nil
		}
	}

	// 2. Match via conceptName
	if item.ConceptName != "" {
		if hit := MatchChunkAnchor(candidates, item.ConceptName); hit != nil {
			for i := range chunks {
				if chunks[i].ID == hit.ID {
					return &hit.ID, hit.HeadingPath, &chunks[i]
				}
			}
			return &hit.ID, hit.HeadingPath, nil
		}
	}

	// 3. Anchor text search (prefer General chunks)
	if item.AnchorText != "" {
		anchorRunes := []rune(item.AnchorText)
		if len(anchorRunes) > 60 {
			anchorRunes = anchorRunes[:60]
		}
		anchor := string(anchorRunes)
		for i := range chunks {
			h := ""
			if chunks[i].Heading != nil {
				h = *chunks[i].Heading
			}
			if NormalizeHeadingKey(h) == "general" && strings.Contains(chunks[i].Content, anchor) {
				return &chunks[i].ID, chunks[i].HeadingPath, &chunks[i]
			}
		}
		for i := range chunks {
			if strings.Contains(chunks[i].Content, anchor) {
				return &chunks[i].ID, chunks[i].HeadingPath, &chunks[i]
			}
		}
	}

	// 4. ConceptName substring in chunk content (len >= 2)
	if len([]rune(item.ConceptName)) >= 2 {
		for i := range chunks {
			if strings.Contains(chunks[i].Content, item.ConceptName) {
				return &chunks[i].ID, chunks[i].HeadingPath, &chunks[i]
			}
		}
	}

	return nil, nil, nil
}

// EnrichPrinciplesText enriches concept principlesText with chunk excerpt (up to 2000 runes).
func EnrichPrinciplesText(item ExtractedConcept, chunkID *string, matchedChunk *DocChunkRow) string {
	principlesText := item.PrinciplesText
	if chunkID != nil && (principlesText == "" || principlesText == item.Summary) {
		if matchedChunk != nil && matchedChunk.Content != "" {
			runes := []rune(matchedChunk.Content)
			if len(runes) > 2000 {
				runes = runes[:2000]
			}
			principlesText = string(runes)
		}
	}
	if principlesText == "" {
		if item.Summary != "" {
			principlesText = item.Summary
		} else {
			principlesText = item.ConceptName
		}
	}
	return principlesText
}

// UpdateDocumentSummary sets Document.summary and updates updatedAt.
func (s *PgxStore) UpdateDocumentSummary(ctx context.Context, docId, summary string) error {
	trimmed := strings.TrimSpace(summary)
	if trimmed == "" {
		return nil
	}
	return s.queries.TranscriptionUpdateDocumentSummary(ctx, db.TranscriptionUpdateDocumentSummaryParams{
		Summary: pgtype.Text{String: trimmed, Valid: true},
		ID:      docId,
	})
}

// SaveDocumentConcepts saves extracted concept nodes and prunes obsolete ones for this document.
// 无 manifest 概念时触发标题块回退提取（对齐 Node concept-extractor.ts:339-342：
// explicitConcepts.length>0 ? explicit : extractConceptsFromMarkdown——web-doc 页、
// 降级转录、零 LLM 复用的概念图不再恒空）。

func (s *PgxStore) StoreDocumentMetadata(ctx context.Context, repositoryId, docId, docPath, content string, manifest ExtractedManifestResult, summary string) error {
	if summary != "" {
		if err := s.UpdateDocumentSummary(ctx, docId, summary); err != nil {
			log.Printf("[store-ext] UpdateDocumentSummary warning for %s: %v", docId, err)
		}
	}
	_, err := s.SaveDocumentConcepts(ctx, repositoryId, docId, docPath, content, manifest)
	if err != nil {
		return fmt.Errorf("save concepts: %w", err)
	}
	if err := s.SyncDocumentCooccurrenceEdges(ctx, repositoryId, docId); err != nil {
		log.Printf("[store-ext] SyncDocumentCooccurrenceEdges warning for %s: %v", docId, err)
	}
	if err := s.SyncDocumentCurriculumEdge(ctx, repositoryId, docId); err != nil {
		log.Printf("[store-ext] SyncDocumentCurriculumEdge warning for %s: %v", docId, err)
	}
	if err := s.SaveDocumentQuizzes(ctx, repositoryId, docId, manifest.Quizzes); err != nil {
		log.Printf("[store-ext] SaveDocumentQuizzes warning for %s: %v", docId, err)
	}
	return nil
}

// SaveDocumentQuizzes 结构化随堂测验幂等落库：先清后插（同一文档重复 finalize 天然收敛）。
// 与概念 reflections 折叠文本并存——Web 端语义零变化（能力不倒退红线）。
func (s *PgxStore) SaveDocumentQuizzes(ctx context.Context, repositoryId, docId string, quizzes []CompanionQuiz) error {
	if len(quizzes) == 0 {
		return nil
	}
	if err := s.queries.DeleteDocumentQuizzes(ctx, docId); err != nil {
		return fmt.Errorf("clear chapter quizzes: %w", err)
	}
	for idx, q := range quizzes {
		if err := s.queries.InsertChapterQuiz(ctx, db.InsertChapterQuizParams{
			DocumentId:   docId,
			RepositoryId: repositoryId,
			Question:     q.Question,
			Options:      q.Options,
			CorrectIndex: int32(q.CorrectIndex),
			Column6:      q.Explanation,
			Order:        int32(idx),
		}); err != nil {
			return fmt.Errorf("insert chapter quiz %d: %w", idx, err)
		}
	}
	return nil
}

// GetDocumentRepositoryInfo fetches repositoryId, docPath, and branch for a given document.
func (s *PgxStore) GetDocumentRepositoryInfo(ctx context.Context, docId string) (repoId, docPath, branch string, err error) {
	row, err := s.queries.TranscriptionGetDocumentRepositoryInfo(ctx, docId)
	if err != nil {
		return "", "", "", err
	}
	return row.RepositoryId, row.Path, row.Branch, nil
}

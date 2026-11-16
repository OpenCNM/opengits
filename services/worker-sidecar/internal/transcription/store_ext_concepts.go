package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

func (s *PgxStore) SaveDocumentConcepts(ctx context.Context, repositoryId, docId, docPath, content string, manifest ExtractedManifestResult) ([]SavedConceptNode, error) {
	explicitConcepts := manifest.Concepts
	if len(explicitConcepts) == 0 && strings.TrimSpace(content) != "" {
		explicitConcepts = concept.ExtractConceptsFromHeadings(content, docPath, "")
	}
	manifestConcepts := ApplyQuizzesAndTakeaways(explicitConcepts, manifest.Quizzes, manifest.Takeaways, docPath)
	if len(manifestConcepts) == 0 {
		return []SavedConceptNode{}, nil
	}

	queries := db.New(s.pool)

	chunksResp, err := queries.GetDocumentChunksForConcepts(ctx, pgtype.Text{String: docId, Valid: true})
	if err != nil {
		return nil, fmt.Errorf("query chunks: %w", err)
	}

	var chunks []docChunkRow
	for _, r := range chunksResp {
		var heading, headingPath *string
		if r.Heading.Valid {
			h := r.Heading.String
			heading = &h
		}
		if r.HeadingPath.Valid {
			hp := r.HeadingPath.String
			headingPath = &hp
		}
		chunks = append(chunks, docChunkRow{
			ID:          r.ID,
			Heading:     heading,
			HeadingPath: headingPath,
			Content:     r.Content,
		})
	}

	var (
		chunkIds          []string
		headingPaths      []string
		conceptNames      []string
		slugs             []string
		canonicalKeys     []string
		canonicalNames    []string
		categories        []string
		principlesTexts   []string
		authorReflections []string
		sopSteps          [][]byte
		summaries         []string
		subTopics         [][]byte
		tags              [][]byte
	)

	affectedKeys := make(map[string]bool, len(manifestConcepts))
	seenSlugs := make(map[string]bool, len(manifestConcepts))

	for _, item := range manifestConcepts {
		chunkID, headingPath, matchedChunk := ResolveConceptChunkAnchor(item, chunks)
		principlesText := EnrichPrinciplesText(item, chunkID, matchedChunk)

		canonicalKey := NormalizeHeadingKey(item.ConceptName)
		canonicalName := strings.TrimSpace(item.ConceptName)
		if canonicalKey != "" {
			affectedKeys[canonicalKey] = true
		}

		slug := item.Slug
		if slug == "" {
			slug = SlugifyConcept(item.ConceptName)
		}
		if slug == "" {
			slug = fmt.Sprintf("concept-%s", canonicalKey)
		}
		// 批内按 (slug) 去重（保首见，确定性）：同一文档两个概念 slugify 撞车
		// 时（Rust 巨文件重复标题/宏名实测命中），ON CONFLICT DO UPDATE 对
		// 同一行二次影响直接 SQLSTATE 21000 整批炸——47/54 章成、7 章全灭
		// 的真凶。
		if seenSlugs[slug] {
			continue
		}
		seenSlugs[slug] = true

		category := item.Category
		if category == "" {
			category = "architecture"
		}

		ss := item.SopSteps
		if ss == nil {
			ss = []string{}
		}
		ssBytes, _ := json.Marshal(ss)

		st := item.SubTopics
		if st == nil {
			st = []string{}
		}
		stBytes, _ := json.Marshal(st)

		ts := item.Tags
		if ts == nil {
			ts = []string{}
		}
		tsBytes, _ := json.Marshal(ts)

		var cid string
		if chunkID != nil {
			cid = *chunkID
		}
		var hp string
		if headingPath != nil {
			hp = *headingPath
		}
		pt := principlesText

		chunkIds = append(chunkIds, cid)
		headingPaths = append(headingPaths, hp)
		conceptNames = append(conceptNames, item.ConceptName)
		slugs = append(slugs, slug)
		canonicalKeys = append(canonicalKeys, canonicalKey)
		canonicalNames = append(canonicalNames, canonicalName)
		categories = append(categories, category)
		principlesTexts = append(principlesTexts, pt)
		authorReflections = append(authorReflections, item.AuthorReflections)
		sopSteps = append(sopSteps, ssBytes)
		summaries = append(summaries, item.Summary)
		subTopics = append(subTopics, stBytes)
		tags = append(tags, tsBytes)
	}

	batchResp, err := queries.BatchUpsertConcepts(ctx, db.BatchUpsertConceptsParams{
		RepositoryID:      repositoryId,
		DocumentID:        docId,
		ChunkIds:          chunkIds,
		HeadingPaths:      headingPaths,
		ConceptNames:      conceptNames,
		Slugs:             slugs,
		CanonicalKeys:     canonicalKeys,
		CanonicalNames:    canonicalNames,
		Categories:        categories,
		PrinciplesTexts:   principlesTexts,
		AuthorReflections: authorReflections,
		SopSteps:          sopSteps,
		Summaries:         summaries,
		SubTopics:         subTopics,
		Tags:              tags,
	})
	if err != nil {
		return nil, fmt.Errorf("batch upsert concepts: %w", err)
	}

	saved := make([]SavedConceptNode, 0, len(batchResp))
	keepSlugs := make([]string, 0, len(batchResp))
	for _, r := range batchResp {
		var cid *string
		if r.ChunkId.Valid {
			v := r.ChunkId.String
			cid = &v
		}
		saved = append(saved, SavedConceptNode{
			ID:          r.ID,
			Slug:        r.Slug,
			ChunkID:     cid,
			ConceptName: r.ConceptName,
		})
		keepSlugs = append(keepSlugs, r.Slug)
	}

	// Clean up obsolete concepts for this document
	if len(keepSlugs) > 0 {
		if err := queries.DeleteObsoleteConcepts(ctx, db.DeleteObsoleteConceptsParams{
			DocumentId: pgtype.Text{String: docId, Valid: true},
			KeepSlugs:  keepSlugs,
		}); err != nil {
			log.Printf("[store-ext] delete obsolete concepts failed for doc %s: %v", docId, err)
		}
	}

	// canonicalName 组代表刷新（WP-I：频率→短名→字典序收敛变体，L1 归并层闭环）
	s.refreshCanonicalNames(ctx, repositoryId, affectedKeys)

	return saved, nil
}

// refreshCanonicalNames 重算受影响 canonicalKey 分组的代表名（对齐 Node
// refreshCanonicalNames/planCanonicalGroups）：全组成员统一为代表名。
func (s *PgxStore) refreshCanonicalNames(ctx context.Context, repositoryId string, keys map[string]bool) {
	if len(keys) == 0 {
		return
	}
	keyList := make([]string, 0, len(keys))
	for k := range keys {
		keyList = append(keyList, k)
	}

	queries := db.New(s.pool)
	rows, err := queries.GetCanonicalGroupsByKeys(ctx, db.GetCanonicalGroupsByKeysParams{
		RepositoryId: repositoryId,
		Keys:         keyList,
	})
	if err != nil {
		log.Printf("[store-ext] canonical group query failed: %v", err)
		return
	}

	groups := map[string][]concept.CanonicalVariant{}
	counts := map[string]map[string]int{}
	for _, r := range rows {
		if !r.CanonicalKey.Valid {
			continue
		}
		key := r.CanonicalKey.String
		name := r.ConceptName
		if counts[key] == nil {
			counts[key] = map[string]int{}
		}
		counts[key][name]++
	}
	for key, byName := range counts {
		for name, n := range byName {
			groups[key] = append(groups[key], concept.CanonicalVariant{Name: name, Count: n})
		}
	}
	planned := concept.PlanCanonicalGroups(groups)
	if len(planned) == 0 {
		return
	}

	batchKeys := make([]string, 0, len(planned))
	batchReps := make([]string, 0, len(planned))
	for k, r := range planned {
		batchKeys = append(batchKeys, k)
		batchReps = append(batchReps, r)
	}

	if err := queries.BatchUpdateCanonicalNames(ctx, db.BatchUpdateCanonicalNamesParams{
		RepositoryId: repositoryId,
		Keys:         batchKeys,
		Reps:         batchReps,
	}); err != nil {
		log.Printf("[store-ext] canonical name batch refresh failed: %v", err)
	}
}

// SyncDocumentCooccurrenceEdges computes chunk-level cooccurrence edges and synchronizes them transactionally.

// ── LLM 概念边同步（WP-I：llm_edges.go 消费） ──

// GetDocumentConceptNodes 文档当前概念节点（LLM 边解析与 <2 判定）。
func (s *PgxStore) GetDocumentConceptNodes(ctx context.Context, docId string) ([]SavedConceptNode, error) {
	queries := db.New(s.pool)
	rows, err := queries.GetDocumentConceptNodes(ctx, pgtype.Text{String: docId, Valid: true})
	if err != nil {
		return nil, err
	}

	var out []SavedConceptNode
	for _, r := range rows {
		var cid *string
		if r.ChunkId.Valid {
			v := r.ChunkId.String
			cid = &v
		}
		out = append(out, SavedConceptNode{
			ID:          r.ID,
			Slug:        r.Slug,
			ChunkID:     cid,
			ConceptName: r.ConceptName,
		})
	}
	return out, nil
}

// ReplaceLlmConceptEdges 先删后建 source='llm_extracted'（对齐 Node
// llm-concept-edges.ts:166-200 事务语义）；prerequisite 候选经
// FilterPrerequisiteCandidates 环卫生（反向矛盾 + 传递环剔除——
// 既有 prerequisite/successor 边为既定事实）。

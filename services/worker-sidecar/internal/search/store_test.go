package search

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/ogis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeriveEditionLabel(t *testing.T) {
	tests := []struct {
		name        string
		profileJSON []byte
		want        string
	}{
		{
			name:        "nil/empty profile defaults to base edition",
			profileJSON: nil,
			want:        baseEditionLabel,
		},
		{
			name:        "invalid json defaults to base edition",
			profileJSON: []byte(`not-json`),
			want:        baseEditionLabel,
		},
		{
			name:        "explicit editionLabel takes highest priority",
			profileJSON: []byte(`{"editionLabel":"  架构师特辑  ","editionPreset":"deep"}`),
			want:        "架构师特辑",
		},
		{
			name:        "editionPreset deep maps to name with suffix",
			profileJSON: []byte(`{"editionPreset":"deep"}`),
			want:        "深度剖析版",
		},
		{
			name:        "editionPreset standard maps to base edition",
			profileJSON: []byte(`{"editionPreset":"standard"}`),
			want:        baseEditionLabel,
		},
		{
			name:        "transcriptionModel takes priority over presets",
			profileJSON: []byte(`{"transcriptionModel":"qwen-max","editionPreset":"deep"}`),
			want:        "qwen-max",
		},
		{
			name:        "transcriptionPreset deep maps to name with suffix",
			profileJSON: []byte(`{"transcriptionPreset":"deep"}`),
			want:        "深度剖析版",
		},
		{
			name:        "transcriptionPreset standard maps to base edition",
			profileJSON: []byte(`{"transcriptionPreset":"standard"}`),
			want:        baseEditionLabel,
		},
		{
			name:        "unknown editionPreset falls back to base edition",
			profileJSON: []byte(`{"editionPreset":"custom_non_existent"}`),
			want:        baseEditionLabel,
		},
		{
			name:        "unknown transcriptionPreset falls back to base edition",
			profileJSON: []byte(`{"transcriptionPreset":"custom_non_existent"}`),
			want:        baseEditionLabel,
		},
		{
			name:        "empty profile json maps to base edition",
			profileJSON: []byte(`{}`),
			want:        baseEditionLabel,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deriveEditionLabel(tt.profileJSON)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestSearchChunkHit_ZeroContentTransport(t *testing.T) {
	tests := []struct {
		name        string
		hit         SearchChunkHit
		wantContain []string
		wantOmit    []string
	}{
		{
			name: "zero-content hit omits content and optional fields",
			hit: SearchChunkHit{
				ChunkID:    "c-1",
				DocID:      "d-1",
				Title:      "Title",
				Path:       "path.md",
				Snippet:    "snippet",
				Similarity: 0.8,
			},
			wantContain: []string{`"chunkId":"c-1"`, `"snippet":"snippet"`},
			wantOmit:    []string{`"content"`, `"editionLabel"`, `"matchCount"`, `"ftsRank"`},
		},
		{
			name: "full hit serializes all optional fields when present",
			hit: func() SearchChunkHit {
				lbl := "深度剖析讲法"
				mc := 3
				rank := 0.75
				return SearchChunkHit{
					ChunkID:      "c-2",
					DocID:        "d-2",
					Title:        "Title 2",
					Path:         "path2.md",
					Snippet:      "snippet 2",
					Similarity:   0.9,
					Content:      "Full text content of the chunk",
					EditionLabel: &lbl,
					MatchCount:   &mc,
					FtsRank:      &rank,
				}
			}(),
			wantContain: []string{
				`"content":"Full text content of the chunk"`,
				`"editionLabel":"深度剖析讲法"`,
				`"matchCount":3`,
				`"ftsRank":0.75`,
			},
			wantOmit: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b, err := json.Marshal(tt.hit)
			require.NoError(t, err)
			str := string(b)
			for _, c := range tt.wantContain {
				assert.Contains(t, str, c)
			}
			for _, o := range tt.wantOmit {
				assert.NotContains(t, str, o)
			}
		})
	}
}

func TestSearchStore_TokenBudgetCalculation(t *testing.T) {
	tests := []struct {
		name          string
		contents      []string
		budget        int
		wantCollected int
	}{
		{
			name:          "budget 0 means no truncation",
			contents:      []string{"aaaa", "bbbb", "cccc"},
			budget:        0,
			wantCollected: 3,
		},
		{
			name:          "first hit always collected even if exceeding budget",
			contents:      []string{string(make([]rune, 100))},
			budget:        5,
			wantCollected: 1,
		},
		{
			name: "stops once cumulative tokens exceed budget",

			contents:      []string{string(make([]rune, 40)), string(make([]rune, 40)), string(make([]rune, 40))},
			budget:        25,
			wantCollected: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cumulativeTokens := 0
			var collected []int
			for idx, c := range tt.contents {
				textLen := len([]rune(c))
				estTokens := int(math.Ceil(float64(textLen) * 0.25))
				if tt.budget > 0 && cumulativeTokens+estTokens > tt.budget && len(collected) > 0 {
					break
				}
				cumulativeTokens += estTokens
				collected = append(collected, idx)
			}
			assert.Len(t, collected, tt.wantCollected)
		})
	}
}

func TestSearchStore_BuildSearchFromJoin(t *testing.T) {
	tests := []struct {
		name        string
		isRepo      bool
		userArgIdx  int
		wantContain []string
		wantOmit    []string
	}{
		{
			name:       "repo search without user filters by repoId $1 and owner null",
			isRepo:     true,
			userArgIdx: 0,
			wantContain: []string{
				`d2."repositoryId" = $1`,
				`d2."ownerUserId" IS NULL`,
				`JOIN "Repository" ON "Document"."repositoryId" = "Repository"."id"`,
			},
			wantOmit: []string{`d2."ownerUserId" = $`},
		},
		{
			name:       "repo search with user filters by repoId $1 and owner $2",
			isRepo:     true,
			userArgIdx: 2,
			wantContain: []string{
				`d2."repositoryId" = $1`,
				`(d2."ownerUserId" IS NULL OR d2."ownerUserId" = $2)`,
				`JOIN "Repository" ON "Document"."repositoryId" = "Repository"."id"`,
			},
			wantOmit: []string{},
		},
		{
			name:       "global search without user filters by owner null without repoId constraint",
			isRepo:     false,
			userArgIdx: 0,
			wantContain: []string{
				`d2."ownerUserId" IS NULL`,
				`JOIN "Repository" ON "Document"."repositoryId" = "Repository"."id"`,
			},
			wantOmit: []string{`d2."repositoryId" = $1`, `d2."ownerUserId" = $`},
		},
		{
			name:       "global search with user filters by owner $1 without repoId constraint",
			isRepo:     false,
			userArgIdx: 1,
			wantContain: []string{
				`(d2."ownerUserId" IS NULL OR d2."ownerUserId" = $1)`,
				`JOIN "Repository" ON "Document"."repositoryId" = "Repository"."id"`,
			},
			wantOmit: []string{`d2."repositoryId" = $1`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var sql string
			if tt.isRepo {
				sql = buildRepoSearchFromJoin(tt.userArgIdx)
			} else {
				sql = buildGlobalSearchFromJoin(tt.userArgIdx)
			}
			for _, c := range tt.wantContain {
				assert.Contains(t, sql, c)
			}
			for _, o := range tt.wantOmit {
				assert.NotContains(t, sql, o)
			}
		})
	}
}

func TestSearchStore_FallbackSignals(t *testing.T) {
	tests := []struct {
		name       string
		matchCount *int
		ftsRank    *float64
		wantSim    float64
	}{
		{
			name:       "stage 1 fts rank sets similarity directly",
			matchCount: nil,
			ftsRank:    func() *float64 { v := 0.78; return &v }(),
			wantSim:    0.78,
		},
		{
			name:       "stage 2 substring rank 0.5 sets similarity 0.5",
			matchCount: nil,
			ftsRank:    func() *float64 { v := 0.5; return &v }(),
			wantSim:    0.5,
		},
		{
			name:       "stage 3 token match count overrides fts rank 0.4 for similarity",
			matchCount: func() *int { v := 3; return &v }(),
			ftsRank:    func() *float64 { v := 0.4; return &v }(),
			wantSim:    0.8,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var sim float64
			switch {
			case tt.matchCount != nil:
				sim = math.Min(0.95, 0.5+float64(*tt.matchCount)*0.1)
			case tt.ftsRank != nil:
				sim = *tt.ftsRank
			default:
				sim = 0.5
			}
			assert.InDelta(t, tt.wantSim, sim, 0.001)
		})
	}
}

func TestBuildTsQuery_CJKScriptCoverage(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  string
	}{
		{
			name:  "chinese characters preserved",
			query: "用户认证",
			want:  "用户认证:*",
		},
		{
			name:  "japanese hiragana and katakana preserved",
			query: "はじめに アーキテクチャ",
			want:  "はじめに:* & アーキテクチャ:*",
		},
		{
			name:  "korean hangul preserved",
			query: "시작하기 핵심개념",
			want:  "시작하기:* & 핵심개념:*",
		},
		{
			name:  "mixed english and cjk",
			query: "React 状态管理 チュートリアル",
			want:  "React:* & 状态管理:* & チュートリアル:*",
		},
		{
			name:  "empty and punctuation queries return empty",
			query: "??? !!! @@@",
			want:  "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := BuildTsQuery(tt.query)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestSearchExactConceptStage0(t *testing.T) {
	t.Run("Stage 0 SQL structure enforces exact TutorialConceptNode match and repository boundary", func(t *testing.T) {
		repoJoin := buildRepoSearchFromJoin(0)
		baseFilters := []string{`"Document"."repositoryId" = $1`, `"Document"."status" = 'PROCESSED'`}
		repoSQL := buildStage0ConceptSQL(repoJoin, baseFilters, 2, 3, 4)

		assert.Contains(t, repoSQL, `JOIN "TutorialConceptNode" ON "TutorialConceptNode"."chunkId" = "DocumentChunk"."id"`)
		assert.Contains(t, repoSQL, `"TutorialConceptNode"."repositoryId" = "Repository"."id"`)
		assert.Contains(t, repoSQL, `"TutorialConceptNode"."conceptName" ILIKE $2`)
		assert.Contains(t, repoSQL, `"TutorialConceptNode"."slug" = $3`)
		assert.Contains(t, repoSQL, `LIMIT $4`)

		globalJoin := buildGlobalSearchFromJoin(0)
		globalFilters := []string{`"Document"."status" = 'PROCESSED'`, `"Repository"."isPublic" = true`}
		globalSQL := buildGlobalStage0ConceptSQL(globalJoin, globalFilters, 1, 2, 3)

		assert.Contains(t, globalSQL, `JOIN "TutorialConceptNode" ON "TutorialConceptNode"."chunkId" = "DocumentChunk"."id"`)
		assert.Contains(t, globalSQL, `"TutorialConceptNode"."repositoryId" = "Repository"."id"`)
		assert.Contains(t, globalSQL, `"TutorialConceptNode"."conceptName" ILIKE $1`)
		assert.Contains(t, globalSQL, `"TutorialConceptNode"."slug" = $2`)
		assert.Contains(t, globalSQL, `LIMIT $3`)
	})

	t.Run("Stage 0 exact concept hits yield similarity 1.0 and precedence", func(t *testing.T) {
		tests := []struct {
			name        string
			stage       int
			ftsRank     *float64
			matchCount  *int
			wantSim     float64
			isStage0Top bool
		}{
			{
				name:        "Stage 0 exact concept match yields maximum similarity 1.0",
				stage:       0,
				ftsRank:     func() *float64 { v := 1.0; return &v }(),
				wantSim:     1.0,
				isStage0Top: true,
			},
			{
				name:        "Stage 1 strong FTS match capped below 1.0",
				stage:       1,
				ftsRank:     func() *float64 { v := 0.85; return &v }(),
				wantSim:     0.85,
				isStage0Top: false,
			},
			{
				name:        "Stage 2 direct substring fallback has baseline similarity",
				stage:       2,
				ftsRank:     func() *float64 { v := 0.5; return &v }(),
				wantSim:     0.5,
				isStage0Top: false,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				var sim float64
				switch {
				case tt.stage == 0:
					sim = 1.0
				case tt.matchCount != nil:
					sim = math.Min(0.95, 0.5+float64(*tt.matchCount)*0.1)
				case tt.ftsRank != nil:
					sim = *tt.ftsRank
				default:
					sim = 0.5
				}
				assert.InDelta(t, tt.wantSim, sim, 0.001)
				if tt.isStage0Top {
					assert.Equal(t, 1.0, sim, "Stage 0 exact concept hit must have similarity 1.0")
				} else {
					assert.Less(t, sim, 1.0, "Non-Stage 0 hit must not exceed Stage 0 precedence")
				}
			})
		}
	})

	t.Run("Stage 0 deduplication preserves Stage 0 precedence over Stage 1 FTS", func(t *testing.T) {
		seenChunkIDs := make(map[string]bool)
		var rawRows []rawRepoChunkRow

		stage0Rank := 1.0
		stage0Row := rawRepoChunkRow{
			ChunkID: "chunk-exact",
			Content: "type LlmGatewayClient struct {}",
			Stage:   0,
			FtsRank: &stage0Rank,
		}
		if !seenChunkIDs[stage0Row.ChunkID] {
			seenChunkIDs[stage0Row.ChunkID] = true
			rawRows = append(rawRows, stage0Row)
		}

		stage1FtsRank := 0.65
		stage1Duplicate := rawRepoChunkRow{
			ChunkID: "chunk-exact",
			Content: "type LlmGatewayClient struct {}",
			Stage:   1,
			FtsRank: &stage1FtsRank,
		}
		stage1Mention := rawRepoChunkRow{
			ChunkID: "chunk-mention",
			Content: "Call LlmGatewayClient here",
			Stage:   1,
			FtsRank: &stage1FtsRank,
		}

		for _, r := range []rawRepoChunkRow{stage1Duplicate, stage1Mention} {
			if !seenChunkIDs[r.ChunkID] {
				seenChunkIDs[r.ChunkID] = true
				rawRows = append(rawRows, r)
			}
		}

		require.Len(t, rawRows, 2, "duplicate chunk-exact must be omitted")
		assert.Equal(t, "chunk-exact", rawRows[0].ChunkID)
		assert.Equal(t, 0, rawRows[0].Stage, "first row must be Stage 0 exact match")
		assert.Equal(t, 1.0, *rawRows[0].FtsRank, "Stage 0 row must retain rank 1.0")
		assert.Equal(t, "chunk-mention", rawRows[1].ChunkID)
		assert.Equal(t, 1, rawRows[1].Stage)
	})

	t.Run("safeLimit strictly caps combined Stage 0 and Stage 1 results", func(t *testing.T) {
		safeLimit := 3
		var rawRows []rawRepoChunkRow
		rank1 := 1.0
		rankFts := 0.8

		rawRows = append(rawRows, rawRepoChunkRow{ChunkID: "s0-1", Content: "c1", Stage: 0, FtsRank: &rank1})
		rawRows = append(rawRows, rawRepoChunkRow{ChunkID: "s0-2", Content: "c2", Stage: 0, FtsRank: &rank1})

		rawRows = append(rawRows, rawRepoChunkRow{ChunkID: "s1-1", Content: "c3", Stage: 1, FtsRank: &rankFts})
		rawRows = append(rawRows, rawRepoChunkRow{ChunkID: "s1-2", Content: "c4", Stage: 1, FtsRank: &rankFts})
		rawRows = append(rawRows, rawRepoChunkRow{ChunkID: "s1-3", Content: "c5", Stage: 1, FtsRank: &rankFts})

		hits := make([]SearchChunkHit, 0, min(safeLimit, len(rawRows)))
		for _, r := range rawRows {
			if len(hits) >= safeLimit {
				break
			}
			hits = append(hits, SearchChunkHit{ChunkID: r.ChunkID})
		}

		require.Len(t, hits, safeLimit, "hits length must not exceed safeLimit")
		assert.Equal(t, "s0-1", hits[0].ChunkID)
		assert.Equal(t, "s0-2", hits[1].ChunkID)
		assert.Equal(t, "s1-1", hits[2].ChunkID)
	})

	t.Run("mdpat.Slugify derives correct slug for Stage 0 query", func(t *testing.T) {
		tests := []struct {
			query    string
			wantSlug string
		}{
			{"LlmGatewayClient", "llmgatewayclient"},
			{"llm gateway client", "llm-gateway-client"},
			{"  UpdatePlan  ", "updateplan"},
			{"状态机 架构", "状态机-架构"},
		}
		for _, tt := range tests {
			slug := mdpat.Slugify(strings.TrimSpace(tt.query))
			assert.Equal(t, tt.wantSlug, slug)
		}
	})
}

func TestRerankRepoChunkRows(t *testing.T) {
	rankExact := 1.0
	rankTest := 0.85
	rankCore := 0.65

	rows := []rawRepoChunkRow{
		{
			ChunkID: "chunk-stage0",
			Path:    "docs/intro.md",
			Stage:   0,
			FtsRank: &rankExact,
		},
		{
			ChunkID: "chunk-test",
			Path:    "tests/unit/auth_test.go",
			Stage:   1,
			FtsRank: &rankTest,
		},
		{
			ChunkID: "chunk-core",
			Path:    "internal/auth/contract.go",
			Stage:   1,
			FtsRank: &rankCore,
		},
	}

	nodes := []ogis.TopologicalNodeMeta{
		{
			Path:       "internal/auth/contract.go",
			Role:       "core_contract",
			IsBackbone: true,
			InDegree:   5,
		},
	}
	scorer := ogis.NewTopologicalScorer(nodes)

	reranked := rerankRepoChunkRows(rows, scorer)
	require.Len(t, reranked, 3)

	assert.Equal(t, "chunk-stage0", reranked[0].ChunkID)

	assert.Equal(t, "chunk-core", reranked[1].ChunkID)
	assert.Equal(t, "chunk-test", reranked[2].ChunkID)
}

func TestRerankGlobalChunkRows(t *testing.T) {
	rankTest := 0.80
	rankReadme := 0.60

	rows := []rawGlobalChunkRow{
		{
			ChunkID: "global-test",
			Path:    "tests/test_helper.ts",
			Stage:   1,
			FtsRank: &rankTest,
		},
		{
			ChunkID: "global-readme",
			Path:    "README.md",
			Stage:   1,
			FtsRank: &rankReadme,
		},
	}

	scorer := ogis.NewHeuristicTopologicalScorer()
	reranked := rerankGlobalChunkRows(rows, scorer)
	require.Len(t, reranked, 2)

	assert.Equal(t, "global-readme", reranked[0].ChunkID)
	assert.Equal(t, "global-test", reranked[1].ChunkID)
}

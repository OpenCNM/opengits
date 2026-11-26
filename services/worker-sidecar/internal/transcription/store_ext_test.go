package transcription

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

func TestFormatQuizzesAndTakeaways(t *testing.T) {
	tests := []struct {
		name      string
		quizzes   []CompanionQuiz
		takeaways []string
		expectedQ string
		expectedT string
	}{
		{
			name:      "empty",
			quizzes:   nil,
			takeaways: nil,
			expectedQ: "",
			expectedT: "",
		},
		{
			name: "single quiz with explanation and takeaways",
			quizzes: []CompanionQuiz{
				{
					Question:     "What is Go?",
					Options:      []string{"Language", "Database"},
					CorrectIndex: 0,
					Explanation:  "Go is an open-source programming language.",
				},
			},
			takeaways: []string{"Fast compilation", "Concurrency built-in"},
			expectedQ: "【测验 1】What is Go?\n选项: Language | Database\n解析: Go is an open-source programming language.",
			expectedT: "【核心要点】\n- Fast compilation\n- Concurrency built-in",
		},
		{
			name: "quiz without explanation falls back to correctIndex",
			quizzes: []CompanionQuiz{
				{
					Question:     "Select 2",
					Options:      []string{"A", "B", "C"},
					CorrectIndex: 1,
				},
			},
			expectedQ: "【测验 1】Select 2\n选项: A | B | C\n解析: 答案序号: 1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.quizzes != nil || tt.expectedQ != "" {
				gotQ := FormatQuizzes(tt.quizzes)
				assert.Equal(t, tt.expectedQ, gotQ)
			}
			if tt.takeaways != nil || tt.expectedT != "" {
				gotT := FormatTakeaways(tt.takeaways)
				assert.Equal(t, tt.expectedT, gotT)
			}
		})
	}
}

func TestApplyQuizzesAndTakeaways(t *testing.T) {
	tests := []struct {
		name      string
		concepts  []ExtractedConcept
		quizzes   []CompanionQuiz
		takeaways []string
		docPath   string
		verify    func(t *testing.T, res []ExtractedConcept)
	}{
		{
			name: "injects quiz into reflection concept when present",
			concepts: []ExtractedConcept{
				{ConceptName: "Arch", Category: "architecture"},
				{ConceptName: "Reflect", Category: "reflection", AuthorReflections: "Existing reflection"},
			},
			quizzes: []CompanionQuiz{
				{Question: "Q1", Options: []string{"A", "B"}, CorrectIndex: 0, Explanation: "Exp1"},
			},
			docPath: "guide/intro.md",
			verify: func(t *testing.T, res []ExtractedConcept) {
				t.Helper()
				require.Len(t, res, 2)
				assert.Equal(t, "Existing reflection\n\n【测验 1】Q1\n选项: A | B\n解析: Exp1", res[1].AuthorReflections)
			},
		},
		{
			name: "injects quiz into first concept when no reflection concept",
			concepts: []ExtractedConcept{
				{ConceptName: "Arch", Category: "architecture"},
			},
			quizzes: []CompanionQuiz{
				{Question: "Q1", Options: []string{"A", "B"}, CorrectIndex: 0, Explanation: "Exp1"},
			},
			docPath: "guide/intro.md",
			verify: func(t *testing.T, res []ExtractedConcept) {
				t.Helper()
				require.Len(t, res, 1)
				assert.Equal(t, "【测验 1】Q1\n选项: A | B\n解析: Exp1", res[0].AuthorReflections)
			},
		},
		{
			name:     "synthesizes reflection concept when concepts slice is empty",
			concepts: nil,
			quizzes: []CompanionQuiz{
				{Question: "Q1", Options: []string{"A", "B"}, CorrectIndex: 0, Explanation: "Exp1"},
			},
			docPath: "docs/intro.md",
			verify: func(t *testing.T, res []ExtractedConcept) {
				t.Helper()
				require.Len(t, res, 1)
				assert.Equal(t, "随堂自测", res[0].ConceptName)
				assert.Equal(t, "reflection", res[0].Category)
				assert.Equal(t, "docs-intro-md-随堂自测", res[0].Slug)
				assert.Contains(t, res[0].AuthorReflections, "【测验 1】Q1")
				assert.Equal(t, res[0].AuthorReflections, res[0].PrinciplesText)
			},
		},
		{
			name: "prepends takeaways to primary concept",
			concepts: []ExtractedConcept{
				{ConceptName: "Main", Category: "principle", AuthorReflections: "Existing note"},
			},
			takeaways: []string{"Point 1", "Point 2"},
			docPath:   "docs/intro.md",
			verify: func(t *testing.T, res []ExtractedConcept) {
				t.Helper()
				require.Len(t, res, 1)
				assert.Equal(t, "【核心要点】\n- Point 1\n- Point 2\n\nExisting note", res[0].AuthorReflections)
			},
		},
		{
			name:      "synthesizes primary concept for takeaways when concepts slice is empty",
			concepts:  nil,
			takeaways: []string{"Point A", "Point B"},
			docPath:   "chapter1/part2.md",
			verify: func(t *testing.T, res []ExtractedConcept) {
				t.Helper()
				require.Len(t, res, 1)
				assert.Equal(t, "核心要点", res[0].ConceptName)
				assert.Equal(t, "principle", res[0].Category)
				assert.Equal(t, "chapter1-part2-md-核心要点", res[0].Slug)
				assert.Equal(t, "Point A Point B", res[0].Summary)
				assert.Contains(t, res[0].AuthorReflections, "【核心要点】\n- Point A\n- Point B")
			},
		},
		{
			name:     "both quizzes and takeaways with empty concepts slice",
			concepts: nil,
			quizzes: []CompanionQuiz{
				{Question: "Q1", Options: []string{"A", "B"}, CorrectIndex: 0, Explanation: "Exp1"},
			},
			takeaways: []string{"Takeaway 1"},
			docPath:   "docs/guide.md",
			verify: func(t *testing.T, res []ExtractedConcept) {
				t.Helper()
				require.Len(t, res, 1)
				assert.Equal(t, "随堂自测", res[0].ConceptName)
				assert.Contains(t, res[0].AuthorReflections, "【核心要点】\n- Takeaway 1")
				assert.Contains(t, res[0].AuthorReflections, "【测验 1】Q1")
				assert.True(t, strings.HasPrefix(res[0].AuthorReflections, "【核心要点】\n- Takeaway 1\n\n【测验 1】Q1"))
			},
		},
		{
			name: "caps concepts at MAX_CONCEPTS_PER_DOC = 5",
			concepts: []ExtractedConcept{
				{ConceptName: "C1"}, {ConceptName: "C2"}, {ConceptName: "C3"},
				{ConceptName: "C4"}, {ConceptName: "C5"}, {ConceptName: "C6"},
			},
			docPath: "docs/huge.md",
			verify: func(t *testing.T, res []ExtractedConcept) {
				t.Helper()
				assert.Len(t, res, 5)
				assert.Equal(t, "C5", res[4].ConceptName)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ApplyQuizzesAndTakeaways(tt.concepts, tt.quizzes, tt.takeaways, tt.docPath)
			tt.verify(t, got)
		})
	}
}

func TestResolveConceptChunkAnchorAndEnrich(t *testing.T) {
	h1 := "01_Overview"
	p1 := "docs#01_Overview"
	h2 := "General"
	p2 := "docs#General"
	h3 := "Architecture > Memory Pool"
	p3 := "docs#Architecture > Memory Pool"

	chunks := []docChunkRow{
		{ID: "c1", Heading: &h1, HeadingPath: &p1, Content: "Overview of the memory subsystem."},
		{ID: "c2", Heading: &h2, HeadingPath: &p2, Content: "This is general introduction anchor line."},
		{ID: "c3", Heading: &h3, HeadingPath: &p3, Content: strings.Repeat("Long content chunk. ", 200)},
	}

	tests := []struct {
		name         string
		concept      ExtractedConcept
		expectedCID  string
		expectedPath string
		expectedPrin string
	}{
		{
			name: "exact sourceHeading match",
			concept: ExtractedConcept{
				ConceptName:   "Overview",
				SourceHeading: "01_Overview",
				Summary:       "Subsystem overview",
			},
			expectedCID:  "c1",
			expectedPath: "docs#01_Overview",
			expectedPrin: "Overview of the memory subsystem.",
		},
		{
			name: "conceptName hierarchical suffix match",
			concept: ExtractedConcept{
				ConceptName: "Memory Pool",
				Summary:     "Pool summary",
			},
			expectedCID:  "c3",
			expectedPath: "docs#Architecture > Memory Pool",
			expectedPrin: string([]rune(chunks[2].Content)[:2000]),
		},
		{
			name: "anchorText match in General chunk",
			concept: ExtractedConcept{
				ConceptName: "Intro",
				AnchorText:  "general introduction anchor line",
				Summary:     "Intro summary",
			},
			expectedCID:  "c2",
			expectedPath: "docs#General",
			expectedPrin: "This is general introduction anchor line.",
		},
		{
			name: "conceptName substring in chunk content",
			concept: ExtractedConcept{
				ConceptName: "subsystem",
				Summary:     "Summary",
			},
			expectedCID:  "c1",
			expectedPath: "docs#01_Overview",
			expectedPrin: "Overview of the memory subsystem.",
		},
		{
			name: "unmatched concept retains summary",
			concept: ExtractedConcept{
				ConceptName: "Quantum Computing",
				Summary:     "Unmatched summary",
			},
			expectedCID:  "",
			expectedPath: "",
			expectedPrin: "Unmatched summary",
		},
		{
			name: "existing principlesText distinct from summary is preserved",
			concept: ExtractedConcept{
				ConceptName:    "Overview",
				SourceHeading:  "01_Overview",
				Summary:        "Summary",
				PrinciplesText: "Custom Principles",
			},
			expectedCID:  "c1",
			expectedPath: "docs#01_Overview",
			expectedPrin: "Custom Principles",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cid, path, matched := ResolveConceptChunkAnchor(tt.concept, chunks)
			if tt.expectedCID == "" {
				assert.Nil(t, cid)
			} else {
				require.NotNil(t, cid)
				assert.Equal(t, tt.expectedCID, *cid)
				if tt.expectedPath != "" {
					require.NotNil(t, path)
					assert.Equal(t, tt.expectedPath, *path)
				}
			}
			enriched := EnrichPrinciplesText(tt.concept, cid, matched)
			assert.Equal(t, tt.expectedPrin, enriched)
		})
	}
}

type mockFinalizeStore struct {
	contentLayers map[string]string
	attached      []string
	stamped       bool
	models        []string

	replaceChunksCalled bool
	replaceChunksErr    error

	metadataCalled bool
	metadataErr    error
	savedDocID     string
	savedSummary   string
}

func (m *mockFinalizeStore) UpsertContentLayer(_ context.Context, hash, _, _, _, _ string) (string, error) {
	if m.contentLayers == nil {
		m.contentLayers = make(map[string]string)
	}
	id := "cid-" + hash[:8]
	m.contentLayers[hash] = id
	return id, nil
}

func (m *mockFinalizeStore) AttachContentChunks(_ context.Context, contentId, _ string) error {
	m.attached = append(m.attached, contentId)
	return nil
}

func (m *mockFinalizeStore) DeleteLegacyChunks(_ context.Context, _ string) error {
	return nil
}

func (m *mockFinalizeStore) StampProcessed(_ context.Context, _, _ string, _ *string, _ *string, _, _ string, _ bool) (bool, error) {
	m.stamped = true
	return true, nil
}

func (m *mockFinalizeStore) RecordTranscriptionModel(_ context.Context, _, model string) error {
	m.models = append(m.models, model)
	return nil
}

func (m *mockFinalizeStore) RecordTranscriptionTokens(_ context.Context, _ string, _ int) error {
	return nil
}

func (m *mockFinalizeStore) ReplaceDocumentChunks(_ context.Context, _ string, chunks []chunker.MarkdownChunk, _ ReplaceChunksOpts) (int, error) {
	m.replaceChunksCalled = true
	if m.replaceChunksErr != nil {
		return 0, m.replaceChunksErr
	}
	return len(chunks), nil
}

func (m *mockFinalizeStore) UpdateDocumentSummary(_ context.Context, _, _ string) error {
	return nil
}

func (m *mockFinalizeStore) SaveDocumentConcepts(_ context.Context, _, _, _, _ string, _ ExtractedManifestResult) ([]SavedConceptNode, error) {
	return []SavedConceptNode{}, nil
}

func (m *mockFinalizeStore) SyncDocumentCooccurrenceEdges(_ context.Context, _, _ string) error {
	return nil
}

func (m *mockFinalizeStore) SyncDocumentCurriculumEdge(_ context.Context, _, _ string) error {
	return nil
}

func (m *mockFinalizeStore) SaveDocumentQuizzes(_ context.Context, _, _ string, _ []CompanionQuiz) error {
	return nil
}

func (m *mockFinalizeStore) StoreDocumentMetadata(_ context.Context, _, docId, _, _ string, _ ExtractedManifestResult, summary string) error {
	m.metadataCalled = true
	m.savedDocID = docId
	m.savedSummary = summary
	return m.metadataErr
}

type mockWebAPI struct {
	err error
}

func (w *mockWebAPI) Prepare(_ context.Context, _ string, _ string) (*PrepareResult, error) {
	return nil, nil
}
func (w *mockWebAPI) ValidateMdx(_ context.Context, _ string) (bool, string, error) {
	return true, "", nil
}
func (w *mockWebAPI) ExtractManifest(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (w *mockWebAPI) Transform(_ context.Context, _, _, _ string, _ *string, _, _ string) (string, error) {
	return "", nil
}

type mockMetadataOnlyStore struct {
	contentLayers  map[string]string
	stamped        bool
	metadataCalled bool
}

func (m *mockMetadataOnlyStore) UpsertContentLayer(_ context.Context, hash, _, _, _, _ string) (string, error) {
	if m.contentLayers == nil {
		m.contentLayers = make(map[string]string)
	}
	id := "cid-" + hash[:8]
	m.contentLayers[hash] = id
	return id, nil
}
func (m *mockMetadataOnlyStore) AttachContentChunks(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockMetadataOnlyStore) DeleteLegacyChunks(_ context.Context, _ string) error {
	return nil
}
func (m *mockMetadataOnlyStore) StampProcessed(_ context.Context, _, _ string, _ *string, _ *string, _, _ string, _ bool) (bool, error) {
	m.stamped = true
	return true, nil
}
func (m *mockMetadataOnlyStore) RecordTranscriptionModel(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockMetadataOnlyStore) RecordTranscriptionTokens(_ context.Context, _ string, _ int) error {
	return nil
}
func (m *mockMetadataOnlyStore) UpdateDocumentSummary(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockMetadataOnlyStore) SaveDocumentConcepts(_ context.Context, _, _, _, _ string, _ ExtractedManifestResult) ([]SavedConceptNode, error) {
	return []SavedConceptNode{}, nil
}
func (m *mockMetadataOnlyStore) SyncDocumentCooccurrenceEdges(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockMetadataOnlyStore) SyncDocumentCurriculumEdge(_ context.Context, _, _ string) error {
	return nil
}
func (m *mockMetadataOnlyStore) SaveDocumentQuizzes(_ context.Context, _, _ string, _ []CompanionQuiz) error {
	return nil
}

func (m *mockMetadataOnlyStore) StoreDocumentMetadata(_ context.Context, _, _, _, _ string, _ ExtractedManifestResult, _ string) error {
	m.metadataCalled = true
	return nil
}

func TestFinalizeTranscriptionFailClosed(t *testing.T) {
	newPrep := func() *PrepareResult {
		p := &PrepareResult{}
		p.Doc.ID = "doc-123"
		p.Doc.Path = "docs/intro.md"
		p.Doc.RepositoryID = "repo-456"
		p.Chunker.MaxTokens = 1000
		p.Chunker.Overlap = 100
		p.Chunker.ParentTitle = "Parent"
		return p
	}

	tests := []struct {
		name           string
		prep           *PrepareResult
		content        string
		store          TranscriptionFinalizeStore
		storeSetup     func(s *mockFinalizeStore)
		expectStamped  bool
		expectMetadata bool
		expectErr      bool
	}{
		{
			name:           "直写成功：盖章与元数据全走 Go，零 web 兜底",
			prep:           newPrep(),
			content:        "# Introduction\n\nThis is content for testing.\n\n---\nsummary: Intro doc\n---\n",
			expectStamped:  true,
			expectMetadata: true,
		},
		{
			name:    "StoreDocumentMetadata 失败：显式报错（Fail-Closed，不退 Node）",
			prep:    newPrep(),
			content: "# Introduction\n\nThis is content for testing.",
			storeSetup: func(s *mockFinalizeStore) {
				s.metadataErr = errors.New("db error in metadata")
			},
			expectErr: true,
		},
		{
			name:    "ReplaceDocumentChunks 失败：显式报错（Fail-Closed）",
			prep:    newPrep(),
			content: "# Introduction\n\nThis is content for testing.",
			storeSetup: func(s *mockFinalizeStore) {
				s.replaceChunksErr = errors.New("db error in chunks")
			},
			expectErr: true,
		},
		{
			name:      "store 缺直写能力：显式报错（配置错误）",
			prep:      newPrep(),
			content:   "# Title\n\nContent for test",
			store:     &mockMetadataOnlyStore{},
			expectErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := tt.store
			var finalizeMock *mockFinalizeStore
			if store == nil {
				finalizeMock = &mockFinalizeStore{}
				if tt.storeSetup != nil {
					tt.storeSetup(finalizeMock)
				}
				store = finalizeMock
			}

			err := finalizeTranscription(context.Background(), Config{DefaultBranch: "main"}, store, tt.prep, tt.content, "user-1", "test-model")
			if tt.expectErr {
				assert.Error(t, err)
				return
			}
			assert.NoError(t, err)
			if finalizeMock != nil {
				assert.True(t, finalizeMock.stamped)
				assert.True(t, finalizeMock.metadataCalled, "StoreDocumentMetadata should have been called")
				assert.Equal(t, tt.prep.Doc.ID, finalizeMock.savedDocID)
			}
		})
	}
}

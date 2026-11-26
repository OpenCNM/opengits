package doc

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

type SavedConceptNode struct {
	ID   string
	Name string
}

type fakeDocStore struct {
	repoId                 string
	docPath                string
	branch                 string
	getDocErr              error
	replaceChunksErr       error
	replaceChunksCalled    bool
	storedChunks           []chunker.MarkdownChunk
	storedChunksOpts       ReplaceChunksOpts
	storeMetadataErr       error
	storeMetadataCalled    bool
	storeMetadataSummary   string
	storeMetadataCleanText string
	upsertContentId        string
	upsertContentErr       error
	attachErr              error
	deleteLegacyErr        error
	deleteLegacyCalled     bool
	stampErr               error
	recordModelErr         error
	recordTokensErr        error
	recordedModel          string
	recordedTokens         int
	stampedDocId           string
	stampedContent         string
	stampedContentId       *string
	stampedGitSha          *string
	stampedModel           string
	stampedDualWrite       bool

	prepareDoc         *PrepareDoc
	prepareDocErr      error
	activeUserModelId  string
	reusableContentId  string
	reusableContent    string
	reusableDonorDocId string
	reusableDonorLevel string
	countContentChunks int

	llmsRepoInfo *LlmsTxtRepoInfo
	llmsDocs     []LlmsTxtDoc
	llmsErr      error
}

func (f *fakeDocStore) ReplaceDocumentChunks(_ context.Context, _ string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error) {
	f.replaceChunksCalled = true
	f.storedChunks = chunks
	f.storedChunksOpts = opts
	if f.replaceChunksErr != nil {
		return 0, f.replaceChunksErr
	}
	return len(chunks), nil
}

func (f *fakeDocStore) UpdateDocumentSummary(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeDocStore) SaveDocumentConcepts(_ context.Context, _, _, _, _ string, _ ExtractedManifestResult) ([]SavedConceptNode, error) {
	return []SavedConceptNode{}, nil
}

func (f *fakeDocStore) SyncDocumentCooccurrenceEdges(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeDocStore) SyncDocumentCurriculumEdge(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeDocStore) StoreDocumentMetadata(_ context.Context, _, _, _, content string, _ ExtractedManifestResult, summary string) error {
	f.storeMetadataCalled = true
	f.storeMetadataSummary = summary
	f.storeMetadataCleanText = content
	return f.storeMetadataErr
}

func (f *fakeDocStore) GetDocumentRepositoryInfo(_ context.Context, _ string) (repoId, docPath, branch string, err error) {
	return f.repoId, f.docPath, f.branch, f.getDocErr
}

func (f *fakeDocStore) UpsertContentLayer(_ context.Context, _, _, _, _, _ string) (string, error) {
	if f.upsertContentErr != nil {
		return "", f.upsertContentErr
	}
	if f.upsertContentId != "" {
		return f.upsertContentId, nil
	}
	return "content-layer-uuid-1", nil
}

func (f *fakeDocStore) AttachContentChunks(_ context.Context, _, _ string) error {
	return f.attachErr
}

func (f *fakeDocStore) DeleteLegacyChunks(_ context.Context, _ string) error {
	f.deleteLegacyCalled = true
	return f.deleteLegacyErr
}

func (f *fakeDocStore) StampProcessed(_ context.Context, docId, content string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error) {
	f.stampedDocId = docId
	f.stampedContent = content
	f.stampedContentId = contentId
	f.stampedGitSha = gitSha
	f.stampedModel = model
	f.stampedDualWrite = dualWrite
	if f.stampErr != nil {
		return false, f.stampErr
	}
	return true, nil
}

func (f *fakeDocStore) RecordTranscriptionModel(_ context.Context, _, model string) error {
	f.recordedModel = model
	return f.recordModelErr
}

func (f *fakeDocStore) RecordTranscriptionTokens(_ context.Context, _ string, tokens int) error {
	f.recordedTokens += tokens
	return f.recordTokensErr
}

func (f *fakeDocStore) LoadDocumentForPrepare(_ context.Context, _ string) (*PrepareDoc, error) {
	return f.prepareDoc, f.prepareDocErr
}

func (f *fakeDocStore) LoadActiveUserModelId(_ context.Context, _ string) (string, error) {
	return f.activeUserModelId, nil
}

func (f *fakeDocStore) FindReusableContentByFingerprint(_ context.Context, _ string) (string, string, string, string, error) {
	return f.reusableContentId, f.reusableContent, f.reusableDonorDocId, f.reusableDonorLevel, nil
}

func (f *fakeDocStore) CountContentChunks(_ context.Context, _ string) (int, error) {
	return f.countContentChunks, nil
}

func (f *fakeDocStore) GetLlmsTxtData(_ context.Context, _ string, _ *string) (*LlmsTxtRepoInfo, []LlmsTxtDoc, error) {
	return f.llmsRepoInfo, f.llmsDocs, f.llmsErr
}

func TestHandleDocStoreChunks(t *testing.T) {
	tests := []struct {
		name           string
		store          Store
		body           map[string]any
		expectedStatus int
		verify         func(t *testing.T, w *httptest.ResponseRecorder, store *fakeDocStore)
	}{
		{
			name:  "missing docId returns 400",
			store: &fakeDocStore{},
			body: map[string]any{
				"docId":   "",
				"content": "Hello",
			},
			expectedStatus: http.StatusBadRequest,
			verify: func(t *testing.T, w *httptest.ResponseRecorder, _ *fakeDocStore) {
				t.Helper()
				assert.Contains(t, w.Body.String(), "docId is required")
			},
		},
		{
			name:  "nil docStore returns 503",
			store: nil,
			body: map[string]any{
				"docId":   "doc-1",
				"content": "Hello",
			},
			expectedStatus: http.StatusServiceUnavailable,
			verify: func(t *testing.T, w *httptest.ResponseRecorder, _ *fakeDocStore) {
				t.Helper()
				assert.Contains(t, w.Body.String(), "not configured")
			},
		},
		{
			name: "successful store with chunks and manifest",
			store: &fakeDocStore{
				repoId:  "repo-1",
				docPath: "docs/readme.md",
				branch:  "main",
			},
			body: map[string]any{
				"docId":   "doc-1",
				"content": "---\nsummary: Readme summary\n---\n# Hello\n\nContent here.\n",
			},
			expectedStatus: http.StatusOK,
			verify: func(t *testing.T, w *httptest.ResponseRecorder, s *fakeDocStore) {
				t.Helper()
				assert.True(t, s.replaceChunksCalled)
				assert.True(t, s.storeMetadataCalled)
				assert.Equal(t, "Readme summary", s.storeMetadataSummary)
				var resp DocStoreChunksResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.OK)
			},
		},
		{
			name: "virtual code chapter auto-chunks in-process with ContentType preserved",
			store: &fakeDocStore{
				repoId:  "repo-code-1",
				docPath: "chapters/01-core.mdx",
				branch:  "main",
			},
			body: map[string]any{
				"docId":       "doc-code-1",
				"moduleName":  "Core",
				"sourceFiles": []string{"src/index.ts"},
				"content":     "## 1. 架构设计\n```mermaid\ngraph TD\nA-->B\n```\n## 2. 入口实现 <!-- path: src/index.ts -->\n```typescript\nexport const run = () => {};\n```",
			},
			expectedStatus: http.StatusOK,
			verify: func(t *testing.T, w *httptest.ResponseRecorder, s *fakeDocStore) {
				t.Helper()
				assert.True(t, s.replaceChunksCalled)
				require.NotEmpty(t, s.storedChunks)
				assert.Equal(t, "architecture_diagram", s.storedChunks[0].ContentType)
				assert.Equal(t, "entry_point", s.storedChunks[1].ContentType)
				var resp DocStoreChunksResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.OK)
			},
		},
		{
			name: "virtual code chapter infers moduleName and sourceFiles from options blueprint",
			store: &fakeDocStore{
				repoId:  "repo-code-bp",
				docPath: "chapters/02-router.mdx",
				branch:  "main",
			},
			body: map[string]any{
				"docId":   "doc-code-bp",
				"content": "## 1. 核心路由 <!-- path: src/router.ts -->\n```typescript\nexport const router = {};\n```",
				"options": map[string]any{
					"blueprint": map[string]any{
						"moduleName":  "Router Module",
						"sourceFiles": []string{"src/router.ts"},
					},
				},
			},
			expectedStatus: http.StatusOK,
			verify: func(t *testing.T, w *httptest.ResponseRecorder, s *fakeDocStore) {
				t.Helper()
				assert.True(t, s.replaceChunksCalled)
				require.NotEmpty(t, s.storedChunks)
				assert.Equal(t, "function_impl", s.storedChunks[0].ContentType)
				assert.Contains(t, s.storedChunks[0].Heading, "核心路由")
				var resp DocStoreChunksResponse
				err := json.Unmarshal(w.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.True(t, resp.OK)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			patterns := &IngestPatterns{
				VirtualChapterPathPrefixes: []string{"chapters/"},
			}
			h := NewHandler(Config{DefaultBranch: "main"}, tt.store, func() Patterns {
				return patterns
			})

			payload, err := json.Marshal(tt.body)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/v1/doc/store-chunks", bytes.NewReader(payload))
			w := httptest.NewRecorder()

			h.HandleStoreChunks(w, req)

			assert.Equal(t, tt.expectedStatus, w.Code)
			var fakeStore *fakeDocStore
			if tt.store != nil {
				fakeStore = tt.store.(*fakeDocStore)
			}
			tt.verify(t, w, fakeStore)
		})
	}
}

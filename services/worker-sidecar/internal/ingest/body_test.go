package ingest

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

func loadConfigFromEnv() Config {
	return LoadConfigFromEnv()
}

type fakeIngestStore struct {
	repoId              string
	docsDone            bool
	snapDone            bool
	outlineId           string
	createdDocs         int
	failAt              string
	lastRepoParams      *UpsertRepositoryRowParams
	lastDocArgs         []UpsertOwnedDocumentArgs
	lastChapters        []ChapterInput
	lastDraft           *OutlineDraft
	webRepo             *WebSyncRepoInfo
	touchCalled         bool
	lastTouchEtag       string
	lastTouchModMap     map[string]string
	lastWebSyncTxParams *WebSyncTxParams
	lastDeletedPaths    []string
	replacedChunksCount int
	storedMetadataCount int
	repoDeleted         int
	peekResult          *PeekRepoResult
	peekErr             error
	peekCount           int
	restoreShaCount     int
	lastRestoredRepoId  string
	lastRestoredSha     *string
	lastExpectSha       *string

	mu sync.Mutex
}

func (f *fakeIngestStore) PeekRepositoryForCommit(_ context.Context, _, _, _, _ string) (*PeekRepoResult, error) {
	f.peekCount++
	if f.peekErr != nil {
		return nil, f.peekErr
	}
	return f.peekResult, nil
}

func (f *fakeIngestStore) RestoreRepositoryGitSha(_ context.Context, repoId string, restoreSha, expectSha *string) (int64, error) {
	f.restoreShaCount++
	f.lastRestoredRepoId = repoId
	f.lastRestoredSha = restoreSha
	f.lastExpectSha = expectSha
	return 1, nil
}

func (f *fakeIngestStore) UpsertRepositoryRow(_ context.Context, p UpsertRepositoryRowParams) (string, error) {
	if f.failAt == "repo" {
		return "", errBoom
	}
	f.repoId = "rid-1"
	f.lastRepoParams = &p
	return f.repoId, nil
}
func (f *fakeIngestStore) UpsertOwnedDocument(_ context.Context, args UpsertOwnedDocumentArgs) (string, error) {
	f.createdDocs++
	f.lastDocArgs = append(f.lastDocArgs, args)
	return "doc", nil
}
func (f *fakeIngestStore) CreateDocsForChapters(_ context.Context, _ string, _ *string, _, _, _ string, _ *string, chapters []ChapterInput, _ string, _ *IngestPatterns) (int, []CodeAssetDoc, error) {
	if f.failAt == "docs" {
		return 0, nil, errBoom
	}
	f.docsDone = true
	f.lastChapters = chapters
	if f.createdDocs > 0 {
		return f.createdDocs, nil, nil
	}
	return 3, nil, nil
}
func (f *fakeIngestStore) RegisterImportSnapshot(context.Context, RegisterSnapshotParams) (bool, error) {
	if f.failAt == "snap" {
		return false, errBoom
	}
	f.snapDone = true
	return false, nil
}

func (f *fakeIngestStore) DeleteRepositoryRow(_ context.Context, _, _, _, _ string) (int64, error) {
	f.repoDeleted++
	return 1, nil
}
func (f *fakeIngestStore) ResetDocumentsUnprocessed(context.Context, string, *string, []string) (int64, error) {
	return 0, nil
}
func (f *fakeIngestStore) StoreOutlineDraft(_ context.Context, _ string, d OutlineDraft, _ bool) (string, error) {
	f.outlineId = "oid-1"
	f.lastDraft = &d
	return f.outlineId, nil
}
func (f *fakeIngestStore) ActivateOutline(context.Context, string, string) error {
	return nil
}
func (f *fakeIngestStore) DeactivateAllOutlines(context.Context, string) error {
	return nil
}
func (f *fakeIngestStore) GetRepositoryForWebSync(_ context.Context, owner, repo string) (*WebSyncRepoInfo, error) {
	if f.failAt == "get_web_repo" {
		return nil, errBoom
	}
	if f.webRepo != nil {
		return f.webRepo, nil
	}
	return nil, nil
}
func (f *fakeIngestStore) TouchWebSyncNoChanges(_ context.Context, repoID, etag string, lastModMap map[string]string) error {
	if f.failAt == "touch_web_sync" {
		return errBoom
	}
	f.touchCalled = true
	f.lastTouchEtag = etag
	f.lastTouchModMap = lastModMap
	return nil
}
func (f *fakeIngestStore) ExecuteWebSyncTx(_ context.Context, p WebSyncTxParams) ([]WebSyncSavedDoc, error) {
	f.lastWebSyncTxParams = &p
	if f.failAt == "exec_web_sync" {
		return nil, errBoom
	}
	var saved []WebSyncSavedDoc
	for i, d := range p.UpdatedDocs {
		saved = append(saved, WebSyncSavedDoc{
			ID:      fmt.Sprintf("saved-doc-%d", i+1),
			Path:    d.Path,
			Content: d.Markdown,
		})
	}
	return saved, nil
}
func (f *fakeIngestStore) DeleteOwnedDocumentsByPaths(_ context.Context, repoID string, docOwnerID *string, paths []string) error {
	if f.failAt == "delete_web_docs" {
		return errBoom
	}
	f.lastDeletedPaths = paths
	return nil
}
func (f *fakeIngestStore) ReplaceDocumentChunks(_ context.Context, documentId string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error) {
	if f.failAt == "replace_chunks" {
		return 0, errBoom
	}
	f.mu.Lock()
	f.replacedChunksCount += len(chunks)
	f.mu.Unlock()
	return len(chunks), nil
}
func (f *fakeIngestStore) StoreDocumentMetadata(_ context.Context, _, _, _, _ string, _ ExtractedManifestResult, _ string) error {
	f.mu.Lock()
	f.storedMetadataCount++
	f.mu.Unlock()
	return nil
}
func (f *fakeIngestStore) UpdateImportJobProgress(_ context.Context, _ string, _ string, _ int) error {
	return nil
}
func (f *fakeIngestStore) BatchEnqueueTranscription(_ context.Context, _ string, _ string, _ any) (int64, error) {
	return 0, nil
}

var errBoom = &boomErr{}

type boomErr struct{}

func (*boomErr) Error() string { return "boom" }

type fakeJobAPI struct {
	settled           bool
	result            ImportSettleResult
	failSettle        bool
	revalidatedRepoId string
}

func (f *fakeJobAPI) Settle(_ context.Context, _ string, result ImportSettleResult) error {
	if f.failSettle {
		return errBoom
	}
	f.settled = true
	f.result = result
	return nil
}

func (f *fakeJobAPI) ExecuteImportJob(_ context.Context, _ string) error {
	return nil
}

func (f *fakeJobAPI) RevalidateRepository(_ context.Context, repoId string) error {
	f.revalidatedRepoId = repoId
	return nil
}

func makeBodyDeps(t *testing.T, store IngestStore, jobAPI *fakeJobAPI) (IngestBodyDeps, string) {
	t.Helper()
	patterns := DefaultPatterns()
	root := t.TempDir()
	sha := "abc1234"
	dir := filepath.Join(root, "o", "r", sha)
	for _, f := range []string{"docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "docs/e.md", "README.md"} {
		p := filepath.Join(dir, filepath.FromSlash(f))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte("x"), 0o644))
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	return IngestBodyDeps{
		Store:       store,
		Archive:     NewArchiveClient(ts.URL, "tok"),
		Web:         jobAPI,
		SettleJob:   jobAPI.Settle,
		ArchiveRoot: root,
		Patterns:    patterns,
	}, sha
}

func jobParams(kind, prefix string, customOutline bool) []byte {
	p := map[string]any{
		"kind": kind, "userId": "u1", "branch": "main", "edition": "",
		"preExistingRepo": nil,
		"options":         map[string]any{"isPublic": true, "category": "test", "gitSha": "abc1234"},
	}
	if prefix != "" {
		p["options"].(map[string]any)["prefix"] = prefix
	}
	if customOutline {
		p["options"].(map[string]any)["customOutline"] = map[string]any{"cats": []any{}}
	}
	b, _ := json.Marshal(p)
	return b
}

func TestIngestBodyHappyPath(t *testing.T) {
	store := &fakeIngestStore{}
	jobAPI := &fakeJobAPI{}
	deps, _ := makeBodyDeps(t, store, jobAPI)
	job := JobRow{Id: "j1", Owner: "o", Repo: "r", Branch: "main", Params: jobParams("", "", false)}
	uid := "u1"
	job.UserId = &uid

	out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
	assert.Equal(t, ingestDone, out, "docs repo text_only happy path must complete in Go")
	assert.True(t, store.docsDone, "docs persistence must be done")
	assert.True(t, store.snapDone, "snapshot registration must be done")
	assert.NotEmpty(t, store.outlineId, "outline draft must be stored")
	assert.True(t, jobAPI.settled, "settlement endpoint must be called")
	assert.Equal(t, "rid-1", jobAPI.result.RepositoryId)
	assert.Equal(t, 3, jobAPI.result.QueuedDocumentsCount)
}

func TestIngestBodyFallbackBranches(t *testing.T) {
	t.Run("1.17.1.1 web-doc kind falls back (no firecrawl)", func(t *testing.T) {
		deps, _ := makeBodyDeps(t, &fakeIngestStore{}, &fakeJobAPI{})
		job := JobRow{Owner: "o", Repo: "r", Params: jobParams("web-doc", "", false)}
		out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
		assert.Equal(t, ingestFallback, out)
	})

	t.Run("1.17.1.1 prefix scope completes in Go", func(t *testing.T) {
		store := &fakeIngestStore{}
		jobAPI := &fakeJobAPI{}
		deps, _ := makeBodyDeps(t, store, jobAPI)
		job := JobRow{Id: "j1", Owner: "o", Repo: "r", Branch: "main", Params: jobParams("", "docs/", false)}
		out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
		assert.Equal(t, ingestDone, out, "prefix-scoped ingest must complete in Go")
		assert.True(t, jobAPI.settled)
	})

	t.Run("1.17.1.1 custom outline completes in Go", func(t *testing.T) {
		jobAPI := &fakeJobAPI{}
		deps, _ := makeBodyDeps(t, &fakeIngestStore{}, jobAPI)
		p := map[string]any{
			"kind": "", "userId": "u1", "branch": "main", "edition": "",
			"preExistingRepo": nil,
			"options": map[string]any{
				"isPublic": true, "category": "test", "gitSha": "abc1234",
				"customOutline": map[string]any{"cats": []any{
					map[string]any{"name": "Part One", "files": []any{"docs/a.md", "docs/b.md"}},
					map[string]any{"name": "Part Two", "files": []any{"docs/c.md"}},
				}},
			},
		}
		b, _ := json.Marshal(p)
		job := JobRow{Id: "j1", Owner: "o", Repo: "r", Branch: "main", Params: b}
		out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
		assert.Equal(t, ingestDone, out, "text_only + customOutline must complete in Go")
		assert.True(t, jobAPI.settled)
		assert.Equal(t, 3, jobAPI.result.QueuedDocumentsCount, "custom outline files must be queued in full")
	})
}

func TestIngestBodyFallsBackOnPersistenceFailure(t *testing.T) {
	tests := []struct {
		name   string
		failAt string
	}{
		{name: "1.17.1.2 repository upsert failure", failAt: "repo"},
		{name: "1.17.1.2 chapter docs creation failure", failAt: "docs"},
		{name: "1.17.1.2 snapshot registration failure", failAt: "snap"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeIngestStore{failAt: tt.failAt}
			jobAPI := &fakeJobAPI{}
			deps, _ := makeBodyDeps(t, store, jobAPI)
			job := JobRow{Id: "j1", Owner: "o", Repo: "r", Branch: "main", Params: jobParams("", "", false)}
			out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
			assert.Equal(t, ingestFallback, out)
			assert.False(t, jobAPI.settled)
		})
	}

	t.Run("1.17.1.3 settle failure falls back to node engine", func(t *testing.T) {
		deps, _ := makeBodyDeps(t, &fakeIngestStore{}, &fakeJobAPI{failSettle: true})
		job := JobRow{Id: "j1", Owner: "o", Repo: "r", Branch: "main", Params: jobParams("", "", false)}
		out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
		assert.Equal(t, ingestFallback, out)
	})
}

func TestIngestBodyGeneratesRSGForCodeRepo(t *testing.T) {
	patterns := DefaultPatterns()
	defs, err := LoadLanguageDefinitions("")
	require.NoError(t, err)

	root := t.TempDir()
	graphDir := t.TempDir()
	sha := "abc1234"
	dir := filepath.Join(root, "o", "r", sha)

	files := map[string]string{
		"src/index.ts": "import { util } from './util';\nexport function main() {}",
		"src/util.ts":  "export const util = 1;",
	}
	for f, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(f))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte(content), 0o644))
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	store := &fakeIngestStore{}
	jobAPI := &fakeJobAPI{}
	deps := IngestBodyDeps{
		Store:       store,
		Archive:     NewArchiveClient(ts.URL, "tok"),
		Web:         jobAPI,
		SettleJob:   jobAPI.Settle,
		ArchiveRoot: root,
		Patterns:    patterns,
		Languages:   defs,
		GraphDir:    graphDir,
	}

	job := JobRow{
		Id:     "j1",
		Owner:  "o",
		Repo:   "r",
		Branch: "main",
		Params: jobParams("", "", false),
	}

	out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
	assert.Equal(t, ingestDone, out, "code_only repo must complete in Go")

	artifact, err := LoadSemanticGraphArtifact(graphDir, "o", "r", sha)
	require.NoError(t, err)
	assert.Equal(t, 2, artifact.Version)
	assert.Len(t, artifact.Nodes, 2)
	require.Len(t, artifact.EntryPoints, 1)
	assert.Equal(t, "src/index.ts", artifact.EntryPoints[0])
}

func TestRunIngestBody_CodeOnlyAndHybrid_Succeeds(t *testing.T) {
	patterns := DefaultPatterns()
	defs, err := LoadLanguageDefinitions("")
	require.NoError(t, err)

	tests := []struct {
		name             string
		files            map[string]string
		paramsJSON       func(sha string) []byte
		expectIngestMode string
		expectedChapters int
		expectedAppendix int
		verify           func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI, sha string, graphDir string)
	}{
		{
			name: "1.17.5.1 code_only repository happy path with RSG and cognitive gradient",
			files: map[string]string{
				"src/index.ts": "import { util } from './util';\nexport function main() { return util; }",
				"src/util.ts":  "export const util = 1;",
			},
			paramsJSON: func(sha string) []byte {
				p := map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"preExistingRepo": nil,
					"options": map[string]any{
						"isPublic": true,
						"category": "backend",
						"gitSha":   sha,
						"tags":     []string{"typescript", "clean"},
					},
				}
				b, _ := json.Marshal(p)
				return b
			},
			expectIngestMode: "code_only",
			expectedChapters: 2,
			expectedAppendix: 0,
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI, sha string, graphDir string) {
				t.Helper()
				assert.True(t, store.docsDone, "chapter docs persistence must be done")
				assert.True(t, store.snapDone, "snapshot registration must be done")
				assert.NotEmpty(t, store.outlineId, "outline draft must be stored")
				assert.True(t, jobAPI.settled, "settle executor must be called")
				assert.Equal(t, "rid-1", jobAPI.result.RepositoryId)
				assert.Equal(t, 2, len(store.lastChapters))
				assert.Equal(t, "第 1 章：类型契约与状态定义", store.lastChapters[0].Title)
				assert.Equal(t, "chapters/01.mdx", store.lastChapters[0].Files[0].Path)
				assert.Equal(t, "第 2 章：核心分发器与业务实现", store.lastChapters[1].Title)
				assert.Equal(t, "chapters/02.mdx", store.lastChapters[1].Files[0].Path)

				require.NotNil(t, store.lastRepoParams)
				var profileMap map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.ProfileJSON, &profileMap))
				assert.Equal(t, "code_only", profileMap["ingestMode"])
				clustersRaw, ok := profileMap["codeClusters"].([]any)
				require.True(t, ok, "codeClusters must be present in profile")
				require.Len(t, clustersRaw, 2)
				cluster := clustersRaw[0].(map[string]any)
				assert.Equal(t, float64(1), cluster["teachingOrder"])
				assert.Equal(t, float64(1), cluster["chapterNo"])
				cognitive, ok := cluster["cognitive"].(map[string]any)
				require.True(t, ok, "cognitive metadata must be attached")
				assert.NotEmpty(t, cognitive["phase"])
				assert.NotEmpty(t, cognitive["rationale"])

				artifact, err := LoadSemanticGraphArtifact(graphDir, "o", "r", sha)
				require.NoError(t, err)
				assert.Equal(t, 2, artifact.Version)
				assert.Len(t, artifact.Nodes, 2)
			},
		},
		{
			name: "1.17.5.1b code_only repository with >3 files falls back to directory clustering",
			files: map[string]string{
				"src/index.ts": "import { util } from './util';\nexport function main() { return util; }",
				"src/util.ts":  "export const util = 1;",
				"src/a.ts":     "export const a = 2;",
				"src/b.ts":     "export const b = 3;",
			},
			paramsJSON: func(sha string) []byte {
				p := map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"preExistingRepo": nil,
					"options": map[string]any{
						"isPublic": true,
						"category": "backend",
						"gitSha":   sha,
						"tags":     []string{"typescript"},
					},
				}
				b, _ := json.Marshal(p)
				return b
			},
			expectIngestMode: "code_only",
			expectedChapters: 1,
			expectedAppendix: 0,
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI, sha string, graphDir string) {
				t.Helper()
				assert.True(t, store.docsDone, "chapter docs persistence must be done")
				assert.True(t, store.snapDone, "snapshot registration must be done")
				assert.Equal(t, 1, len(store.lastChapters))
				assert.Equal(t, "src", store.lastChapters[0].Title)
			},
		},
		{
			name: "1.17.5.1 hybrid repository with draftOutline modules and appendix docs",
			files: map[string]string{
				"src/index.ts":  "export const app = 1;",
				"src/router.ts": "export const router = 2;",
				"docs/guide.md": "# User Guide\nWelcome to the guide.",
				"docs/api.md":   "# API Reference\nEndpoint docs.",
				"README.md":     "# Readme\nRepository overview.",
			},
			paramsJSON: func(sha string) []byte {
				p := map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"preExistingRepo": nil,
					"options": map[string]any{
						"isPublic": true,
						"category": "framework",
						"gitSha":   sha,
						"draftOutline": map[string]any{
							"modules": []map[string]any{
								{
									"name":        "Core Engine",
									"summary":     "Core engine implementation",
									"directories": []string{"src/"},
								},
							},
						},
					},
				}
				b, _ := json.Marshal(p)
				return b
			},
			expectIngestMode: "hybrid",
			expectedChapters: 1,
			expectedAppendix: 3,
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI, sha string, graphDir string) {
				t.Helper()
				assert.True(t, store.docsDone, "chapter docs persistence must be done")
				assert.True(t, store.snapDone, "snapshot registration must be done")
				assert.True(t, jobAPI.settled, "settle executor must be called")
				assert.Equal(t, 1, len(store.lastChapters))
				assert.Equal(t, "Core Engine", store.lastChapters[0].Title)

				require.GreaterOrEqual(t, len(store.lastDocArgs), 3)
				docPaths := make(map[string]string)
				for _, docArg := range store.lastDocArgs {
					assert.Equal(t, "PROCESSED", docArg.Status)
					docPaths[docArg.Path] = docArg.Content
				}
				assert.Contains(t, docPaths, "docs/guide.md")
				assert.Contains(t, docPaths["docs/guide.md"], "Welcome to the guide.")
				assert.Contains(t, docPaths, "docs/api.md")
				assert.Contains(t, docPaths["docs/api.md"], "Endpoint docs.")
				assert.Contains(t, docPaths, "README.md")
				assert.Contains(t, docPaths["README.md"], "Repository overview.")

				require.NotNil(t, store.lastRepoParams)
				var navTree []map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.NavTreeJSON, &navTree))
				require.Len(t, navTree, 4)
				assert.Equal(t, "chapter-1", navTree[0]["name"])
				assert.Equal(t, "Core Engine", navTree[0]["title"])
				assert.Equal(t, "chapters/01.mdx", navTree[0]["path"])
				assert.Equal(t, "appendix-doc-0", navTree[1]["name"])
			},
		},
		{
			name: "1.17.5.2 code_only repository with customOutline preserves user ordering",
			files: map[string]string{
				"src/core/kernel.ts":  "export class Kernel {}",
				"src/utils/helper.ts": "export function helper() {}",
			},
			paramsJSON: func(sha string) []byte {
				p := map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"preExistingRepo": nil,
					"options": map[string]any{
						"isPublic": true,
						"category": "tools",
						"gitSha":   sha,
						"customOutline": []map[string]any{
							{
								"name":    "First Kernel",
								"summary": "Kernel subsystem",
								"files":   []string{"src/core/kernel.ts"},
							},
							{
								"name":    "Second Helper",
								"summary": "Helper utilities",
								"files":   []string{"src/utils/helper.ts"},
							},
						},
					},
				}
				b, _ := json.Marshal(p)
				return b
			},
			expectIngestMode: "code_only",
			expectedChapters: 2,
			expectedAppendix: 0,
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI, sha string, graphDir string) {
				t.Helper()
				assert.True(t, store.docsDone, "chapter docs persistence must be done")
				assert.True(t, jobAPI.settled, "settle executor must be called")
				require.Len(t, store.lastChapters, 2)
				assert.Equal(t, "First Kernel", store.lastChapters[0].Title)
				assert.Equal(t, "chapters/01.mdx", store.lastChapters[0].Files[0].Path)
				assert.Equal(t, "Second Helper", store.lastChapters[1].Title)
				assert.Equal(t, "chapters/02.mdx", store.lastChapters[1].Files[0].Path)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			graphDir := t.TempDir()
			sha := "sha_" + mdpat.SlugifyUnderscore(tt.name)
			dir := filepath.Join(root, "o", "r", sha)

			for f, content := range tt.files {
				p := filepath.Join(dir, filepath.FromSlash(f))
				require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
				require.NoError(t, os.WriteFile(p, []byte(content), 0o644))
			}

			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			defer ts.Close()

			store := &fakeIngestStore{}
			jobAPI := &fakeJobAPI{}
			deps := IngestBodyDeps{
				Store:       store,
				Archive:     NewArchiveClient(ts.URL, "tok"),
				Web:         jobAPI,
				SettleJob:   jobAPI.Settle,
				ArchiveRoot: root,
				Patterns:    patterns,
				Languages:   defs,
				GraphDir:    graphDir,
			}

			job := JobRow{
				Id:     "job-test",
				Owner:  "o",
				Repo:   "r",
				Branch: "main",
				Params: tt.paramsJSON(sha),
			}

			out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
			assert.Equal(t, ingestDone, out, "must complete in Go native pipeline (ingestDone)")
			if tt.verify != nil {
				tt.verify(t, store, jobAPI, sha, graphDir)
			}
		})
	}
}

func makeLadderDeps(t *testing.T, store IngestStore, jobAPI *fakeJobAPI, files map[string]string, withLanguages bool) (IngestBodyDeps, string) {
	t.Helper()
	root := t.TempDir()
	sha := "laddersha1"
	writeLadderFiles := func(dir string) {
		for f, content := range files {
			p := filepath.Join(dir, filepath.FromSlash(f))
			require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
			require.NoError(t, os.WriteFile(p, []byte(content), 0o644))
		}
	}
	writeLadderFiles(ArchiveDirFor(root, "o", "r", sha))

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)

	deps := IngestBodyDeps{
		Store:       store,
		Archive:     NewArchiveClient(ts.URL, "tok"),
		Web:         jobAPI,
		SettleJob:   jobAPI.Settle,
		ArchiveRoot: root,
		Patterns:    DefaultPatterns(),
	}
	if withLanguages {
		defs, err := LoadLanguageDefinitions("")
		require.NoError(t, err)
		deps.Languages = defs
		deps.GraphDir = t.TempDir()
	}
	return deps, sha
}

func TestIngestEvidenceLadderPerCell(t *testing.T) {
	tests := []struct {
		name          string
		files         map[string]string
		params        func(sha string) map[string]any
		withLanguages bool
		verify        func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI)
	}{
		{
			name: "cell-1 customOutline (user-confirmed) wins for text repo",
			files: map[string]string{
				"docs/a.md": "a", "docs/b.md": "b", "docs/c.md": "c",
				"docs/d.md": "d", "docs/e.md": "e", "README.md": "r",
			},
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
						"customOutline": []map[string]any{
							{"name": "Part One", "files": []string{"docs/a.md", "docs/b.md"}},
							{"name": "Part Two", "files": []string{"docs/c.md"}},
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.Len(t, store.lastChapters, 2)
				assert.Equal(t, "Part One", store.lastChapters[0].Title)
				assert.Equal(t, "docs/a.md", store.lastChapters[0].Files[0].Path)
			},
		},
		{
			name: "cell-2 draftOutline.outline (LLM draft) converts to chapters",
			files: map[string]string{
				"docs/a.md": "a", "docs/b.md": "b", "docs/c.md": "c",
				"docs/d.md": "d", "docs/e.md": "e", "README.md": "r",
			},
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
						"draftOutline": map[string]any{
							"outline": []map[string]any{
								{"name": "Getting Started", "files": []string{"docs/a.md", "docs/b.md"}},
								{"name": "Advanced", "files": []string{"docs/c.md"}},
							},
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.Len(t, store.lastChapters, 2)
				assert.Equal(t, "Getting Started", store.lastChapters[0].Title)
			},
		},
		{
			name: "cell-3 draftOutline.modules matches nodes by directory prefix (text)",
			files: map[string]string{
				"docs/a.md": "a", "docs/b.md": "b", "docs/c.md": "c",
				"docs/d.md": "d", "docs/e.md": "e", "README.md": "r",
			},
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
						"draftOutline": map[string]any{
							"modules": []map[string]any{
								{"name": "Documentation Core", "directories": []string{"docs"}},
							},
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.Len(t, store.lastChapters, 1)
				assert.Equal(t, "Documentation Core", store.lastChapters[0].Title)
				assert.Equal(t, "docs/a.md", store.lastChapters[0].Files[0].Path)
			},
		},
		{
			name: "cell-4 chapterMap (textbook signal via envelope chapterCount + numeric prefix) records curriculum map",
			files: map[string]string{
				"docs/01-intro.md":    "intro",
				"docs/02-advanced.md": "advanced",
				"docs/03-guide.md":    "guide",
				"labs/lab1.md":        "lab",
			},
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
						"repoProfile": map[string]any{
							"tier": "A", "ingestMode": "text_only", "textRoot": "docs",
							"chapterCount": 3, "profileVersion": 2,
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.NotNil(t, store.lastRepoParams)
				var profileMap map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.ProfileJSON, &profileMap))
				chapterMap, ok := profileMap["chapterMap"].([]any)
				require.True(t, ok, "textbook-signal repo must hit chapterMap cell")
				require.Len(t, chapterMap, 3)
				assert.Equal(t, float64(2), profileMap["profileVersion"])
				var navTree []map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.NavTreeJSON, &navTree))
				require.NotEmpty(t, navTree)
				assert.Equal(t, "directory", navTree[0]["type"])
				require.Len(t, store.lastChapters, 3)
				assert.Equal(t, "docs/01-intro.md", store.lastChapters[0].Files[0].Path)
				require.NotNil(t, store.lastDraft)
				require.NotEmpty(t, store.lastDraft.Parts, "curriculum import must persist OutlinePart rows")
				for _, ch := range store.lastDraft.Chapters {
					assert.NotEmpty(t, ch.PartTitle, "curriculum chapters must carry PartTitle")
				}
			},
		},
		{
			name: "cell-4b envelope chapterMap (profileVersion=2) is reused verbatim with zero LLM",
			files: map[string]string{
				"docs/01-intro.md": "intro",
				"docs/02-adv.md":   "adv",
				"README.md":        "r",
			},
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
						"repoProfile": map[string]any{
							"tier": "A", "ingestMode": "text_only",
							"chapterCount": 2, "profileVersion": 2,
							"chapterMap": []map[string]any{
								{"order": 1, "title": "Intro", "mainPath": "docs/01-intro.md"},
								{"order": 2, "title": "Advanced", "mainPath": "docs/02-adv.md"},
							},
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.NotNil(t, store.lastRepoParams)
				var profileMap map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.ProfileJSON, &profileMap))
				chapterMap, ok := profileMap["chapterMap"].([]any)
				require.True(t, ok, "envelope chapterMap must be reused verbatim")
				require.Len(t, chapterMap, 2)
				require.Len(t, store.lastChapters, 2)
				assert.Equal(t, "docs/01-intro.md", store.lastChapters[0].Files[0].Path)
				assert.Equal(t, "docs/02-adv.md", store.lastChapters[1].Files[0].Path)
			},
		},
		{
			name: "cell-4c translation roots filtered out of navtree (Node filterNodesByProfile)",
			files: map[string]string{
				"docs/a.md": "a", "docs/b.md": "b", "docs/c.md": "c",
				"docs/d.md": "d", "docs/e.md": "e",
				"zh-cn/docs/a.md": "翻译A", "zh-cn/docs/b.md": "翻译B",
				"README.md": "r",
			},
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
						"repoProfile": map[string]any{
							"tier": "B", "ingestMode": "text_only",
							"translationRoots": []string{"zh-cn/"},
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.NotEmpty(t, store.lastChapters)
				for _, ch := range store.lastChapters {
					for _, f := range ch.Files {
						assert.False(t, strings.HasPrefix(f.Path, "zh-cn/"),
							"translation-root files must not enter the canonical navtree: %s", f.Path)
					}
				}
			},
		},
		{
			name: "cell-1b customOutline code rung enriches cognitive metadata while preserving user order",
			files: map[string]string{
				"src/index.ts": "import { util } from './util';\nexport function main() { return util; }",
				"src/util.ts":  "export const util = 1;",
			},
			withLanguages: true,
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
						"customOutline": []map[string]any{
							{"name": "Utilities First", "files": []string{"src/util.ts"}},
							{"name": "Entry Second", "files": []string{"src/index.ts"}},
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.NotNil(t, store.lastRepoParams)
				var profileMap map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.ProfileJSON, &profileMap))
				clusters, ok := profileMap["codeClusters"].([]any)
				require.True(t, ok, "code rung must persist codeClusters")
				require.Len(t, clusters, 2)
				first := clusters[0].(map[string]any)
				second := clusters[1].(map[string]any)
				assert.Equal(t, "Utilities First", first["title"])
				assert.Equal(t, float64(1), first["teachingOrder"])
				assert.Equal(t, "Entry Second", second["title"])
				assert.NotEmpty(t, first["cognitive"], "customOutline code rung must attach cognitive metadata")
			},
		},
		{
			name: "cell-5 RSG cognitive projection derives code chapters with cognitive metadata",
			files: map[string]string{
				"src/index.ts": "import { util } from './util';\nexport function main() { return util; }",
				"src/util.ts":  "export const util = 1;",
			},
			withLanguages: true,
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.NotEmpty(t, store.lastChapters)
				assert.Equal(t, "chapters/01.mdx", store.lastChapters[0].Files[0].Path)
				require.NotNil(t, store.lastRepoParams)
				var profileMap map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.ProfileJSON, &profileMap))
				clusters, ok := profileMap["codeClusters"].([]any)
				require.True(t, ok, "RSG cell must attach codeClusters")
				require.NotEmpty(t, clusters)
				cluster := clusters[0].(map[string]any)
				cognitive, ok := cluster["cognitive"].(map[string]any)
				require.True(t, ok, "cognitive metadata must be attached by projection cell")
				assert.NotEmpty(t, cognitive["phase"])
			},
		},
		{
			name: "cell-7 rule tree fallback for plain docs repo",
			files: map[string]string{
				"docs/a.md": "a", "docs/b.md": "b", "docs/c.md": "c",
				"docs/d.md": "d", "docs/e.md": "e", "README.md": "r",
			},
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.NotEmpty(t, store.lastChapters)
				require.NotNil(t, store.lastRepoParams)
				var profileMap map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.ProfileJSON, &profileMap))
				assert.NotContains(t, profileMap, "chapterMap", "no textbook signal must skip chapterMap cell")
				assert.NotContains(t, profileMap, "codeClusters", "text repo must skip RSG cell")
				require.NotNil(t, store.lastDraft, "rule tree draft must be stored")
			},
		},
		{
			name: "cell-1c stale text_only envelope promoted to hybrid when customOutline has code chapters and companionFiles",
			files: map[string]string{
				"docs/a.md":                      "# Doc A",
				"docs/b.md":                      "# Doc B",
				"docs/c.md":                      "# Doc C",
				"docs/d.md":                      "# Doc D",
				"docs/e.md":                      "# Doc E",
				"config/README.md":               "# Config",
				"packages/shared/src/index.ts":   "export const sharedValue = 1;",
				"packages/services/src/ports.ts": "export interface ServicePort { run(): void; }",
			},
			withLanguages: true,
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "ed_bf495c50",
					"options": map[string]any{
						"isPublic": false, "gitSha": sha, "useAi": true,
						"repoProfile": map[string]any{
							"tier": "B", "repoType": "docs", "ingestMode": "text_only", "textRoot": "docs/",
						},
						"customOutline": []map[string]any{
							{
								"name":      "第 1 章：packages 分层契约",
								"partTitle": "模块 1: 分层边界",
								"files": []map[string]any{
									{
										"path":           "packages/shared/src/index.ts",
										"shortTitle":     "index",
										"companionFiles": []string{"packages/services/src/ports.ts"},
									},
								},
							},
							{
								"name":      "第 2 章：配置分区",
								"partTitle": "模块 1: 分层边界",
								"files": []map[string]any{
									{"path": "config/README.md", "shortTitle": "README"},
								},
							},
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.Len(t, store.lastChapters, 2)
				assert.Equal(t, "chapters/01.mdx", store.lastChapters[0].Files[0].Path)
				assert.Equal(t, "chapters/02.mdx", store.lastChapters[1].Files[0].Path)

				require.NotNil(t, store.lastRepoParams)
				var profileMap map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.ProfileJSON, &profileMap))
				assert.Equal(t, "hybrid", profileMap["ingestMode"])
				assert.Equal(t, "codebase", profileMap["repoType"])

				clusters, ok := profileMap["codeClusters"].([]any)
				require.True(t, ok)
				require.Len(t, clusters, 2)
				ch1Files := clusters[0].(map[string]any)["files"].([]any)
				assert.Contains(t, ch1Files, "packages/shared/src/index.ts")
				assert.Contains(t, ch1Files, "packages/services/src/ports.ts")
			},
		},
		{
			name: "cell-1d pure docs customOutline stays text_only when no code chapters present",
			files: map[string]string{
				"docs/a.md":                    "# Doc A",
				"docs/b.md":                    "# Doc B",
				"packages/shared/src/index.ts": "export const sharedValue = 1;",
			},
			withLanguages: true,
			params: func(sha string) map[string]any {
				return map[string]any{
					"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
					"options": map[string]any{
						"isPublic": true, "gitSha": sha,
						"repoProfile": map[string]any{
							"tier": "B", "repoType": "docs", "ingestMode": "text_only", "textRoot": "docs/",
						},
						"customOutline": []map[string]any{
							{"name": "Guide", "files": []string{"docs/a.md", "docs/b.md"}},
						},
					},
				}
			},
			verify: func(t *testing.T, store *fakeIngestStore, jobAPI *fakeJobAPI) {
				t.Helper()
				require.True(t, jobAPI.settled)
				require.Len(t, store.lastChapters, 1)
				assert.Equal(t, "docs/a.md", store.lastChapters[0].Files[0].Path)
				var profileMap map[string]any
				require.NoError(t, json.Unmarshal(store.lastRepoParams.ProfileJSON, &profileMap))
				assert.Equal(t, "text_only", profileMap["ingestMode"])
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeIngestStore{}
			jobAPI := &fakeJobAPI{}
			deps, sha := makeLadderDeps(t, store, jobAPI, tt.files, tt.withLanguages)

			rawParams, err := json.Marshal(tt.params(sha))
			require.NoError(t, err)
			job := JobRow{Id: "ladder-job", Owner: "o", Repo: "r", Branch: "main", Params: rawParams}

			out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
			assert.Equal(t, ingestDone, out, "ladder cell must complete via commitIngest funnel")
			tt.verify(t, store, jobAPI)
		})
	}
}

func TestIngestBodyGiantRepoExplicitErrorWithoutOutline(t *testing.T) {
	store := &fakeIngestStore{}
	jobAPI := &fakeJobAPI{}
	deps, _ := makeBodyDeps(t, store, jobAPI)

	sha := "giantsha2"
	dir := filepath.Join(deps.ArchiveRoot, "o", "r", sha)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"), []byte("x"), 0o644))
	for i := 0; i < 1100; i++ {
		f := filepath.Join(dir, "packages", fmt.Sprintf("mod%d", i%5), fmt.Sprintf("file_%d.ts", i))
		require.NoError(t, os.MkdirAll(filepath.Dir(f), 0o755))
		require.NoError(t, os.WriteFile(f, []byte("export const v = 1;"), 0o644))
	}

	params := map[string]any{
		"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
		"preExistingRepo": nil,
		"options":         map[string]any{"isPublic": true, "category": "giant-test", "gitSha": sha},
	}
	rawParams, err := json.Marshal(params)
	require.NoError(t, err)
	job := JobRow{Id: "giant-job-1", Owner: "o", Repo: "r", Branch: "main", Params: rawParams}

	out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
	assert.Equal(t, ingestFallback, out, "巨仓无大纲必须显式失败(引导树大纲模式),不得静默走旧巨型泳道")
	assert.False(t, store.docsDone, "不得落任何章节文档")
}

func TestIngestBodyGiantRepoOutlineScopesLanding(t *testing.T) {
	store := &fakeIngestStore{}
	jobAPI := &fakeJobAPI{}
	deps, _ := makeBodyDeps(t, store, jobAPI)

	sha := "giantsha3"
	dir := filepath.Join(deps.ArchiveRoot, "o", "r", sha)
	outlineFiles := []string{"README.md", "docs/guide.md", "docs/api.md"}
	for _, f := range outlineFiles {
		p := filepath.Join(dir, filepath.FromSlash(f))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte("# doc\n内容"), 0o644))
	}
	for i := 0; i < 1100; i++ {
		f := filepath.Join(dir, "z_bulk", fmt.Sprintf("f%04d.ts", i))
		require.NoError(t, os.MkdirAll(filepath.Dir(f), 0o755))
		require.NoError(t, os.WriteFile(f, []byte("export const v = 1;"), 0o644))
	}

	params := map[string]any{
		"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
		"preExistingRepo": nil,
		"options": map[string]any{
			"isPublic": true, "category": "giant-outline-test", "gitSha": sha,
			"customOutline": []map[string]any{{
				"name":  "第 1 章:上手指南",
				"files": outlineFiles,
			}},
		},
	}
	rawParams, err := json.Marshal(params)
	require.NoError(t, err)
	job := JobRow{Id: "giant-job-2", Owner: "o", Repo: "r", Branch: "main", Params: rawParams}

	out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
	assert.Equal(t, ingestDone, out, "大纲在场时巨型闸让路,普通泳道完成导入")
	require.Len(t, store.lastChapters, 1, "章节 = 大纲章 1:1")
	assert.Equal(t, "第 1 章:上手指南", store.lastChapters[0].Title)
	require.Len(t, store.lastChapters[0].Files, 3)
	for i, want := range outlineFiles {
		assert.Equal(t, want, store.lastChapters[0].Files[i].Path)
	}
	assert.True(t, store.snapDone, "RegisterImportSnapshot must be called")
	assert.True(t, jobAPI.settled, "settlement endpoint must be called")
}

func TestIngestBodyDraftModulesPath(t *testing.T) {
	store := &fakeIngestStore{}
	jobAPI := &fakeJobAPI{}
	files := map[string]string{
		"README.md":               "# doc",
		"packages/core/index.ts":  "export const a = 1;",
		"packages/core/engine.ts": "export const b = 2;",
		"packages/core/types.ts":  "export const c = 3;",
	}
	deps, sha := makeLadderDeps(t, store, jobAPI, files, true)

	params := map[string]any{
		"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
		"preExistingRepo": nil,
		"options": map[string]any{
			"isPublic": true, "category": "draft-test", "gitSha": sha,
			"draftOutline": map[string]any{
				"modules": []map[string]any{{
					"name":        "Core Engine",
					"summary":     "核心编译调度引擎",
					"directories": []string{"packages/core"},
				}},
			},
		},
	}
	rawParams, err := json.Marshal(params)
	require.NoError(t, err)
	job := JobRow{Id: "draft-job", Owner: "o", Repo: "r", Branch: "main", Params: rawParams}

	out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
	assert.Equal(t, ingestDone, out, "draft modules 路径正常完成")
	assert.NotEmpty(t, store.lastChapters, "模块章应产出")
}

func TestScanArchiveStreamPrunesNonContentDirs(t *testing.T) {
	patterns := DefaultPatterns()
	root := t.TempDir()
	sha := "prunesha1"
	dir := ArchiveDirFor(root, "o", "r", sha)

	for _, f := range []string{"src/index.ts", "src/util.ts", "src/types.ts", "README.md"} {
		p := filepath.Join(dir, filepath.FromSlash(f))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte("const x = 1;"), 0o644))
	}

	for i := 0; i < 50; i++ {
		p := filepath.Join(dir, "node_modules", "pkg", filepath.FromSlash("f"+string(rune('0'+(i%10)))+".js"))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte("junk"), 0o644))
	}

	scan, ok := ScanArchiveStream(root, "o", "r", sha, patterns, nil)
	require.True(t, ok, "ScanArchiveStream failed")

	assert.Equal(t, 4, scan.Scale.TotalFiles, "node_modules should be pruned")
	assert.Equal(t, "normal", scan.Scale.Scale)
	for _, n := range scan.Nodes {
		assert.NotContains(t, n.Path, "node_modules", "node_modules file should not be in scan.Nodes")
	}
}

func TestScanArchiveStreamKeepPathsOutlivesGiantTruncation(t *testing.T) {
	patterns := DefaultPatterns()
	const keepA = "pkg/a_outline/core.go"
	const keepB = "pkg/a_outline/deep/nested/keep.go"
	tests := []struct {
		name     string
		keep     map[string]bool
		wantKeep bool
	}{
		{name: "无 keep:截断后大纲文件被吞", keep: nil, wantKeep: false},
		{name: "keep 命中:大纲文件恒存活", keep: map[string]bool{keepA: true, keepB: true}, wantKeep: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			sha := "giantkeep1"
			dir := ArchiveDirFor(root, "o", "r", sha)
			for i := 0; i < 1100; i++ {
				p := filepath.Join(dir, "pkg", "z_bulk", fmt.Sprintf("f%04d.go", i))
				require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
				require.NoError(t, os.WriteFile(p, []byte("package bulk"), 0o644))
			}
			for _, f := range []string{keepA, keepB} {
				p := filepath.Join(dir, filepath.FromSlash(f))
				require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
				require.NoError(t, os.WriteFile(p, []byte("package core"), 0o644))
			}
			scan, ok := ScanArchiveStream(root, "o", "r", sha, patterns, tt.keep)
			require.True(t, ok, "ScanArchiveStream failed")
			require.True(t, scan.IsGiant, "1102 文件应为巨仓")
			got := map[string]bool{}
			for _, n := range scan.Nodes {
				if n.Type == "blob" {
					got[n.Path] = true
				}
			}
			assert.Equal(t, tt.wantKeep, got[keepA], "keep 文件 %s 存活=%v 期望 %v", keepA, got[keepA], tt.wantKeep)
			assert.Equal(t, tt.wantKeep, got[keepB], "keep 文件 %s 存活=%v 期望 %v", keepB, got[keepB], tt.wantKeep)
		})
	}
}

type fakeFirecrawl struct {
	docs []FirecrawlDoc
	err  error
}

func (f *fakeFirecrawl) ScrapeUrl(_ context.Context, _ string) (*FirecrawlDoc, error) {
	if f.err != nil {
		return nil, f.err
	}
	if len(f.docs) > 0 {
		return &f.docs[0], nil
	}
	return nil, assert.AnError
}
func (f *fakeFirecrawl) Crawl(_ context.Context, _ string, _ int, _ *CrawlFilters) ([]FirecrawlDoc, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.docs, nil
}

func TestWebDocIngest(t *testing.T) {
	tests := []struct {
		name         string
		kind         string
		maxPages     int
		hasClient    bool
		crawlDocs    []FirecrawlDoc
		crawlErr     error
		wantOutcome  ingestOutcome
		wantDocs     int
		checkDetails bool
	}{
		{
			name:      "firecrawl success ingests docs natively in Go with NavTree, Profile, and PROCESSED status",
			kind:      "web-doc",
			maxPages:  10,
			hasClient: true,
			crawlDocs: []FirecrawlDoc{
				{
					Path:        "docs/intro.md",
					Title:       "Introduction",
					Markdown:    "# Introduction\n\nWelcome to our web docs with rich text.",
					ContentHash: "hash1",
				},
				{
					Path:        "docs/install.md",
					Title:       "Installation",
					Markdown:    "# Installation\n\nRun npm install to get started now.",
					ContentHash: "hash2",
				},
			},
			wantOutcome:  ingestDone,
			wantDocs:     2,
			checkDetails: true,
		},
		{
			name:      "firecrawl single page scrape with maxPages=1",
			kind:      "web-doc",
			maxPages:  1,
			hasClient: true,
			crawlDocs: []FirecrawlDoc{
				{
					Path:        "docs/single.md",
					Title:       "Single Page",
					Markdown:    "# Single Page\n\nThis is a single page document scrape.",
					ContentHash: "hash-single",
				},
			},
			wantOutcome: ingestDone,
			wantDocs:    1,
		},
		{
			name:        "web-sync kind falls back to Web for sitemap diffing",
			kind:        "web-sync",
			maxPages:    10,
			hasClient:   true,
			crawlDocs:   []FirecrawlDoc{{Path: "docs/sync.md", Title: "Sync", Markdown: "Some content here for sync test."}},
			wantOutcome: ingestFallback,
		},
		{
			name:        "firecrawl crawl error falls back",
			kind:        "web-doc",
			maxPages:    10,
			hasClient:   true,
			crawlErr:    assert.AnError,
			wantOutcome: ingestFallback,
		},
		{
			name:        "firecrawl not configured falls back",
			kind:        "web-doc",
			maxPages:    10,
			hasClient:   false,
			wantOutcome: ingestFallback,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("WEB_CRAWLER_FAST_PATH", "false")
			store := &fakeIngestStore{}
			jobAPI := &fakeJobAPI{}
			deps, _ := makeBodyDeps(t, store, jobAPI)
			if tt.hasClient {
				deps.Firecrawl = &fakeFirecrawl{
					docs: tt.crawlDocs,
					err:  tt.crawlErr,
				}
			}

			envelope := ImportJobEnvelope{
				Kind:   tt.kind,
				UserId: "u1",
				Branch: "main",
			}
			envelope.Options.Url = "https://example.com/docs"
			envelope.Options.MaxPages = tt.maxPages
			envelope.Options.IsPublic = true
			paramsBytes, _ := json.Marshal(envelope)

			job := JobRow{
				Id:     "job-web-1",
				Owner:  "web-docs",
				Repo:   "example-docs",
				Branch: "main",
				Params: paramsBytes,
			}

			cfg := loadConfigFromEnv()
			outcome := runIngestBody(context.Background(), cfg, deps, job)

			assert.Equal(t, tt.wantOutcome, outcome)
			if tt.wantOutcome == ingestDone {
				assert.Equal(t, tt.wantDocs, store.createdDocs)
				assert.True(t, jobAPI.settled)
				assert.Equal(t, tt.wantDocs, jobAPI.result.QueuedDocumentsCount)

				if tt.checkDetails {
					require.Len(t, store.lastDocArgs, 2)
					for _, d := range store.lastDocArgs {
						assert.Equal(t, "PROCESSED", d.Status, "Status must strictly match DocumentStatus enum PROCESSED")
					}

					require.NotNil(t, store.lastRepoParams)
					assert.Contains(t, string(store.lastRepoParams.NavTreeJSON), "docs", "NavTreeJSON must contain tree structure")
					assert.Contains(t, string(store.lastRepoParams.ProfileJSON), `"sourceType":"web"`, "ProfileJSON must record web sourceType")
					assert.Contains(t, string(store.lastRepoParams.ProfileJSON), `"engineUsed":"firecrawl"`, "ProfileJSON must record firecrawl engine")
				}
			}
		})
	}
}

func TestSanitizeWebDocMarkdown(t *testing.T) {
	tests := []struct {
		name     string
		docPath  string
		raw      string
		contains []string
	}{
		{
			name:     "plain markdown stays untouched",
			docPath:  "docs/intro.md",
			raw:      "# Title\n\nSimple text content without issues.",
			contains: []string{"# Title", "Simple text content without issues."},
		},
		{
			name:     "html tags sanitized and mdx braces preserved or healed",
			docPath:  "docs/guide.md",
			raw:      "<div><script>alert('xss')</script># Hello {user.name}</div>",
			contains: []string{"# Hello"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeWebDocMarkdown(tt.docPath, tt.raw)
			for _, exp := range tt.contains {
				assert.Contains(t, got, exp)
			}
		})
	}
}

func TestIngestBodyWithDraftOutline(t *testing.T) {
	tests := []struct {
		name                    string
		draftOutline            any
		optionCategory          string
		optionTags              []string
		wantCategory            string
		wantTags                []string
		wantBestUsedFor         []string
		wantChapterCount        int
		wantFirstChapterName    string
		wantFirstChapterFile    string
		wantFirstChapterSummary string
		checkStages             bool
	}{
		{
			name: "pre-structured outline chapters are converted to chapters",
			draftOutline: map[string]any{
				"category":    "Documentation",
				"tags":        []string{"guide", "getting-started"},
				"bestUsedFor": []string{"Team onboarding", "API reference"},
				"outline": []map[string]any{
					{
						"name":    "Getting Started",
						"summary": "Introduction to the docs",
						"files": []map[string]any{
							{"path": "docs/a.md", "shortTitle": "Introduction"},
							{"path": "docs/b.md", "shortTitle": "Installation"},
						},
					},
					{
						"name":    "Advanced Concepts",
						"summary": "Deep dive into system concepts",
						"files": []map[string]any{
							{"path": "docs/c.md", "shortTitle": "Architecture"},
						},
					},
				},
			},
			optionCategory:          "",
			optionTags:              nil,
			wantCategory:            "Documentation",
			wantTags:                []string{"guide", "getting-started"},
			wantBestUsedFor:         []string{"Team onboarding", "API reference"},
			wantChapterCount:        2,
			wantFirstChapterName:    "Getting Started",
			wantFirstChapterFile:    "docs/a.md",
			wantFirstChapterSummary: "Introduction to the docs",
			checkStages:             true,
		},
		{
			name: "module suggestions match nodes by directory prefix",
			draftOutline: map[string]any{
				"category": "Guides",
				"modules": []map[string]any{
					{
						"name":        "Documentation Core",
						"summary":     "核心文档模块",
						"directories": []string{"docs"},
					},
				},
			},
			optionCategory:       "OverrideCat",
			optionTags:           []string{"custom-tag"},
			wantCategory:         "OverrideCat",
			wantTags:             []string{"custom-tag"},
			wantChapterCount:     1,
			wantFirstChapterName: "Documentation Core",
			wantFirstChapterFile: "docs/a.md",
			checkStages:          false,
		},
		{
			name: "empty or unmatched outline falls back to BuildNavTree rules",
			draftOutline: map[string]any{
				"category": "Unmatched",
				"modules": []map[string]any{
					{
						"name":        "Nonexistent Module",
						"directories": []string{"nonexistent_dir"},
					},
				},
			},
			optionCategory:   "",
			wantCategory:     "Unmatched",
			wantChapterCount: 2,
			checkStages:      false,
		},
		{
			name:                    "stringified JSON draftOutline is correctly unmarshaled and imported",
			draftOutline:            `{"category":"StrCategory","tags":["str-tag"],"bestUsedFor":["doc portal","api guide"],"outline":[{"name":"StrChapter","summary":"Summary from stringified JSON","files":[{"path":"docs/a.md"}]}]}`,
			optionCategory:          "",
			wantCategory:            "StrCategory",
			wantTags:                []string{"str-tag"},
			wantBestUsedFor:         []string{"doc portal", "api guide"},
			wantChapterCount:        1,
			wantFirstChapterName:    "StrChapter",
			wantFirstChapterFile:    "docs/a.md",
			wantFirstChapterSummary: "Summary from stringified JSON",
			checkStages:             false,
		},
		{
			name: "top-level array of chapters in draftOutline is correctly converted",
			draftOutline: []map[string]any{
				{
					"name":    "DirectArrayChapter",
					"summary": "Direct array summary",
					"files":   []string{"docs/b.md"},
				},
			},
			optionCategory:          "DefaultCat",
			wantCategory:            "DefaultCat",
			wantChapterCount:        1,
			wantFirstChapterName:    "DirectArrayChapter",
			wantFirstChapterFile:    "docs/b.md",
			wantFirstChapterSummary: "Direct array summary",
			checkStages:             false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeIngestStore{}
			jobAPI := &fakeJobAPI{}
			deps, sha := makeBodyDeps(t, store, jobAPI)

			var emittedStages []string
			deps.Emit = func(eventType string, payload map[string]any) {
				if eventType == "log" && payload != nil {
					if msg, ok := payload["message"].(string); ok {
						emittedStages = append(emittedStages, msg)
					}
				}
			}

			rawOptions := map[string]any{
				"isPublic":     true,
				"category":     tt.optionCategory,
				"tags":         tt.optionTags,
				"gitSha":       sha,
				"draftOutline": tt.draftOutline,
			}
			paramsBytes, err := json.Marshal(map[string]any{
				"kind":    "github",
				"userId":  "u1",
				"branch":  "main",
				"options": rawOptions,
			})
			require.NoError(t, err)

			job := JobRow{
				Id:     "test-job-draft",
				Owner:  "o",
				Repo:   "r",
				Branch: "main",
				Params: paramsBytes,
			}

			out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
			assert.Equal(t, ingestDone, out, "text_only repo with draftOutline must complete in Go")
			assert.True(t, store.docsDone)
			assert.True(t, store.snapDone)
			assert.True(t, jobAPI.settled)

			require.NotNil(t, store.lastRepoParams)
			assert.Equal(t, tt.wantCategory, store.lastRepoParams.Category)
			if tt.wantTags != nil {
				assert.Equal(t, tt.wantTags, store.lastRepoParams.Tags)
			}
			if tt.wantBestUsedFor != nil {
				assert.Equal(t, tt.wantBestUsedFor, store.lastRepoParams.BestUsedFor)
			}

			assert.NotEmpty(t, store.lastChapters)
			if tt.wantFirstChapterName != "" {
				assert.Equal(t, tt.wantFirstChapterName, store.lastChapters[0].Title)
			}
			if tt.wantFirstChapterFile != "" && len(store.lastChapters[0].Files) > 0 {
				assert.Equal(t, tt.wantFirstChapterFile, store.lastChapters[0].Files[0].Path)
			}
			if tt.wantFirstChapterSummary != "" {
				require.NotNil(t, store.lastDraft)
				require.NotEmpty(t, store.lastDraft.Chapters)
				require.NotNil(t, store.lastDraft.Chapters[0].Summary)
				assert.Equal(t, tt.wantFirstChapterSummary, *store.lastDraft.Chapters[0].Summary)
			}

			if tt.checkStages {
				expectedStages := []string{
					"[1/5] 解析代码仓版本与提交标识 (Resolve Git SHA)...",
					"[2/5] 装载并解压代码仓归档 (Ensure Archive)...",
					"[3/5] 流式扫描文件树与结构嗅探 (Scan Tree & Sniff Profile)...",
					"[4/5] 构建大纲导航树与章节落库 (Build NavTree & Create Docs)...",
					"[5/5] 同步知识大纲快照与终态结算 (Sync Outline & Settle Job)...",
				}
				for _, expected := range expectedStages {
					assert.Contains(t, emittedStages, expected)
				}
			}
		})
	}
}

func TestCommitIngest_AppendixDocsKnowledgeGraphAndSignatures(t *testing.T) {
	store := &fakeIngestStore{}
	jobAPI := &fakeJobAPI{}
	deps, _ := makeBodyDeps(t, store, jobAPI)

	sha := "testsha12345"
	dir := filepath.Join(deps.ArchiveRoot, "org", "repo", sha)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "docs"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "docs", "appendix.md"), []byte("# Appendix Documentation\n\nThis is an important appendix document with concept [Authentication].\n\n```ts\nexport const auth = true;\n```\n"), 0o644))

	rawNodes := []GitNode{
		{Path: "src/index.ts", Type: "blob"},
		{Path: "src/utils.ts", Type: "blob"},
		{Path: "docs/appendix.md", Type: "blob"},
		{Path: "README.md", Type: "blob"},
		{Path: "package.json", Type: "blob"},
		{Path: "src/auth.ts", Type: "blob"},
		{Path: "src/db.ts", Type: "blob"},
		{Path: "src/server.ts", Type: "blob"},
	}

	plan := ChapterPlan{
		Chapters: []ChapterInput{
			{
				Title: "Chapter 1",
				Files: []ChapterFile{{Path: "chapters/01.mdx", ShortTitle: "Chapter 1"}},
			},
		},
		NavTree: []*NavNode{
			{Name: "ch-1", Title: "Chapter 1", Type: "file", Path: "chapters/01.mdx"},
			{Name: "app-1", Title: "Appendix", Type: "file", Path: "docs/appendix.md"},
		},
		AppendixDocs: []GitNode{
			{Path: "docs/appendix.md", Type: "blob"},
		},
		RawNodes: rawNodes,
	}

	envelope := ImportJobEnvelope{
		Kind:   "repo",
		UserId: "u-test",
	}
	envelope.Options.IsPublic = true
	job := JobRow{Id: "job-1", Owner: "org", Repo: "repo", Branch: "main"}

	outcome, repoId, created := commitIngest(context.Background(), deps, job, envelope, sha, plan)
	assert.Equal(t, ingestDone, outcome)
	assert.Equal(t, "rid-1", repoId)
	assert.Equal(t, 3, created)

	require.NotNil(t, store.lastRepoParams)
	assert.NotEmpty(t, store.lastRepoParams.Skeleton, "Skeleton must be calculated from RawNodes")
	assert.NotEmpty(t, store.lastRepoParams.SkeletonHash, "SkeletonHash must be calculated from RawNodes")
	assert.Contains(t, store.lastRepoParams.Skeleton, "src/index.ts")
	assert.Contains(t, store.lastRepoParams.Skeleton, "docs/appendix.md")

	assert.Greater(t, store.replacedChunksCount, 0, "Appendix doc must be chunked and stored in DocumentChunk")
	assert.Greater(t, store.storedMetadataCount, 0, "Appendix doc must extract concepts and store metadata")

	assert.Equal(t, "rid-1", jobAPI.revalidatedRepoId, "Web L1 cache must be revalidated with repoId")
}

func TestCodeRepoRSGFailClosed(t *testing.T) {
	store := &fakeIngestStore{}
	jobAPI := &fakeJobAPI{}
	deps, sha := makeLadderDeps(t, store, jobAPI, map[string]string{
		"src/index.ts": "import { util } from './util';\nexport function main() { return util; }",
		"src/util.ts":  "export const util = 1;",
	}, false)

	rawParams, err := json.Marshal(map[string]any{
		"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
		"options": map[string]any{"isPublic": true, "gitSha": sha},
	})
	require.NoError(t, err)
	job := JobRow{Id: "fc-job", Owner: "o", Repo: "r", Branch: "main", Params: rawParams}

	out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
	assert.Equal(t, ingestFallback, out, "code repo must fail closed when the semantic graph cannot be built")
	assert.False(t, jobAPI.settled, "no settle must run for a failed ingest")
}

func TestFirstImportFailureRollback(t *testing.T) {
	tests := []struct {
		name         string
		preExisting  string
		wantRollback bool
	}{
		{name: "first import (null preExistingRepo) rolls back repository row", preExisting: `null`, wantRollback: true},
		{name: "absent preExistingRepo field rolls back repository row", preExisting: "", wantRollback: true},
		{name: "existing repo (update import) keeps repository row", preExisting: `{"id":"rid-1","isPublic":true}`, wantRollback: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeIngestStore{}
			jobAPI := &fakeJobAPI{failSettle: true}
			deps, sha := makeLadderDeps(t, store, jobAPI, map[string]string{
				"docs/a.md": "a", "docs/b.md": "b", "docs/c.md": "c",
				"docs/d.md": "d", "docs/e.md": "e", "README.md": "r",
			}, false)

			options := map[string]any{"isPublic": true, "gitSha": sha}
			envelopeMap := map[string]any{
				"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
				"options": options,
			}
			if tt.preExisting != "" {
				envelopeMap["preExistingRepo"] = json.RawMessage(tt.preExisting)
				if tt.preExisting != "null" {
					store.peekResult = &PeekRepoResult{Id: "rid-1", GitSha: &sha}
				}
			}
			rawParams, err := json.Marshal(envelopeMap)
			require.NoError(t, err)
			job := JobRow{Id: "rb-job", Owner: "o", Repo: "r", Branch: "main", Params: rawParams}

			out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
			assert.Equal(t, ingestFallback, out, "settle failure must fail the ingest")
			if tt.wantRollback {
				assert.Equal(t, 1, store.repoDeleted, "first-import repository row must be rolled back")
			} else {
				assert.Equal(t, 0, store.repoDeleted, "existing repository row must be preserved")
			}
		})
	}
}

func TestUpdateImportFailureCompensateRollback(t *testing.T) {
	oldSha := "old-sha-initial"
	tests := []struct {
		name              string
		isExisting        bool
		oldSha            *string
		failPoint         string
		wantRepoDeleted   int
		wantRestoreCalled int
		wantRestoredSha   *string
		wantErrorMsg      string
	}{
		{
			name:              "existing repo fails at settle -> gitSha restored to oldSha, repo row preserved",
			isExisting:        true,
			oldSha:            &oldSha,
			failPoint:         "settle",
			wantRepoDeleted:   0,
			wantRestoreCalled: 1,
			wantRestoredSha:   &oldSha,
			wantErrorMsg:      "更新导入在结算阶段失败，内容可能处于新旧混合状态；gitSha 已回滚，重试导入即可自愈",
		},
		{
			name:              "existing repo fails at snapshot -> gitSha restored to oldSha, repo row preserved",
			isExisting:        true,
			oldSha:            &oldSha,
			failPoint:         "snap",
			wantRepoDeleted:   0,
			wantRestoreCalled: 1,
			wantRestoredSha:   &oldSha,
			wantErrorMsg:      "更新导入在结算阶段失败，内容可能处于新旧混合状态；gitSha 已回滚，重试导入即可自愈",
		},
		{
			name:              "first import fails at settle -> repo row deleted, no gitSha restoration",
			isExisting:        false,
			oldSha:            nil,
			failPoint:         "settle",
			wantRepoDeleted:   1,
			wantRestoreCalled: 0,
			wantRestoredSha:   nil,
			wantErrorMsg:      "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeIngestStore{}
			if tt.failPoint == "snap" {
				store.failAt = "snap"
			}
			jobAPI := &fakeJobAPI{failSettle: tt.failPoint == "settle"}

			deps, newSha := makeLadderDeps(t, store, jobAPI, map[string]string{
				"docs/intro.md": "intro",
				"README.md":     "readme",
			}, false)

			var emittedErrors []string
			deps.Emit = func(eventType string, payload map[string]any) {
				if eventType == "error" && payload != nil {
					if m, ok := payload["message"].(string); ok {
						emittedErrors = append(emittedErrors, m)
					}
				}
			}

			if tt.isExisting {
				store.peekResult = &PeekRepoResult{Id: "rid-1", GitSha: tt.oldSha}
			} else {
				store.peekResult = nil
			}

			envelopeMap := map[string]any{
				"kind": "repo", "userId": "u1", "branch": "main", "edition": "",
				"options": map[string]any{"isPublic": true, "gitSha": newSha},
			}
			rawParams, err := json.Marshal(envelopeMap)
			require.NoError(t, err)

			job := JobRow{Id: "job-compensate", Owner: "o", Repo: "r", Branch: "main", Params: rawParams}

			out := runIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
			assert.Equal(t, ingestFallback, out)

			assert.Equal(t, 1, store.peekCount, "commit must peek repository existence")
			assert.Equal(t, tt.wantRepoDeleted, store.repoDeleted)
			assert.Equal(t, tt.wantRestoreCalled, store.restoreShaCount)
			if tt.wantRestoredSha != nil {
				require.NotNil(t, store.lastRestoredSha)
				assert.Equal(t, *tt.wantRestoredSha, *store.lastRestoredSha)
			}
			if tt.wantErrorMsg != "" {
				assert.Contains(t, emittedErrors, tt.wantErrorMsg)
			}
		})
	}
}

func TestLoadPatternsVirtualChapterPrefixes(t *testing.T) {
	patterns := DefaultPatterns()
	require.NotNil(t, patterns, "注册表不可达(cwd 应为包目录)")
	require.NotEmpty(t, patterns.VirtualChapterPathPrefixes, "virtualChapterPathPrefixes 必须非空——漏字段即虚拟章判定全灭")
	assert.True(t, patterns.IsVirtualChapterPath("chapters/01.mdx"), "chapters/NN.mdx 应判虚拟章")
	assert.False(t, patterns.IsVirtualChapterPath("docs/intro.md"), "真实文件不应误判")
}

type mockProgressStore struct {
	fakeIngestStore
	mu      sync.Mutex
	reports []struct {
		JobID    string
		Step     string
		Progress int
	}
}

func (m *mockProgressStore) UpdateImportJobProgress(_ context.Context, jobID, step string, progress int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reports = append(m.reports, struct {
		JobID    string
		Step     string
		Progress int
	}{JobID: jobID, Step: step, Progress: progress})
	return nil
}

func TestIngestProgressReporter(t *testing.T) {
	tests := []struct {
		name        string
		jobID       string
		ops         func(r *ingestProgressReporter)
		wantReports int
		wantSteps   []string
		wantProgs   []int
	}{
		{
			name:  "first call reports and throttles within interval",
			jobID: "job-p1",
			ops: func(r *ingestProgressReporter) {
				r.Report(context.Background(), "step 1", 10, false)
				r.Report(context.Background(), "step 2", 20, false)
			},
			wantReports: 1,
			wantSteps:   []string{"step 1"},
			wantProgs:   []int{10},
		},
		{
			name:  "force bypasses throttling and maintains monotonic progress",
			jobID: "job-p2",
			ops: func(r *ingestProgressReporter) {
				r.Report(context.Background(), "step 1", 30, true)
				r.Report(context.Background(), "step 2", 20, true)
				r.Report(context.Background(), "step 3", 50, true)
			},
			wantReports: 3,
			wantSteps:   []string{"step 1", "step 2", "step 3"},
			wantProgs:   []int{30, 30, 50},
		},
		{
			name:  "empty job ID never reports",
			jobID: "",
			ops: func(r *ingestProgressReporter) {
				r.Report(context.Background(), "step 1", 10, true)
			},
			wantReports: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &mockProgressStore{}
			r := newIngestProgressReporter(store, tt.jobID, 100*time.Millisecond)
			tt.ops(r)
			assert.Len(t, store.reports, tt.wantReports)
			if tt.wantReports > 0 {
				for i, rep := range store.reports {
					assert.Equal(t, tt.jobID, rep.JobID)
					if i < len(tt.wantSteps) {
						assert.Equal(t, tt.wantSteps[i], rep.Step)
					}
					if i < len(tt.wantProgs) {
						assert.Equal(t, tt.wantProgs[i], rep.Progress)
					}
				}
			}
		})
	}
}

func TestRunWebDocIngestFailClosed(t *testing.T) {
	tests := []struct {
		name        string
		targetUrl   string
		firecrawl   FirecrawlAPI
		wantOutcome ingestOutcome
		wantEvent   string
		wantMsgSub  string
	}{
		{
			name:        "empty target URL fails closed",
			targetUrl:   "",
			firecrawl:   nil,
			wantOutcome: ingestFallback,
			wantEvent:   "error",
			wantMsgSub:  "目标 URL 为空",
		},
		{
			name:        "nil firecrawl fails closed without panic when fastpath fails",
			targetUrl:   "http://127.0.0.1:54321/nonexistent",
			firecrawl:   nil,
			wantOutcome: ingestFallback,
			wantEvent:   "error",
			wantMsgSub:  "Firecrawl 抓取服务未配置",
		},
		{
			name:        "firecrawl error fails closed with error event",
			targetUrl:   "http://127.0.0.1:54321/nonexistent",
			firecrawl:   &fakeFirecrawl{err: assert.AnError},
			wantOutcome: ingestFallback,
			wantEvent:   "error",
			wantMsgSub:  "网页文档抓取失败",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var emittedType string
			var emittedPayload map[string]any
			deps := IngestBodyDeps{
				Store:     &fakeIngestStore{},
				Firecrawl: tt.firecrawl,
				Emit: func(eventType string, payload map[string]any) {
					emittedType = eventType
					emittedPayload = payload
				},
			}
			job := JobRow{
				Id:    "web-job-1",
				Owner: "test-owner",
				Repo:  "test-repo",
			}
			envelope := ImportJobEnvelope{
				Kind:   "web-doc",
				UserId: "test-user",
				Options: EnvelopeOptions{
					Url:      tt.targetUrl,
					MaxPages: 5,
				},
			}

			outcome := runWebDocIngest(context.Background(), loadConfigFromEnv(), deps, job, envelope)
			assert.Equal(t, tt.wantOutcome, outcome)
			assert.Equal(t, tt.wantEvent, emittedType)
			if tt.wantMsgSub != "" {
				msg, _ := emittedPayload["message"].(string)
				assert.Contains(t, msg, tt.wantMsgSub)
			}
		})
	}
}

func TestRunIngestBody_ScopedUnpackPrefixPassed(t *testing.T) {
	tests := []struct {
		name         string
		prefix       string
		prefixFilter string
		wantScope    string
	}{
		{
			name:      "explicit prefix passed to EnsureWithCap",
			prefix:    "src/audio",
			wantScope: "src/audio",
		},
		{
			name:         "prefixFilter fallback passed to EnsureWithCap",
			prefixFilter: "src/video",
			wantScope:    "src/video",
		},
		{
			name:      "empty prefix passed as empty scope",
			prefix:    "",
			wantScope: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var receivedScope string
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if scope, ok := body["prefixScope"].(string); ok {
					receivedScope = scope
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer ts.Close()

			root := t.TempDir()
			sha := "abc1234"
			dir := filepath.Join(root, "o", "r", sha)
			require.NoError(t, os.MkdirAll(dir, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Title"), 0o644))
			if tt.wantScope != "" {
				sub := filepath.Join(dir, filepath.FromSlash(tt.wantScope))
				require.NoError(t, os.MkdirAll(sub, 0o755))
				require.NoError(t, os.WriteFile(filepath.Join(sub, "index.md"), []byte("# Doc"), 0o644))
			}

			store := &fakeIngestStore{}
			jobAPI := &fakeJobAPI{}
			patterns := DefaultPatterns()

			deps := IngestBodyDeps{
				Store:       store,
				Archive:     NewArchiveClient(ts.URL, "tok"),
				Web:         jobAPI,
				SettleJob:   jobAPI.Settle,
				ArchiveRoot: root,
				Patterns:    patterns,
			}

			opts := map[string]any{
				"isPublic": true,
				"gitSha":   sha,
			}
			if tt.prefix != "" {
				opts["prefix"] = tt.prefix
			}
			if tt.prefixFilter != "" {
				opts["prefixFilter"] = tt.prefixFilter
			}

			params, err := json.Marshal(map[string]any{
				"kind":    "code",
				"userId":  "u1",
				"options": opts,
			})
			require.NoError(t, err)

			job := JobRow{
				Id:     "test-job",
				Owner:  "o",
				Repo:   "r",
				Branch: "main",
				Params: params,
			}

			_ = RunIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
			assert.Equal(t, tt.wantScope, receivedScope, "EnsureWithCap 必须准确收到透传的 prefixScope")
		})
	}
}

type progressReportCall struct {
	step     string
	progress int
}

type progressTrackingStore struct {
	fakeIngestStore
	mu      sync.Mutex
	reports []progressReportCall
}

func (s *progressTrackingStore) UpdateImportJobProgress(_ context.Context, _ string, step string, progress int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reports = append(s.reports, progressReportCall{step: step, progress: progress})
	return nil
}

func TestRunIngestBody_ArchiveProgressReporting(t *testing.T) {
	tests := []struct {
		name                string
		incomingProgress    []archive.Progress
		progressDelays      []time.Duration
		cancelCtxBeforeCall bool
		wantEmitsMin        int
		wantEmitsMax        int
		checkPayload        func(t *testing.T, payloads []map[string]any, reports []progressReportCall)
	}{
		{
			name: "single progress update emits speed and step description",
			incomingProgress: []archive.Progress{
				{
					DownloadedBytes: 1024 * 1024,
					TotalBytes:      2 * 1024 * 1024,
					ExtractedBytes:  2 * 1024 * 1024,
					ExtractedFiles:  5,
					CurrentFile:     "src/index.ts",
					SpeedBps:        8.2 * 1024 * 1024,
					SpeedFormatted:  "8.2 MB/s",
					Percent:         50.0,
				},
			},
			wantEmitsMin: 1,
			wantEmitsMax: 1,
			checkPayload: func(t *testing.T, payloads []map[string]any, reports []progressReportCall) {
				t.Helper()
				require.Len(t, payloads, 1)
				p := payloads[0]
				assert.Equal(t, 8.2*1024*1024, p["speedBps"])
				assert.Equal(t, "8.2 MB/s", p["speedFormatted"])
				assert.Equal(t, 50.0, p["percent"])
				assert.Equal(t, "src/index.ts", p["currentFile"])
				assert.Contains(t, p["message"], "8.2 MB/s")
				assert.Contains(t, p["message"], "50.0%")
				assert.Contains(t, p["message"], "src/index.ts")

				require.NotEmpty(t, reports)
				lastRep := reports[len(reports)-1]
				assert.Contains(t, lastRep.step, "[2/5] 装载并解压代码仓归档 (8.2 MB/s, 50.0%)")
				assert.Equal(t, 29, lastRep.progress)
			},
		},
		{
			name: "throttling drops rapid updates under 1 second",
			incomingProgress: []archive.Progress{
				{DownloadedBytes: 100, Percent: 10.0, SpeedFormatted: "1.0 MB/s", CurrentFile: "a.go"},
				{DownloadedBytes: 200, Percent: 20.0, SpeedFormatted: "2.0 MB/s", CurrentFile: "b.go"},
				{DownloadedBytes: 300, Percent: 30.0, SpeedFormatted: "3.0 MB/s", CurrentFile: "c.go"},
			},
			progressDelays: []time.Duration{0, 10 * time.Millisecond, 20 * time.Millisecond},
			wantEmitsMin:   1,
			wantEmitsMax:   1,
			checkPayload: func(t *testing.T, payloads []map[string]any, reports []progressReportCall) {
				t.Helper()
				require.Len(t, payloads, 1)
				assert.Equal(t, 10.0, payloads[0]["percent"])
			},
		},
		{
			name: "rapid completion update under 1 second bypasses throttling",
			incomingProgress: []archive.Progress{
				{DownloadedBytes: 100, Percent: 20.0, SpeedFormatted: "1.0 MB/s", CurrentFile: "a.go"},
				{DownloadedBytes: 500, Percent: 100.0, SpeedFormatted: "5.0 MB/s", CurrentFile: "b.go"},
			},
			progressDelays: []time.Duration{0, 20 * time.Millisecond},
			wantEmitsMin:   2,
			wantEmitsMax:   2,
			checkPayload: func(t *testing.T, payloads []map[string]any, reports []progressReportCall) {
				t.Helper()
				require.Len(t, payloads, 2)
				assert.Equal(t, 20.0, payloads[0]["percent"])
				assert.Equal(t, 100.0, payloads[1]["percent"])
				require.NotEmpty(t, reports)
				lastRep := reports[len(reports)-1]
				assert.Equal(t, 38, lastRep.progress)
				assert.Contains(t, lastRep.step, "100.0%")
			},
		},
		{
			name: "cached archive progress without currentFile formatting",
			incomingProgress: []archive.Progress{
				{
					DownloadedBytes: 500,
					Percent:         100.0,
					SpeedFormatted:  "cached",
					CurrentFile:     "cached",
				},
			},
			wantEmitsMin: 1,
			wantEmitsMax: 1,
			checkPayload: func(t *testing.T, payloads []map[string]any, reports []progressReportCall) {
				t.Helper()
				require.Len(t, payloads, 1)
				p := payloads[0]
				assert.Equal(t, "cached", p["speedFormatted"])
				assert.Equal(t, 100.0, p["percent"])
				assert.NotContains(t, p["message"], " · cached", "cached 标记不作为文件名后缀附加")
			},
		},
		{
			name: "cancelled context safely drops further progress updates",
			incomingProgress: []archive.Progress{
				{DownloadedBytes: 100, Percent: 10.0, SpeedFormatted: "1.0 MB/s"},
			},
			cancelCtxBeforeCall: true,
			wantEmitsMin:        0,
			wantEmitsMax:        0,
			checkPayload: func(t *testing.T, payloads []map[string]any, reports []progressReportCall) {
				t.Helper()
				assert.Empty(t, payloads)
				assert.Empty(t, reports)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var emitMu sync.Mutex
			var emittedEvents []map[string]any

			store := &progressTrackingStore{}
			reporter := newIngestProgressReporter(store, "test-job-prog", 0)

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tt.cancelCtxBeforeCall {
				cancel()
			}

			emit := func(eventType string, payload map[string]any) {
				if eventType == "progress" {
					emitMu.Lock()
					emittedEvents = append(emittedEvents, payload)
					emitMu.Unlock()
				}
			}

			onProgress := newArchiveProgressHandler(ctx, reporter, emit)

			for i, p := range tt.incomingProgress {
				if len(tt.progressDelays) > i && tt.progressDelays[i] > 0 {
					time.Sleep(tt.progressDelays[i])
				}
				onProgress(p)
			}

			emitMu.Lock()
			count := len(emittedEvents)
			emitMu.Unlock()
			assert.GreaterOrEqual(t, count, tt.wantEmitsMin)
			assert.LessOrEqual(t, count, tt.wantEmitsMax)

			store.mu.Lock()
			reportsCopy := make([]progressReportCall, len(store.reports))
			copy(reportsCopy, store.reports)
			store.mu.Unlock()

			tt.checkPayload(t, emittedEvents, reportsCopy)
		})
	}
}

func createTestTarGz(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, content := range entries {
		err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content))})
		require.NoError(t, err)
		_, err = tw.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, tw.Close())
	require.NoError(t, gw.Close())
	return buf.Bytes()
}

func TestRunIngestBody_LiveArchiveEnsureProgress(t *testing.T) {
	tests := []struct {
		name        string
		scopePrefix string
	}{
		{
			name:        "full archive ensure emits progress events and completes",
			scopePrefix: "",
		},
		{
			name:        "scoped archive ensure emits progress events and completes",
			scopePrefix: "src",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			sha := "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

			gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-gzip")
				tarData := createTestTarGz(t, map[string]string{
					"owner-repo-" + sha + "/README.md":   "# Live Test\n",
					"owner-repo-" + sha + "/src/main.go": "package main\n\nfunc main() {}\n",
					"owner-repo-" + sha + "/src/util.go": "package main\n\nfunc util() {}\n",
				})
				w.Header().Set("Content-Length", fmt.Sprintf("%d", len(tarData)))
				_, _ = w.Write(tarData)
			}))
			defer gh.Close()

			cfg := archive.Config{
				ArchiveRoot:              root,
				GitHubAPIBase:            gh.URL,
				UserAgent:                "test-agent",
				InternalToken:            "tok",
				DatabaseURL:              "postgres://unused",
				EntryCapBytes:            1024 * 1024,
				ArchiveDownloadTimeoutMs: 5000,
			}
			svc := archive.NewEnsureService(cfg)
			client := NewLocalArchiveClient(svc)

			var emittedMu sync.Mutex
			var progressEvents []map[string]any

			emit := func(eventType string, payload map[string]any) {
				if eventType == "progress" {
					emittedMu.Lock()
					progressEvents = append(progressEvents, payload)
					emittedMu.Unlock()
				}
			}

			store := &progressTrackingStore{
				fakeIngestStore: fakeIngestStore{repoId: "test-repo-id"},
			}
			jobAPI := &fakeJobAPI{}
			patterns := DefaultPatterns()
			defs, _ := LoadLanguageDefinitions("")
			graphDir := t.TempDir()

			deps := IngestBodyDeps{
				Store:       store,
				Archive:     client,
				Web:         jobAPI,
				SettleJob:   jobAPI.Settle,
				ArchiveRoot: root,
				Patterns:    patterns,
				Languages:   defs,
				GraphDir:    graphDir,
				Emit:        emit,
			}

			opts := map[string]any{
				"isPublic": true,
				"gitSha":   sha,
			}
			if tt.scopePrefix != "" {
				opts["prefix"] = tt.scopePrefix
			}

			params, err := json.Marshal(map[string]any{
				"kind":    "code",
				"userId":  "u1",
				"options": opts,
			})
			require.NoError(t, err)

			job := JobRow{
				Id:     "test-live-progress-job",
				Owner:  "owner",
				Repo:   "repo",
				Branch: "main",
				Params: params,
			}

			outcome := RunIngestBody(context.Background(), loadConfigFromEnv(), deps, job)
			assert.Equal(t, Done, outcome)

			emittedMu.Lock()
			count := len(progressEvents)
			emittedMu.Unlock()
			assert.Greater(t, count, 0, "真实归档下载解压必须触发至少一次 progress 事件发射")
			first := progressEvents[0]
			assert.NotEmpty(t, first["speedFormatted"], "格式化速度必须非空")
			assert.GreaterOrEqual(t, first["percent"], 0.0, "进度百分比必须 >= 0")
			last := progressEvents[count-1]
			assert.Equal(t, 100.0, last["percent"], "真实归档下载解压完成后最终必须发射 100% 进度事件")
		})
	}
}

func TestEnvelopeOptionsWebDocScopeDecode(t *testing.T) {
	tests := []struct {
		name string
		json string
		want EnvelopeOptions
	}{
		{
			name: "explicit custom scope round-trips fully",
			json: `{"kind":"web-doc","options":{"url":"https://eve.dev/docs","scopeMode":"custom","primaryDocPrefix":"/docs","allowedPrefixes":["/docs","/integrations"],"moduleTabs":[{"id":"docs","label":"Docs","path":"/docs","kind":"doc"},{"id":"changelog","label":"Changelog","path":"/changelog","kind":"changelog"}]}}`,
			want: EnvelopeOptions{
				Url:              "https://eve.dev/docs",
				ScopeMode:        "custom",
				PrimaryDocPrefix: "/docs",
				AllowedPrefixes:  []string{"/docs", "/integrations"},
				ModuleTabs: []webdoc.ModuleTab{
					{ID: "docs", Label: "Docs", Path: "/docs", Kind: "doc"},
					{ID: "changelog", Label: "Changelog", Path: "/changelog", Kind: "changelog"},
				},
			},
		},
		{
			name: "auto fallback scope stays empty",
			json: `{"kind":"web-doc","options":{"url":"https://eve.dev","scopeMode":"","primaryDocPrefix":"","allowedPrefixes":[]}}`,
			want: EnvelopeOptions{Url: "https://eve.dev", AllowedPrefixes: []string{}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var envelope ImportJobEnvelope
			require.NoError(t, json.Unmarshal([]byte(tt.json), &envelope))
			assert.Equal(t, "web-doc", envelope.Kind)
			assert.Equal(t, tt.want.ScopeMode, envelope.Options.ScopeMode)
			assert.Equal(t, tt.want.PrimaryDocPrefix, envelope.Options.PrimaryDocPrefix)
			assert.Equal(t, tt.want.AllowedPrefixes, envelope.Options.AllowedPrefixes)
			assert.Equal(t, tt.want.ModuleTabs, envelope.Options.ModuleTabs)
		})
	}
}

func TestEmitIngestErrorStructuredGatewayFields(t *testing.T) {
	tests := []struct {
		name           string
		prefix         string
		err            error
		wantCode       string
		wantProvider   string
		wantModel      string
		wantUpStatus   int
		wantUpCode     string
		wantUpMessage  string
		wantDisplayMsg string
	}{
		{
			name:   "direct LlmGatewayError emits structured SSE error fields",
			prefix: "大纲章节规划阶梯执行失败: ",
			err: &client.LlmGatewayError{
				Code:           client.ErrCodeUpstreamQuotaExceeded,
				Message:        "已达到 5 小时使用上限",
				Status:         402,
				Provider:       "zhipu",
				Model:          "glm-5.3-flash",
				UpstreamStatus: 429,
				UpstreamCode:   "1308",
			},
			wantCode:       client.ErrCodeUpstreamQuotaExceeded,
			wantProvider:   "zhipu",
			wantModel:      "glm-5.3-flash",
			wantUpStatus:   429,
			wantUpCode:     "1308",
			wantUpMessage:  "已达到 5 小时使用上限",
			wantDisplayMsg: "大纲章节规划阶梯执行失败: 已达到 5 小时使用上限",
		},
		{
			name:   "wrapped LlmGatewayError unwraps structured fields",
			prefix: "语义图谱构建失败：",
			err: fmt.Errorf("build failed: %w", &client.LlmGatewayError{
				Code:           client.ErrCodeUpstreamAuthError,
				Message:        "Invalid API key",
				Status:         401,
				Provider:       "openai",
				Model:          "gpt-4o",
				UpstreamStatus: 401,
				UpstreamCode:   "invalid_api_key",
			}),
			wantCode:       client.ErrCodeUpstreamAuthError,
			wantProvider:   "openai",
			wantModel:      "gpt-4o",
			wantUpStatus:   401,
			wantUpCode:     "invalid_api_key",
			wantUpMessage:  "Invalid API key",
			wantDisplayMsg: "语义图谱构建失败：Invalid API key",
		},
		{
			name:           "non-gateway error emits plain message only",
			prefix:         "大纲章节规划阶梯执行失败: ",
			err:            fmt.Errorf("empty rule tree"),
			wantDisplayMsg: "大纲章节规划阶梯执行失败: empty rule tree",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotType string
			var gotPayload map[string]any
			deps := IngestBodyDeps{
				Emit: func(eventType string, payload map[string]any) {
					gotType = eventType
					gotPayload = payload
				},
			}
			emitIngestError(deps, tt.prefix, tt.err)
			assert.Equal(t, "error", gotType)
			assert.Equal(t, tt.wantDisplayMsg, gotPayload["message"])
			if tt.wantCode != "" {
				assert.Equal(t, tt.wantCode, gotPayload["code"])
				assert.Equal(t, tt.wantProvider, gotPayload["provider"])
				assert.Equal(t, tt.wantModel, gotPayload["model"])
				assert.Equal(t, tt.wantUpStatus, gotPayload["upstreamStatus"])
				assert.Equal(t, tt.wantUpCode, gotPayload["upstreamCode"])
				assert.Equal(t, tt.wantUpMessage, gotPayload["upstreamMessage"])
			} else {
				assert.Nil(t, gotPayload["code"])
			}
		})
	}
}

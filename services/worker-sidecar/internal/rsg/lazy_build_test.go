package rsg

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeGraphRepo struct {
	mu        sync.Mutex
	artifacts map[string]*SemanticGraphArtifact
	curated   map[string][]string
	loadCalls int
	saveCalls int
}

func newFakeGraphRepo() *fakeGraphRepo {
	return &fakeGraphRepo{
		artifacts: make(map[string]*SemanticGraphArtifact),
		curated:   make(map[string][]string),
	}
}

func (f *fakeGraphRepo) LoadCuratedPaths(_ context.Context, owner, repo string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.curated[owner+"/"+repo], nil
}

func (f *fakeGraphRepo) key(owner, repo, sha string) string {
	return owner + "/" + repo + "@" + sha
}

func (f *fakeGraphRepo) LoadArtifact(_ context.Context, owner, repo, sha string) (*SemanticGraphArtifact, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loadCalls++
	return f.artifacts[f.key(owner, repo, sha)], nil
}

func (f *fakeGraphRepo) SaveArtifact(_ context.Context, owner, repo, sha string, artifact *SemanticGraphArtifact) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saveCalls++
	f.artifacts[f.key(owner, repo, sha)] = artifact
	return nil
}

func TestLoadOrBuildSemanticGraph_DBAndLazyBackfill(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T)
	}{
		{
			name: "loads persisted artifact from DB and warms local disk cache",
			run: func(t *testing.T) {
				t.Helper()
				graphDir := t.TempDir()
				archiveRoot := t.TempDir()
				repo := newFakeGraphRepo()
				sha := "1111111111111111111111111111111111111111"
				repo.artifacts["acme/lib@"+sha] = &SemanticGraphArtifact{
					Version: 2,
					GitSha:  sha,
					Nodes:   []SemanticGraphArtifactNode{{Path: "src/index.ts", Role: RoleEntryPoint, PageRank: 0.5}},
					SymbolsByFile: map[string][]SymbolEntry{
						"src/index.ts": {{Name: "createApp", Kind: "function", StartLine: 1, EndLine: 5, Exported: true}},
					},
				}

				h := NewHandler(Config{ArchiveRoot: archiveRoot, SemanticGraphDir: graphDir}, nil, nil)
				h.SetGraphRepo(repo)

				art, err := h.LoadOrBuildSemanticGraph(context.Background(), "acme", "lib", sha)
				require.NoError(t, err)
				require.NotNil(t, art)
				assert.Equal(t, 1, repo.loadCalls)
				assert.Len(t, art.SymbolsByFile["src/index.ts"], 1)

				diskLoaded, derr := LoadSemanticGraphArtifact(graphDir, "acme", "lib", sha)
				require.NoError(t, derr)
				require.NotNil(t, diskLoaded)
			},
		},
		{
			name: "missing disk and DB triggers archive ensurer, builds AST symbols, and persists to DB",
			run: func(t *testing.T) {
				t.Helper()
				graphDir := t.TempDir()
				archiveRoot := t.TempDir()
				repo := newFakeGraphRepo()
				sha := "2222222222222222222222222222222222222222"
				ensureCalled := 0

				h := NewHandler(Config{ArchiveRoot: archiveRoot, SemanticGraphDir: graphDir}, nil, nil)
				h.SetGraphRepo(repo)
				h.SetArchiveEnsurer(func(_ context.Context, owner, repoName, s string) (string, error) {
					ensureCalled++
					dir := archive.ArchiveDirFor(archiveRoot, owner, repoName, s)
					require.NoError(t, os.MkdirAll(filepath.Join(dir, "pkg"), 0o755))
					src := "package pkg\n\nfunc HelloWorld(name string) string {\n\treturn name\n}\n"
					require.NoError(t, os.WriteFile(filepath.Join(dir, "pkg", "hello.go"), []byte(src), 0o644))
					return dir, nil
				})

				bodyBytes, _ := json.Marshal(SymbolSearchRequest{
					Owner: "acme",
					Repo:  "hello",
					Sha:   sha,
					Query: "Hello",
				})
				req := httptest.NewRequest(http.MethodPost, "/v1/graph/symbol-search", bytes.NewReader(bodyBytes))
				rec := httptest.NewRecorder()
				h.HandleSymbolSearch(rec, req)

				require.Equal(t, http.StatusOK, rec.Code)
				var resp SymbolSearchResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
				assert.True(t, resp.Ok)
				require.NotEmpty(t, resp.Symbols)
				assert.Equal(t, "HelloWorld", resp.Symbols[0].Name)
				assert.Equal(t, 1, ensureCalled)
				assert.Equal(t, 1, repo.saveCalls)
			},
		},
		{
			name: "giant repo (>1000 valid files) builds bounded stratified + curated RSG and persists to DB",
			run: func(t *testing.T) {
				t.Helper()
				graphDir := t.TempDir()
				archiveRoot := t.TempDir()
				repo := newFakeGraphRepo()
				repo.curated["mega/mono"] = []string{"extensions/special/deep/curated_target.ts"}
				sha := "4444444444444444444444444444444444444444"

				dir := archive.ArchiveDirFor(archiveRoot, "mega", "mono", sha)
				// 构建 >1000 个有效源码文件（跨越多个顶层目录）
				for _, top := range []string{"apps", "packages", "src", "extensions"} {
					require.NoError(t, os.MkdirAll(filepath.Join(dir, top), 0o755))
				}
				require.NoError(t, os.MkdirAll(filepath.Join(dir, "extensions/special/deep"), 0o755))
				require.NoError(t, os.WriteFile(
					filepath.Join(dir, "extensions/special/deep/curated_target.ts"),
					[]byte("export function CuratedGatewayHook(): string { return 'ok'; }\n"),
					0o644,
				))
				for i := 0; i < 1050; i++ {
					top := []string{"apps", "packages", "src", "extensions"}[i%4]
					sub := filepath.Join(dir, top, "mod")
					if i%2 == 0 {
						sub = filepath.Join(dir, top)
					}
					require.NoError(t, os.MkdirAll(sub, 0o755))
					fileName := "file_" + filepath.Base(sub) + "_" + strconv.Itoa(i) + ".ts"
					require.NoError(t, os.WriteFile(filepath.Join(sub, fileName), []byte("export function fn"+strconv.Itoa(i)+"() { return "+strconv.Itoa(i)+"; }\n"), 0o644))
				}

				h := NewHandler(Config{ArchiveRoot: archiveRoot, SemanticGraphDir: graphDir}, nil, nil)
				h.SetGraphRepo(repo)

				art, err := h.LoadOrBuildSemanticGraph(context.Background(), "mega", "mono", sha)
				require.NoError(t, err)
				require.NotNil(t, art)
				assert.LessOrEqual(t, len(art.Nodes), giantRepoScopedMaxFiles)
				// 教学聚类精选文件虽在 3 层深处，仍必须优先入图并抽出真实符号
				syms, ok := art.SymbolsByFile["extensions/special/deep/curated_target.ts"]
				require.True(t, ok, "curated deep codeCluster file must be prioritized into bounded giant-repo RSG")
				require.NotEmpty(t, syms)
				assert.Equal(t, "CuratedGatewayHook", syms[0].Name)
				assert.Equal(t, 1, repo.saveCalls)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, tt.run)
	}
}

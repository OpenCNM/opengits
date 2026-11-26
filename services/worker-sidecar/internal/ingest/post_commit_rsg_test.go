package ingest

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakePostCommitGraphRepo struct {
	mu        sync.Mutex
	artifacts map[string]*SemanticGraphArtifact
	saveCalls int
}

func newFakePostCommitGraphRepo() *fakePostCommitGraphRepo {
	return &fakePostCommitGraphRepo{artifacts: make(map[string]*SemanticGraphArtifact)}
}

func (f *fakePostCommitGraphRepo) LoadArtifact(_ context.Context, owner, repo, sha string) (*SemanticGraphArtifact, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.artifacts[owner+"/"+repo+"@"+sha], nil
}

func (f *fakePostCommitGraphRepo) SaveArtifact(_ context.Context, owner, repo, sha string, artifact *SemanticGraphArtifact) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saveCalls++
	f.artifacts[owner+"/"+repo+"@"+sha] = artifact
	return nil
}

func TestEnsurePostCommitSemanticGraph(t *testing.T) {
	writeFile := func(t *testing.T, root, owner, repo, sha, rel, body string) GitNode {
		t.Helper()
		dir := archive.ArchiveDirFor(root, owner, repo, sha)
		full := filepath.Join(dir, filepath.FromSlash(rel))
		require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
		require.NoError(t, os.WriteFile(full, []byte(body), 0o644))
		return GitNode{Path: rel, Type: "blob", Size: int64(len(body))}
	}

	tests := []struct {
		name      string
		owner     string
		repo      string
		isGiant   bool
		setup     func(t *testing.T, archiveRoot string, sha string) ([]GitNode, map[string]any)
		wantSaved bool
		check     func(t *testing.T, art *SemanticGraphArtifact)
	}{
		{
			name:    "non-RSG ladder repo persists full RSG artifact at import completion",
			owner:   "acme",
			repo:    "custom-outline-app",
			isGiant: false,
			setup: func(t *testing.T, archiveRoot, sha string) ([]GitNode, map[string]any) {
				nodes := []GitNode{
					writeFile(t, archiveRoot, "acme", "custom-outline-app", sha, "src/main.ts", "export function bootApp(): string { return 'ready'; }\n"),
					writeFile(t, archiveRoot, "acme", "custom-outline-app", sha, "src/helper.ts", "export const VERSION = '1.0.0';\n"),
				}
				return nodes, map[string]any{
					"codeClusters": []ModuleSnapshot{
						{Title: "Core", Files: []string{"src/main.ts#bootApp"}},
					},
				}
			},
			wantSaved: true,
			check: func(t *testing.T, art *SemanticGraphArtifact) {
				require.NotNil(t, art)
				require.NotEmpty(t, art.SymbolsByFile["src/main.ts"])
				assert.Equal(t, "bootApp", art.SymbolsByFile["src/main.ts"][0].Name)
			},
		},
		{
			name:    "giant repo (>1000 files) builds bounded RSG prioritizing codeClusters files",
			owner:   "mega",
			repo:    "giant-mono",
			isGiant: true,
			setup: func(t *testing.T, archiveRoot, sha string) ([]GitNode, map[string]any) {
				writeFile(t, archiveRoot, "mega", "giant-mono", sha, "extensions/deep/nested/curated_entry.ts", "export function GiantCuratedInit(): boolean { return true; }\n")
				tops := []string{"apps", "packages", "src", "extensions"}
				for i := 0; i < 1050; i++ {
					top := tops[i%len(tops)]
					rel := top + "/mod/f_" + strconv.Itoa(i) + ".ts"
					writeFile(t, archiveRoot, "mega", "giant-mono", sha, rel, "export function f"+strconv.Itoa(i)+"() { return "+strconv.Itoa(i)+"; }\n")
				}
				return nil, map[string]any{
					"codeClusters": []ModuleSnapshot{
						{Title: "Extensions", Files: []string{"extensions/deep/nested/curated_entry.ts"}},
					},
				}
			},
			wantSaved: true,
			check: func(t *testing.T, art *SemanticGraphArtifact) {
				require.NotNil(t, art)
				assert.LessOrEqual(t, len(art.Nodes), rsg.GiantRepoScopedMaxFiles)
				syms := art.SymbolsByFile["extensions/deep/nested/curated_entry.ts"]
				require.NotEmpty(t, syms)
				assert.Equal(t, "GiantCuratedInit", syms[0].Name)
			},
		},
		{
			name:    "skips web-docs virtual owner cleanly",
			owner:   "web-docs",
			repo:    "docs-site",
			isGiant: false,
			setup: func(_ *testing.T, _ string, _ string) ([]GitNode, map[string]any) {
				return nil, nil
			},
			wantSaved: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			archiveRoot := t.TempDir()
			graphDir := t.TempDir()
			sha := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			repoStore := newFakePostCommitGraphRepo()
			nodes, patch := tt.setup(t, archiveRoot, sha)

			cfg := Config{ArchiveRoot: archiveRoot, SemanticGraphDir: graphDir}
			deps := IngestBodyDeps{
				ArchiveRoot: archiveRoot,
				GraphDir:    graphDir,
				GraphRepo:   repoStore,
				Patterns:    DefaultPatterns(),
				Languages:   rsg.DefaultLanguageDefinitions(),
			}
			job := JobRow{Owner: tt.owner, Repo: tt.repo}

			ensurePostCommitSemanticGraph(context.Background(), cfg, deps, job, sha, nodes, nil, patch, tt.isGiant)

			if !tt.wantSaved {
				assert.Equal(t, 0, repoStore.saveCalls)
				return
			}
			assert.Equal(t, 1, repoStore.saveCalls)
			if tt.check != nil {
				tt.check(t, repoStore.artifacts[tt.owner+"/"+tt.repo+"@"+sha])
			}
		})
	}
}

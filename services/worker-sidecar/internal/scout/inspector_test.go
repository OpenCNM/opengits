package scout

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestScoutServer(t *testing.T, archiveRoot, githubBase string) http.Handler {
	t.Helper()
	cfg := Config{
		ArchiveRoot:   archiveRoot,
		GitHubAPIBase: githubBase,
	}
	patterns := ingest.DefaultPatterns()
	h := NewHandler(cfg, func() Patterns { return patterns })
	mux := http.NewServeMux()
	internalAuth := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			token := r.Header.Get("x-internal-token")
			if token != "test-internal-token" {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("POST /v1/scout/inspect", internalAuth(h.HandleInspect))
	return mux
}

func setupTestScoutArchive(t *testing.T, root, owner, repo, sha string) {
	t.Helper()
	repoDir := filepath.Join(root, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(repoDir, "docs", "intro"), 0755))
	require.NoError(t, os.MkdirAll(filepath.Join(repoDir, "src"), 0755))
	require.NoError(t, os.MkdirAll(filepath.Join(repoDir, "node_modules", "pkg"), 0755))
	require.NoError(t, os.MkdirAll(filepath.Join(repoDir, ".github", "workflows"), 0755))

	// Markdown files
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "docs", "README.md"), []byte("# Hello"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "docs", "intro", "guide.md"), []byte("# Guide"), 0644))
	// High-priority migration file
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "CHANGELOG.md"), []byte("# Changelog"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "v2.0-migration.md"), []byte("# v2"), 0644))
	// Code file
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "src", "index.ts"), []byte("export const a = 1;"), 0644))
	// Excluded category files
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "archive.zip"), []byte("fake-zip"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "binary.exe"), []byte("fake-exe"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "docs", "manual.pdf"), []byte("fake-pdf"), 0644))
	// Noisy path file (should be ignored)
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "node_modules", "pkg", "index.js"), []byte("module.exports = {}"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, ".github", "workflows", "ci.yml"), []byte("name: CI"), 0644))
}

// 🧪 TestScoutInspect_ReadmeSnippet 验证本地归档中主 README 摘要正确提取
func TestScoutInspect_ReadmeSnippet(t *testing.T) {
	tempRoot := t.TempDir()
	owner := "acme"
	repo := "widget"
	sha := "sha-readme-123"
	repoDir := filepath.Join(tempRoot, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(repoDir, "src"), 0755))
	readmeContent := "# Acme Widget\n\nA modern tool for widget automation.\n\n## Installation\n`npm install acme-widget`"
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "README.md"), []byte(readmeContent), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "src", "index.ts"), []byte("export const a = 1;"), 0644))

	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	ins := NewInspector(Config{ArchiveRoot: tempRoot})
	res, err := ins.Inspect(context.Background(), ScoutInspectRequest{
		Owner: owner,
		Repo:  repo,
		Sha:   sha,
	}, patterns)

	require.NoError(t, err)
	require.NotNil(t, res)
	assert.True(t, res.ArchiveUsed)
	assert.Contains(t, res.ReadmeSnippet, "# Acme Widget")
	assert.Contains(t, res.ReadmeSnippet, "A modern tool for widget automation")
}

// 🧪 [1.16.1.3] TestScoutInspect_LocalArchive Table-Driven 验证本地归档优先直读与回退
func TestScoutInspect_LocalArchive(t *testing.T) {
	tempRoot := t.TempDir()
	setupTestScoutArchive(t, tempRoot, "facebook", "react", "sha-archive-123")

	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	tests := []struct {
		name            string
		req             ScoutInspectRequest
		expectArchive   bool
		expectError     bool
		minExcluded     int
		expectedMdFiles []string
	}{
		{
			name: "existing_sha_hits_local_archive",
			req: ScoutInspectRequest{
				Owner: "facebook",
				Repo:  "react",
				Sha:   "sha-archive-123",
			},
			expectArchive: true,
			expectError:   false,
			minExcluded:   3,
			expectedMdFiles: []string{
				"CHANGELOG.md",
				"v2.0-migration.md",
				"docs/README.md",
				"docs/intro/guide.md",
			},
		},
		{
			name: "missing_sha_archive_miss_without_remote_fails",
			req: ScoutInspectRequest{
				Owner: "facebook",
				Repo:  "react",
				Sha:   "non-existent-sha",
			},
			expectArchive: false,
			expectError:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{
				ArchiveRoot:   tempRoot,
				GitHubAPIBase: "http://127.0.0.1:0", // Invalid port to ensure no unwanted network access
			}

			res, err := InspectRepositoryTree(context.Background(), cfg, tt.req, patterns)
			if tt.expectError {
				require.Error(t, err)
				return
			}

			require.NoError(t, err)
			require.NotNil(t, res)

			assert.True(t, res.Ok)
			assert.Equal(t, tt.expectArchive, res.ArchiveUsed)
			assert.False(t, res.Truncated)
			assert.True(t, res.TotalNodeCount > 0)

			// Verify ExclusionReport
			assert.True(t, res.ExclusionReport.TotalExcludedCount >= tt.minExcluded)
			assert.True(t, res.ExclusionReport.ByCategory["archive"] >= 1)
			assert.True(t, res.ExclusionReport.ByCategory["executable"] >= 1)
			assert.True(t, res.ExclusionReport.ByCategory["office_media"] >= 1)
			assert.True(t, len(res.ExclusionReport.SampleExcludedFiles) <= 15)

			// Verify MarkdownFiles
			mdPaths := make([]string, len(res.MarkdownFiles))
			for i, f := range res.MarkdownFiles {
				mdPaths[i] = f.Path
			}
			for _, expected := range tt.expectedMdFiles {
				assert.Contains(t, mdPaths, expected)
			}

			// Verify Skeleton & Hash
			assert.NotEmpty(t, res.Skeleton)
			assert.NotEmpty(t, res.SkeletonHash)
			assert.Equal(t, SkeletonHashOf(res.Skeleton), res.SkeletonHash)

			// Verify DirTree
			assert.NotEmpty(t, res.DirTree)
			var srcNode *DirTreeNode
			for i := range res.DirTree {
				if res.DirTree[i].Path == "src/" {
					srcNode = &res.DirTree[i]
					break
				}
			}
			require.NotNil(t, srcNode, "DirTree must include src/")
			assert.Equal(t, 1, srcNode.CodeCount)
			assert.Equal(t, "typescript", srcNode.PrimaryLang)
			assert.Equal(t, []string{"index.ts"}, srcNode.KeyFiles)
		})
	}
}

// 🧪 [1.2.1.1] TestScoutInspect_MockGitHubAPI Table-Driven 验证 GitHub API 流式解析、截断补偿与异常处理
func TestScoutInspect_MockGitHubAPI(t *testing.T) {
	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	tests := []struct {
		name              string
		treeStatus        int
		treeBody          any
		contentsStatus    int
		contentsBody      any
		expectError       bool
		expectedTruncated bool
		expectedTotal     int
		expectedExcluded  int
		expectedMdFiles   []string
	}{
		{
			name:       "standard_streamed_tree",
			treeStatus: http.StatusOK,
			treeBody: map[string]any{
				"sha":       "sha-api-456",
				"truncated": false,
				"tree": []GitNode{
					{Path: "README.md", Type: "blob", Size: 200},
					{Path: "docs/getting-started.md", Type: "blob", Size: 300},
					{Path: "src/main.go", Type: "blob", Size: 1000},
					{Path: "dist/bundle.js", Type: "blob", Size: 5000},
					{Path: "archive.tar.gz", Type: "blob", Size: 500},
					{Path: "tool.wasm", Type: "blob", Size: 2000},
					{Path: "CHANGELOG.md", Type: "blob", Size: 800},
				},
			},
			expectError:       false,
			expectedTruncated: false,
			expectedTotal:     7,
			expectedExcluded:  2, // archive.tar.gz, tool.wasm
			expectedMdFiles:   []string{"README.md", "docs/getting-started.md", "CHANGELOG.md"},
		},
		{
			name:       "truncated_tree_with_contents_api_fallback",
			treeStatus: http.StatusOK,
			treeBody: map[string]any{
				"sha":       "sha-trunc-789",
				"truncated": true,
				"tree": []GitNode{
					{Path: "docs/intro.md", Type: "blob", Size: 400},
				},
			},
			contentsStatus: http.StatusOK,
			contentsBody: []map[string]any{
				{"path": "docs", "type": "dir", "size": 0},
				{"path": "README.md", "type": "file", "size": 500},
			},
			expectError:       false,
			expectedTruncated: true,
			expectedTotal:     3, // docs/intro.md, docs (tree), README.md (blob)
			expectedExcluded:  0,
			expectedMdFiles:   []string{"docs/intro.md", "README.md"},
		},
		{
			name:        "empty_repository_returns_error",
			treeStatus:  http.StatusNotFound,
			treeBody:    map[string]string{"message": "Not Found"},
			expectError: true,
		},
		{
			name:        "rate_limit_exceeded_returns_error",
			treeStatus:  http.StatusForbidden,
			treeBody:    map[string]string{"message": "API rate limit exceeded"},
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/repos/golang/go/contents" {
					w.WriteHeader(tt.contentsStatus)
					_ = json.NewEncoder(w).Encode(tt.contentsBody)
					return
				}
				w.WriteHeader(tt.treeStatus)
				_ = json.NewEncoder(w).Encode(tt.treeBody)
			}))
			defer server.Close()

			cfg := Config{
				ArchiveRoot:   t.TempDir(),
				GitHubAPIBase: server.URL,
				GitHubToken:   "test-token",
			}

			req := ScoutInspectRequest{
				Owner:  "golang",
				Repo:   "go",
				Branch: "main",
			}

			res, err := InspectRepositoryTree(context.Background(), cfg, req, patterns)
			if tt.expectError {
				require.Error(t, err)
				return
			}

			require.NoError(t, err)
			require.NotNil(t, res)

			assert.True(t, res.Ok)
			assert.False(t, res.ArchiveUsed)
			assert.Equal(t, tt.expectedTruncated, res.Truncated)
			assert.Equal(t, tt.expectedTotal, res.TotalNodeCount)
			assert.Equal(t, tt.expectedExcluded, res.ExclusionReport.TotalExcludedCount)

			mdPaths := make([]string, len(res.MarkdownFiles))
			for i, f := range res.MarkdownFiles {
				mdPaths[i] = f.Path
			}
			for _, expected := range tt.expectedMdFiles {
				assert.Contains(t, mdPaths, expected)
			}
		})
	}
}

// 🧪 [1.2.1.2] TestScoutInspect_MarkdownScope Table-Driven 验证作用域过滤与单文档模式
func TestScoutInspect_MarkdownScope(t *testing.T) {
	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	baseNodes := []GitNode{
		{Path: "README.md", Type: "blob"},
		{Path: "docs/getting-started.md", Type: "blob"},
		{Path: "docs/api/endpoints.md", Type: "blob"},
		{Path: "packages/core/README.md", Type: "blob"},
		{Path: "packages/core/docs/setup.md", Type: "blob"},
		{Path: "packages/ui/README.md", Type: "blob"},
		{Path: "manual/guide.md", Type: "blob"},
	}

	tests := []struct {
		name          string
		prefixFilter  string
		filePath      string
		singleDocMode bool
		expectedPaths []string
	}{
		{
			name:          "no_filter_returns_all_markdown",
			prefixFilter:  "",
			filePath:      "",
			singleDocMode: false,
			expectedPaths: []string{
				"README.md",
				"docs/getting-started.md",
				"docs/api/endpoints.md",
				"packages/core/README.md",
				"packages/core/docs/setup.md",
				"packages/ui/README.md",
				"manual/guide.md",
			},
		},
		{
			name:          "prefix_filter_scopes_to_docs_directory",
			prefixFilter:  "docs",
			filePath:      "",
			singleDocMode: false,
			expectedPaths: []string{
				"docs/getting-started.md",
				"docs/api/endpoints.md",
			},
		},
		{
			name:          "single_doc_mode_exact_match",
			prefixFilter:  "",
			filePath:      "manual/guide.md",
			singleDocMode: true,
			expectedPaths: []string{
				"manual/guide.md",
			},
		},
		{
			name:          "single_doc_mode_exact_match_priority_over_suffix",
			prefixFilter:  "",
			filePath:      "README.md",
			singleDocMode: true,
			expectedPaths: []string{
				"README.md",
			},
		},
		{
			name:          "single_doc_mode_suffix_match",
			prefixFilter:  "",
			filePath:      "setup.md",
			singleDocMode: true,
			expectedPaths: []string{
				"packages/core/docs/setup.md",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"sha":       "sha-scope",
					"truncated": false,
					"tree":      baseNodes,
				})
			}))
			defer server.Close()

			cfg := Config{
				ArchiveRoot:   t.TempDir(),
				GitHubAPIBase: server.URL,
			}

			req := ScoutInspectRequest{
				Owner:         "test",
				Repo:          "scope",
				PrefixFilter:  tt.prefixFilter,
				FilePath:      tt.filePath,
				SingleDocMode: tt.singleDocMode,
			}

			res, err := InspectRepositoryTree(context.Background(), cfg, req, patterns)
			require.NoError(t, err)
			require.NotNil(t, res)

			mdPaths := make([]string, len(res.MarkdownFiles))
			for i, f := range res.MarkdownFiles {
				mdPaths[i] = f.Path
			}
			assert.ElementsMatch(t, tt.expectedPaths, mdPaths)
		})
	}
}

// 🧪 [1.22.6.3] TestScoutInspect_DirTree_HierarchyAndNaturalOrder Table-Driven 验证多级树结构保持与自然排序
func TestScoutInspect_DirTree_HierarchyAndNaturalOrder(t *testing.T) {
	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	baseNodes := []GitNode{
		{Path: "docs", Type: "tree"},
		{Path: "docs/chapter-1", Type: "tree"},
		{Path: "docs/chapter-2", Type: "tree"},
		{Path: "docs/chapter-10", Type: "tree"},
		{Path: "docs/chapter-1/lesson.md", Type: "blob"},
		{Path: "docs/chapter-2/lesson.md", Type: "blob"},
		{Path: "docs/chapter-10/lesson.md", Type: "blob"},
		{Path: "docs/README.md", Type: "blob"},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sha":       "sha-tree",
			"truncated": false,
			"tree":      baseNodes,
		})
	}))
	defer server.Close()

	cfg := Config{
		ArchiveRoot:   t.TempDir(),
		GitHubAPIBase: server.URL,
	}

	req := ScoutInspectRequest{
		Owner: "test",
		Repo:  "dirtree",
	}

	res, err := InspectRepositoryTree(context.Background(), cfg, req, patterns)
	require.NoError(t, err)
	require.NotNil(t, res)

	// Top level should be docs/
	require.Len(t, res.DirTree, 1)
	docsNode := res.DirTree[0]
	assert.Equal(t, "docs/", docsNode.Path)
	assert.Equal(t, "docs", docsNode.Name)
	assert.Equal(t, 1, docsNode.Depth)
	assert.Equal(t, 4, docsNode.MdCount) // README.md + 3 lessons

	// Children of docs should be chapter-1, chapter-2, chapter-10 in natural order
	require.Len(t, docsNode.Children, 3)
	assert.Equal(t, "chapter-1", docsNode.Children[0].Name)
	assert.Equal(t, "chapter-2", docsNode.Children[1].Name)
	assert.Equal(t, "chapter-10", docsNode.Children[2].Name) // Natural sort: 10 comes AFTER 2!

	// Depth of children should be 2
	assert.Equal(t, 2, docsNode.Children[0].Depth)
	assert.Equal(t, 2, docsNode.Children[1].Depth)
	assert.Equal(t, 2, docsNode.Children[2].Depth)
}

// 🧪 [1.20.1.1] TestScoutInspect_DirTree_BudgetPruning Table-Driven 验证超过 2000 节点时整枝裁剪防 OOM
func TestScoutInspect_DirTree_BudgetPruning(t *testing.T) {
	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	// Create 2500 directories with varied markdown files
	var massiveNodes []GitNode
	for i := 1; i <= 2500; i++ {
		dirPath := fmt.Sprintf("module/sub_%04d", i)
		massiveNodes = append(massiveNodes, GitNode{Path: dirPath, Type: "tree"})
		// Give first 500 dirs more markdown files to ensure budget preserves them
		if i <= 500 {
			massiveNodes = append(massiveNodes, GitNode{Path: dirPath + "/index.md", Type: "blob"})
		}
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sha":       "sha-massive",
			"truncated": false,
			"tree":      massiveNodes,
		})
	}))
	defer server.Close()

	cfg := Config{
		ArchiveRoot:   t.TempDir(),
		GitHubAPIBase: server.URL,
	}

	req := ScoutInspectRequest{
		Owner: "massive",
		Repo:  "repo",
	}

	res, err := InspectRepositoryTree(context.Background(), cfg, req, patterns)
	require.NoError(t, err)
	require.NotNil(t, res)

	// Count total nodes in returned DirTree
	var countNodes func(nodes []DirTreeNode) int
	countNodes = func(nodes []DirTreeNode) int {
		cnt := len(nodes)
		for _, n := range nodes {
			cnt += countNodes(n.Children)
		}
		return cnt
	}

	totalTreeNodes := countNodes(res.DirTree)
	assert.True(t, totalTreeNodes <= DirTreeMaxNodes, "dirTree total nodes %d must be <= budget %d", totalTreeNodes, DirTreeMaxNodes)
}

// 🧪 [1.22.6.1] TestScoutHandler_HTTP Table-Driven 验证 POST /v1/scout/inspect 端点鉴权与契约
func TestScoutHandler_HTTP(t *testing.T) {
	tempRoot := t.TempDir()
	setupTestScoutArchive(t, tempRoot, "acme", "repo", "sha999")

	server := newTestScoutServer(t, tempRoot, "https://api.github.com")

	tests := []struct {
		name           string
		token          string
		payload        any
		expectedStatus int
		expectOk       bool
	}{
		{
			name:           "unauthorized_when_token_missing",
			token:          "",
			payload:        ScoutInspectRequest{Owner: "acme", Repo: "repo"},
			expectedStatus: http.StatusUnauthorized,
			expectOk:       false,
		},
		{
			name:           "unauthorized_when_token_invalid",
			token:          "bad-token",
			payload:        ScoutInspectRequest{Owner: "acme", Repo: "repo"},
			expectedStatus: http.StatusUnauthorized,
			expectOk:       false,
		},
		{
			name:           "bad_request_on_invalid_json",
			token:          "test-internal-token",
			payload:        "invalid json body",
			expectedStatus: http.StatusBadRequest,
			expectOk:       false,
		},
		{
			name:           "bad_request_on_missing_owner_repo",
			token:          "test-internal-token",
			payload:        ScoutInspectRequest{Owner: "", Repo: ""},
			expectedStatus: http.StatusBadRequest,
			expectOk:       false,
		},
		{
			name:           "bad_request_on_path_traversal",
			token:          "test-internal-token",
			payload:        ScoutInspectRequest{Owner: "../escape", Repo: "repo"},
			expectedStatus: http.StatusBadRequest,
			expectOk:       false,
		},
		{
			name:           "success_200_local_archive",
			token:          "test-internal-token",
			payload:        ScoutInspectRequest{Owner: "acme", Repo: "repo", Sha: "sha999"},
			expectedStatus: http.StatusOK,
			expectOk:       true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body []byte
			if s, ok := tt.payload.(string); ok {
				body = []byte(s)
			} else {
				body, _ = json.Marshal(tt.payload)
			}

			req := httptest.NewRequest(http.MethodPost, "/v1/scout/inspect", bytes.NewReader(body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			req.Header.Set("Content-Type", "application/json")

			rec := httptest.NewRecorder()
			server.ServeHTTP(rec, req)

			assert.Equal(t, tt.expectedStatus, rec.Code)

			if tt.expectOk {
				var res ScoutInspectResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
				assert.True(t, res.Ok)
				assert.True(t, res.ArchiveUsed)
				assert.NotEmpty(t, res.SkeletonHash)
			}
		})
	}
}

// 🧪 Table-Driven: TestScoutInspect_DirTree_CodeStats 验证 Inspect 端点输出包含代码统计、主语言与代表性源码选样
func TestScoutInspect_DirTree_CodeStats(t *testing.T) {
	patterns := ingest.DefaultPatterns()
	require.NotNil(t, patterns)

	tests := []struct {
		name        string
		nodes       []GitNode
		verifyTrees func(t *testing.T, dirTree []DirTreeNode)
	}{
		{
			name: "pure codebase (micrograd) returns rich code metadata in dirTree",
			nodes: []GitNode{
				{Path: "micrograd", Type: "tree"},
				{Path: "micrograd/engine.py", Type: "blob"},
				{Path: "micrograd/nn.py", Type: "blob"},
				{Path: "micrograd/__init__.py", Type: "blob"},
				{Path: "test", Type: "tree"},
				{Path: "test/test_engine.py", Type: "blob"},
				{Path: "README.md", Type: "blob"},
			},
			verifyTrees: func(t *testing.T, dirTree []DirTreeNode) {
				require.Len(t, dirTree, 2)

				mg := dirTree[0]
				assert.Equal(t, "micrograd/", mg.Path)
				assert.Equal(t, 0, mg.MdCount)
				assert.Equal(t, 3, mg.CodeCount)
				assert.Equal(t, "python", mg.PrimaryLang)
				assert.Equal(t, []string{"engine.py", "nn.py", "__init__.py"}, mg.KeyFiles)

				testNode := dirTree[1]
				assert.Equal(t, "test/", testNode.Path)
				assert.Equal(t, 0, testNode.MdCount)
				assert.Equal(t, 1, testNode.CodeCount)
				assert.Equal(t, "python", testNode.PrimaryLang)
				assert.Equal(t, []string{"test_engine.py"}, testNode.KeyFiles)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"sha":       "sha-code-stats",
					"truncated": false,
					"tree":      tt.nodes,
				})
			}))
			defer server.Close()

			cfg := Config{
				ArchiveRoot:   t.TempDir(),
				GitHubAPIBase: server.URL,
			}

			req := ScoutInspectRequest{
				Owner: "karpathy",
				Repo:  "micrograd",
			}

			res, err := InspectRepositoryTree(context.Background(), cfg, req, patterns)
			require.NoError(t, err)
			require.NotNil(t, res)
			tt.verifyTrees(t, res.DirTree)
		})
	}
}

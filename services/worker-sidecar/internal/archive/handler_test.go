package archive

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type testRepoSniffer struct{}

func (s *testRepoSniffer) SniffRepo(nodes []GitNode, isTreeTruncated bool) SniffProfile {
	var p SniffProfile
	p.IsTreeTruncated = isTreeTruncated
	p.LabRoots = []string{}
	p.TranslationRoots = []string{}
	p.ExcludeFromNav = []string{}
	p.SemanticTags = map[string]string{}
	p.GlobalAssets.Pdfs = []struct {
		Path string `json:"path"`
		Size int64  `json:"size"`
		Lang string `json:"lang,omitempty"`
	}{}
	p.GlobalAssets.Translations = []struct {
		Lang string `json:"lang"`
		Dir  string `json:"dir"`
	}{}
	p.GlobalAssets.BuildScripts = []string{}
	p.GlobalAssets.Misc = []string{}

	mdCount := 0
	for _, n := range nodes {
		if strings.HasSuffix(n.Path, ".md") {
			mdCount++
		}
		if strings.HasSuffix(n.Path, ".pdf") {
			p.GlobalAssets.Pdfs = append(p.GlobalAssets.Pdfs, struct {
				Path string `json:"path"`
				Size int64  `json:"size"`
				Lang string `json:"lang,omitempty"`
			}{Path: n.Path, Size: n.Size, Lang: "zh"})
		}
	}
	if mdCount >= 2 && len(p.GlobalAssets.Pdfs) > 0 {
		p.RepoType = "notebook"
		p.Tier = "C"
	} else {
		p.RepoType = "codebase"
		p.Tier = "D"
	}
	return p
}

func (s *testRepoSniffer) ComputeRepoScale(nodes []GitNode) ScaleDecision {
	return ScaleDecision{
		Scale:      "normal",
		Confidence: "high",
		TotalFiles: len(nodes),
		MaxDepth:   2,
	}
}

type testArchiveServer struct {
	handler http.Handler
}

func (s *testArchiveServer) routes() http.Handler {
	return s.handler
}

func newTestArchiveServer(t *testing.T, archiveRoot string) *testArchiveServer {
	t.Helper()
	cfg := Config{
		InternalToken: "test-secret-token",
		ArchiveRoot:   archiveRoot,
	}
	h := NewHandler(cfg, NewEnsureService(cfg), nil, &testRepoSniffer{})
	return &testArchiveServer{handler: h.testRoutes(cfg.InternalToken)}
}

func setupTestArchiveRepo(t *testing.T, archiveRoot, owner, repo, sha string) {
	t.Helper()
	repoDir := filepath.Join(archiveRoot, owner, repo, sha)
	bookDir := filepath.Join(repoDir, "book")
	lessonsDir := filepath.Join(repoDir, "lessons", "lab1")
	require.NoError(t, os.MkdirAll(bookDir, 0755))
	require.NoError(t, os.MkdirAll(lessonsDir, 0755))

	require.NoError(t, os.WriteFile(filepath.Join(bookDir, "ch1.md"), []byte("# Chapter 1\nContent"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(bookDir, "ch2.md"), []byte("# Chapter 2\nContent"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(bookDir, "guide-zh.pdf"), make([]byte, 600*1024), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(lessonsDir, "main.py"), []byte("print('hello')"), 0644))
}

// 🧪 [1.22.6.1] TestArchiveHandler_Tree httpx.go readJSON/writeJSON/httpError 统一四件套骨架
func TestArchiveHandler_Tree(t *testing.T) {
	tempRoot := t.TempDir()
	setupTestArchiveRepo(t, tempRoot, "acme", "docs-repo", "sha123")

	validPayload, _ := json.Marshal(ArchiveTreeRequest{
		Owner: "acme",
		Repo:  "docs-repo",
		Sha:   "sha123",
	})
	missingRepoPayload, _ := json.Marshal(ArchiveTreeRequest{
		Owner: "acme",
		Repo:  "nonexistent-repo",
		Sha:   "sha123",
	})
	missingFieldsPayload, _ := json.Marshal(ArchiveTreeRequest{
		Owner: "acme",
		Repo:  "",
		Sha:   "sha123",
	})
	pathTraversalPayload, _ := json.Marshal(ArchiveTreeRequest{
		Owner: "../../etc",
		Repo:  "docs-repo",
		Sha:   "sha123",
	})

	tests := []struct {
		name        string
		method      string
		token       string
		body        string
		wantStatus  int
		wantOk      bool
		wantMinNode int
	}{
		{
			name:        "1.14.1.1 unauthorized when token missing",
			method:      http.MethodPost,
			token:       "",
			body:        string(validPayload),
			wantStatus:  http.StatusUnauthorized,
			wantOk:      false,
			wantMinNode: 0,
		},
		{
			name:        "1.14.1.1 unauthorized when token invalid",
			method:      http.MethodPost,
			token:       "wrong-token",
			body:        string(validPayload),
			wantStatus:  http.StatusUnauthorized,
			wantOk:      false,
			wantMinNode: 0,
		},
		{
			name:        "method not allowed on GET",
			method:      http.MethodGet,
			token:       "test-secret-token",
			body:        "",
			wantStatus:  http.StatusMethodNotAllowed,
			wantOk:      false,
			wantMinNode: 0,
		},
		{
			name:        "bad request on invalid json",
			method:      http.MethodPost,
			token:       "test-secret-token",
			body:        `{invalid-json`,
			wantStatus:  http.StatusBadRequest,
			wantOk:      false,
			wantMinNode: 0,
		},
		{
			name:        "bad request on missing required fields",
			method:      http.MethodPost,
			token:       "test-secret-token",
			body:        string(missingFieldsPayload),
			wantStatus:  http.StatusBadRequest,
			wantOk:      false,
			wantMinNode: 0,
		},
		{
			name:        "1.14.2.3 bad request on path traversal in owner",
			method:      http.MethodPost,
			token:       "test-secret-token",
			body:        string(pathTraversalPayload),
			wantStatus:  http.StatusBadRequest,
			wantOk:      false,
			wantMinNode: 0,
		},
		{
			name:        "not found when archive does not exist on disk",
			method:      http.MethodPost,
			token:       "test-secret-token",
			body:        string(missingRepoPayload),
			wantStatus:  http.StatusNotFound,
			wantOk:      false,
			wantMinNode: 0,
		},
		{
			name:        "success returning nodes for existing archive",
			method:      http.MethodPost,
			token:       "test-secret-token",
			body:        string(validPayload),
			wantStatus:  http.StatusOK,
			wantOk:      true,
			wantMinNode: 4,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestArchiveServer(t, tempRoot)
			req := httptest.NewRequest(tt.method, "/v1/archive/tree", bytes.NewBufferString(tt.body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			rec := httptest.NewRecorder()

			srv.routes().ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantStatus == http.StatusOK {
				var resp ArchiveTreeResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tt.wantOk, resp.Ok)
				assert.GreaterOrEqual(t, len(resp.Nodes), tt.wantMinNode)

				// Assert wire JSON has lowercase keys (path, type, size) for TypeScript consumer parity
				assert.Contains(t, rec.Body.String(), `"path":"book/ch1.md"`)
				assert.Contains(t, rec.Body.String(), `"type":"blob"`)
				assert.NotContains(t, rec.Body.String(), `"Path":`)
				assert.NotContains(t, rec.Body.String(), `"Type":`)

				hasBookCh1 := false
				for _, n := range resp.Nodes {
					if n.Path == "book/ch1.md" && n.Type == "blob" && n.Size > 0 {
						hasBookCh1 = true
					}
				}
				assert.True(t, hasBookCh1, "expected book/ch1.md to be present in parsed nodes")
			}
		})
	}
}

func TestArchiveHandler_Sniff(t *testing.T) {
	tempRoot := t.TempDir()
	setupTestArchiveRepo(t, tempRoot, "acme", "docs-repo", "sha123")

	modeAZeroTreePayload, _ := json.Marshal(ArchiveSniffRequest{
		Owner: "acme",
		Repo:  "docs-repo",
		Sha:   "sha123",
	})
	modeANotFoundPayload, _ := json.Marshal(ArchiveSniffRequest{
		Owner: "acme",
		Repo:  "unknown-repo",
		Sha:   "sha123",
	})
	modeAPathTraversalPayload, _ := json.Marshal(ArchiveSniffRequest{
		Owner: "../../etc",
		Repo:  "docs-repo",
		Sha:   "sha123",
	})
	nodesB := []GitNode{
		{Path: "README.md", Type: "blob", Size: 200},
		{Path: "src/index.ts", Type: "blob", Size: 1000},
		{Path: "src/util.ts", Type: "blob", Size: 500},
	}
	modeBNodesPayload, _ := json.Marshal(ArchiveSniffRequest{
		Nodes:           &nodesB,
		IsTreeTruncated: false,
	})
	nodesBTruncated := []GitNode{
		{Path: "README.md", Type: "blob", Size: 200},
	}
	modeBTruncatedPayload, _ := json.Marshal(ArchiveSniffRequest{
		Nodes:           &nodesBTruncated,
		IsTreeTruncated: true,
	})
	emptyNodes := []GitNode{}
	modeBEmptyPayload, _ := json.Marshal(ArchiveSniffRequest{
		Nodes: &emptyNodes,
	})
	emptyPayload := `{}`

	tests := []struct {
		name          string
		method        string
		token         string
		body          string
		wantStatus    int
		wantOk        bool
		wantRepoType  string
		wantTier      string
		wantScale     string
		wantTruncated bool
	}{
		{
			name:       "unauthorized when token missing",
			method:     http.MethodPost,
			token:      "",
			body:       string(modeAZeroTreePayload),
			wantStatus: http.StatusUnauthorized,
			wantOk:     false,
		},
		{
			name:       "method not allowed on GET",
			method:     http.MethodGet,
			token:      "test-secret-token",
			body:       "",
			wantStatus: http.StatusMethodNotAllowed,
			wantOk:     false,
		},
		{
			name:       "bad request on invalid json",
			method:     http.MethodPost,
			token:      "test-secret-token",
			body:       `{invalid-json`,
			wantStatus: http.StatusBadRequest,
			wantOk:     false,
		},
		{
			name:       "bad request when neither owner/repo/sha nor nodes provided",
			method:     http.MethodPost,
			token:      "test-secret-token",
			body:       emptyPayload,
			wantStatus: http.StatusBadRequest,
			wantOk:     false,
		},
		{
			name:       "1.14.2.3 mode A 400 when path traversal in owner",
			method:     http.MethodPost,
			token:      "test-secret-token",
			body:       string(modeAPathTraversalPayload),
			wantStatus: http.StatusBadRequest,
			wantOk:     false,
		},
		{
			name:       "mode A 404 when archive does not exist on disk",
			method:     http.MethodPost,
			token:      "test-secret-token",
			body:       string(modeANotFoundPayload),
			wantStatus: http.StatusNotFound,
			wantOk:     false,
		},
		{
			name:          "1.16.1.3 mode A zero-tree disk read and sniff",
			method:        http.MethodPost,
			token:         "test-secret-token",
			body:          string(modeAZeroTreePayload),
			wantStatus:    http.StatusOK,
			wantOk:        true,
			wantRepoType:  "notebook", // 2 md files -> tier C notebook
			wantTier:      "C",
			wantScale:     "normal",
			wantTruncated: false,
		},
		{
			name:          "mode B nodes payload sniff",
			method:        http.MethodPost,
			token:         "test-secret-token",
			body:          string(modeBNodesPayload),
			wantStatus:    http.StatusOK,
			wantOk:        true,
			wantRepoType:  "codebase",
			wantTier:      "D",
			wantScale:     "normal",
			wantTruncated: false,
		},
		{
			name:          "mode B truncated flag propagation",
			method:        http.MethodPost,
			token:         "test-secret-token",
			body:          string(modeBTruncatedPayload),
			wantStatus:    http.StatusOK,
			wantOk:        true,
			wantTruncated: true,
		},
		{
			name:          "mode B empty nodes boundary case",
			method:        http.MethodPost,
			token:         "test-secret-token",
			body:          string(modeBEmptyPayload),
			wantStatus:    http.StatusOK,
			wantOk:        true,
			wantRepoType:  "codebase",
			wantTier:      "D",
			wantScale:     "normal",
			wantTruncated: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newTestArchiveServer(t, tempRoot)
			req := httptest.NewRequest(tt.method, "/v1/archive/sniff", bytes.NewBufferString(tt.body))
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			rec := httptest.NewRecorder()

			srv.routes().ServeHTTP(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantStatus == http.StatusOK {
				var resp ArchiveSniffResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tt.wantOk, resp.Ok)

				// Verify nil-safety: GlobalAssets slices must serialize as [] not null
				assert.Contains(t, rec.Body.String(), `"pdfs":`)
				assert.Contains(t, rec.Body.String(), `"translations":`)
				assert.Contains(t, rec.Body.String(), `"buildScripts":`)
				assert.Contains(t, rec.Body.String(), `"misc":`)
				assert.NotContains(t, rec.Body.String(), `"pdfs":null`)
				assert.NotContains(t, rec.Body.String(), `"translations":null`)
				assert.NotContains(t, rec.Body.String(), `"buildScripts":null`)
				assert.NotContains(t, rec.Body.String(), `"misc":null`)

				if tt.wantRepoType != "" {
					assert.Equal(t, tt.wantRepoType, resp.Profile.RepoType)
				}
				if tt.wantTier != "" {
					assert.Equal(t, tt.wantTier, resp.Profile.Tier)
				}
				if tt.wantScale != "" {
					assert.Equal(t, tt.wantScale, resp.Scale.Scale)
				}
				assert.Equal(t, tt.wantTruncated, resp.Profile.IsTreeTruncated)
			}
		})
	}
}

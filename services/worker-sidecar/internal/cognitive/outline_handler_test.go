package cognitive

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type testServer struct {
	h       *Handler
	handler http.Handler
	token   string
}

func newTestOutlineServer(t *testing.T, archiveRoot string) *testServer {
	t.Helper()
	token := "test-secret-token"
	h := NewHandler(archiveRoot, nil)
	return &testServer{
		h:       h,
		handler: h.testRoutes(token),
		token:   token,
	}
}

func setupTestOutlineArchive(t *testing.T, archiveRoot, owner, repo, sha string) {
	t.Helper()
	repoDir := filepath.Join(archiveRoot, owner, repo, sha)
	srcDir := filepath.Join(repoDir, "src")
	docsDir := filepath.Join(repoDir, "docs")
	require.NoError(t, os.MkdirAll(srcDir, 0755))
	require.NoError(t, os.MkdirAll(docsDir, 0755))

	require.NoError(t, os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("# Project\nOverview"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(srcDir, "main.ts"), []byte("console.log('main')"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(srcDir, "config.ts"), []byte("export const cfg = {}"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(docsDir, "intro.md"), []byte("# Intro"), 0644))
}

func TestOutlineHandler_Auth(t *testing.T) {
	s := newTestOutlineServer(t, "")
	handler := s.handler

	endpoints := []string{
		"/v1/outline/candidates",
		"/v1/outline/rule-fallback",
		"/v1/outline/sanitize",
		"/v1/outline/prepare-signals",
	}

	for _, ep := range endpoints {
		t.Run(fmt.Sprintf("401 when unauthenticated on %s", ep), func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, ep, bytes.NewBufferString(`{}`))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			assert.Equal(t, http.StatusUnauthorized, w.Code)
		})
	}
}

func TestOutlineHandler_Validation(t *testing.T) {
	tempRoot := t.TempDir()
	s := newTestOutlineServer(t, tempRoot)
	handler := s.handler

	tests := []struct {
		name           string
		endpoint       string
		body           string
		expectedStatus int
	}{
		{
			name:           "invalid json returns 400",
			endpoint:       "/v1/outline/candidates",
			body:           `{not-valid-json`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "missing both owner/repo/sha and nodes returns 400",
			endpoint:       "/v1/outline/candidates",
			body:           `{"maxFiles": 10}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "path traversal in owner returns 400",
			endpoint:       "/v1/outline/candidates",
			body:           `{"owner": "../evil", "repo": "r", "sha": "s"}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "path traversal in repo returns 400",
			endpoint:       "/v1/outline/candidates",
			body:           `{"owner": "o", "repo": "sub/repo", "sha": "s"}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "archive not found on disk returns 404",
			endpoint:       "/v1/outline/candidates",
			body:           `{"owner": "acme", "repo": "nonexistent", "sha": "sha999"}`,
			expectedStatus: http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tt.endpoint, bytes.NewBufferString(tt.body))
			req.Header.Set("x-internal-token", "test-secret-token")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			assert.Equal(t, tt.expectedStatus, w.Code)
		})
	}
}

func TestOutlineHandler_Candidates(t *testing.T) {
	tempRoot := t.TempDir()
	setupTestOutlineArchive(t, tempRoot, "acme", "demo-repo", "sha123")
	s := newTestOutlineServer(t, tempRoot)
	handler := s.handler

	tests := []struct {
		name           string
		token          string
		payload        OutlineCandidatesRequest
		expectedStatus int
		checkResp      func(t *testing.T, resp OutlineCandidatesResponse)
	}{
		{
			name:  "Mode B: evaluate provided nodes with Round-Robin and handle assignment",
			token: "test-secret-token",
			payload: OutlineCandidatesRequest{
				MaxFiles: 10,
				Nodes: &[]GitNode{
					{Path: "README.md", Type: "blob", Size: 100},
					{Path: "src/main.ts", Type: "blob", Size: 100},
					{Path: "src/config.ts", Type: "blob", Size: 100},
					{Path: "src/test.test.ts", Type: "blob", Size: 100},
					{Path: "assets/logo.png", Type: "blob", Size: 100},
					{Path: "dist/bundle.js", Type: "blob", Size: 100},
					{Path: "docs/intro.md", Type: "blob", Size: 100},
				},
			},
			expectedStatus: http.StatusOK,
			checkResp: func(t *testing.T, resp OutlineCandidatesResponse) {
				require.True(t, resp.Ok)
				var paths []string
				for _, c := range resp.Candidates {
					paths = append(paths, c.Path)
					assert.Greater(t, c.Handle, 0)
				}
				assert.Contains(t, paths, "README.md")
				assert.Contains(t, paths, "src/main.ts")
				assert.Contains(t, paths, "src/config.ts")
				assert.Contains(t, paths, "docs/intro.md")
				assert.NotContains(t, paths, "src/test.test.ts")
				assert.NotContains(t, paths, "assets/logo.png")
				assert.NotContains(t, paths, "dist/bundle.js")
			},
		},
		{
			name:  "Mode A: Zero-Tree disk read via owner/repo/sha",
			token: "test-secret-token",
			payload: OutlineCandidatesRequest{
				Owner:    "acme",
				Repo:     "demo-repo",
				Sha:      "sha123",
				MaxFiles: 10,
			},
			expectedStatus: http.StatusOK,
			checkResp: func(t *testing.T, resp OutlineCandidatesResponse) {
				require.True(t, resp.Ok)
				assert.NotEmpty(t, resp.Candidates)
				var paths []string
				for _, c := range resp.Candidates {
					paths = append(paths, c.Path)
				}
				assert.Contains(t, paths, "README.md")
				assert.Contains(t, paths, "src/main.ts")
			},
		},
		{
			name:  "Mode A: Zero-Tree with prefix scoping",
			token: "test-secret-token",
			payload: OutlineCandidatesRequest{
				Owner:    "acme",
				Repo:     "demo-repo",
				Sha:      "sha123",
				Prefix:   "src",
				MaxFiles: 10,
			},
			expectedStatus: http.StatusOK,
			checkResp: func(t *testing.T, resp OutlineCandidatesResponse) {
				require.True(t, resp.Ok)
				assert.NotEmpty(t, resp.Candidates)
				for _, c := range resp.Candidates {
					isUnderSrc := strings.HasPrefix(c.Path, "src/")
					isRootReadme := c.Path == "README.md"
					assert.True(t, isUnderSrc || isRootReadme, "candidate %s should be under src or root README", c.Path)
				}
			},
		},
		{
			name:  "Round-Robin bucket balancing across multiple directories",
			token: "test-secret-token",
			payload: func() OutlineCandidatesRequest {
				var nodes []GitNode
				for i := 1; i <= 20; i++ {
					nodes = append(nodes,
						GitNode{Path: fmt.Sprintf("src/aaa/file_%d.ts", i), Type: "blob", Size: 50},
						GitNode{Path: fmt.Sprintf("src/mmm/file_%d.ts", i), Type: "blob", Size: 50},
						GitNode{Path: fmt.Sprintf("src/zzz/file_%d.ts", i), Type: "blob", Size: 50},
					)
				}
				return OutlineCandidatesRequest{
					MaxFiles: 15,
					Nodes:    &nodes,
				}
			}(),
			expectedStatus: http.StatusOK,
			checkResp: func(t *testing.T, resp OutlineCandidatesResponse) {
				require.True(t, resp.Ok)
				assert.Len(t, resp.Candidates, 15)
				hasAAA := false
				hasMMM := false
				hasZZZ := false
				for _, c := range resp.Candidates {
					if strings.HasPrefix(c.Path, "src/aaa/") {
						hasAAA = true
					}
					if strings.HasPrefix(c.Path, "src/mmm/") {
						hasMMM = true
					}
					if strings.HasPrefix(c.Path, "src/zzz/") {
						hasZZZ = true
					}
				}
				assert.True(t, hasAAA, "should contain files from aaa")
				assert.True(t, hasMMM, "should contain files from mmm")
				assert.True(t, hasZZZ, "should contain files from zzz")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(tt.payload)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/v1/outline/candidates", bytes.NewReader(body))
			req.Header.Set("x-internal-token", tt.token)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			assert.Equal(t, tt.expectedStatus, w.Code)
			if tt.expectedStatus == http.StatusOK {
				var resp OutlineCandidatesResponse
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
				tt.checkResp(t, resp)
			}
		})
	}
}

func TestOutlineHandler_RuleFallback(t *testing.T) {
	s := newTestOutlineServer(t, "")
	handler := s.handler

	tests := []struct {
		name           string
		payload        OutlineRuleFallbackRequest
		expectedStatus int
		checkResp      func(t *testing.T, resp OutlineRuleFallbackResponse)
	}{
		{
			name: "Chinese localization with docs and code chunks",
			payload: OutlineRuleFallbackRequest{
				TargetLanguage: "zh-CN",
				Nodes: &[]GitNode{
					{Path: "README.md", Type: "blob", Size: 100},
					{Path: "docs/guide.md", Type: "blob", Size: 100},
					{Path: "src/index.ts", Type: "blob", Size: 100},
					{Path: "src/config.ts", Type: "blob", Size: 100},
					{Path: "src/core/engine.ts", Type: "blob", Size: 100},
				},
			},
			expectedStatus: http.StatusOK,
			checkResp: func(t *testing.T, resp OutlineRuleFallbackResponse) {
				require.True(t, resp.Ok)
				require.NotEmpty(t, resp.Chapters)
				assert.Contains(t, resp.Chapters[0].Name, "快速上手")
			},
		},
		{
			name: "English localization with empty nodes",
			payload: OutlineRuleFallbackRequest{
				TargetLanguage: "en",
				Nodes:          &[]GitNode{},
			},
			expectedStatus: http.StatusOK,
			checkResp: func(t *testing.T, resp OutlineRuleFallbackResponse) {
				require.True(t, resp.Ok)
				require.Len(t, resp.Chapters, 1)
				assert.Equal(t, "Chapter 1: Core Project", resp.Chapters[0].Name)
				assert.Empty(t, resp.Chapters[0].Files)
			},
		},
		{
			name: "Japanese localization with empty nodes",
			payload: OutlineRuleFallbackRequest{
				TargetLanguage: "ja",
				Nodes:          &[]GitNode{},
			},
			expectedStatus: http.StatusOK,
			checkResp: func(t *testing.T, resp OutlineRuleFallbackResponse) {
				require.True(t, resp.Ok)
				require.Len(t, resp.Chapters, 1)
				assert.Equal(t, "第 1 章：プロジェクトコア", resp.Chapters[0].Name)
				assert.Empty(t, resp.Chapters[0].Files)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(tt.payload)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/v1/outline/rule-fallback", bytes.NewReader(body))
			req.Header.Set("x-internal-token", "test-secret-token")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			assert.Equal(t, tt.expectedStatus, w.Code)
			var resp OutlineRuleFallbackResponse
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
			tt.checkResp(t, resp)
		})
	}
}

func TestOutlineHandler_Sanitize(t *testing.T) {
	s := newTestOutlineServer(t, "")
	handler := s.handler

	tests := []struct {
		name      string
		payload   OutlineSanitizeRequest
		checkResp func(t *testing.T, resp OutlineSanitizeResponse)
	}{
		{
			name: "Integer handle resolution and hallucination dropping",
			payload: OutlineSanitizeRequest{
				TargetLanguage: "zh-CN",
				CandidateFiles: []CandidateOutlineFile{
					{Handle: 1, Path: "src/real_entry.ts", IsDoc: false, Role: "entry_point", Weight: 15},
					{Handle: 2, Path: "docs/real_doc.md", IsDoc: true, Weight: 10},
				},
				Nodes: &[]GitNode{
					{Path: "src/real_entry.ts", Type: "blob", Size: 100},
					{Path: "docs/real_doc.md", Type: "blob", Size: 100},
					{Path: "README.md", Type: "blob", Size: 100},
				},
				Chapters: []OutlineChapter{
					{
						Name:    "第一章",
						Summary: "测试",
						Files: []ChapterFile{
							{Handle: 1, Path: "", ShortTitle: ""},
							{Path: "nonexistent/hallucinated.ts", ShortTitle: ""},
						},
					},
				},
			},
			checkResp: func(t *testing.T, resp OutlineSanitizeResponse) {
				require.True(t, resp.Ok)
				assert.Contains(t, resp.DroppedPaths, "nonexistent/hallucinated.ts")
				require.NotEmpty(t, resp.SanitizedChapters)
				files := resp.SanitizedChapters[0].Files
				var filePaths []string
				for _, f := range files {
					filePaths = append(filePaths, f.Path)
				}
				assert.Contains(t, filePaths, "src/real_entry.ts")
				assert.Contains(t, filePaths, "README.md")
			},
		},
		{
			name: "Same-name tail match disambiguation via candidate list",
			payload: OutlineSanitizeRequest{
				CandidateFiles: []CandidateOutlineFile{
					{Handle: 1, Path: "packages/core/src/index.ts", IsDoc: false, Role: "entry_point", Weight: 15},
				},
				Nodes: &[]GitNode{
					{Path: "packages/core/src/index.ts", Type: "blob", Size: 100},
					{Path: "packages/cli/src/index.ts", Type: "blob", Size: 100},
				},
				Chapters: []OutlineChapter{
					{
						Name:    "入口",
						Summary: "入口介绍",
						Files: []ChapterFile{
							{Path: "index.ts", ShortTitle: "入口文件"},
						},
					},
				},
			},
			checkResp: func(t *testing.T, resp OutlineSanitizeResponse) {
				require.True(t, resp.Ok)
				require.NotEmpty(t, resp.SanitizedChapters)
				assert.Equal(t, "packages/core/src/index.ts", resp.SanitizedChapters[0].Files[0].Path)
			},
		},
		{
			name: "Module directory sanitization and pruning",
			payload: OutlineSanitizeRequest{
				Modules: []DraftModule{
					{
						Name:        "模块 1",
						Summary:     "有效目录与根目录变体",
						Directories: []string{"/", "./", "src/real/"},
					},
					{
						Name:        "虚构模块",
						Summary:     "不存在的目录",
						Directories: []string{"ghost_folder/"},
					},
				},
				Nodes: &[]GitNode{
					{Path: "src/real/app.ts", Type: "blob", Size: 100},
				},
				Chapters: []OutlineChapter{
					{
						Name:    "有效章节",
						Summary: "包含有效文件",
						Files:   []ChapterFile{{Path: "src/real/app.ts", ShortTitle: "app"}},
					},
				},
			},
			checkResp: func(t *testing.T, resp OutlineSanitizeResponse) {
				require.True(t, resp.Ok)
				require.Len(t, resp.SanitizedModules, 2)
				assert.Equal(t, []string{"", "src/real/"}, resp.SanitizedModules[0].Directories)
				assert.Equal(t, []string{""}, resp.SanitizedModules[1].Directories)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(tt.payload)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, "/v1/outline/sanitize", bytes.NewReader(body))
			req.Header.Set("x-internal-token", "test-secret-token")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			assert.Equal(t, http.StatusOK, w.Code)
			var resp OutlineSanitizeResponse
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
			tt.checkResp(t, resp)
		})
	}
}

func TestOutlineHandler_PrepareSignals(t *testing.T) {
	s := newTestOutlineServer(t, "")
	handler := s.handler

	payload := OutlinePrepareSignalsRequest{
		MaxFiles: 20,
		Nodes: &[]GitNode{
			{Path: "index.ts", Type: "blob", Size: 100},
			{Path: "server.ts", Type: "blob", Size: 100},
			{Path: "auth.ts", Type: "blob", Size: 100},
			{Path: "db.ts", Type: "blob", Size: 100},
			{Path: "routes.ts", Type: "blob", Size: 100},
			{Path: "utils.ts", Type: "blob", Size: 100},
			{Path: "config.ts", Type: "blob", Size: 100},
		},
	}

	body, err := json.Marshal(payload)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/v1/outline/prepare-signals", bytes.NewReader(body))
	req.Header.Set("x-internal-token", "test-secret-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp OutlinePrepareSignalsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.True(t, resp.Ok)
	assert.True(t, resp.IsFlat)
	assert.NotEmpty(t, resp.FlatRepoHints)
	assert.Equal(t, 7, resp.FileCount)
}

func TestOutlineHandler_ResolveOutlineNodes_FallbackToNodes(t *testing.T) {
	s := newTestOutlineServer(t, "")
	handler := s.handler

	payload := OutlinePrepareSignalsRequest{
		Owner:    "testowner",
		Repo:     "testrepo",
		Sha:      "0123456789abcdef0123456789abcdef01234567",
		MaxFiles: 10,
		Nodes: &[]GitNode{
			{Path: "README.md", Type: "blob", Size: 100},
			{Path: "main.go", Type: "blob", Size: 200},
		},
	}

	body, err := json.Marshal(payload)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/v1/outline/prepare-signals", bytes.NewReader(body))
	req.Header.Set("x-internal-token", "test-secret-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp OutlinePrepareSignalsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.True(t, resp.Ok)
	assert.Equal(t, 2, resp.FileCount)
}

func TestSlugifyAnchor_CJKAndHashFallback(t *testing.T) {
	tests := []struct {
		input    string
		expected string
		isHash   bool
	}{
		{input: "快速开始", expected: "快速开始"},
		{input: "架构设计与实现()", expected: "架构设计与实现"},
		{input: "はじめに", expected: "はじめに"},
		{input: "시작하기", expected: "시작하기"},
		{input: "get_user_info()", expected: "get_user_info"},
		{input: "User Management / API", expected: "user-management-api"},
		{input: "", expected: ""},
		{input: "   ", expected: ""},
		{input: "???", isHash: true},
		{input: ":::!!!", isHash: true},
	}

	for _, tt := range tests {
		actual := slugifyAnchor(tt.input)
		if tt.isHash {
			assert.True(t, strings.HasPrefix(actual, "h-"), "expected hash fallback for %s, got %s", tt.input, actual)
			assert.NotEmpty(t, actual)
		} else {
			assert.Equal(t, tt.expected, actual)
		}
	}
}

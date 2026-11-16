package pipelineb

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

// TestHandleTreeOutlineDepth1And2 端点全链:小仓深度 1 / 大仓深度 2 课程树。
func TestHandleTreeOutlineDepth1And2(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	// 小仓(≤1200)→ 深度 1
	small := t.TempDir()
	writeTreeRepo(t, small, map[string]string{
		"README.md": "# s\n" + strings.Repeat("x\n", 20),
		"a/main.go": "package main\nfunc main() {}\n",
		"a/run.go":  "package main\nfunc Run(x int) int { return x + 1 }\n",
		"b/net.go":  "package b\nfunc Dial() error { return nil }\n",
	})
	h1 := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		model:      reqFake{},
	}
	rec := httptest.NewRecorder()
	h1.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"owner":"o","repo":"small","repoDir":"`+small+`"}`)))
	require.Equal(t, http.StatusOK, rec.Code)
	var out1 map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out1))
	assert.EqualValues(t, 1, out1["depth"])
	assert.NotEmpty(t, out1["chapters"])

	// 大仓(>1200 文件)→ 深度 2 + 课程树
	big := t.TempDir()
	files := map[string]string{"README.md": "# big\n"}
	for i := 0; i < 1250; i++ {
		dir := "p" + string(rune('a'+i%4))
		files[dir+"/f"+fmt.Sprintf("%04d", i)+".go"] = "package p\nfunc F() {}\n"
	}
	writeTreeRepo(t, big, files)

	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:全景","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:pa 实战","summary":"s","targetPaths":["pa"],"phase":"实战","drillDown":true},
		{"name":"第 3 章:pb 实战","summary":"s","targetPaths":["pb"],"phase":"实战","drillDown":true},
		{"name":"第 4 章:pc 实战","summary":"s","targetPaths":["pc"],"phase":"实战","drillDown":true},
		{"name":"第 5 章:pd 实战","summary":"s","targetPaths":["pd"],"phase":"实战","drillDown":true}
	]}`}
	h2 := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		planner:    planner,
		model:      reqFake{},
	}
	rec2 := httptest.NewRecorder()
	h2.HandleTreeOutline(rec2, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"owner":"o","repo":"big","repoDir":"`+big+`"}`)))
	require.Equal(t, http.StatusOK, rec2.Code, rec2.Body.String())
	var out2 map[string]any
	require.NoError(t, json.Unmarshal(rec2.Body.Bytes(), &out2))
	assert.EqualValues(t, 2, out2["depth"])
	ct, ok := out2["courseTree"].(map[string]any)
	require.True(t, ok, "courseTree missing")
	assert.NotNil(t, ct["overviewCourse"], "总览课缺失")
	subs, _ := ct["subCourses"].([]any)
	assert.GreaterOrEqual(t, len(subs), 3, "子课数不足: %v", ct)
}

// TestDynamicFileCapRouting 验证大仓与长上下文情况下的物理硬上限与 LLM 协同路由。
func TestDynamicFileCapRouting(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	// a) 150 file repo (100-200) choosing matrix mode -> depth: 2
	repo150 := t.TempDir()
	files150 := map[string]string{"README.md": "# repo150\n"}
	for i := 0; i < 50; i++ {
		files150[fmt.Sprintf("pkga/f%03d.go", i)] = "package pkga\nfunc F() {}\n"
		files150[fmt.Sprintf("pkgb/f%03d.go", i)] = "package pkgb\nfunc F() {}\n"
		files150[fmt.Sprintf("pkgc/f%03d.go", i)] = "package pkgc\nfunc F() {}\n"
	}
	writeTreeRepo(t, repo150, files150)

	plannerMatrix := &fakePlanner{first: `{"curriculumMode":"matrix", "chapters":[
		{"name":"第 1 章","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章","summary":"s","targetPaths":["pkga"],"phase":"实战", "drillDown":true},
		{"name":"第 3 章","summary":"s","targetPaths":["pkgb"],"phase":"实战", "drillDown":true},
		{"name":"第 4 章","summary":"s","targetPaths":["pkgc"],"phase":"实战"}
	]}`}

	hMatrix := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		planner:    plannerMatrix,
		model:      reqFake{},
	}
	rec1 := httptest.NewRecorder()
	hMatrix.HandleTreeOutline(rec1, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"owner":"o","repo":"r1","repoDir":"`+repo150+`","fileCap":100}`)))
	var out1 map[string]any
	require.NoError(t, json.Unmarshal(rec1.Body.Bytes(), &out1))
	assert.EqualValues(t, 2, out1["depth"])
	_, ok := out1["courseTree"]
	assert.True(t, ok)

	// b) 150 file repo exceeding fileCap (100) choosing single mode -> depth: 1
	plannerSingle := &fakePlanner{first: `{"curriculumMode":"single", "chapters":[
		{"name":"第 1 章","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章","summary":"s","targetPaths":["pkga"],"phase":"实战"},
		{"name":"第 3 章","summary":"s","targetPaths":["pkgb"],"phase":"实战"},
		{"name":"第 4 章","summary":"s","targetPaths":["pkgc"],"phase":"实战"}
	]}`}

	hSingle := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		planner:    plannerSingle,
		model:      reqFake{},
	}
	rec2 := httptest.NewRecorder()
	hSingle.HandleTreeOutline(rec2, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"owner":"o","repo":"r2","repoDir":"`+repo150+`","fileCap":100}`)))
	var out2 map[string]any
	require.NoError(t, json.Unmarshal(rec2.Body.Bytes(), &out2))
	assert.EqualValues(t, 1, out2["depth"])

	// c) Default cap (1200 files): 150 file repo stays in depth: 1 directly without drilling
	recDefault := httptest.NewRecorder()
	hMatrix.HandleTreeOutline(recDefault, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"owner":"o","repo":"rDefault","repoDir":"`+repo150+`"}`)))
	var outDefault map[string]any
	require.NoError(t, json.Unmarshal(recDefault.Body.Bytes(), &outDefault))
	assert.EqualValues(t, 1, outDefault["depth"], "未超过默认 1200 上限时直出深度 1")

	// c2) Mid-sized repo (600 files, e.g. peft with 596 files): stays in depth: 1 under default 1200 cap
	repo600 := t.TempDir()
	files600 := map[string]string{"README.md": "# peft scale repo\n"}
	for i := 0; i < 600; i++ {
		files600[fmt.Sprintf("src/pkg/f%04d.go", i)] = "package pkg\nfunc F() {}\n"
	}
	writeTreeRepo(t, repo600, files600)

	rec600 := httptest.NewRecorder()
	hMatrix.HandleTreeOutline(rec600, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"owner":"o","repo":"r600","repoDir":"`+repo600+`"}`)))
	var out600 map[string]any
	require.NoError(t, json.Unmarshal(rec600.Body.Bytes(), &out600))
	assert.EqualValues(t, 1, out600["depth"], "600 文件中型仓(如 peft 596 文件)在默认 1200 预算下必须走深度 1 单发快路径")

	// d) Oversized repo (>1200 files) where LLM attempts single -> overridden to matrix (depth 2)
	repo1250 := t.TempDir()
	files1250 := map[string]string{"README.md": "# repo1250\n"}
	for i := 0; i < 420; i++ {
		files1250[fmt.Sprintf("pkga/f%04d.go", i)] = "package pkga\nfunc F() {}\n"
		files1250[fmt.Sprintf("pkgb/f%04d.go", i)] = "package pkgb\nfunc F() {}\n"
		files1250[fmt.Sprintf("pkgc/f%04d.go", i)] = "package pkgc\nfunc F() {}\n"
	}
	writeTreeRepo(t, repo1250, files1250)

	plannerOversized := &fakePlanner{first: `{"curriculumMode":"single", "chapters":[
		{"name":"第 1 章","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章","summary":"s","targetPaths":["pkga"],"phase":"实战"},
		{"name":"第 3 章","summary":"s","targetPaths":["pkgb"],"phase":"实战"},
		{"name":"第 4 章","summary":"s","targetPaths":["pkgc"],"phase":"实战"}
	]}`}
	hOversized := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		planner:    plannerOversized,
		model:      reqFake{},
	}
	rec3 := httptest.NewRecorder()
	hOversized.HandleTreeOutline(rec3, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"owner":"o","repo":"r3","repoDir":"`+repo1250+`"}`)))
	var out3 map[string]any
	require.NoError(t, json.Unmarshal(rec3.Body.Bytes(), &out3))
	assert.EqualValues(t, 2, out3["depth"])
	_, ok3 := out3["courseTree"]
	assert.True(t, ok3)
}

// TestHandleSkeletonAndExcludedPathsPruning 测试骨架提取端点以及通过 ExcludedPaths 的物理剪枝。
func TestHandleTreeOutlineExcludedPathsPruning(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	repoDir := t.TempDir()
	writeTreeRepo(t, repoDir, map[string]string{
		"README.md":          "# Title\n",
		"src/main.go":        "package main\nfunc main() {}\n",
		"src/util.go":        "package main\nfunc Util() {}\n",
		"tests/unit_test.go": "package main\nfunc TestUnit() {}\n",
		"docs/guide.md":      "# Guide\nContent\n",
	})

	h := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		model:      reqFake{},
	}

	// 2. 测试 HandleTreeOutline 传入 ExcludedPaths 进行剪枝
	recTree := httptest.NewRecorder()
	h.HandleTreeOutline(recTree, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(
		`{"owner":"o","repo":"r","repoDir":"`+repoDir+`","excludedPaths":["tests","docs"]}`)))
	require.Equal(t, http.StatusOK, recTree.Code)

	var treeResp struct {
		Depth    int                        `json:"depth"`
		Chapters []cognitive.OutlineChapter `json:"chapters"`
	}
	require.NoError(t, json.Unmarshal(recTree.Body.Bytes(), &treeResp))
	assert.Equal(t, 1, treeResp.Depth)

	// 验证生成章节中完全不包含被剪枝的路径
	for _, ch := range treeResp.Chapters {
		for _, f := range ch.Files {
			assert.False(t, strings.HasPrefix(f.Path, "tests/"), "tests/ should be pruned")
			assert.False(t, strings.HasPrefix(f.Path, "docs/"), "docs/ should be pruned")
		}
	}
}

func writeTreeRepo(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, c := range files {
		full := filepath.Join(dir, p)
		require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
		require.NoError(t, os.WriteFile(full, []byte(c), 0o644))
	}
}

// reqFake 按请求子树生成的确定性桩(与 pbtool 同款,包内独立定义)。
type reqFake struct{}

func (reqFake) Complete(_ context.Context, req ModelRequest) (string, error) {
	var files []string
	for i, f := range req.RepoMap.Files {
		if i >= 3 {
			break
		}
		files = append(files, f.Path)
	}
	b, _ := json.Marshal(map[string]any{
		"chapters": []map[string]any{
			{"name": "桩章:" + req.RepoMap.RepoName, "summary": "fake", "files": files, "phase": "实战"},
		},
	})
	return string(b), nil
}

type delayedReqFake struct {
	delay time.Duration
}

func (d delayedReqFake) Complete(ctx context.Context, req ModelRequest) (string, error) {
	if d.delay > 0 {
		time.Sleep(d.delay)
	}
	return reqFake{}.Complete(ctx, req)
}

func TestHandleTreeOutline_TreeFirstFastPath(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)
	cacheDir := t.TempDir()

	treeCalled := false
	blobCalled := false

	h := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		model:      reqFake{},
		CacheDir:   cacheDir,
		statDir:    func(owner, repo, sha string) bool { return false }, // 磁盘无归档 (冷路径)
		prep:       NewPrepTracker(),
	}

	h.SetFetchers(
		func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
			treeCalled = true
			return &client.GitTreeResponse{
				SHA: sha,
				Tree: []client.GitTreeEntry{
					{Path: "README.md", Type: "blob", Size: 200},
					{Path: "main.go", Type: "blob", Size: 400},
					{Path: "pkg/calc.go", Type: "blob", Size: 300},
				},
				Truncated: false,
			}, nil
		},
		func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error) {
			blobCalled = true
			return map[string]string{
				"README.md": "# Fast Path Readme\n",
				"main.go":   "package main\nfunc Run() {}\n",
			}, nil
		},
	)
	h.SetGitHubConfig("test-token", "", "UA-Test")

	rec := httptest.NewRecorder()
	reqBody := `{"owner":"test-o","repo":"test-r","sha":"abc1234"}`
	h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.True(t, treeCalled, "treeFetcher should be called")
	assert.True(t, blobCalled, "blobFetcher should be called")

	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.EqualValues(t, 1, out["depth"])
	assert.NotEmpty(t, out["chapters"])

	// 缓存固化验证：tree-map 缓存应已写入
	cached, err := LoadTreeMap(cacheDir, "test-o", "test-r", "abc1234")
	require.NoError(t, err)
	require.NotNil(t, cached.Tree)
	assert.Equal(t, 3, cached.Tree.FileCount)

	// 第二次请求：命中缓存，零网络交互直出
	treeCalled = false
	blobCalled = false
	rec2 := httptest.NewRecorder()
	h.HandleTreeOutline(rec2, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))
	require.Equal(t, http.StatusOK, rec2.Code)
	assert.False(t, treeCalled, "should hit cache, no tree fetch")
	assert.False(t, blobCalled, "should hit cache, no blob fetch")
}

func TestHandleTreeOutline_TreeFirstTruncatedFallback(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	h := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		model:      reqFake{},
		statDir:    func(owner, repo, sha string) bool { return false },
		prep:       NewPrepTracker(),
		ensureDir: func(ctx context.Context, owner, repo, sha string) (string, error) {
			return t.TempDir(), nil
		},
	}

	h.SetFetchers(
		func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
			// 模拟 GitHub 返回 >100,000 条目截断
			return &client.GitTreeResponse{
				SHA:       sha,
				Truncated: true,
			}, nil
		},
		nil,
	)
	h.SetGitHubConfig("test-token", "", "UA-Test")

	rec := httptest.NewRecorder()
	reqBody := `{"owner":"huge-o","repo":"huge-r","sha":"def5678"}`
	h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))

	// 截断时自动降级回退到 202 异步后台准备
	require.Equal(t, http.StatusAccepted, rec.Code)
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, true, out["preparing"])
	assert.Equal(t, "running", out["status"])
}

func TestHandleTreeOutline_TreeFirstErrorFallback(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	h := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		model:      reqFake{},
		statDir:    func(owner, repo, sha string) bool { return false },
		prep:       NewPrepTracker(),
		ensureDir: func(ctx context.Context, owner, repo, sha string) (string, error) {
			return t.TempDir(), nil
		},
	}

	h.SetFetchers(
		func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
			// 模拟网络异常
			return nil, fmt.Errorf("network connection reset")
		},
		nil,
	)
	h.SetGitHubConfig("test-token", "", "UA-Test")

	rec := httptest.NewRecorder()
	reqBody := `{"owner":"err-o","repo":"err-r","sha":"ghi9012"}`
	h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))

	// 网络报错时自动降级回退到 202 异步后台准备
	require.Equal(t, http.StatusAccepted, rec.Code)
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, true, out["preparing"])
}

func TestHandleTreeOutline_PrepRunningBypassesTreeFirst(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	var treeCalls int32
	h := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		model:      reqFake{},
		statDir:    func(owner, repo, sha string) bool { return false },
		prep:       NewPrepTracker(),
		ensureDir: func(ctx context.Context, owner, repo, sha string) (string, error) {
			time.Sleep(500 * time.Millisecond) // 模拟长耗时后台下载
			return t.TempDir(), nil
		},
	}

	h.SetFetchers(
		func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
			atomic.AddInt32(&treeCalls, 1)
			return nil, fmt.Errorf("simulate tree fetch failure")
		},
		nil,
	)
	h.SetGitHubConfig("test-token", "", "UA-Test")

	reqBody := `{"owner":"poll-o","repo":"poll-r","sha":"poll123"}`

	// 第一次调用：Tree-First 失败，触发 launchPrep，返回 202
	rec1 := httptest.NewRecorder()
	h.HandleTreeOutline(rec1, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))
	require.Equal(t, http.StatusAccepted, rec1.Code)
	assert.Equal(t, int32(1), atomic.LoadInt32(&treeCalls))

	// 第二次调用（客户端 8 秒后轮询，后台仍在运行中）：必须直接让位 202，绝不重复调用 treeFetcher
	rec2 := httptest.NewRecorder()
	h.HandleTreeOutline(rec2, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))
	require.Equal(t, http.StatusAccepted, rec2.Code)
	assert.Equal(t, int32(1), atomic.LoadInt32(&treeCalls), "轮询期间不应重复调用 treeFetcher 浪费配额")
}

func TestHandleTreeOutline_TreeFirstWithPrefixScope(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	var requestedPaths []string
	h := &Handler{
		patternsFn: func() cognitive.Patterns { return patterns },
		defsFn:     func() *rsg.LanguageDefinitions { return defs },
		model:      reqFake{},
		statDir:    func(owner, repo, sha string) bool { return false },
		prep:       NewPrepTracker(),
	}

	h.SetFetchers(
		func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
			return &client.GitTreeResponse{
				SHA: sha,
				Tree: []client.GitTreeEntry{
					{Path: "README.md", Type: "blob", Size: 200},
					{Path: "package.json", Type: "blob", Size: 300},
					{Path: "packages/core/README.md", Type: "blob", Size: 350},
					{Path: "packages/core/package.json", Type: "blob", Size: 400},
					{Path: "packages/core/src/index.ts", Type: "blob", Size: 500},
				},
			}, nil
		},
		func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error) {
			requestedPaths = paths
			return map[string]string{
				"packages/core/README.md":    "# Core\n",
				"packages/core/package.json": "{\"name\":\"core\"}\n",
				"packages/core/src/index.ts": "export const Core = 1;\n",
			}, nil
		},
	)
	h.SetGitHubConfig("test-token", "", "UA-Test")

	rec := httptest.NewRecorder()
	reqBody := `{"owner":"scope-o","repo":"scope-r","sha":"scope123","prefix":"packages/core"}`
	h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotEmpty(t, requestedPaths)
	for _, p := range requestedPaths {
		assert.True(t, strings.HasPrefix(p, "packages/core/"), "核心抓取路径必须位于 prefix 范围内: %s", p)
	}
}

func TestHandleTreeOutline_WithAiDirectedSampling(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	t.Run("sampler actively directs core files and mounts AST", func(t *testing.T) {
		var samplerCalled bool
		var receivedSreq *SampleRequest
		var blobRequests [][]string

		sampler := &fakeSamplerImpl{
			res: &OutlineSamplerResult{
				ArchitectureArchetype: "cli_engine",
				SubsystemCount:        2,
				NeedFiles:             []string{"cmd/cli.go", "pkg/core.go", "hallucinated.go"},
			},
		}

		h := NewHandler(
			func() cognitive.Patterns { return patterns },
			func() *rsg.LanguageDefinitions { return defs },
			func(ctx context.Context, owner, repo, sha string) (string, error) { return t.TempDir(), nil },
			nil,
			reqFake{},
			sampler,
		)

		// 包装 sampler 捕获输入（策略 B 条件透传断言）
		h.SetSampler(&customSamplerFunc{
			fn: func(ctx context.Context, sreq SampleRequest) (*OutlineSamplerResult, error) {
				samplerCalled = true
				receivedSreq = &sreq
				return sampler.SampleCoreFiles(ctx, sreq)
			},
		})

		h.SetFetchers(
			func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
				return &client.GitTreeResponse{
					SHA: sha,
					Tree: []client.GitTreeEntry{
						{Path: "README.md", Type: "blob", Size: 300},
						{Path: "cmd/cli.go", Type: "blob", Size: 400},
						{Path: "pkg/core.go", Type: "blob", Size: 350},
						{Path: "pkg/unused.go", Type: "blob", Size: 200},
					},
				}, nil
			},
			func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error) {
				blobRequests = append(blobRequests, paths)
				res := make(map[string]string)
				for _, p := range paths {
					if p == "README.md" {
						res[p] = "# CLI Project\n"
					} else if p == "cmd/cli.go" {
						res[p] = "package cmd\nfunc RunCLI() {}\n"
					} else if p == "pkg/core.go" {
						res[p] = "package pkg\nfunc CoreLogic() {}\n"
					}
				}
				return res, nil
			},
		)
		h.SetGitHubConfig("test-token", "", "UA-Test")

		rec := httptest.NewRecorder()
		reqBody := `{"owner":"ai-o","repo":"ai-r","sha":"aisha1","teachingDepth":"deep","learnerArchetype":"deep_dive_internals","customPrompt":"聚焦 CLI 编排层"}`
		h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))

		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.True(t, samplerCalled, "AI sampler 应被调用")
		require.NotNil(t, receivedSreq, "采样请求必须被捕获")
		assert.Contains(t, receivedSreq.Readme, "# CLI Project")
		assert.NotEmpty(t, receivedSreq.Skeleton)
		assert.Contains(t, receivedSreq.Skeleton, "cmd/cli.go", "采样骨架图必须挂载实际文件物理路径")
		assert.Contains(t, receivedSreq.Skeleton, "pkg/core.go", "采样骨架图必须挂载实际文件物理路径")
		// 策略 B 条件透传断言（契约 C5/WP3）：采样器收到用户选定三字段
		assert.Equal(t, "deep", receivedSreq.TeachingDepth, "TeachingDepth 必须透传至采样器")
		assert.Equal(t, "deep_dive_internals", receivedSreq.LearnerArchetype, "LearnerArchetype 必须透传至采样器")
		assert.Equal(t, "聚焦 CLI 编排层", receivedSreq.CustomPrompt, "CustomPrompt 必须透传至采样器")

		// 采样路由观测键（契约 C4）必须进 stats
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		stats, ok := out["stats"].(map[string]any)
		require.True(t, ok, "stats 必须为对象")
		assert.Equal(t, "stratified", stats["samplingStrategy"], "策略 B 采样模式必须可观测")
		assert.Greater(t, stats["sampledFileCount"].(float64), float64(0))
		assert.Contains(t, stats, "astCoverageRatio")

		// 验证 blob 抓取包含了 README 与 AI 挑选的有效文件（幻觉文件已过滤）
		allFetched := make(map[string]bool)
		for _, batch := range blobRequests {
			for _, p := range batch {
				allFetched[p] = true
			}
		}
		assert.True(t, allFetched["README.md"])
		assert.True(t, allFetched["cmd/cli.go"])
		assert.True(t, allFetched["pkg/core.go"])
		assert.False(t, allFetched["hallucinated.go"], "幻觉路径必须被丢弃")
		assert.False(t, allFetched["pkg/unused.go"], "未被点名的文件不应抓取源码")
	})

	t.Run("sampler error triggers fail-open fallback without breaking request", func(t *testing.T) {
		h := NewHandler(
			func() cognitive.Patterns { return patterns },
			func() *rsg.LanguageDefinitions { return defs },
			func(ctx context.Context, owner, repo, sha string) (string, error) { return t.TempDir(), nil },
			nil,
			reqFake{},
			&fakeSamplerImpl{err: errors.New("ai gateway error 502")},
		)

		var blobPaths []string
		h.SetFetchers(
			func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
				return &client.GitTreeResponse{
					SHA: sha,
					Tree: []client.GitTreeEntry{
						{Path: "README.md", Type: "blob", Size: 300},
						{Path: "package.json", Type: "blob", Size: 200},
						{Path: "src/main.ts", Type: "blob", Size: 400},
					},
				}, nil
			},
			func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error) {
				blobPaths = append(blobPaths, paths...)
				return map[string]string{
					"README.md":    "# Fallback\n",
					"package.json": "{}\n",
					"src/main.ts":  "console.log(1);\n",
				}, nil
			},
		)
		h.SetGitHubConfig("test-token", "", "UA-Test")

		rec := httptest.NewRecorder()
		reqBody := `{"owner":"err-o","repo":"err-r","sha":"errsha"}`
		h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree", strings.NewReader(reqBody)))

		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.NotEmpty(t, blobPaths, "fail-open 兜底应抓取基础入口文件")
		assert.Contains(t, blobPaths, "README.md")
		assert.Contains(t, blobPaths, "package.json")

		// 回退路径可观测（契约 C4）：规则兜底必须如实标记 fallback-8
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		stats, ok := out["stats"].(map[string]any)
		require.True(t, ok, "stats 必须为对象")
		assert.Equal(t, "fallback-8", stats["samplingStrategy"], "规则兜底路径必须标记 fallback-8")
	})
}

type customSamplerFunc struct {
	fn func(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error)
}

func (c *customSamplerFunc) SampleCoreFiles(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error) {
	return c.fn(ctx, req)
}

// ─────────────────────────────────────────────────────────────
// TestHandleSkeletonAndTopology_WithoutEnsureDir
// 验证 HandleSkeleton 和 HandleTopology 在未配置 ensureDir 的情况下：
// 1. 冷启动走 tryTreeFirst 纯内存构建，零归档下载并成功写入 CacheDir；
// 2. 第二次请求命中 CacheDir，零网络请求；
// 3. 支持 prefix 过滤；
// 4. 当 tryTreeFirst 遇到截断且未配置 ensureDir 时，失效封闭返回 502。
// ─────────────────────────────────────────────────────────────

// TestHandleTreeOutlineStreaming 验证端到端 SSE 流式长连接大纲生成与心跳保活。
func TestHandleTreeOutlineStreaming(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	small := t.TempDir()
	writeTreeRepo(t, small, map[string]string{
		"README.md": "# s\n" + strings.Repeat("x\n", 20),
		"a/main.go": "package main\nfunc main() {}\n",
		"a/run.go":  "package main\nfunc Run(x int) int { return x + 1 }\n",
		"b/net.go":  "package b\nfunc Dial() error { return nil }\n",
	})

	big := t.TempDir()
	bigFiles := map[string]string{"README.md": "# big\n"}
	for i := 0; i < 1250; i++ {
		dir := "p" + string(rune('a'+i%4))
		bigFiles[dir+"/f"+fmt.Sprintf("%04d", i)+".go"] = "package p\nfunc F() {}\n"
	}
	writeTreeRepo(t, big, bigFiles)

	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:全景","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:pa 实战","summary":"s","targetPaths":["pa"],"phase":"实战","drillDown":true},
		{"name":"第 3 章:pb 实战","summary":"s","targetPaths":["pb"],"phase":"实战","drillDown":true},
		{"name":"第 4 章:pc 实战","summary":"s","targetPaths":["pc"],"phase":"实战","drillDown":true},
		{"name":"第 5 章:pd 实战","summary":"s","targetPaths":["pd"],"phase":"实战","drillDown":true}
	]}`}

	tests := []struct {
		name          string
		repoDir       string
		acceptHeader  string
		queryStream   string
		expectedDepth int
		isStreaming   bool
		withPingTest  bool
	}{
		{
			name:          "small repo SSE streaming via Accept header",
			repoDir:       small,
			acceptHeader:  "text/event-stream",
			expectedDepth: 1,
			isStreaming:   true,
		},
		{
			name:          "big repo SSE streaming via Accept header",
			repoDir:       big,
			acceptHeader:  "text/event-stream",
			expectedDepth: 2,
			isStreaming:   true,
		},
		{
			name:          "small repo SSE streaming via stream=1 query",
			repoDir:       small,
			queryStream:   "1",
			expectedDepth: 1,
			isStreaming:   true,
		},
		{
			name:          "SSE streaming emits ping keep-alive comment frames during long operations",
			repoDir:       small,
			acceptHeader:  "text/event-stream",
			expectedDepth: 1,
			isStreaming:   true,
			withPingTest:  true,
		},
		{
			name:          "backward compatibility: non-streaming returns synchronous JSON",
			repoDir:       small,
			acceptHeader:  "application/json",
			expectedDepth: 1,
			isStreaming:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			model := OutlineModel(reqFake{})
			var pInterval time.Duration
			if tt.withPingTest {
				pInterval = 10 * time.Millisecond
				model = delayedReqFake{delay: 35 * time.Millisecond}
			}

			h := &Handler{
				patternsFn:   func() cognitive.Patterns { return patterns },
				defsFn:       func() *rsg.LanguageDefinitions { return defs },
				planner:      planner,
				model:        model,
				pingInterval: pInterval,
			}

			url := "/v1/outline/tree"
			if tt.queryStream != "" {
				url += "?stream=" + tt.queryStream
			}

			payload := map[string]any{
				"owner":   "test-owner",
				"repo":    "test-repo",
				"repoDir": tt.repoDir,
			}
			bodyBytes, err := json.Marshal(payload)
			require.NoError(t, err)

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(bodyBytes))
			if tt.acceptHeader != "" {
				req.Header.Set("Accept", tt.acceptHeader)
			}

			h.HandleTreeOutline(rec, req)
			require.Equal(t, http.StatusOK, rec.Code)

			if !tt.isStreaming {
				// 传统同步 JSON
				assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")
				var jsonRes map[string]any
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &jsonRes))
				assert.EqualValues(t, tt.expectedDepth, jsonRes["depth"])
				assert.NotEmpty(t, jsonRes["chapters"])
				return
			}

			// SSE 流式响应
			assert.Contains(t, rec.Header().Get("Content-Type"), "text/event-stream")
			rawOutput := rec.Body.String()
			assert.NotEmpty(t, rawOutput)

			// 验证包含阶段推进事件 (event: step)
			assert.Contains(t, rawOutput, "event: step\n")
			// 验证包含终态交付事件 (event: complete)
			assert.Contains(t, rawOutput, "event: complete\n")

			if tt.withPingTest {
				assert.Contains(t, rawOutput, ": ping\n\n", "SSE 长连接必须定期发送 : ping 注释保活帧")
			}

			// 解析 complete 帧负载
			lines := strings.Split(rawOutput, "\n")
			var completeJSON string
			for i, line := range lines {
				if strings.TrimSpace(line) == "event: complete" && i+1 < len(lines) {
					dataLine := lines[i+1]
					if strings.HasPrefix(dataLine, "data: ") {
						completeJSON = strings.TrimPrefix(dataLine, "data: ")
						break
					}
				}
			}
			require.NotEmpty(t, completeJSON, "must contain complete event with data")

			var parsedComplete map[string]any
			require.NoError(t, json.Unmarshal([]byte(completeJSON), &parsedComplete))
			assert.EqualValues(t, tt.expectedDepth, parsedComplete["depth"])
			assert.Equal(t, true, parsedComplete["ok"])

			if tt.expectedDepth == 2 {
				ct, ok := parsedComplete["courseTree"].(map[string]any)
				require.True(t, ok, "courseTree missing in depth 2 complete payload")
				assert.NotNil(t, ct["overviewCourse"], "总览课缺失")
				subs, _ := ct["subCourses"].([]any)
				assert.NotEmpty(t, subs, "子课程缺失")
			}
		})
	}
}

// ─────────────────────────────────────────────────────────────
// 策略 B（tryStratifiedMap）可观测降级与字节预过滤（终审 FIX-1）：
// truncated 标注 stratified-partial、全灭 fail-closed 触发归档降级、
// 部分成功 fail-open 且必须留痕、>256KB 巨型文件抓取前短路。
// ─────────────────────────────────────────────────────────────

// newStratifiedTestHandler 构造走策略 B 的 tree-first 夹具（TREE_FIRST_FULL_AST_CAP=1
// 强制分级路由至 tryStratifiedMap；README 走旧版单批通道，核心文件走并发分块通道）。
func newStratifiedTestHandler(t *testing.T, patterns cognitive.Patterns, defs *rsg.LanguageDefinitions, sampler OutlineSampler) (*Handler, *[][]string) {
	t.Helper()
	var requestedBatches [][]string
	h := NewHandler(
		func() cognitive.Patterns { return patterns },
		func() *rsg.LanguageDefinitions { return defs },
		func(ctx context.Context, owner, repo, sha string) (string, error) { return t.TempDir(), nil },
		nil,
		reqFake{},
	)
	h.SetSampler(sampler)
	h.SetFetchers(
		func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
			return &client.GitTreeResponse{
				SHA:  sha,
				Tree: stratifiedFixtureTreeEntries(),
			}, nil
		},
		func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error) {
			// 旧版通道在本夹具中仅承接 README（可选输入）
			res := make(map[string]string)
			for _, p := range paths {
				if p == "README.md" {
					res[p] = "# Stratified Fixture\n"
				}
			}
			return res, nil
		},
	)
	h.SetConcurrentBlobFetcher(
		func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error) {
			requestedBatches = append(requestedBatches, paths)
			return map[string]string{}, false, nil
		},
	)
	h.SetGitHubConfig("test-token", "", "UA-Test")
	h.statDir = func(owner, repo, sha string) bool { return false }
	return h, &requestedBatches
}

// stratifiedFixtureTreeEntries 策略 B 夹具的 Git Tree（4 个内容文件，1 仓 2 分区）。
func stratifiedFixtureTreeEntries() []client.GitTreeEntry {
	return []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 300},
		{Path: "cmd/cli.go", Type: "blob", Size: 400},
		{Path: "pkg/core.go", Type: "blob", Size: 350},
		{Path: "pkg/unused.go", Type: "blob", Size: 200},
	}
}

// captureStdlibLog 捕获标准库 log 默认 logger 输出（warn 可观测断言用）。
func captureStdlibLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	oldWriter := log.Writer()
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(oldWriter) })
	return buf
}

func TestTryStratifiedMapObservableDegradation_TableDriven(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	tests := []struct {
		name          string
		blobs         map[string]string // 并发通道返回内容
		truncated     bool              // 并发通道截断标志
		blobErr       error             // 并发通道错误（nil = 成功）
		readmeErr     error             // README 旧版通道错误（可选输入失败）
		wantStatus    int
		wantPreparing bool // 全灭降级 202 断言
		wantStrategy  string
		wantLogParts  []string // 结构化 warn 必须出现的片段
	}{
		{
			name: "truncated 部分成功 → stratified-partial 且截断 warn 可观测",
			blobs: map[string]string{
				"cmd/cli.go": "package cmd\nfunc RunCLI() {}\n",
			},
			truncated:    true,
			wantStatus:   http.StatusOK,
			wantStrategy: "stratified-partial",
			wantLogParts: []string{"stratified blob fetch partial: fetched=1/2 requested files"},
		},
		{
			name:          "核心文件全灭且 README 亦失败 → fail-closed 触发 202 归档降级",
			blobErr:       errors.New("all batches failed"),
			readmeErr:     errors.New("readme gateway 502"),
			wantStatus:    http.StatusAccepted,
			wantPreparing: true,
		},
		{
			name:         "核心文件全灭但 README 在手 → fail-open 继续 200 且留痕",
			blobErr:      errors.New("all batches failed"),
			wantStatus:   http.StatusOK,
			wantStrategy: "stratified",
			wantLogParts: []string{"stratified blob fetch partial failure"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(TreeFirstFullAstCapEnvVar, "1") // 强制策略 B 分级路由
			logBuf := captureStdlibLog(t)

			sampler := &customSamplerFunc{fn: func(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error) {
				return &OutlineSamplerResult{NeedFiles: []string{"cmd/cli.go", "pkg/core.go"}}, nil
			}}
			h, batches := newStratifiedTestHandler(t, patterns, defs, sampler)

			// 按用例覆写并发通道行为（readme 失败经旧版通道错误注入）
			h.SetConcurrentBlobFetcher(
				func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error) {
					*batches = append(*batches, paths)
					if tt.blobErr != nil {
						return nil, false, tt.blobErr
					}
					return tt.blobs, tt.truncated, nil
				},
			)
			if tt.readmeErr != nil {
				readmeErr := tt.readmeErr
				h.SetFetchers(
					func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
						return &client.GitTreeResponse{SHA: sha, Tree: stratifiedFixtureTreeEntries()}, nil
					},
					func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error) {
						return nil, readmeErr
					},
				)
				h.SetConcurrentBlobFetcher(
					func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error) {
						*batches = append(*batches, paths)
						if tt.blobErr != nil {
							return nil, false, tt.blobErr
						}
						return tt.blobs, tt.truncated, nil
					},
				)
			}

			rec := httptest.NewRecorder()
			h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree",
				strings.NewReader(`{"owner":"ob-o","repo":"ob-r","sha":"obsha1"}`)))
			require.Equal(t, tt.wantStatus, rec.Code, rec.Body.String())

			if tt.wantPreparing {
				var out map[string]any
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
				assert.Equal(t, true, out["preparing"], "零文件到手必须触发上层归档降级")
				return
			}

			var out map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
			stats, ok := out["stats"].(map[string]any)
			require.True(t, ok, "stats 必须为对象")
			assert.Equal(t, tt.wantStrategy, stats["samplingStrategy"], "降级事实必须如实进 stats（契约 C4）")
			for _, part := range tt.wantLogParts {
				assert.Contains(t, logBuf.String(), part, "降级 warn 必须可观测")
			}
		})
	}
}

// TestTryStratifiedMapOversizedPrefilter 单文件字节预过滤：AI 点名的 >256KB
// 巨型文件不进抓取清单（策略 A 同款 fullAstPrefilterMaxBytes 帽），并留 debug 日志。
func TestTryStratifiedMapOversizedPrefilter(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)
	t.Setenv(TreeFirstFullAstCapEnvVar, "1")
	logBuf := captureStdlibLog(t)

	sampler := &customSamplerFunc{fn: func(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error) {
		return &OutlineSamplerResult{NeedFiles: []string{"pkg/big.go", "pkg/small.go"}}, nil
	}}
	h, batches := newStratifiedTestHandler(t, patterns, defs, sampler)

	// 本夹具专用 tree：pkg/big.go 在 tree entry 层即 >256KB（大于 helper 通用夹具）
	h.SetFetchers(
		func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
			return &client.GitTreeResponse{
				SHA: sha,
				Tree: []client.GitTreeEntry{
					{Path: "README.md", Type: "blob", Size: 300},
					{Path: "pkg/big.go", Type: "blob", Size: 300 << 10},
					{Path: "pkg/small.go", Type: "blob", Size: 400},
				},
			}, nil
		},
		func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, error) {
			res := make(map[string]string)
			for _, p := range paths {
				if p == "README.md" {
					res[p] = "# Oversized Fixture\n"
				}
			}
			return res, nil
		},
	)

	// pkg/big.go 巨型文件在 tree entry 层即 >256KB：抓取清单必须剔除
	// （SetFetchers 置空并发通道后必须重新接线）
	h.SetConcurrentBlobFetcher(
		func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error) {
			*batches = append(*batches, paths)
			res := map[string]string{}
			for _, p := range paths {
				if p == "pkg/small.go" {
					res[p] = "package pkg\nfunc Core() {}\n"
				}
			}
			return res, false, nil
		},
	)

	rec := httptest.NewRecorder()
	h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree",
		strings.NewReader(`{"owner":"big-o","repo":"big-r","sha":"bigsha1"}`)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	require.Len(t, *batches, 1, "核心文件应单批并发抓取")
	assert.NotContains(t, (*batches)[0], "pkg/big.go", ">256KB 巨型文件必须在抓取前被字节预过滤剔除")
	assert.Contains(t, (*batches)[0], "pkg/small.go", "常规体量点名文件照常抓取")

	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	stats := out["stats"].(map[string]any)
	assert.Equal(t, "stratified", stats["samplingStrategy"], "字节过滤不改变策略分级（非截断）")
	assert.Contains(t, logBuf.String(), "stratified skip oversized sample", "被过滤文件必须留 debug 日志")
}

// ─────────────────────────────────────────────────────────────
// 深度 1 旗舰路径 AST 边优先挂载（终审 FIX-3）：handler :845 已改
// AttachSubtreeCompanionsWithMap——策略 A 提取的 CallEdges 在深度 1 生效，
// 严禁仅因共享顶层分区（depth==1）跨子系统错挂。
// ─────────────────────────────────────────────────────────────
func TestHandleTreeOutlineDepth1AstEdgeCompanions(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	// monorepo 夹具：packages/react-dom（主课时子系统）+ packages/compiler-core
	// （异子系统陷阱文件）。shared "packages/" 使 commonDirDepth==1——
	// legacy 目录深度版在此必然错挂，AST 边版必须防线生效。
	contents := map[string]string{
		"README.md":                                  "# monorepo\n",
		"packages/react-dom/src/index.ts":            "export function render() { return 1; }\n",
		"packages/react-dom/src/adapters/connect.ts": "import { render } from '../index';\nexport function connect() { return render(); }\n",
		"packages/compiler-core/src/parse.ts":        "export function parse() { return 2; }\n",
	}

	h := NewHandler(
		func() cognitive.Patterns { return patterns },
		func() *rsg.LanguageDefinitions { return defs },
		func(ctx context.Context, owner, repo, sha string) (string, error) { return t.TempDir(), nil },
		nil,
		fakeModel{resp: `{"chapters":[{"name":"第 1 章：渲染入口","summary":"s","files":["packages/react-dom/src/index.ts"],"phase":"入门"}]}`},
	)
	h.SetFetchers(
		func(ctx context.Context, apiBase, owner, repo, sha, token, userAgent string) (*client.GitTreeResponse, error) {
			return &client.GitTreeResponse{
				SHA: sha,
				Tree: []client.GitTreeEntry{
					{Path: "README.md", Type: "blob", Size: 100},
					{Path: "packages/react-dom/src/index.ts", Type: "blob", Size: 500},
					{Path: "packages/react-dom/src/adapters/connect.ts", Type: "blob", Size: 400},
					{Path: "packages/compiler-core/src/parse.ts", Type: "blob", Size: 300},
				},
			}, nil
		},
		nil,
	)
	h.SetConcurrentBlobFetcher(
		func(ctx context.Context, apiBase, owner, repo, sha string, paths []string, token, userAgent string) (map[string]string, bool, error) {
			res := make(map[string]string)
			for _, p := range paths {
				if c, ok := contents[p]; ok {
					res[p] = c
				}
			}
			return res, false, nil
		},
	)
	h.SetGitHubConfig("test-token", "", "UA-Test")

	rec := httptest.NewRecorder()
	h.HandleTreeOutline(rec, httptest.NewRequest(http.MethodPost, "/v1/outline/tree",
		strings.NewReader(`{"owner":"vdom-o","repo":"vdom-r","sha":"vdomsha1"}`)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var out struct {
		Depth int `json:"depth"`
		Stats struct {
			SamplingStrategy string `json:"samplingStrategy"`
		} `json:"stats"`
		Chapters []cognitive.OutlineChapter `json:"chapters"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, 1, out.Depth, "4 文件夹具必须走深度 1 旗舰路径")
	assert.Equal(t, "full-ast", out.Stats.SamplingStrategy, "夹具应走策略 A 全量 AST 建图")
	require.NotEmpty(t, out.Chapters)

	comps := companionPaths(out.Chapters)
	for c := range comps {
		assert.False(t, strings.HasPrefix(c, "packages/compiler-core/"),
			"深度 1 严禁跨子系统错挂（depth==1 共享顶层分区不是挂载凭证）: %s", c)
	}
	assert.Contains(t, comps, "packages/react-dom/src/adapters/connect.ts",
		"同子系统关联文件必须挂载（AST 边第一轮或同子系统补位第二轮）")
	assert.NotContains(t, comps, "packages/react-dom/src/index.ts", "主课时自身不出现在协同集")
}

package pipelineb

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

func TestSelectCoreFilesFromTree(t *testing.T) {
	patterns := loadPatterns(t)

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 500},
		{Path: "package.json", Type: "blob", Size: 300},
		{Path: "src/index.ts", Type: "blob", Size: 800},
		{Path: "src/utils.ts", Type: "blob", Size: 1200},
		{Path: "assets/logo.png", Type: "blob", Size: 5000},
		{Path: "node_modules/dep/index.js", Type: "blob", Size: 1000},
		{Path: ".git/config", Type: "blob", Size: 100},
		{Path: "docs/architecture.md", Type: "blob", Size: 2000},
	}

	selected := SelectCoreFilesFromTree(entries, patterns, 3)
	require.Len(t, selected, 3)
	assert.Equal(t, "README.md", selected[0])
	assert.Equal(t, "package.json", selected[1])
	assert.Equal(t, "src/index.ts", selected[2])

	for _, p := range selected {
		assert.NotContains(t, p, "logo.png")
		assert.NotContains(t, p, "node_modules")
		assert.NotContains(t, p, ".git")
	}
}

func TestSelectCoreFilesFromTree_WithPrefixScope(t *testing.T) {
	patterns := loadPatterns(t)

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 500},
		{Path: "package.json", Type: "blob", Size: 300},
		{Path: "services/worker-sidecar/README.md", Type: "blob", Size: 400},
		{Path: "services/worker-sidecar/go.mod", Type: "blob", Size: 250},
		{Path: "services/worker-sidecar/cmd/main.go", Type: "blob", Size: 600},
		{Path: "services/worker-sidecar/internal/calc.go", Type: "blob", Size: 300},
	}

	selected := SelectCoreFilesFromTree(entries, patterns, 3, "services/worker-sidecar")
	require.Len(t, selected, 3)
	assert.Equal(t, "services/worker-sidecar/README.md", selected[0])
	assert.Equal(t, "services/worker-sidecar/go.mod", selected[1])
	assert.Equal(t, "services/worker-sidecar/cmd/main.go", selected[2])

	for _, p := range selected {
		assert.True(t, strings.HasPrefix(p, "services/worker-sidecar/"), "must be scoped inside prefix: %s", p)
	}
}

func TestSelectCoreFilesFromTree_MultipleReadmeTranslations(t *testing.T) {
	patterns := loadPatterns(t)

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 500},
		{Path: "README_zh.md", Type: "blob", Size: 500},
		{Path: "README_ja.md", Type: "blob", Size: 500},
		{Path: "README_fr.md", Type: "blob", Size: 500},
		{Path: "package.json", Type: "blob", Size: 300},
		{Path: "src/main.ts", Type: "blob", Size: 800},
	}

	selected := SelectCoreFilesFromTree(entries, patterns, 3)
	require.Len(t, selected, 3)
	assert.Equal(t, "README.md", selected[0], "主 README 必须首选")
	assert.Equal(t, "package.json", selected[1], "构建配置应当优于翻译版 README")
	assert.Equal(t, "README_fr.md", selected[2], "次级文件按评分或路径排序")
}

func TestBuildRepoMapFromTree_Basic(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	readmeContent := "# Project\nLine 2\nLine 3\n"
	mainContent := "package main\n\nimport \"fmt\"\n\nfunc MainRun() {\n\tfmt.Println(\"ok\")\n}\n"

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: int64(len(readmeContent))},
		{Path: "main.go", Type: "blob", Size: int64(len(mainContent))},
		{Path: "pkg/calc.go", Type: "blob", Size: 320},
		{Path: "pkg/sub/foo.go", Type: "blob", Size: 640},
	}

	coreFiles := map[string]string{
		"README.md": readmeContent,
		"main.go":   mainContent,
	}

	m, err := BuildRepoMapFromTree(entries, coreFiles, "demo-repo", "", defs, patterns, 100)
	require.NoError(t, err)
	require.NotNil(t, m)
	assert.Equal(t, "demo-repo", m.RepoName)
	assert.False(t, m.Truncated)
	require.NotNil(t, m.Tree)
	assert.Equal(t, 4, m.Tree.FileCount)

	var readmeFm *FileMap
	for _, f := range m.Files {
		if f.Path == "README.md" {
			readmeFm = &f
			break
		}
	}
	require.NotNil(t, readmeFm)
	assert.Equal(t, 4, readmeFm.LOC)

	var calcFm *FileMap
	for _, f := range m.Files {
		if f.Path == "pkg/calc.go" {
			calcFm = &f
			break
		}
	}
	require.NotNil(t, calcFm)
	assert.Equal(t, 11, calcFm.LOC)

	var mainFm *FileMap
	for _, f := range m.Files {
		if f.Path == "main.go" {
			mainFm = &f
			break
		}
	}
	require.NotNil(t, mainFm)
	assert.Contains(t, mainFm.Exports, "MainRun")
}

func TestBuildRepoMapFromTree_LargeTreeScale(t *testing.T) {
	patterns := loadPatterns(t)

	const totalEntries = 60000
	entries := make([]client.GitTreeEntry, totalEntries)
	for i := 0; i < totalEntries; i++ {
		dir := fmt.Sprintf("module_%02d/sub_%02d", i%20, (i/20)%10)
		entries[i] = client.GitTreeEntry{
			Path: fmt.Sprintf("%s/file_%05d.cpp", dir, i),
			Type: "blob",
			Size: int64(100 + (i % 5000)),
		}
	}
	entries[0] = client.GitTreeEntry{Path: "README.md", Type: "blob", Size: 400}
	entries[1] = client.GitTreeEntry{Path: "CMakeLists.txt", Type: "blob", Size: 1200}

	coreFiles := map[string]string{
		"README.md":      "# OpenClaw\nArchitecture Overview\n",
		"CMakeLists.txt": "cmake_minimum_required(VERSION 3.10)\nproject(OpenClaw)\n",
	}

	start := time.Now()
	m, err := BuildRepoMapFromTree(entries, coreFiles, "openclaw", "", nil, patterns, 1200)
	elapsed := time.Since(start)

	require.NoError(t, err)
	require.NotNil(t, m)
	assert.True(t, m.Truncated)
	require.NotNil(t, m.Tree)
	assert.Equal(t, totalEntries, m.Tree.FileCount)
	assert.Len(t, m.Files, 1200)

	hasReadme := false
	hasCMake := false
	for _, f := range m.Files {
		if f.Path == "README.md" {
			hasReadme = true
		}
		if f.Path == "CMakeLists.txt" {
			hasCMake = true
			assert.True(t, f.IsConfig, "CMakeLists.txt 必须被标记为 IsConfig")
		}
	}
	assert.True(t, hasReadme, "README.md 必须保底入选")
	assert.True(t, hasCMake, "CMakeLists.txt 必须保底入选")

	t.Logf("60,000 entries in-memory build took %v", elapsed)
	assert.Less(t, elapsed, 1500*time.Millisecond)
}

func TestBuildRepoMapFromTree_Empty(t *testing.T) {
	patterns := loadPatterns(t)

	_, err := BuildRepoMapFromTree(nil, nil, "empty", "", nil, patterns)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "empty repository")

	onlyImages := []client.GitTreeEntry{
		{Path: "image.png", Type: "blob", Size: 100},
	}
	_, err2 := BuildRepoMapFromTree(onlyImages, nil, "images", "", nil, patterns)
	require.Error(t, err2)
	assert.Contains(t, err2.Error(), "no content files found")
}

func TestBuildRepoMapFromTree_MicroRepo(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 50},
		{Path: "index.js", Type: "blob", Size: 120},
	}
	coreFiles := map[string]string{
		"README.md": "# Micro\n",
		"index.js":  "module.exports = function add(a, b) { return a + b; };\n",
	}

	m, err := BuildRepoMapFromTree(entries, coreFiles, "micro", "", defs, patterns, 100)
	require.NoError(t, err)
	require.NotNil(t, m)
	assert.True(t, m.IsMicroRepo)
}

func TestBuildRepoMapFromTree_AstGroundingAndCallEdges(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	calcContent := "package pkg\n\nfunc ComputeScore(x int) int {\n\treturn x * 42\n}\n"
	mainContent := "package main\n\nimport \"demo/pkg\"\n\nfunc Entrypoint() {\n\tpkg.ComputeScore(10)\n}\n"

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 50},
		{Path: "pkg/calc.go", Type: "blob", Size: int64(len(calcContent))},
		{Path: "cmd/main.go", Type: "blob", Size: int64(len(mainContent))},
	}

	coreFiles := map[string]string{
		"pkg/calc.go": calcContent,
		"cmd/main.go": mainContent,
	}

	m, err := BuildRepoMapFromTree(entries, coreFiles, "demo", "", defs, patterns, 100)
	require.NoError(t, err)
	require.NotNil(t, m)

	var calcFm, mainFm *FileMap
	for _, f := range m.Files {
		if f.Path == "pkg/calc.go" {
			calcFm = &f
		}
		if f.Path == "cmd/main.go" {
			mainFm = &f
		}
	}
	require.NotNil(t, calcFm)
	assert.Contains(t, calcFm.Exports, "ComputeScore")

	require.NotNil(t, mainFm)
	assert.Contains(t, mainFm.Exports, "Entrypoint")
	assert.Contains(t, mainFm.Imports, "demo/pkg")

	require.NotEmpty(t, m.CallEdges, "必须捕获 cmd/main.go -> pkg/calc.go 真实 AST 调用边")
	foundEdge := false
	for _, edge := range m.CallEdges {
		if edge.Caller == "cmd/main.go" && edge.Callee == "pkg/calc.go" && edge.Symbol == "ComputeScore" {
			foundEdge = true
			break
		}
	}
	assert.True(t, foundEdge, "CallEdges 应包含 Caller=cmd/main.go, Callee=pkg/calc.go, Symbol=ComputeScore")

	require.NotNil(t, m.Tree)
	leafFiles := m.Tree.LeafFiles()
	var treeCalcFm *FileMap
	for _, f := range leafFiles {
		if f.Path == "pkg/calc.go" {
			treeCalcFm = &f
			break
		}
	}
	require.NotNil(t, treeCalcFm)
	assert.Contains(t, treeCalcFm.Exports, "ComputeScore", "m.Tree 叶子节点必须挂载真实 AST 导出")
}

func monorepoTreeEntries() []client.GitTreeEntry {
	return []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: 300},
		{Path: "package.json", Type: "blob", Size: 200},
		{Path: "packages/reactivity/index.ts", Type: "blob", Size: 500},
		{Path: "packages/reactivity/effect.ts", Type: "blob", Size: 400},
		{Path: "packages/compiler-core/index.ts", Type: "blob", Size: 600},
		{Path: "packages/compiler-core/parse.ts", Type: "blob", Size: 450},
		{Path: "packages/compiler-core/codegen.ts", Type: "blob", Size: 380},
		{Path: "packages/runtime-core/index.ts", Type: "blob", Size: 550},
		{Path: "packages/runtime-core/vnode.ts", Type: "blob", Size: 420},
	}
}

func hasPrefixShare(paths []string, prefix string) bool {
	for _, p := range paths {
		if strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	return false
}

func TestSubsystemStratifiedSamplingShares(t *testing.T) {
	patterns := loadPatterns(t)
	entries := monorepoTreeEntries()

	subsystems := DiscoverSubsystems(SubsystemSourcesFromTreeEntries(entries), patterns)
	require.Len(t, subsystems, 3, "三包子目录必须识别为三个子系统")
	gotPrefixes := make([]string, 0, len(subsystems))
	for _, s := range subsystems {
		gotPrefixes = append(gotPrefixes, s.Prefix)
	}
	assert.ElementsMatch(t, []string{
		"packages/reactivity", "packages/compiler-core", "packages/runtime-core",
	}, gotPrefixes)

	previewFiles := make([]FileMap, 0, len(entries))
	for _, e := range entries {
		rel := strings.TrimPrefix(e.Path, "/")
		previewFiles = append(previewFiles, FileMap{
			Path:     rel,
			LOC:      int(e.Size)/32 + 1,
			IsConfig: isMainConfigFile(strings.ToLower(filepath.Base(rel))),
		})
	}
	tree := BuildRepoTree(previewFiles, "vue-like")

	tests := []struct {
		name   string
		budget int
	}{
		{name: "预算充裕 160", budget: 160},
		{name: "预算紧绷 9", budget: 9},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			skeleton := RenderStratifiedSamplingSkeleton(tree, subsystems, tt.budget)
			assert.Contains(t, skeleton, "packages/reactivity/index.ts", "reactivity 必须有骨架份额")
			assert.Contains(t, skeleton, "packages/compiler-core/index.ts", "compiler-core 必须有骨架份额")
			assert.Contains(t, skeleton, "packages/runtime-core/index.ts", "runtime-core 必须有骨架份额")
		})
	}

	filled := FillSubsystemQuotaFiles([]string{"packages/reactivity/index.ts"}, entries, patterns, subsystems, "", 50)
	assert.True(t, hasPrefixShare(filled, "packages/compiler-core"), "补足后 compiler-core 必须有份额: %v", filled)
	assert.True(t, hasPrefixShare(filled, "packages/runtime-core"), "补足后 runtime-core 必须有份额: %v", filled)

	quota := SelectCoreFilesFromTreeSubsystemQuota(entries, patterns, 8, subsystems)
	require.NotEmpty(t, quota)
	assert.LessOrEqual(t, len(quota), 8, "规则兜底硬帽沿用 ≤8")
	for _, prefix := range []string{"packages/reactivity", "packages/compiler-core", "packages/runtime-core"} {
		assert.True(t, hasPrefixShare(quota, prefix), "配额兜底后 %s 必须有份额: %v", prefix, quota)
	}
}

func TestTryTreeFirstFullAstStrategy(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	readmeContent := "# demo\n"
	calcContent := "package pkg\n\nfunc ComputeScore(x int) int {\n\treturn x * 42\n}\n"
	mainContent := "package main\n\nimport \"demo/pkg\"\n\nfunc Entrypoint() {\n\tpkg.ComputeScore(10)\n}\n"

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: int64(len(readmeContent))},
		{Path: "pkg/calc.go", Type: "blob", Size: int64(len(calcContent))},
		{Path: "cmd/main.go", Type: "blob", Size: int64(len(mainContent))},
	}
	allContents := map[string]string{
		"README.md":   readmeContent,
		"pkg/calc.go": calcContent,
		"cmd/main.go": mainContent,
	}

	sampler := &fakeSamplerImpl{res: &OutlineSamplerResult{NeedFiles: []string{"cmd/main.go"}}}
	var fetchedPaths []string

	h := &Handler{
		defsFn: func() *rsg.LanguageDefinitions { return defs },
		treeFetcher: func(_ context.Context, _ string, _, _, _, _, _ string) (*client.GitTreeResponse, error) {
			return &client.GitTreeResponse{SHA: "sha1", Tree: entries}, nil
		},
	}
	h.SetGitHubConfig("test-token", "", "UA-Test")
	h.SetConcurrentBlobFetcher(func(_ context.Context, _ string, _, _, _ string, paths []string, _, _ string) (map[string]string, bool, error) {
		fetchedPaths = paths
		out := make(map[string]string, len(paths))
		for _, p := range paths {
			out[p] = allContents[p]
		}
		return out, false, nil
	})

	m, stats, err := h.tryTreeFirst(context.Background(), TreeOutlineRequest{Owner: "o", Repo: "demo", SHA: "sha1"}, patterns)
	require.NoError(t, err)
	require.NotNil(t, m)
	require.NotNil(t, stats)

	assert.Equal(t, "full-ast", stats.Strategy, "阈值内仓库必须走策略 A 全量 AST")
	assert.Equal(t, 3, stats.SampledFileCount, "全量拉取下采样文件数 = 作用域内容文件数")
	assert.InDelta(t, 1.0, stats.AstCoverageRatio, 0.001, "全量拉取 AST 覆盖率必须为 1")
	assert.Nil(t, sampler.captured, "策略 A 必须显式短路 LLM 采样器（零采样延迟）")
	assert.ElementsMatch(t, []string{"README.md", "pkg/calc.go", "cmd/main.go"}, fetchedPaths)

	var calcFm *FileMap
	for i := range m.Files {
		if m.Files[i].Path == "pkg/calc.go" {
			calcFm = &m.Files[i]
			break
		}
	}
	require.NotNil(t, calcFm)
	assert.Greater(t, calcFm.Hotness, 0, "非入口核心文件必须有真实 PageRank Hotness")
	require.NotEmpty(t, m.CallEdges, "策略 A 必须建出跨文件 AST 调用边")
	foundEdge := false
	for _, edge := range m.CallEdges {
		if edge.Caller == "cmd/main.go" && edge.Callee == "pkg/calc.go" && edge.Symbol == "ComputeScore" {
			foundEdge = true
			break
		}
	}
	assert.True(t, foundEdge, "CallEdges 必须包含 cmd/main.go -> pkg/calc.go (ComputeScore)")
}

func TestTryTreeFirstPartialAst(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	readmeContent := "# demo\n"
	calcContent := "package pkg\n\nfunc ComputeScore(x int) int {\n\treturn x * 42\n}\n"
	mainContent := "package main\n\nfunc Entrypoint() {}\n"

	entries := []client.GitTreeEntry{
		{Path: "README.md", Type: "blob", Size: int64(len(readmeContent))},
		{Path: "pkg/calc.go", Type: "blob", Size: int64(len(calcContent))},
		{Path: "cmd/main.go", Type: "blob", Size: int64(len(mainContent))},
	}

	h := &Handler{
		defsFn: func() *rsg.LanguageDefinitions { return defs },
		treeFetcher: func(_ context.Context, _ string, _, _, _, _, _ string) (*client.GitTreeResponse, error) {
			return &client.GitTreeResponse{SHA: "sha1", Tree: entries}, nil
		},
	}
	h.SetGitHubConfig("test-token", "", "UA-Test")
	h.SetConcurrentBlobFetcher(func(_ context.Context, _ string, _, _, _ string, paths []string, _, _ string) (map[string]string, bool, error) {
		return map[string]string{"README.md": readmeContent}, true, nil
	})

	m, stats, err := h.tryTreeFirst(context.Background(), TreeOutlineRequest{Owner: "o", Repo: "demo", SHA: "sha1"}, patterns)
	require.NoError(t, err)
	require.NotNil(t, m)
	require.NotNil(t, stats)
	assert.Equal(t, "partial-ast", stats.Strategy, "截断时采样策略必须记 partial-ast")
	assert.Equal(t, 1, stats.SampledFileCount)
	assert.InDelta(t, 1.0/3.0, stats.AstCoverageRatio, 0.001, "覆盖率必须如实反映部分拉取")
}

func TestTryTreeFirstStratifiedRouting(t *testing.T) {
	t.Setenv("TREE_FIRST_FULL_AST_CAP", "2")

	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	readmeContent := "# demo\n"
	entries := monorepoTreeEntries()

	sampler := &fakeSamplerImpl{
		res: &OutlineSamplerResult{NeedFiles: []string{"packages/reactivity/index.ts"}},
	}

	h := &Handler{
		defsFn: func() *rsg.LanguageDefinitions { return defs },
		sampler: &customSamplerFunc{
			fn: func(ctx context.Context, sreq SampleRequest) (*OutlineSamplerResult, error) {
				sampler.captured = &sreq
				return sampler.SampleCoreFiles(ctx, sreq)
			},
		},
	}
	h.SetGitHubConfig("test-token", "", "UA-Test")
	h.SetFetchers(
		func(_ context.Context, _ string, _, _, _, _, _ string) (*client.GitTreeResponse, error) {
			return &client.GitTreeResponse{SHA: "sha1", Tree: entries}, nil
		},
		func(_ context.Context, _ string, _, _, _ string, paths []string, _, _ string) (map[string]string, error) {
			out := make(map[string]string, len(paths))
			for _, p := range paths {
				out[p] = "export const X = 1;\n"
				if p == "README.md" {
					out[p] = readmeContent
				}
			}
			return out, nil
		},
	)

	req := TreeOutlineRequest{
		Owner: "o", Repo: "vue-like", SHA: "sha1",
		TeachingDepth:    "deep",
		LearnerArchetype: "deep_dive_internals",
		CustomPrompt:     "聚焦编译器管线",
	}
	m, stats, err := h.tryTreeFirst(context.Background(), req, patterns)
	require.NoError(t, err)
	require.NotNil(t, m)
	require.NotNil(t, stats)
	assert.Equal(t, "stratified", stats.Strategy, "超阈值仓库必须走策略 B 分层抽样")
	assert.Greater(t, stats.SampledFileCount, 0)

	require.NotNil(t, sampler.captured)
	assert.Equal(t, "deep", sampler.captured.TeachingDepth)
	assert.Equal(t, "deep_dive_internals", sampler.captured.LearnerArchetype)
	assert.Equal(t, "聚焦编译器管线", sampler.captured.CustomPrompt)
	assert.Contains(t, sampler.captured.Skeleton, "packages/compiler-core", "分层骨架必须按子系统均摊")
}

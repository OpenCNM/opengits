package pipelineb

import (
	"os"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildMacroTopology_TableDriven(t *testing.T) {
	patterns := loadPatterns(t)

	tests := []struct {
		name             string
		setupRepoMap     func() *RepoMap
		scope            string
		scale            int
		expectStrategy   string
		expectMinNodes   int
		expectMaxNodes   int
		expectNodeIDs    []string
		expectEdgeCount  int
		mermaidSubstring string
	}{
		{
			name: "flat repo with no subdirectories triggers topological_layer strategy",
			setupRepoMap: func() *RepoMap {
				files := []FileMap{
					{Path: "cli.go", LOC: 100, Layer: LayerInterface, Exports: []string{"Run", "Execute"}, Hotness: 90},
					{Path: "engine.go", LOC: 250, Layer: LayerPipeline, Exports: []string{"Process", "Compute"}, Hotness: 70},
					{Path: "model.go", LOC: 80, Layer: LayerFoundation, Exports: []string{"DataModel"}, Hotness: 40},
				}
				tree := BuildRepoTree(files, "flat-repo")
				return &RepoMap{
					RepoName: "flat-repo",
					Files:    files,
					Tree:     tree,
					CallEdges: []ASTCallEdge{
						{Caller: "cli.go", Callee: "engine.go", Symbol: "Process"},
						{Caller: "engine.go", Callee: "model.go", Symbol: "DataModel"},
					},
				}
			},
			scope:            "",
			scale:            1,
			expectStrategy:   "topological_layer",
			expectMinNodes:   2,
			expectMaxNodes:   4,
			expectNodeIDs:    []string{"layer_interface", "layer_pipeline", "layer_foundation"},
			expectEdgeCount:  2,
			mermaidSubstring: "layer_interface",
		},
		{
			name: "multi-dir repo with root entrypoint creates entrypoint and subsystem nodes",
			setupRepoMap: func() *RepoMap {
				files := []FileMap{
					{Path: "gin.go", LOC: 180, Layer: LayerInterface, Exports: []string{"Default", "New"}, Hotness: 95},
					{Path: "binding/binding.go", LOC: 120, Layer: LayerPipeline, Exports: []string{"JSON", "Bind"}, Hotness: 60},
					{Path: "binding/json.go", LOC: 80, Layer: LayerPipeline, Exports: []string{"ParseJSON"}, Hotness: 50},
					{Path: "render/render.go", LOC: 150, Layer: LayerPipeline, Exports: []string{"RenderHTML"}, Hotness: 70},
					{Path: "render/html.go", LOC: 90, Layer: LayerPipeline, Exports: []string{"Template"}, Hotness: 45},
					{Path: "utils/common.go", LOC: 60, Layer: LayerFoundation, Exports: []string{"Assert"}, Hotness: 30},
				}
				tree := BuildRepoTree(files, "gin-like-repo")
				return &RepoMap{
					RepoName: "gin-like-repo",
					Files:    files,
					Tree:     tree,
					CallEdges: []ASTCallEdge{
						{Caller: "gin.go", Callee: "binding/binding.go", Symbol: "JSON"},
						{Caller: "gin.go", Callee: "render/render.go", Symbol: "RenderHTML"},
						{Caller: "render/render.go", Callee: "utils/common.go", Symbol: "Assert"},
					},
				}
			},
			scope:            "",
			scale:            1,
			expectStrategy:   "directory",
			expectMinNodes:   3,
			expectMaxNodes:   5,
			expectNodeIDs:    []string{"entrypoint", "sub_binding", "sub_render"},
			expectEdgeCount:  3,
			mermaidSubstring: "entrypoint",
		},
		{
			name: "large repo with >10 subdirectories clusters tail into common_utils",
			setupRepoMap: func() *RepoMap {
				var files []FileMap
				// 12 top-level subdirectories
				subnames := []string{
					"commands", "hugolib", "tpl", "resources", "deploy", "config",
					"parser", "markup", "langs", "media", "cache", "common",
				}
				var callEdges []ASTCallEdge
				for i, name := range subnames {
					p := name + "/core.go"
					hotness := 100 - i*7
					files = append(files, FileMap{
						Path:    p,
						LOC:     200,
						Exports: []string{"Fn" + name},
						Hotness: hotness,
					})
				}
				callEdges = append(callEdges, ASTCallEdge{
					Caller: "commands/core.go",
					Callee: "hugolib/core.go",
					Symbol: "Build",
				})
				callEdges = append(callEdges, ASTCallEdge{
					Caller: "hugolib/core.go",
					Callee: "common/core.go",
					Symbol: "Helper",
				})
				tree := BuildRepoTree(files, "hugo-like-repo")
				return &RepoMap{
					RepoName:  "hugo-like-repo",
					Files:     files,
					Tree:      tree,
					CallEdges: callEdges,
				}
			},
			scope:            "",
			scale:            1,
			expectStrategy:   "directory",
			expectMinNodes:   5,
			expectMaxNodes:   10,
			expectNodeIDs:    []string{"sub_commands", "sub_hugolib", "common_utils"},
			expectEdgeCount:  2,
			mermaidSubstring: "common_utils",
		},
		{
			name: "scale 2 drills into subsystem and attaches external boundary connectors",
			setupRepoMap: func() *RepoMap {
				files := []FileMap{
					{Path: "commands/cli.go", LOC: 100, Exports: []string{"Exec"}},
					{Path: "hugolib/site.go", LOC: 300, Exports: []string{"NewSite"}},
					{Path: "hugolib/page.go", LOC: 200, Exports: []string{"NewPage"}},
					{Path: "hugolib/collector.go", LOC: 150, Exports: []string{"Collect"}},
					{Path: "tpl/template.go", LOC: 250, Exports: []string{"Execute"}},
				}
				tree := BuildRepoTree(files, "repo-scale2")
				return &RepoMap{
					RepoName: "repo-scale2",
					Files:    files,
					Tree:     tree,
					CallEdges: []ASTCallEdge{
						// Inbound: commands calls hugolib/site.go
						{Caller: "commands/cli.go", Callee: "hugolib/site.go", Symbol: "NewSite"},
						// Internal: site.go calls page.go
						{Caller: "hugolib/site.go", Callee: "hugolib/page.go", Symbol: "NewPage"},
						// Outbound: page.go calls tpl/template.go
						{Caller: "hugolib/page.go", Callee: "tpl/template.go", Symbol: "Execute"},
					},
				}
			},
			scope:            "hugolib",
			scale:            2,
			expectStrategy:   "subsystem_components",
			expectMinNodes:   2,
			expectMaxNodes:   6,
			expectNodeIDs:    []string{"ext_inbound", "ext_outbound"},
			expectEdgeCount:  2,
			mermaidSubstring: "ext_inbound",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := tt.setupRepoMap()
			topo := BuildMacroTopology(m, tt.scope, tt.scale, patterns)

			require.NotNil(t, topo, "topology should not be nil")
			assert.Equal(t, tt.expectStrategy, topo.Strategy, "strategy mismatch")
			assert.GreaterOrEqual(t, len(topo.Nodes), tt.expectMinNodes, "nodes count too low")
			assert.LessOrEqual(t, len(topo.Nodes), tt.expectMaxNodes, "nodes count exceeded cap")

			nodeMap := make(map[string]MacroTopologyNode)
			for _, n := range topo.Nodes {
				nodeMap[n.ID] = n
			}

			for _, expectedId := range tt.expectNodeIDs {
				_, ok := nodeMap[expectedId]
				assert.True(t, ok, "expected node ID %s not found in nodes", expectedId)
			}

			assert.GreaterOrEqual(t, len(topo.Edges), tt.expectEdgeCount, "edge count too low")

			// 验证物理骨架 Mermaid 格式闭合性
			require.NotEmpty(t, topo.RawMermaid, "rawMermaid should not be empty")
			assert.True(t, strings.HasPrefix(topo.RawMermaid, "```mermaid\nflowchart TD"), "mermaid header invalid")
			assert.True(t, strings.HasSuffix(topo.RawMermaid, "```"), "mermaid footer invalid")
			assert.Contains(t, topo.RawMermaid, tt.mermaidSubstring, "mermaid should contain expected substring")
		})
	}
}

func TestAttachTopologies_CourseTreeIntegration(t *testing.T) {
	patterns := loadPatterns(t)

	files := []FileMap{
		{Path: "cli/main.go", LOC: 100, Layer: LayerInterface, Exports: []string{"Main"}},
		{Path: "engine/core.go", LOC: 300, Layer: LayerPipeline, Exports: []string{"Start"}},
		{Path: "engine/worker.go", LOC: 150, Layer: LayerPipeline, Exports: []string{"Work"}},
		{Path: "store/db.go", LOC: 200, Layer: LayerFoundation, Exports: []string{"Query"}},
	}
	tree := BuildRepoTree(files, "app")
	m := &RepoMap{
		RepoName: "app",
		Files:    files,
		Tree:     tree,
		CallEdges: []ASTCallEdge{
			{Caller: "cli/main.go", Callee: "engine/core.go", Symbol: "Start"},
			{Caller: "engine/core.go", Callee: "store/db.go", Symbol: "Query"},
		},
	}

	courseTree := &CourseTree{
		Repo: "app",
		OverviewCourse: &Course{
			Name:        "Overview",
			SourcePaths: []string{"."},
		},
		SubCourses: []Course{
			{
				Name:        "Engine Subsystem",
				SourcePaths: []string{"engine"},
			},
		},
	}

	courseTree.AttachTopologies(m, patterns)

	require.NotNil(t, courseTree.MacroTopology, "courseTree.MacroTopology should be populated")
	assert.Equal(t, 1, courseTree.MacroTopology.Scale)
	assert.NotEmpty(t, courseTree.MacroTopology.Nodes)

	require.NotNil(t, courseTree.OverviewCourse.Topology, "overviewCourse.Topology should be attached")
	assert.Equal(t, courseTree.MacroTopology, courseTree.OverviewCourse.Topology)

	require.NotNil(t, courseTree.SubCourses[0].Topology, "subCourse[0].Topology should be attached")
	assert.Equal(t, 2, courseTree.SubCourses[0].Topology.Scale)
	assert.Equal(t, "engine", courseTree.SubCourses[0].Topology.Scope)
}

func TestBuildMacroTopology_RealReposIntegration(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)

	repos := []struct {
		relPath  string
		name     string
		minNodes int
		maxNodes int
	}{
		{"../../../../../storage/repos/gin-gonic/gin", "gin", 2, 8},
		{"../../../../../storage/repos/pallets/click", "click", 3, 10},
		{"../../../../../storage/repos/gohugoio/hugo", "hugo", 4, 10},
	}

	for _, r := range repos {
		t.Run(r.name, func(t *testing.T) {
			// 夹具存在性前置守卫：BuildRepoMap 对缺失/空目录不报错（空图），
			// 仅靠 err 判定会让 skip 失效——占位挂载点（存在但 0 文件）同样跳过
			entries, readErr := os.ReadDir(r.relPath)
			if readErr != nil || len(entries) == 0 {
				t.Skip("local storage repo not available:", r.relPath)
				return
			}
			m, err := BuildRepoMap(r.relPath, r.name, defs, patterns)
			if err != nil {
				t.Skip("local storage repo not available:", err)
				return
			}
			require.NotNil(t, m)

			topo := BuildMacroTopology(m, "", 1, patterns)
			require.NotNil(t, topo)
			assert.GreaterOrEqual(t, len(topo.Nodes), r.minNodes)
			assert.LessOrEqual(t, len(topo.Nodes), r.maxNodes)
			assert.NotEmpty(t, topo.RawMermaid)
			assert.Contains(t, topo.RawMermaid, "```mermaid")
		})
	}
}

// CJK 目录名 mermaid ID 不碰撞回归（宪章 III.5 FNV 兜底）+ docker/ 不再误判辅助目录。
func TestSanitizeMermaidIdCJKCollision(t *testing.T) {
	a := sanitizeMermaidId("sub_组件")
	b := sanitizeMermaidId("sub_模块")
	if a == b {
		t.Fatalf("CJK names collapsed to same id: %q", a)
	}
	assert.True(t, strings.HasPrefix(a, "sub_"), "readable ascii prefix kept: %s", a)
}

func TestIsAuxiliaryDirNameBoundary(t *testing.T) {
	assert.False(t, isAuxiliaryDirName("docker"))
	assert.False(t, isAuxiliaryDirName("docx"))
	assert.False(t, isAuxiliaryDirName("testify-example"))
	assert.True(t, isAuxiliaryDirName("tests"))
	assert.True(t, isAuxiliaryDirName("docs"))
	assert.True(t, isAuxiliaryDirName("benchmark"))
}

// ─────────────────────────────────────────────────────────────
// 契约 C1：DiscoverSubsystems 统一子系统发现 SSOT
// ─────────────────────────────────────────────────────────────

func TestDiscoverSubsystems_TableDriven(t *testing.T) {
	patterns := loadPatterns(t)

	tests := []struct {
		name            string
		patterns        cognitive.Patterns // nil 时回退默认 patterns
		sources         []SubsystemSource
		expectNil       bool
		expectPrimary   []string // 非 auxiliary 的 Prefix，按返回顺序 (EstLOC 降序)
		expectAuxiliary []string // auxiliary 截断尾流
		verify          func(t *testing.T, specs []SubsystemSpec)
	}{
		{
			name: "monorepo manifests at level 1/2 form package boundaries",
			sources: []SubsystemSource{
				{Path: "go.mod", LOC: 5},                    // 根清单不构成子系统
				{Path: "apps/client/package.json", LOC: 10}, // 二级清单目录
				{Path: "apps/client/src/main.ts", LOC: 200},
				{Path: "services/worker-sidecar/go.mod", LOC: 5}, // 二级清单目录
				{Path: "services/worker-sidecar/cmd/serve/main.go", LOC: 150},
				{Path: "packages/shared/package.json", LOC: 10},
				{Path: "packages/shared/lib.ts", LOC: 100},
				{Path: "tools/generator/deep/package.json", LOC: 3}, // 三级清单忽略
				{Path: "README.md", LOC: 30},                        // 根散落文件不占用顶层目录
			},
			expectPrimary: []string{"apps/client", "services/worker-sidecar", "packages/shared", "tools"},
			verify: func(t *testing.T, specs []SubsystemSpec) {
				t.Helper()
				// 聚合统计锁定：最长前缀归属 + FileCount/EstLOC 消费语义
				top := specs[0]
				assert.Equal(t, "apps/client", top.Prefix)
				assert.Equal(t, 2, top.FileCount)
				assert.Equal(t, 210, top.EstLOC)
				assert.Equal(t, "client", top.Name)
				assert.Equal(t, "sub_client", top.ID)
			},
		},
		{
			name: "natural package anchors with uncovered top dir fallback",
			sources: []SubsystemSource{
				{Path: "packages/react/package.json", LOC: 10},
				{Path: "packages/react/src/index.ts", LOC: 300},
				{Path: "packages/dom/dom.ts", LOC: 120},
				{Path: "crates/wasm-core/src/lib.rs", LOC: 200},
				{Path: "cmd/cli/main.go", LOC: 80},
				{Path: "internal/helper/util.go", LOC: 30},
				{Path: "docs/guide.md", LOC: 5}, // 辅助目录不占用候选名额
			},
			expectPrimary: []string{"packages/react", "crates/wasm-core", "packages/dom", "cmd/cli", "internal"},
		},
		{
			name: "single natural package falls back to top-dir partition",
			sources: []SubsystemSource{
				{Path: "packages/foo/src/a.ts", LOC: 50},
				{Path: "packages/foo/src/b.ts", LOC: 40},
				{Path: "src/main.go", LOC: 200},
				{Path: "lib/util.go", LOC: 100},
			},
			expectPrimary: []string{"src", "lib", "packages"},
		},
		{
			name: "truncation keeps top-7 primary and marks tail auxiliary",
			sources: []SubsystemSource{
				{Path: "heavy/core.go", LOC: 900},
				{Path: "d01/core.go", LOC: 100},
				{Path: "d02/core.go", LOC: 100},
				{Path: "d03/core.go", LOC: 100},
				{Path: "d04/core.go", LOC: 100},
				{Path: "d05/core.go", LOC: 100},
				{Path: "d06/core.go", LOC: 100},
				{Path: "d07/core.go", LOC: 100},
				{Path: "d08/core.go", LOC: 100},
				{Path: "d09/core.go", LOC: 100},
				{Path: "d10/core.go", LOC: 100},
			},
			expectPrimary:   []string{"heavy", "d01", "d02", "d03", "d04", "d05", "d06"},
			expectAuxiliary: []string{"d07", "d08", "d09", "d10"},
		},
		{
			name: "auxiliary and non-content dirs are excluded from candidates",
			sources: []SubsystemSource{
				{Path: "engine/a.go", LOC: 80},
				{Path: "engine/b.go", LOC: 60},
				{Path: "core/main.go", LOC: 100},
				{Path: "utils/u.go", LOC: 20},
				{Path: "docs/guide.md", LOC: 5},
				{Path: "media/img.png", LOC: 10}, // 非内容目录 + 二进制
				{Path: "vendor/v.go", LOC: 10},   // 辅助目录名 + 非内容目录
			},
			expectPrimary: []string{"engine", "core", "utils"},
		},
		{
			name: "sparse root files descend through single-dir wrapper",
			sources: []SubsystemSource{
				{Path: "django/core/handler.py", LOC: 200},
				{Path: "django/forms/fields.py", LOC: 150},
				{Path: "django/__init__.py", LOC: 1},
			},
			expectPrimary: []string{"django/core", "django/forms"},
		},
		{
			name: "dense root files stop wrapper descent",
			sources: []SubsystemSource{
				{Path: "main.go", LOC: 500},
				{Path: "app/app.go", LOC: 10},
			},
			expectPrimary: []string{"app"},
		},
		{
			name:      "empty sources yield no subsystems",
			expectNil: true,
		},
		{
			name:     "nil patterns still hard-excludes .git and node_modules",
			patterns: nil,
			sources: []SubsystemSource{
				{Path: ".github/workflows/ci.yml", LOC: 5},
				{Path: "node_modules/left-pad/index.js", LOC: 5},
				{Path: "a/b.go", LOC: 30},
				{Path: "main.go", LOC: 500}, // 根直属文件阻止包装下钻
			},
			expectPrimary: []string{"a"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := tt.patterns
			if p == nil {
				p = patterns
			}
			specs := DiscoverSubsystems(tt.sources, p)
			if tt.expectNil {
				assert.Empty(t, specs, "expected no subsystem specs")
				return
			}
			var primary, aux []string
			for _, s := range specs {
				if s.IsAuxiliary {
					aux = append(aux, s.Prefix)
				} else {
					primary = append(primary, s.Prefix)
				}
			}
			assert.Equal(t, tt.expectPrimary, primary, "primary prefixes (order = EstLOC desc)")
			assert.Equal(t, tt.expectAuxiliary, aux, "auxiliary tail prefixes")

			// 契约字段完整性：ID 唯一且非空、Name/Prefix 非空
			seen := make(map[string]bool, len(specs))
			for _, s := range specs {
				assert.NotEmpty(t, s.ID, "spec id must be assigned")
				assert.NotEmpty(t, s.Name, "spec name must be assigned")
				assert.False(t, seen[s.ID], "duplicated spec id %s", s.ID)
				seen[s.ID] = true
			}
			if tt.verify != nil {
				tt.verify(t, specs)
			}
		})
	}
}

// TestBuildMacroTopology_MonorepoDirectoryPartition 锁定 monorepo 仓库经
// DiscoverSubsystems SSOT 分区后 MacroTopologyNode/Edge 的对外形状
// (结构与字段冻结，update/drift.go 依赖)。
func TestBuildMacroTopology_MonorepoDirectoryPartition(t *testing.T) {
	patterns := loadPatterns(t)

	files := []FileMap{
		{Path: "packages/auth/package.json", LOC: 20, IsConfig: true},
		{Path: "packages/auth/token.go", LOC: 250, Exports: []string{"VerifyToken", "SignClaim"}, Hotness: 90},
		{Path: "packages/auth/hash.go", LOC: 120, Hotness: 40},
		{Path: "packages/api/package.json", LOC: 20, IsConfig: true},
		{Path: "packages/api/handler.go", LOC: 300, Exports: []string{"HandleAuth"}, Hotness: 70},
		{Path: "packages/core/package.json", LOC: 20, IsConfig: true},
		{Path: "packages/core/engine.go", LOC: 400, Exports: []string{"Execute"}, Hotness: 85},
	}
	m := &RepoMap{
		RepoName: "monorepo",
		Files:    files,
		Tree:     BuildRepoTree(files, "monorepo"),
		CallEdges: []ASTCallEdge{
			{Caller: "packages/api/handler.go", Callee: "packages/auth/token.go", Symbol: "VerifyToken"},
			{Caller: "packages/api/handler.go", Callee: "packages/core/engine.go", Symbol: "Execute"},
		},
	}

	topo := BuildMacroTopology(m, "", 1, patterns)
	require.NotNil(t, topo)
	assert.Equal(t, "directory", topo.Strategy, "monorepo packages should partition by directory")

	nodeByID := make(map[string]MacroTopologyNode, len(topo.Nodes))
	for _, n := range topo.Nodes {
		nodeByID[n.ID] = n
	}
	require.Len(t, topo.Nodes, 3, "exactly one node per package, no entrypoint/common_utils")
	for id, wantPath := range map[string]string{
		"sub_auth": "packages/auth",
		"sub_api":  "packages/api",
		"sub_core": "packages/core",
	} {
		n, ok := nodeByID[id]
		require.True(t, ok, "expected node %s", id)
		assert.Equal(t, wantPath, n.Path)
	}
	assert.Equal(t, "interface", nodeByID["sub_api"].Role, "role derived from segment name")
	assert.Equal(t, 2, nodeByID["sub_core"].FileCount, "FileCount includes package manifest + source")
	assert.Equal(t, 420, nodeByID["sub_core"].LOC)

	// 跨包 AST 调用边聚合到子系统节点对
	edgeFound := false
	for _, e := range topo.Edges {
		if e.From == "sub_api" && e.To == "sub_auth" {
			edgeFound = true
			assert.Contains(t, e.Symbols, "VerifyToken")
		}
	}
	assert.True(t, edgeFound, "expected aggregated edge sub_api -> sub_auth")
}

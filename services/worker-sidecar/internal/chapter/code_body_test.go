package chapter

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestResolveModuleSnapshot 验证序号匹配、默认 1 匹配、slug 匹配与无快照兜底
func TestResolveModuleSnapshot(t *testing.T) {
	tests := []struct {
		name        string
		repoProfile map[string]any
		docPath     string
		docTitle    string
		wantTitle   string
		wantNil     bool
	}{
		{
			name: "numeric matching ChapterNo",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{
					{"teachingOrder": 1, "chapterNo": 1, "title": "Module 1"},
					{"teachingOrder": 2, "chapterNo": 2, "title": "Module 2"},
				},
			},
			docPath:   "chapters/02.mdx",
			wantTitle: "Module 2",
		},
		{
			name: "numeric matching TeachingOrder fallback when chapterNo is 0",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{
					{"teachingOrder": 3, "chapterNo": 0, "title": "Module 3"},
				},
			},
			docPath:   "chapters/03.mdx",
			wantTitle: "Module 3",
		},
		{
			name: "slug fuzzy matching",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{
					{"teachingOrder": 0, "chapterNo": 0, "title": "Database Engine"},
				},
			},
			docPath:   "chapters/database-engine.mdx",
			wantTitle: "Database Engine",
		},
		{
			name: "docTitle contains cluster title",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{
					{"teachingOrder": 0, "chapterNo": 0, "title": "Core Parser"},
				},
			},
			docPath:   "chapters/deep-dive.mdx",
			docTitle:  "Deep Dive into Core Parser",
			wantTitle: "Core Parser",
		},
		{
			name:        "nil repoProfile returns nil",
			repoProfile: nil,
			docPath:     "chapters/01.mdx",
			wantNil:     true,
		},
		{
			name: "empty codeClusters returns nil",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{},
			},
			docPath: "chapters/01.mdx",
			wantNil: true,
		},
		{
			name: "unmatched chapter returns nil",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{
					{"teachingOrder": 1, "chapterNo": 1, "title": "Auth"},
				},
			},
			docPath: "chapters/99-unknown.mdx",
			wantNil: true,
		},
		{
			name: "cjk slug matching",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{
					{"teachingOrder": 0, "chapterNo": 0, "title": "用户中心"},
				},
			},
			docPath:   "chapters/用户中心.mdx",
			wantTitle: "用户中心",
		},
		{
			name: "cjk docTitle substring matching",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{
					{"teachingOrder": 0, "chapterNo": 0, "title": "订单支付系统"},
				},
			},
			docPath:   "chapters/subsystem_order.mdx",
			docTitle:  "🔬 订单支付系统 深度研读",
			wantTitle: "订单支付系统",
		},
		{
			name: "japanese katakana slug matching",
			repoProfile: map[string]any{
				"codeClusters": []map[string]any{
					{"teachingOrder": 0, "chapterNo": 0, "title": "決済サブシステム"},
				},
			},
			docPath:   "chapters/決済サブシステム.mdx",
			wantTitle: "決済サブシステム",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveModuleSnapshotFromProfile(tt.repoProfile, tt.docPath, tt.docTitle)
			if tt.wantNil {
				assert.Nil(t, got)
			} else {
				require.NotNil(t, got)
				assert.Equal(t, tt.wantTitle, got.Title)
			}
		})
	}
}

// TestPackModuleFilesFromArchive 验证本地解压归档多文件聚合读取与平滑预算分配
func TestPackModuleFilesFromArchive(t *testing.T) {
	tmpDir := t.TempDir()
	owner, repo, sha := "owner1", "repo1", "sha123"
	baseDir := filepath.Join(tmpDir, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(baseDir, "src"), 0o755))

	require.NoError(t, os.WriteFile(filepath.Join(baseDir, "src", "a.ts"), []byte("line1\nline2\nline3\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(baseDir, "src", "b.ts"), []byte("const x = 1;\n"), 0o644))

	tests := []struct {
		name      string
		files     []string
		wantCount int
	}{
		{
			name:      "pack existing files",
			files:     []string{"src/a.ts", "src/b.ts"},
			wantCount: 2,
		},
		{
			name:      "skip missing files",
			files:     []string{"src/a.ts", "src/nonexistent.ts"},
			wantCount: 1,
		},
		{
			name:      "pack files with anchor reads underlying file",
			files:     []string{"src/a.ts#myFunc", "src/b.ts#on"},
			wantCount: 2,
		},
		{
			name:      "empty files slice",
			files:     []string{},
			wantCount: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := PackModuleFilesFromArchive(tmpDir, owner, repo, sha, tt.files)
			assert.Len(t, got, tt.wantCount)
			if tt.wantCount > 0 {
				assert.Contains(t, got[0].Path, "src/a.ts")
				assert.Equal(t, 4, got[0].TotalLines)
			}
		})
	}
}

// TestBuildFilesSummary 验证代码材料 Prompt 格式化拼接与 AST 符号锚点 SSOT
func TestBuildFilesSummary(t *testing.T) {
	tests := []struct {
		name          string
		snippets      []armor.ArmorAllocatedSnippet
		symbolsByFile map[string][]cognitive.SymbolEntry
		wantSub       []string
		wantNotSub    []string
		wantEmpty     bool
	}{
		{
			name: "formats snippets correctly without symbol table",
			snippets: []armor.ArmorAllocatedSnippet{
				{
					Path:       "src/index.ts",
					TotalLines: 10,
					Snippet:    "console.log('hello');",
				},
				{
					Path:       "src/util.ts",
					TotalLines: 5,
					Snippet:    "export const id = 1;",
				},
			},
			wantSub: []string{
				"[File 1] src/index.ts (10 lines)",
				"console.log('hello');",
				"[File 2] src/util.ts (5 lines)",
				"export const id = 1;",
			},
			wantNotSub: []string{
				"Available code slot anchors",
			},
		},
		{
			name: "formats snippets with focus anchor",
			snippets: []armor.ArmorAllocatedSnippet{
				{
					Path:       "src/index.ts#mitt",
					TotalLines: 10,
					Snippet:    "export default function mitt() {}",
				},
			},
			symbolsByFile: map[string][]cognitive.SymbolEntry{
				"src/index.ts": {
					{Name: "mitt", Kind: "function", StartLine: 1, EndLine: 1},
				},
			},
			wantSub: []string{
				"[File 1] src/index.ts (focus: mitt, 10 lines)",
				"(Available code slot anchors: [File 1#mitt])",
				"export default function mitt() {}",
			},
		},
		{
			name: "docstring example defs do not leak as anchors when using AST SSOT",
			snippets: []armor.ArmorAllocatedSnippet{
				{
					Path:       "libs/langgraph/langgraph/graph/state.py",
					TotalLines: 200,
					Snippet:    "class StateGraph:\n    \"\"\"\n    Example:\n        def reducer(a, b):\n            return a\n        class State(TypedDict):\n            pass\n    \"\"\"\n    pass",
				},
			},
			symbolsByFile: map[string][]cognitive.SymbolEntry{
				"libs/langgraph/langgraph/graph/state.py": {
					{Name: "StateGraph", Kind: "class", StartLine: 1, EndLine: 10},
				},
			},
			wantSub: []string{
				"(Available code slot anchors: [File 1#StateGraph])",
			},
			wantNotSub: []string{
				"[File 1#reducer]",
				"[File 1#State]",
			},
		},
		{
			name:      "empty snippets returns empty string",
			snippets:  []armor.ArmorAllocatedSnippet{},
			wantEmpty: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := BuildFilesSummary(tt.snippets, tt.symbolsByFile)
			if tt.wantEmpty {
				assert.Empty(t, got)
			} else {
				for _, sub := range tt.wantSub {
					assert.Contains(t, got, sub)
				}
				for _, notSub := range tt.wantNotSub {
					assert.NotContains(t, got, notSub)
				}
			}
		})
	}
}

// TestFormatCodeChapterBody 验证确定性 Markdown 模板与 Mermaid 图谱
func TestResolveModuleSnapshotEmptySlugGuard(t *testing.T) {
	profile := map[string]any{
		"codeClusters": []map[string]any{
			{"teachingOrder": 1, "title": "Introduction"},
			{"teachingOrder": 2, "title": "Advanced"},
		},
	}
	// 中文文件名清洗后 slug 为空：Contains(_, "") 恒真曾误配到首个模块
	snap := ResolveModuleSnapshotFromProfile(profile, "chapters/快速入门.mdx", "")
	assert.Nil(t, snap)
	// docTitle 兜底不受影响
	snap = ResolveModuleSnapshotFromProfile(profile, "chapters/快速入门.mdx", "Advanced")
	if assert.NotNil(t, snap) {
		assert.Equal(t, "Advanced", snap.Title)
	}
}

package chapter

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
				"Valid slot anchors",
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
				"(Valid slot anchors — cite only the ones you teach: [File 1#mitt])",
				"export default function mitt() {}",
			},
			wantNotSub: []string{
				"most central first",
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
				"(Valid slot anchors — cite only the ones you teach: [File 1#StateGraph])",
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
			got := BuildFilesSummary(tt.snippets, EvidenceOptions{SymbolsByFile: tt.symbolsByFile})
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

func TestResolveModuleSnapshotEmptySlugGuard(t *testing.T) {
	profile := map[string]any{
		"codeClusters": []map[string]any{
			{"teachingOrder": 1, "title": "Introduction"},
			{"teachingOrder": 2, "title": "Advanced"},
		},
	}
	snap := ResolveModuleSnapshotFromProfile(profile, "chapters/快速入门.mdx", "")
	assert.Nil(t, snap)
	snap = ResolveModuleSnapshotFromProfile(profile, "chapters/快速入门.mdx", "Advanced")
	if assert.NotNil(t, snap) {
		assert.Equal(t, "Advanced", snap.Title)
	}
}

func TestFileEvidence_ContainerContractAndTruncatedNested(t *testing.T) {
	t.Helper()
	var pyLines []string
	pyLines = append(pyLines, "import torch", "import torch.nn as nn", "")
	pyLines = append(pyLines, "class GPT(nn.Module):")
	for i := 5; i <= 75; i++ {
		pyLines = append(pyLines, "    def helper_method(): pass")
	}
	pyLines = append(pyLines, "    def from_pretrained(cls, model_type):")
	pyLines = append(pyLines, "        return model_type")
	pyLines = append(pyLines, "    def estimate_mfu(self, dt):")
	pyLines = append(pyLines, "        return dt")
	for i := len(pyLines) + 1; i <= 150; i++ {
		pyLines = append(pyLines, "    # trailing padding line")
	}
	pyRaw := strings.Join(pyLines, "\n")

	var tsLines []string
	tsLines = append(tsLines, "export function outerFlow() {")
	for i := 2; i <= 30; i++ {
		tsLines = append(tsLines, "    doStep();")
	}
	tsLines = append(tsLines, "    function earlyInner() { return 1; }")
	for i := 32; i <= 75; i++ {
		tsLines = append(tsLines, "    doMore();")
	}
	tsLines = append(tsLines, "    function lateInner() { return 2; }")
	for i := 77; i <= 110; i++ {
		tsLines = append(tsLines, "    finishStep();")
	}
	tsLines = append(tsLines, "}")
	for i := 0; i < 60; i++ {
		tsLines = append(tsLines, "// module trailing filler line to ensure truncation happens cleanly")
	}
	tsRaw := strings.Join(tsLines, "\n")

	tests := []struct {
		name       string
		path       string
		raw        string
		symbols    []cognitive.SymbolEntry
		edges      []cognitive.CallEdge
		wantSub    []string
		wantNotSub []string
	}{
		{
			name: "巨型容器类提取 AspectContract 且不吞并内部核心方法",
			path: "model.py",
			raw:  pyRaw,
			symbols: []cognitive.SymbolEntry{
				{Name: "GPT", Kind: "type", StartLine: 4, EndLine: 150, Importers: 3},
				{Name: "from_pretrained", Kind: "function", StartLine: 76, EndLine: 77},
				{Name: "estimate_mfu", Kind: "function", StartLine: 78, EndLine: 79},
			},
			edges: []cognitive.CallEdge{
				{CallerFile: "model.py", CallerSymbol: "from_pretrained", CalleeFile: "model.py", CalleeSymbol: "GPT", Line: 77},
				{CallerFile: "model.py", CallerSymbol: "estimate_mfu", CalleeFile: "model.py", CalleeSymbol: "from_pretrained", Line: 79},
			},
			wantSub: []string{
				"Evidence 1 — [File 1#GPT] (L4-L150)",
				"class GPT(nn.Module): ...",
				"Evidence 2 — [File 1#from_pretrained] (L76-L77)",
				"Evidence 3 — [File 1#estimate_mfu] (L78-L79)",
			},
		},
		{
			name: "截断函数按实际覆盖行记入 emitted：早段已展示跳过，后段未展示不吞并",
			path: "flow.ts",
			raw:  tsRaw,
			symbols: []cognitive.SymbolEntry{
				{Name: "outerFlow", Kind: "function", StartLine: 1, EndLine: 111},
				{Name: "earlyInner", Kind: "function", StartLine: 31, EndLine: 31},
				{Name: "lateInner", Kind: "function", StartLine: 76, EndLine: 76},
			},
			edges: []cognitive.CallEdge{
				{CallerFile: "flow.ts", CallerSymbol: "outerFlow", CalleeFile: "flow.ts", CalleeSymbol: "earlyInner", Line: 31},
				{CallerFile: "flow.ts", CallerSymbol: "outerFlow", CalleeFile: "flow.ts", CalleeSymbol: "lateInner", Line: 76},
			},
			wantSub: []string{
				"Evidence 1 — [File 1#outerFlow] (L1-L111)",
				"Evidence 2 — [File 1#lateInner] (L76-L76)",
			},
			wantNotSub: []string{
				"Evidence 2 — [File 1#earlyInner]",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			symsByFile := map[string][]cognitive.SymbolEntry{tt.path: tt.symbols}
			ranks := RankChapterSymbols(symsByFile, tt.edges, []string{tt.path})
			snipLen := min(len(tt.raw)-100, 3000)
			snippets := []armor.ArmorAllocatedSnippet{
				{Path: tt.path, TotalLines: len(strings.Split(tt.raw, "\n")), Snippet: tt.raw[:snipLen]},
			}
			got := BuildFilesSummary(snippets, EvidenceOptions{
				SymbolsByFile: symsByFile,
				Ranks:         ranks,
				ReadFile:      func(string) (string, bool) { return tt.raw, true },
			})
			for _, sub := range tt.wantSub {
				assert.Contains(t, got, sub)
			}
			for _, notSub := range tt.wantNotSub {
				assert.NotContains(t, got, notSub)
			}
		})
	}
}

func TestFileEvidence_StrictBudgetClamping(t *testing.T) {
	t.Helper()
	var lines []string
	for i := 1; i <= 20; i++ {
		lines = append(lines, "import { helper } from './helper'; // padding padding padding")
	}
	fnStart := len(lines) + 1
	lines = append(lines, "export function bigHandler(input: string): string {")
	for i := 0; i < 40; i++ {
		lines = append(lines, "    const stepValue = transform(input); // long statement padding")
	}
	lines = append(lines, "    return input;")
	lines = append(lines, "}")
	fnEnd := len(lines)
	raw := strings.Join(lines, "\n")

	symsByFile := map[string][]cognitive.SymbolEntry{
		"big.ts": {{Name: "bigHandler", Kind: "function", StartLine: fnStart, EndLine: fnEnd}},
	}
	edges := []cognitive.CallEdge{
		{CallerFile: "main.ts", CallerSymbol: "main", CalleeFile: "big.ts", CalleeSymbol: "bigHandler", Line: 5},
	}
	ranks := RankChapterSymbols(symsByFile, edges, []string{"big.ts"})

	tests := []struct {
		name   string
		budget int
	}{
		{name: "多文件小预算 1400 严格不膨胀", budget: 1400},
		{name: "极小预算 900 降级为契约或不越界", budget: 900},
		{name: "超小预算 300 安全退回 legacy 且不越界", budget: 300},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := fileEvidence(1, armor.ArmorAllocatedSnippet{
				Path:       "big.ts",
				TotalLines: len(lines),
				Snippet:    raw[:tt.budget],
			}, "big.ts", EvidenceOptions{
				SymbolsByFile: symsByFile,
				Ranks:         ranks,
				ReadFile:      func(string) (string, bool) { return raw, true },
			})
			assert.LessOrEqual(t, len(out), tt.budget+220, "单文件证据卡片总长不应大幅越过文件分配预算")
		})
	}

	t.Run("headWindow 零负边界安全不崩溃", func(t *testing.T) {
		assert.Equal(t, "", headWindow(raw, 0))
		assert.Equal(t, "", headWindow(raw, -10))
	})
}

func TestAnchorSymbolEntries_LineRangeFilter(t *testing.T) {
	entries := []cognitive.SymbolEntry{
		{Name: "ZeroStart", Kind: "function", StartLine: 0, EndLine: 5},
		{Name: "Inverted", Kind: "function", StartLine: 10, EndLine: 5},
		{Name: "Dup", Kind: "function", StartLine: 0, EndLine: 0},
		{Name: "Dup", Kind: "function", StartLine: 12, EndLine: 18},
		{Name: "Valid", Kind: "type", StartLine: 20, EndLine: 20},
	}
	got := anchorSymbolEntries(entries, 10)
	require.Len(t, got, 2)
	assert.Equal(t, cognitive.SymbolEntry{Name: "Dup", Kind: "function", StartLine: 12, EndLine: 18}, got[0])
	assert.Equal(t, cognitive.SymbolEntry{Name: "Valid", Kind: "type", StartLine: 20, EndLine: 20}, got[1])
}

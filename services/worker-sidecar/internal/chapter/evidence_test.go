package chapter

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const evLineBytes = 50

func padLine(s string) string {
	for len(s) < evLineBytes-1 {
		s += " "
	}
	return s
}

type evSym struct {
	name       string
	start, end int
}

func synthEvidenceFile(t *testing.T, syms []evSym) (string, []cognitive.SymbolEntry) {
	t.Helper()
	const total = 400
	lines := make([]string, total)
	for i := range lines {
		lines[i] = padLine(fmt.Sprintf("const line%03d = %03d; // pad pad pad", i+1, i+1))
	}
	symbols := make([]cognitive.SymbolEntry, 0, len(syms))
	for _, s := range syms {
		require.GreaterOrEqual(t, s.start, 1)
		require.LessOrEqual(t, s.end, total)
		for ln := s.start; ln <= s.end; ln++ {
			if ln == s.start {
				lines[ln-1] = padLine(fmt.Sprintf("  // %s body line %d", s.name, ln))
			} else {
				lines[ln-1] = padLine(fmt.Sprintf("  const _v%d = %d; // %s", ln, ln, s.name))
			}
		}
		symbols = append(symbols, cognitive.SymbolEntry{Name: s.name, Kind: "function", StartLine: s.start, EndLine: s.end})
	}
	return strings.Join(lines, "\n"), symbols
}

func evEvidenceFixture(t *testing.T) (raw string, symbols []cognitive.SymbolEntry, edges []cognitive.CallEdge) {
	t.Helper()
	raw, symbols = synthEvidenceFile(t, []evSym{
		{"utility", 20, 24},
		{"orchestrator", 300, 330},
		{"helper", 305, 308},
		{"leaf", 350, 352},
	})
	const path = "src/big.ts"
	for i := 1; i <= 8; i++ {
		edges = append(edges, cognitive.CallEdge{CallerFile: path, CallerSymbol: fmt.Sprintf("caller%d", i), CalleeFile: path, CalleeSymbol: "utility", Line: 10 + i})
	}
	edges = append(edges,
		cognitive.CallEdge{CallerFile: path, CallerSymbol: "entryA", CalleeFile: path, CalleeSymbol: "orchestrator", Line: 5},
		cognitive.CallEdge{CallerFile: path, CallerSymbol: "entryB", CalleeFile: path, CalleeSymbol: "orchestrator", Line: 6},
	)
	for _, callee := range []string{"helper", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"} {
		edges = append(edges, cognitive.CallEdge{CallerFile: path, CallerSymbol: "orchestrator", CalleeFile: path, CalleeSymbol: callee, Line: 310})
	}
	return raw, symbols, edges
}

func TestRankChapterSymbols(t *testing.T) {
	syms := func(entries ...cognitive.SymbolEntry) map[string][]cognitive.SymbolEntry {
		return map[string][]cognitive.SymbolEntry{"a.ts": entries}
	}
	edge := func(callerFile, caller, calleeFile, callee string) cognitive.CallEdge {
		return cognitive.CallEdge{CallerFile: callerFile, CallerSymbol: caller, CalleeFile: calleeFile, CalleeSymbol: callee}
	}
	manyCallers := func(callee string, n int) []cognitive.CallEdge {
		out := make([]cognitive.CallEdge, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, edge("a.ts", fmt.Sprintf("c%d", i), "a.ts", callee))
		}
		return out
	}
	util := cognitive.SymbolEntry{Name: "util", Kind: "function", StartLine: 1, EndLine: 2}
	orch := cognitive.SymbolEntry{Name: "orch", Kind: "function", StartLine: 3, EndLine: 9}

	tests := []struct {
		name       string
		symbols    map[string][]cognitive.SymbolEntry
		edges      []cognitive.CallEdge
		files      []string
		wantNames  []string
		wantSignal bool
		wantFirst  cognitive.SymbolEntry
	}{
		{
			name:    "度中心性把编排型机制排在高入度工具前",
			symbols: syms(util, orch),
			edges: append(manyCallers("util", 6),
				edge("a.ts", "entry", "a.ts", "orch"),
				edge("a.ts", "orch", "a.ts", "x1"), edge("a.ts", "orch", "a.ts", "x2"),
				edge("a.ts", "orch", "a.ts", "x3"), edge("a.ts", "orch", "a.ts", "x4"),
				edge("a.ts", "orch", "a.ts", "x5"), edge("a.ts", "orch", "a.ts", "x6"),
				edge("a.ts", "orch", "a.ts", "x7"), edge("a.ts", "orch", "a.ts", "x8")),
			files:      []string{"a.ts"},
			wantNames:  []string{"orch", "util"},
			wantSignal: true,
		},
		{
			name: "同分保持声明序",
			symbols: syms(
				cognitive.SymbolEntry{Name: "first", StartLine: 1, EndLine: 1},
				cognitive.SymbolEntry{Name: "second", StartLine: 2, EndLine: 2},
			),
			edges:      []cognitive.CallEdge{edge("a.ts", "x", "a.ts", "first"), edge("a.ts", "y", "a.ts", "second")},
			files:      []string{"a.ts"},
			wantNames:  []string{"first", "second"},
			wantSignal: true,
		},
		{
			name: "同名符号只保留首个声明",
			symbols: syms(
				cognitive.SymbolEntry{Name: "constructor", StartLine: 10, EndLine: 12},
				cognitive.SymbolEntry{Name: "foo", StartLine: 20, EndLine: 21},
				cognitive.SymbolEntry{Name: "constructor", StartLine: 30, EndLine: 32},
			),
			files:     []string{"a.ts"},
			wantNames: []string{"constructor", "foo"},
			wantFirst: cognitive.SymbolEntry{Name: "constructor", StartLine: 10, EndLine: 12},
		},
		{
			name: "无调用边：无信号且等于声明序",
			symbols: syms(
				cognitive.SymbolEntry{Name: "zeta", StartLine: 1, EndLine: 1},
				cognitive.SymbolEntry{Name: "alpha", StartLine: 2, EndLine: 2},
			),
			files:     []string{"a.ts"},
			wantNames: []string{"zeta", "alpha"},
		},
		{
			name: "与本章文件无关的调用边不计入",
			symbols: syms(
				cognitive.SymbolEntry{Name: "zeta", StartLine: 1, EndLine: 1},
				cognitive.SymbolEntry{Name: "alpha", StartLine: 2, EndLine: 2},
			),
			edges:     []cognitive.CallEdge{edge("x.ts", "x", "y.ts", "alpha"), edge("y.ts", "alpha", "y.ts", "zeta")},
			files:     []string{"a.ts"},
			wantNames: []string{"zeta", "alpha"},
		},
		{
			name: "跨文件调用方计入被调方入度",
			symbols: syms(
				cognitive.SymbolEntry{Name: "zeta", StartLine: 1, EndLine: 1},
				cognitive.SymbolEntry{Name: "alpha", StartLine: 2, EndLine: 2},
			),
			edges:      []cognitive.CallEdge{edge("b.ts", "x", "a.ts", "alpha")},
			files:      []string{"a.ts"},
			wantNames:  []string{"alpha", "zeta"},
			wantSignal: true,
		},
		{
			name: "文件清单带 anchor 后缀与重复项只排一次",
			symbols: syms(
				cognitive.SymbolEntry{Name: "zeta", StartLine: 1, EndLine: 1},
				cognitive.SymbolEntry{Name: "alpha", StartLine: 2, EndLine: 2},
			),
			edges:      []cognitive.CallEdge{edge("a.ts", "zeta", "a.ts", "alpha")},
			files:      []string{"a.ts#zeta", "a.ts"},
			wantNames:  []string{"zeta", "alpha"},
			wantSignal: true,
		},
		{
			name: "Importers 计入得分",
			symbols: syms(
				cognitive.SymbolEntry{Name: "plain", StartLine: 1, EndLine: 1},
				cognitive.SymbolEntry{Name: "imported", StartLine: 2, EndLine: 2, Importers: 3},
			),
			files:     []string{"a.ts"},
			wantNames: []string{"imported", "plain"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ranks := RankChapterSymbols(tt.symbols, tt.edges, tt.files)
			require.Len(t, ranks, 1)
			got := ranks["a.ts"]
			names := make([]string, 0, len(got.Symbols))
			for _, s := range got.Symbols {
				names = append(names, s.Name)
			}
			assert.Equal(t, tt.wantNames, names)
			assert.Equal(t, tt.wantSignal, got.HasSignal)
			if tt.wantFirst.Name != "" {
				assert.Equal(t, tt.wantFirst, got.Symbols[0])
			}
		})
	}
}

func TestBuildFilesSummaryEvidence(t *testing.T) {
	raw, symbols, edges := evEvidenceFixture(t)
	const path = "src/big.ts"
	readable := func(string) (string, bool) { return raw, true }

	tests := []struct {
		name          string
		edges         []cognitive.CallEdge
		readFile      func(string) (string, bool)
		snippetLen    int
		wantSub       []string
		wantNotSub    []string
		wantBefore    [2]string
		wantLegacyEnd bool
		wantMinLen    int
	}{
		{
			name:       "截断且有调用边：头部窗口 + 度中心性证据函数体，剩余预算扩给头部",
			edges:      edges,
			readFile:   readable,
			snippetLen: 10000,
			wantSub: []string{
				"(Valid slot anchors, most central first — cite only the ones you teach: [File 1#orchestrator], [File 1#utility], [File 1#helper], [File 1#leaf])",
				"File head (imports and module setup):\n```typescript\n",
				"Evidence 1 — [File 1#orchestrator] (L300-L330)\n```typescript\n",
				"Evidence 2 — [File 1#utility] (L20-L24)\n```typescript\n",
				"Evidence 3 — [File 1#leaf] (L350-L352)\n```typescript\n",
				"// orchestrator body line 300",
			},
			wantNotSub: []string{
				"[File 1#helper] (L",
			},
			wantBefore: [2]string{"Evidence 1 — [File 1#orchestrator]", "Evidence 2 — [File 1#utility]"},
			wantMinLen: 10000,
		},
		{
			name:       "截断但无调用边：逐字节退化为历史头部摘录",
			readFile:   readable,
			snippetLen: 10000,
			wantSub: []string{
				"(Valid slot anchors — cite only the ones you teach: [File 1#utility], [File 1#orchestrator], [File 1#helper], [File 1#leaf])",
			},
			wantNotSub:    []string{"File head", "Evidence ", "most central first"},
			wantLegacyEnd: true,
		},
		{
			name:          "读不到原文：退化为历史头部摘录",
			edges:         edges,
			snippetLen:    10000,
			wantNotSub:    []string{"File head", "Evidence "},
			wantLegacyEnd: true,
		},
		{
			name:          "未截断的整文件：保持历史形态",
			edges:         edges,
			readFile:      readable,
			wantSub:       []string{"(Valid slot anchors, most central first"},
			wantNotSub:    []string{"File head", "Evidence "},
			wantLegacyEnd: true,
		},
		{
			name:       "预算装不下第二个证据：至少输出首个",
			edges:      edges,
			readFile:   readable,
			snippetLen: 3000,
			wantSub:    []string{"Evidence 1 — [File 1#orchestrator] (L300-L330)"},
			wantNotSub: []string{"Evidence 2"},
			wantMinLen: 3000,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snippet := raw
			if tt.snippetLen > 0 {
				snippet = raw[:tt.snippetLen]
			}
			symbolsByFile := map[string][]cognitive.SymbolEntry{path: symbols}
			got := BuildFilesSummary(
				[]armor.ArmorAllocatedSnippet{{Path: path, TotalLines: 400, Snippet: snippet}},
				EvidenceOptions{
					SymbolsByFile: symbolsByFile,
					Ranks:         RankChapterSymbols(symbolsByFile, tt.edges, []string{path}),
					ReadFile:      tt.readFile,
				},
			)
			require.Contains(t, got, "[File 1] src/big.ts (400 lines)")
			for _, sub := range tt.wantSub {
				assert.Contains(t, got, sub)
			}
			for _, notSub := range tt.wantNotSub {
				assert.NotContains(t, got, notSub)
			}
			if tt.wantBefore[0] != "" {
				assert.Less(t, strings.Index(got, tt.wantBefore[0]), strings.Index(got, tt.wantBefore[1]), "证据顺序应遵循度中心性")
			}
			if tt.wantLegacyEnd {
				assert.True(t, strings.HasSuffix(got, "```\n"+snippet+"\n```"), "代码体应逐字节等于历史头部摘录")
			}
			if tt.wantMinLen > 0 {
				assert.GreaterOrEqual(t, len(got), tt.wantMinLen, "文件卡片字符数不应低于历史分配额")
			}
		})
	}
}

func TestBuildSlotMenu(t *testing.T) {
	f1 := cognitive.SymbolEntry{Name: "hydrate", Kind: "function", StartLine: 30, EndLine: 40, Exported: true}
	f2 := cognitive.SymbolEntry{Name: "flush", Kind: "function", StartLine: 50, EndLine: 52}
	ty := cognitive.SymbolEntry{Name: "State", Kind: "type", StartLine: 10, EndLine: 12}
	many := make([]cognitive.SymbolEntry, 0, 15)
	for i := 0; i < 15; i++ {
		many = append(many, cognitive.SymbolEntry{Name: fmt.Sprintf("s%d", i), Kind: "function", StartLine: i + 1, EndLine: i + 1})
	}

	tests := []struct {
		name     string
		snippets []armor.ArmorAllocatedSnippet
		symbols  map[string][]cognitive.SymbolEntry
		edges    []cognitive.CallEdge
		noRanks  bool
		want     []SlotMenuItem
	}{
		{
			name: "有排序：度中心性降序、函数 core、类型 contract、ID 跨文件连续",
			snippets: []armor.ArmorAllocatedSnippet{
				{Path: "src/a.ts", TotalLines: 100, Snippet: "x"},
				{Path: "src/b.ts#focus", TotalLines: 100, Snippet: "x"},
			},
			symbols: map[string][]cognitive.SymbolEntry{"src/a.ts": {ty, f1, f2}, "src/b.ts": {{Name: "z", Kind: "function", StartLine: 1, EndLine: 1}}},
			edges: []cognitive.CallEdge{
				{CallerFile: "src/a.ts", CallerSymbol: "x", CalleeFile: "src/a.ts", CalleeSymbol: "hydrate", Line: 1},
				{CallerFile: "src/a.ts", CallerSymbol: "hydrate", CalleeFile: "src/a.ts", CalleeSymbol: "flush", Line: 1},
			},
			want: []SlotMenuItem{
				{ID: 1, FileIndex: 1, Anchor: "hydrate", Aspect: "core", StartLine: 30, EndLine: 40},
				{ID: 2, FileIndex: 1, Anchor: "flush", Aspect: "core", StartLine: 50, EndLine: 52},
				{ID: 3, FileIndex: 1, Anchor: "State", Aspect: "contract", StartLine: 10, EndLine: 12},
				{ID: 4, FileIndex: 2, Anchor: "z", Aspect: "core", StartLine: 1, EndLine: 1},
			},
		},
		{
			name: "无调用图：按声明序回退",
			snippets: []armor.ArmorAllocatedSnippet{
				{Path: "src/a.ts", TotalLines: 100, Snippet: "x"},
			},
			symbols: map[string][]cognitive.SymbolEntry{"src/a.ts": {ty, f2, f1}},
			noRanks: true,
			want: []SlotMenuItem{
				{ID: 1, FileIndex: 1, Anchor: "State", Aspect: "contract", StartLine: 10, EndLine: 12},
				{ID: 2, FileIndex: 1, Anchor: "flush", Aspect: "core", StartLine: 50, EndLine: 52},
				{ID: 3, FileIndex: 1, Anchor: "hydrate", Aspect: "core", StartLine: 30, EndLine: 40},
			},
		},
		{
			name: "每文件锚点上限 12",
			snippets: []armor.ArmorAllocatedSnippet{
				{Path: "src/a.ts", TotalLines: 100, Snippet: "x"},
			},
			symbols: map[string][]cognitive.SymbolEntry{"src/a.ts": many},
			want: func() []SlotMenuItem {
				out := make([]SlotMenuItem, 0, slotAnchorsPerFile)
				for i := 0; i < slotAnchorsPerFile; i++ {
					out = append(out, SlotMenuItem{ID: i + 1, FileIndex: 1, Anchor: fmt.Sprintf("s%d", i), Aspect: "core", StartLine: i + 1, EndLine: i + 1})
				}
				return out
			}(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := make([]string, 0, len(tt.snippets))
			for _, s := range tt.snippets {
				files = append(files, s.Path)
			}
			opts := EvidenceOptions{SymbolsByFile: tt.symbols, Ranks: RankChapterSymbols(tt.symbols, tt.edges, files)}
			if tt.noRanks {
				opts.Ranks = nil
			}
			assert.Equal(t, tt.want, BuildSlotMenu(tt.snippets, opts))
		})
	}

	t.Run("FormatSlotMenu 文本形态", func(t *testing.T) {
		menu := []SlotMenuItem{
			{ID: 1, FileIndex: 1, Anchor: "ensureColdReadyPublisher", Aspect: "core", StartLine: 3411, EndLine: 3436},
			{ID: 2, FileIndex: 2, Anchor: "State", Aspect: "contract", StartLine: 10, EndLine: 12},
		}
		assert.Equal(t,
			"1 = [File 1#ensureColdReadyPublisher:core] (L3411-L3436)\n2 = [File 2#State:contract] (L10-L12)",
			FormatSlotMenu(menu))
		assert.Contains(t, FormatSlotMenu(nil), "no pre-validated slots")
	})

	t.Run("菜单项 JSON 形态可供网关透传", func(t *testing.T) {
		raw, err := json.Marshal([]SlotMenuItem{{ID: 1, FileIndex: 1, Anchor: "a", Aspect: "core", StartLine: 1, EndLine: 2}})
		require.NoError(t, err)
		assert.JSONEq(t, `[{"id":1,"fileIndex":1,"anchor":"a","aspect":"core","startLine":1,"endLine":2}]`, string(raw))
	})
}

func TestRankChapterSymbols_DisambiguationAndCalleeDedup(t *testing.T) {
	tests := []struct {
		name      string
		symbols   map[string][]cognitive.SymbolEntry
		edges     []cognitive.CallEdge
		files     []string
		wantOrder []string
	}{
		{
			name: "calleeSets 按 (CalleeFile, CalleeSymbol) 去重：跨文件同名被调方计 2 分",
			symbols: map[string][]cognitive.SymbolEntry{
				"caller.ts": {
					{Name: "alpha", Kind: "function", StartLine: 1, EndLine: 5},
					{Name: "multiCaller", Kind: "function", StartLine: 10, EndLine: 20},
				},
			},
			edges: []cognitive.CallEdge{
				{CallerFile: "caller.ts", CallerSymbol: "alpha", CalleeFile: "x.ts", CalleeSymbol: "run", Line: 2},
				{CallerFile: "caller.ts", CallerSymbol: "multiCaller", CalleeFile: "a.ts", CalleeSymbol: "run", Line: 12},
				{CallerFile: "caller.ts", CallerSymbol: "multiCaller", CalleeFile: "b.ts", CalleeSymbol: "run", Line: 13},
			},
			files:     []string{"caller.ts"},
			wantOrder: []string{"multiCaller", "alpha"},
		},
		{
			name: "同文件多类同名方法消歧：LayerNorm.__init__ 不劫持 GPT.__init__ 调用边",
			symbols: map[string][]cognitive.SymbolEntry{
				"model.py": {
					{Name: "LayerNorm", Kind: "type", StartLine: 18, EndLine: 27},
					{Name: "__init__", Kind: "function", StartLine: 21, EndLine: 24},
					{Name: "forward", Kind: "function", StartLine: 26, EndLine: 27},
					{Name: "Block", Kind: "type", StartLine: 94, EndLine: 106},
					{Name: "__init__", Kind: "function", StartLine: 96, EndLine: 101},
					{Name: "GPT", Kind: "type", StartLine: 118, EndLine: 330, Importers: 3},
					{Name: "__init__", Kind: "function", StartLine: 120, EndLine: 148},
					{Name: "get_num_params", Kind: "function", StartLine: 150, EndLine: 160},
					{Name: "forward", Kind: "function", StartLine: 170, EndLine: 193},
					{Name: "from_pretrained", Kind: "function", StartLine: 207, EndLine: 261},
				},
			},
			edges: []cognitive.CallEdge{
				{CallerFile: "model.py", CallerSymbol: "__init__", CalleeFile: "model.py", CalleeSymbol: "__init__", Line: 22},
				{CallerFile: "model.py", CallerSymbol: "__init__", CalleeFile: "model.py", CalleeSymbol: "__init__", Line: 97},
				{CallerFile: "model.py", CallerSymbol: "__init__", CalleeFile: "model.py", CalleeSymbol: "LayerNorm", Line: 98},
				{CallerFile: "model.py", CallerSymbol: "__init__", CalleeFile: "model.py", CalleeSymbol: "__init__", Line: 121},
				{CallerFile: "model.py", CallerSymbol: "__init__", CalleeFile: "model.py", CalleeSymbol: "Block", Line: 130},
				{CallerFile: "model.py", CallerSymbol: "__init__", CalleeFile: "model.py", CalleeSymbol: "LayerNorm", Line: 131},
				{CallerFile: "model.py", CallerSymbol: "__init__", CalleeFile: "model.py", CalleeSymbol: "get_num_params", Line: 148},
				{CallerFile: "model.py", CallerSymbol: "from_pretrained", CalleeFile: "model.py", CalleeSymbol: "GPT", Line: 232},
				{CallerFile: "model.py", CallerSymbol: "from_pretrained", CalleeFile: "model.py", CalleeSymbol: "Block", Line: 233},
				{CallerFile: "model.py", CallerSymbol: "from_pretrained", CalleeFile: "model.py", CalleeSymbol: "LayerNorm", Line: 234},
			},
			files:     []string{"model.py"},
			wantOrder: []string{"GPT", "LayerNorm", "from_pretrained", "__init__", "Block", "get_num_params", "forward"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ranks := RankChapterSymbols(tt.symbols, tt.edges, tt.files)
			got := ranks[tt.files[0]]
			assert.True(t, got.HasSignal)
			var names []string
			for _, s := range got.Symbols {
				names = append(names, s.Name)
			}
			assert.Equal(t, tt.wantOrder, names)
		})
	}

	t.Run("RankedFileSymbols 过滤非法行号并优先消费排序结果", func(t *testing.T) {
		syms := map[string][]cognitive.SymbolEntry{
			"a.go": {
				{Name: "BadLine", Kind: "function", StartLine: 0, EndLine: 0},
				{Name: "First", Kind: "function", StartLine: 10, EndLine: 20},
				{Name: "Second", Kind: "function", StartLine: 30, EndLine: 40},
			},
		}
		edges := []cognitive.CallEdge{
			{CallerFile: "b.go", CallerSymbol: "main", CalleeFile: "a.go", CalleeSymbol: "Second", Line: 5},
		}
		ranks := RankChapterSymbols(syms, edges, []string{"a.go"})
		ranked := RankedFileSymbols(syms, ranks, "a.go", 10)
		require.Len(t, ranked, 2)
		assert.Equal(t, "Second", ranked[0].Name)
		assert.Equal(t, "First", ranked[1].Name)
	})
}

func TestEvidence_CachedNanogptModel(t *testing.T) {
	storageDir := os.Getenv("OPENGITS_STORAGE_DIR")
	if storageDir == "" {
		t.Skip("OPENGITS_STORAGE_DIR not set; skipping cached karpathy/nanogpt verification")
	}
	repoDir := filepath.Join(storageDir, "repos", "karpathy", "nanogpt")
	entries, err := os.ReadDir(repoDir)
	if err != nil || len(entries) == 0 {
		t.Skip("cached karpathy/nanogpt archive not available")
	}
	sha := entries[0].Name()
	modelBytes, err := os.ReadFile(filepath.Join(repoDir, sha, "model.py"))
	if err != nil {
		t.Skip("model.py not found in cached archive")
	}
	artifact, err := cognitive.LoadSemanticGraphArtifact(filepath.Join(storageDir, "graphs"), "karpathy", "nanogpt", sha)
	if err != nil {
		t.Skip("cached nanogpt graph artifact not available")
	}

	raw := string(modelBytes)
	ranks := RankChapterSymbols(artifact.SymbolsByFile, artifact.CallEdges, []string{"model.py"})
	gotRank := ranks["model.py"]
	require.True(t, gotRank.HasSignal)
	require.NotEmpty(t, gotRank.Symbols)
	assert.NotEqual(t, "__init__", gotRank.Symbols[0].Name, "LayerNorm.__init__ must not hijack top rank")

	summary := BuildFilesSummary(
		[]armor.ArmorAllocatedSnippet{{Path: "model.py", TotalLines: strings.Count(raw, "\n") + 1, Snippet: raw[:8000]}},
		EvidenceOptions{
			SymbolsByFile: artifact.SymbolsByFile,
			Ranks:         ranks,
			ReadFile:      func(string) (string, bool) { return raw, true },
		},
	)
	assert.Contains(t, summary, "[File 1#GPT]")
	assert.Contains(t, summary, "class GPT(nn.Module): ...")
	assert.Contains(t, summary, "[File 1#from_pretrained]")
	assert.Contains(t, summary, "[File 1#estimate_mfu]")
}

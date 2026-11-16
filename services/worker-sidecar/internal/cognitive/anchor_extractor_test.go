package cognitive

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAnchorExtractor_TableDriven(t *testing.T) {
	fakeFileReader := func(path string) ([]byte, error) {
		switch path {
		case "src/math.ts":
			return []byte("export function add(a: number, b: number): number { return a + b; }\nexport type Num = number;"), nil
		case "docs/intro.md":
			return []byte("## Quick Start\nHere is how to use the app.\n### Configuration Details\nConfig info here."), nil
		case "src/math_test.go":
			return []byte("package math\nimport \"testing\"\nfunc TestAdd(t *testing.T) {}\nfunc TestSubtract(t *testing.T) {}"), nil
		default:
			return nil, nil
		}
	}

	// BUG-65 关闭后正则符号兜底已退役:测试注入桩 extractor 模拟 AST 产出
	// (生产路径由 rsg LanguageDefinitions 实现同一接口)。
	stubExtractor := SymbolExtractorFunc(func(content, path string) []SymbolEntry {
		if path != "src/math.ts" {
			return nil
		}
		return []SymbolEntry{
			{Name: "add", Kind: "function", StartLine: 1, EndLine: 1, Exported: true},
			{Name: "Num", Kind: "type", StartLine: 2, EndLine: 2, Exported: true},
		}
	})

	tests := []struct {
		name         string
		strategy     SubFileAnchorExtractor
		ctx          *AnchorExtractContext
		wantMinCount int
		checkFirst   func(t *testing.T, anchors []CandidateOutlineFile)
	}{
		{
			name:     "code_symbol_strategy_extracts_exported_functions",
			strategy: &CodeSymbolAnchorStrategy{},
			ctx: &AnchorExtractContext{
				CodeCandidates: []CandidateOutlineFile{
					{Path: "src/math.ts", IsDoc: false},
				},
				FileReader:    fakeFileReader,
				Extractor:     stubExtractor,
				SeenAnchorKey: make(map[string]bool),
			},
			wantMinCount: 1,
			checkFirst: func(t *testing.T, anchors []CandidateOutlineFile) {
				t.Helper()
				assert.Equal(t, "src/math.ts", anchors[0].Path)
				assert.Equal(t, "add", anchors[0].Anchor)
				assert.Equal(t, "function", anchors[0].Kind)
			},
		},
		{
			name:     "doc_heading_strategy_extracts_markdown_headings",
			strategy: &DocHeadingAnchorStrategy{},
			ctx: &AnchorExtractContext{
				DocCandidates: []CandidateOutlineFile{
					{Path: "docs/intro.md", IsDoc: true},
				},
				FileReader:    fakeFileReader,
				SeenAnchorKey: make(map[string]bool),
			},
			wantMinCount: 2,
			checkFirst: func(t *testing.T, anchors []CandidateOutlineFile) {
				t.Helper()
				assert.Equal(t, "docs/intro.md", anchors[0].Path)
				assert.Equal(t, "Quick Start", anchors[0].Anchor)
				assert.Equal(t, "heading", anchors[0].Kind)
				assert.True(t, anchors[0].IsDoc)
			},
		},
		{
			name:     "test_spec_strategy_extracts_go_tests",
			strategy: &TestSpecAnchorStrategy{},
			ctx: func() *AnchorExtractContext {
				p, _ := LoadIngestPatterns("")
				return &AnchorExtractContext{
					AllNodes: []GitNode{
						{Path: "src/math_test.go", Type: "blob"},
					},
					FileReader:    fakeFileReader,
					Patterns:      p,
					SeenAnchorKey: make(map[string]bool),
				}
			}(),
			wantMinCount: 2,
			checkFirst: func(t *testing.T, anchors []CandidateOutlineFile) {
				t.Helper()
				assert.Equal(t, "src/math_test.go", anchors[0].Path)
				assert.Equal(t, "TestAdd", anchors[0].Anchor)
				assert.Equal(t, "spec", anchors[0].Kind)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			anchors := tt.strategy.Extract(tt.ctx)
			require.GreaterOrEqual(t, len(anchors), tt.wantMinCount)
			if tt.checkFirst != nil {
				tt.checkFirst(t, anchors)
			}
		})
	}
}

func TestCompositeAnchorExtractor_Integration(t *testing.T) {
	fakeFileReader := func(path string) ([]byte, error) {
		switch path {
		case "src/math.ts":
			return []byte("export function add() {}"), nil
		case "docs/intro.md":
			return []byte("## Usage\nRun the tool."), nil
		default:
			return nil, nil
		}
	}

	composite := NewCompositeAnchorExtractor(
		&CodeSymbolAnchorStrategy{},
		&DocHeadingAnchorStrategy{},
	)

	ctx := &AnchorExtractContext{
		CodeCandidates: []CandidateOutlineFile{{Path: "src/math.ts"}},
		DocCandidates:  []CandidateOutlineFile{{Path: "docs/intro.md", IsDoc: true}},
		FileReader:     fakeFileReader,
		Extractor: SymbolExtractorFunc(func(content, path string) []SymbolEntry {
			if path == "src/math.ts" {
				return []SymbolEntry{{Name: "add", Kind: "function", StartLine: 1, EndLine: 1, Exported: true}}
			}
			return nil
		}),
		SeenAnchorKey: make(map[string]bool),
	}

	anchors := composite.Extract(ctx)
	require.Len(t, anchors, 2)
	assert.Equal(t, "add", anchors[0].Anchor)
	assert.Equal(t, "Usage", anchors[1].Anchor)
}

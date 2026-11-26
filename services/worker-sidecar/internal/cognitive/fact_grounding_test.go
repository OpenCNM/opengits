package cognitive

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVerifyFileGrounding_PathAnchors(t *testing.T) {
	index := GroundingIndex{
		Paths: []string{
			"src/index.ts",
			"src/utils/emitter.ts",
			"README.md",
			"test/emitter.test.ts",
		},
		SymbolsByFile: map[string][]SymbolEntry{
			"src/index.ts": {
				{Name: "mitt", Kind: "function", StartLine: 10, EndLine: 35, Exported: true},
				{Name: "Emitter", Kind: "type", StartLine: 2, EndLine: 8, Exported: true},
			},
		},
	}

	tests := []struct {
		name                 string
		claimedFiles         []string
		expectedValid        bool
		expectedGrounded     []string
		expectedHallucinated []string
		expectedWarningSub   []string
	}{
		{
			name: "exact match with anchor preserves path anchor",
			claimedFiles: []string{
				"src/index.ts#mitt",
				"README.md#Usage",
			},
			expectedValid: true,
			expectedGrounded: []string{
				"src/index.ts#mitt",
				"README.md#Usage",
			},
			expectedHallucinated: []string{},
		},
		{
			name: "suffix fuzzy alignment with anchor",
			claimedFiles: []string{
				"emitter.ts#on",
			},
			expectedValid: true,
			expectedGrounded: []string{
				"src/utils/emitter.ts#on",
			},
			expectedHallucinated: []string{},
			expectedWarningSub: []string{
				"Fuzzy-aligned 'emitter.ts#on' to grounded path 'src/utils/emitter.ts#on'",
			},
		},
		{
			name: "hallucinated file with anchor is rejected",
			claimedFiles: []string{
				"nonexistent.ts#foo",
			},
			expectedValid:        false,
			expectedGrounded:     []string{},
			expectedHallucinated: []string{"nonexistent.ts#foo"},
			expectedWarningSub: []string{
				"Hallucinated path 'nonexistent.ts#foo' rejected",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			verdict := VerifyFileGrounding(tt.claimedFiles, index)
			assert.Equal(t, tt.expectedValid, verdict.Valid)
			assert.Equal(t, tt.expectedGrounded, verdict.GroundedFiles)
			assert.Equal(t, tt.expectedHallucinated, verdict.HallucinatedFiles)
			for _, w := range tt.expectedWarningSub {
				found := false
				for _, actualW := range verdict.Warnings {
					if assert.Contains(t, actualW, w) {
						found = true
						break
					}
				}
				require.True(t, found, "warning substring not found: %s", w)
			}
		})
	}
}

func TestVerifySymbolGrounding_PathAnchors(t *testing.T) {
	index := GroundingIndex{
		Paths: []string{
			"src/index.ts",
			"README.md",
		},
		SymbolsByFile: map[string][]SymbolEntry{
			"src/index.ts": {
				{Name: "mitt", Kind: "function", StartLine: 10, EndLine: 35, Exported: true},
				{Name: "Emitter", Kind: "type", StartLine: 2, EndLine: 8, Exported: true},
			},
		},
	}

	line15 := 15
	tests := []struct {
		name                 string
		claims               []SymbolClaim
		expectedGroundedName []string
		expectedHalluName    []string
	}{
		{
			name: "symbol claim referencing file with anchor resolves correctly",
			claims: []SymbolClaim{
				{File: "src/index.ts#mitt", Symbol: "mitt", Line: &line15},
			},
			expectedGroundedName: []string{"mitt"},
			expectedHalluName:    []string{},
		},
		{
			name: "missing symbol in grounded file with anchor is hallucinated",
			claims: []SymbolClaim{
				{File: "src/index.ts#mitt", Symbol: "unknownFunc"},
			},
			expectedGroundedName: []string{},
			expectedHalluName:    []string{"unknownFunc"},
		},
		{
			name: "symbol claim referencing doc file (README.md) is grounded without AST symbol table",
			claims: []SymbolClaim{
				{File: "README.md#get_current_time", Symbol: "get_current_time"},
			},
			expectedGroundedName: []string{"get_current_time"},
			expectedHalluName:    []string{},
		},
		{
			name: "symbol claim referencing non-existent doc file is hallucinated",
			claims: []SymbolClaim{
				{File: "nonexistent.md#some_func", Symbol: "some_func"},
			},
			expectedGroundedName: []string{},
			expectedHalluName:    []string{"some_func"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			grounded, hallucinated, _ := VerifySymbolGrounding(tt.claims, index)
			groundedNames := make([]string, 0)
			for _, g := range grounded {
				groundedNames = append(groundedNames, g.Symbol)
			}
			halluNames := make([]string, 0)
			for _, h := range hallucinated {
				halluNames = append(halluNames, h.Symbol)
			}
			assert.Equal(t, tt.expectedGroundedName, groundedNames)
			assert.Equal(t, tt.expectedHalluName, halluNames)
		})
	}
}

func TestIsDocFile(t *testing.T) {
	assert.True(t, IsDocFile("README.md"))
	assert.True(t, IsDocFile("README"))
	assert.True(t, IsDocFile("docs/guide.markdown"))
	assert.True(t, IsDocFile("notes.txt"))
	assert.True(t, IsDocFile("docs/spec.rst"))
	assert.True(t, IsDocFile("doc.adoc"))
	assert.True(t, IsDocFile("paper.tex"))
	assert.True(t, IsDocFile("CHAPTER.mdx"))

	assert.False(t, IsDocFile("src/main.ts"))
	assert.False(t, IsDocFile("app.py"))
	assert.False(t, IsDocFile("main.go"))
	assert.False(t, IsDocFile("Cargo.toml"))
	assert.False(t, IsDocFile(""))
}

func TestExtractClaimedPathsFromMdx_FilterResidualHandles(t *testing.T) {
	mdx := `# Title
<!-- path: src/core/engine.ts -->
<!-- path: [1#create_tasks_prompt:core] -->

` + "```python // [1#create_tasks_prompt:core]" + `
pass
` + "```" + `

` + "```ts // [File 2#InitScheduler]" + `
pass
` + "```" + `

` + "```tsx // app/[id]/page.tsx" + `
export default function Page() {}
` + "```" + `

` + "```go // src/server.go#Start" + `
func Start() {}
` + "```" + `
`
	paths := ExtractClaimedPathsFromMdx(mdx)
	assert.Contains(t, paths, "src/core/engine.ts")
	assert.Contains(t, paths, "app/[id]/page.tsx")
	assert.Contains(t, paths, "src/server.go#Start")
	assert.NotContains(t, paths, "[1#create_tasks_prompt:core]")
	assert.NotContains(t, paths, "[File 2#InitScheduler]")
}

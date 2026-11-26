package pipeline

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/armor"
)

type mockConvergenceLlm struct {
	calls []string
	vars  []map[string]any
	fn    func(purpose string, vars map[string]any) (LlmTextResult, error)
}

func (m *mockConvergenceLlm) Complete(_ context.Context, purpose string, vars map[string]any, _ *string) (LlmTextResult, error) {
	m.calls = append(m.calls, purpose)
	m.vars = append(m.vars, vars)
	if m.fn != nil {
		return m.fn(purpose, vars)
	}
	return LlmTextResult{Text: "default text", FinishReason: "stop"}, nil
}

func TestMdxConvergencePipeline_HappyPath(t *testing.T) {
	tests := []struct {
		name          string
		rawDraft      string
		refs          []armor.ArmorFileRef
		docPath       string
		wantSubstrs   []string
		wantExcludes  []string
		checkManifest func(t *testing.T, m *ConceptManifest)
	}{
		{
			name: "plain valid mdx with sentinel and file handle",
			rawDraft: "===CONTENT_BEGIN===\n" +
				"# Introduction\n\n" +
				"Here is a code snippet:\n\n" +
				"```typescript [File 1]\n" +
				"export const meaning = 42;\n" +
				"```\n" +
				"===CONTENT_END===",
			refs:         []armor.ArmorFileRef{{Path: "src/meaning.ts"}},
			docPath:      "docs/intro.mdx",
			wantSubstrs:  []string{"# Introduction", "src/meaning.ts", "export const meaning = 42;"},
			wantExcludes: []string{"[File 1]", "===CONTENT_BEGIN===", "===CONTENT_END==="},
			checkManifest: func(t *testing.T, m *ConceptManifest) {
				t.Helper()
				require.NotNil(t, m)
				assert.False(t, m.HasFrontmatter)
			},
		},
		{
			name: "mdx with frontmatter preserved in FinalContent but stripped in CleanMdx",
			rawDraft: "---\n" +
				"summary: Lesson summary\n" +
				"concepts:\n" +
				"  - name: Core Architecture\n" +
				"    category: architecture\n" +
				"---\n" +
				"# Lesson Title\n\n" +
				"Explanatory text with `inline code`.\n",
			refs:        nil,
			docPath:     "chapters/01.mdx",
			wantSubstrs: []string{"---", "summary: Lesson summary", "# Lesson Title"},
			checkManifest: func(t *testing.T, m *ConceptManifest) {
				t.Helper()
				require.NotNil(t, m)
				assert.True(t, m.HasFrontmatter)
				assert.Equal(t, "Lesson summary", m.Summary)
				require.Len(t, m.Concepts, 1)
				assert.Equal(t, "Core Architecture", m.Concepts[0].ConceptName)
			},
		},
		{
			name: "mdx with XML concept manifest stripped from final content",
			rawDraft: "# Transcribed Content\n\n" +
				"Core explanations.\n\n" +
				"<concept_manifest>\n" +
				"```json\n" +
				"{\"concepts\": [{\"name\": \"Buffer Protocol\", \"category\": \"runtime\"}]}\n" +
				"```\n" +
				"</concept_manifest>",
			refs:         nil,
			docPath:      "docs/buffer.mdx",
			wantSubstrs:  []string{"# Transcribed Content", "Core explanations."},
			wantExcludes: []string{"<concept_manifest>", "</concept_manifest>", "Buffer Protocol"},
			checkManifest: func(t *testing.T, m *ConceptManifest) {
				t.Helper()
				require.NotNil(t, m)
				assert.False(t, m.HasFrontmatter)
				require.Len(t, m.Concepts, 1)
				assert.Equal(t, "Buffer Protocol", m.Concepts[0].ConceptName)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pipeline := MdxConvergencePipeline{
				DocPath: tt.docPath,
				Refs:    tt.refs,
				FallbackBuilder: func() string {
					return "# Fallback"
				},
			}

			res := pipeline.Execute(context.Background(), tt.rawDraft, nil)

			assert.False(t, res.WasRepaired, "happy path should not trigger repair")
			assert.False(t, res.WasFallbackUsed, "happy path should not use fallback")
			assert.Empty(t, res.ValidationError, "happy path should have no validation error")
			assert.Equal(t, len(tt.rawDraft), res.OriginalLength)
			assert.Equal(t, len(res.FinalContent), res.FinalLength)

			for _, sub := range tt.wantSubstrs {
				assert.Contains(t, res.FinalContent, sub)
			}
			for _, excl := range tt.wantExcludes {
				assert.NotContains(t, res.FinalContent, excl)
			}
			if tt.checkManifest != nil {
				tt.checkManifest(t, res.Manifest)
			}
		})
	}
}

func TestMdxConvergencePipeline_RepairSuccess(t *testing.T) {
	tests := []struct {
		name         string
		rawDraft     string
		repairOutput string
		refs         []armor.ArmorFileRef
		wantSubstrs  []string
		wantExcludes []string
	}{
		{
			name:     "unclosed tag triggers repair with handle resolved",
			rawDraft: "# Invalid MDX\n\n<UnclosedTag>\nSome code: [File 1]",
			repairOutput: "===CONTENT_BEGIN===\n" +
				"# Repaired MDX\n\n" +
				"<ClosedTag />\n" +
				"Resolved path: [File 1]\n" +
				"===CONTENT_END===",
			refs: []armor.ArmorFileRef{{Path: "packages/core/index.ts"}},
			wantSubstrs: []string{
				"# Repaired MDX",
				"<ClosedTag />",
				"packages/core/index.ts",
			},
			wantExcludes: []string{
				"<UnclosedTag>",
				"[File 1]",
				"===CONTENT_BEGIN===",
			},
		},
		{
			name:     "mismatched tag triggers repair and compiles clean",
			rawDraft: "# Invalid\n\n<SectionHeader title=\"Overview\">\nContent without closing tag",
			repairOutput: "# Repaired\n\n" +
				"<SectionHeader title=\"Overview\">\nContent with closing tag\n</SectionHeader>",
			refs: nil,
			wantSubstrs: []string{
				"# Repaired",
				"</SectionHeader>",
			},
			wantExcludes: []string{
				"# Invalid",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockLlm := &mockConvergenceLlm{
				fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
					assert.Equal(t, "mdx_repair", purpose)
					assert.NotEmpty(t, vars["compileError"])
					assert.NotEmpty(t, vars["mdxSource"])
					return LlmTextResult{
						Text:         tt.repairOutput,
						FinishReason: "stop",
					}, nil
				},
			}

			pipeline := MdxConvergencePipeline{
				LlmClient:     mockLlm,
				RepairPurpose: "mdx_repair",
				DocPath:       "docs/guide.mdx",
				Refs:          tt.refs,
				FallbackBuilder: func() string {
					return "# Fallback Template"
				},
			}

			res := pipeline.Execute(context.Background(), tt.rawDraft, nil)

			assert.True(t, res.WasRepaired, "repair should be marked as used")
			assert.False(t, res.WasFallbackUsed, "fallback should not be used on repair success")
			assert.Empty(t, res.ValidationError)
			require.Len(t, mockLlm.calls, 1)

			for _, sub := range tt.wantSubstrs {
				assert.Contains(t, res.FinalContent, sub)
			}
			for _, excl := range tt.wantExcludes {
				assert.NotContains(t, res.FinalContent, excl)
			}
		})
	}
}

func TestMdxConvergencePipeline_RepairFailedFallback(t *testing.T) {
	tests := []struct {
		name       string
		llmSetup   func() *mockConvergenceLlm
		rawDraft   string
		wantCaller int
	}{
		{
			name: "repair output still contains invalid syntax",
			llmSetup: func() *mockConvergenceLlm {
				return &mockConvergenceLlm{
					fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
						return LlmTextResult{
							Text:         "# Still Broken\n\n<StillUnclosed>",
							FinishReason: "stop",
						}, nil
					},
				}
			},
			rawDraft:   "# Broken Initially\n\n<UnclosedComponent>",
			wantCaller: 1,
		},
		{
			name: "repair output returns empty string",
			llmSetup: func() *mockConvergenceLlm {
				return &mockConvergenceLlm{
					fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
						return LlmTextResult{
							Text:         "   \n\n  ",
							FinishReason: "stop",
						}, nil
					},
				}
			},
			rawDraft:   "# Broken Initially\n\n<UnclosedComponent>",
			wantCaller: 1,
		},
		{
			name: "repair call returns network error",
			llmSetup: func() *mockConvergenceLlm {
				return &mockConvergenceLlm{
					fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
						return LlmTextResult{}, errors.New("gateway connection timeout")
					},
				}
			},
			rawDraft:   "# Broken Initially\n\n<UnclosedComponent>",
			wantCaller: 1,
		},
		{
			name: "repair output truncated by length finishReason",
			llmSetup: func() *mockConvergenceLlm {
				return &mockConvergenceLlm{
					fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
						return LlmTextResult{
							Text:         "# Truncated repair text...",
							FinishReason: "length",
						}, nil
					},
				}
			},
			rawDraft:   "# Broken Initially\n\n<UnclosedComponent>",
			wantCaller: 1,
		},
		{
			name:       "nil llm client directly falls back",
			llmSetup:   func() *mockConvergenceLlm { return nil },
			rawDraft:   "# Broken Initially\n\n<UnclosedComponent>",
			wantCaller: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var llmClient LlmCompleter
			var mockLlm *mockConvergenceLlm
			if tt.llmSetup != nil {
				mockLlm = tt.llmSetup()
				if mockLlm != nil {
					llmClient = mockLlm
				}
			}

			fallbackContent := "# Deterministic Fallback Template\n\nSafe content guaranteed."
			pipeline := MdxConvergencePipeline{
				LlmClient:     llmClient,
				RepairPurpose: "mdx_repair",
				DocPath:       "docs/failed.mdx",
				FallbackBuilder: func() string {
					return fallbackContent
				},
			}

			res := pipeline.Execute(context.Background(), tt.rawDraft, nil)

			assert.False(t, res.WasRepaired, "repair should be considered failed")
			assert.True(t, res.WasFallbackUsed, "fallback should be marked as used")
			assert.Equal(t, fallbackContent, res.FinalContent)
			assert.NotEmpty(t, res.ValidationError, "original error must be preserved in result")

			if mockLlm != nil {
				assert.Len(t, mockLlm.calls, tt.wantCaller)
			}
		})
	}
}

func TestMdxConvergencePipeline_UnpeeledJSONFailsClosed(t *testing.T) {
	unpeeledMalformedJSON := `{"lessonMarkdown": {"invalid": "object payload instead of string"}}`
	fallbackContent := "# Deterministic Fallback Template\n\nSafe content guaranteed."

	p := MdxConvergencePipeline{
		DocPath: "chapters/01.mdx",
		FallbackBuilder: func() string {
			return fallbackContent
		},
	}

	res := p.Execute(context.Background(), unpeeledMalformedJSON, nil)

	assert.True(t, res.WasFallbackUsed, "unpeeled JSON shell must trigger fallback rather than silently passing")
	assert.Equal(t, fallbackContent, res.FinalContent)
	assert.Contains(t, res.ValidationError, "unpeeled JSON payload shell detected")
}

func TestMdxConvergencePipeline_TokenTruncatedDirectRepair(t *testing.T) {
	tests := []struct {
		name            string
		repairOk        bool
		wantRepaired    bool
		wantFallback    bool
		wantFinalSubstr string
	}{
		{
			name:            "token truncated with successful repair re-running armor",
			repairOk:        true,
			wantRepaired:    true,
			wantFallback:    false,
			wantFinalSubstr: "# Repaired After Truncation",
		},
		{
			name:            "token truncated with repair also failing triggers deterministic fallback",
			repairOk:        false,
			wantRepaired:    false,
			wantFallback:    true,
			wantFinalSubstr: "# Fallback Safe Content",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockLlm := &mockConvergenceLlm{
				fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
					if tt.repairOk {
						return LlmTextResult{
							Text:         "# Repaired After Truncation\n\nFull lesson body.",
							FinishReason: "stop",
						}, nil
					}
					return LlmTextResult{
						Text:         "# Truncated again\n<UnclosedFailure>",
						FinishReason: "stop",
					}, nil
				},
			}

			fallbackContent := "# Fallback Safe Content\n\n100% deterministic."
			pipeline := MdxConvergencePipeline{
				LlmClient: mockLlm,
				DocPath:   "chapters/02.mdx",
				FallbackBuilder: func() string {
					return fallbackContent
				},
			}

			validSyntaxDraft := "# Lesson Title\n\nBody cut off"
			res := pipeline.Execute(context.Background(), validSyntaxDraft, nil, true)

			assert.Equal(t, tt.wantRepaired, res.WasRepaired)
			assert.Equal(t, tt.wantFallback, res.WasFallbackUsed)
			assert.Contains(t, res.FinalContent, tt.wantFinalSubstr)
			assert.NotEmpty(t, mockLlm.calls)
		})
	}
}

func TestFactGroundingFunnel_KeyDataStructures(t *testing.T) {
	realTree := map[string]bool{
		"packages/core/src/index.ts": true,
		"src/router.go":              true,
		"internal/db/schema.prisma":  true,
	}
	inTree := func(p string) bool {
		return realTree[p]
	}

	deterministicFallback := func() []KeyDataStructure {
		return []KeyDataStructure{
			{Name: "FallbackConfig", Subsystem: "core", FilePath: "packages/core/src/index.ts"},
		}
	}

	tests := []struct {
		name              string
		input             []KeyDataStructure
		inTreeFn          func(string) bool
		wantNames         []string
		wantTotal         int
		wantKept          int
		wantDiscarded     int
		wantFallback      bool
		wantDeterministic bool
	}{
		{
			name: "all proposed exist in tree",
			input: []KeyDataStructure{
				{Name: "Router", Subsystem: "api", FilePath: "src/router.go"},
				{Name: "Schema", Subsystem: "db", FilePath: "internal/db/schema.prisma"},
			},
			inTreeFn:      inTree,
			wantNames:     []string{"Router", "Schema"},
			wantTotal:     2,
			wantKept:      2,
			wantDiscarded: 0,
			wantFallback:  false,
		},
		{
			name: "partial hallucinated paths discarded and empty paths kept",
			input: []KeyDataStructure{
				{Name: "Router", Subsystem: "api", FilePath: "src/router.go"},
				{Name: "GhostType", Subsystem: "ghost", FilePath: "src/fake/ghost.ts"},
				{Name: "NormalizedPath", Subsystem: "core", FilePath: ".\\packages\\core\\src\\index.ts"},
				{Name: "EmptyPath", Subsystem: "generic", FilePath: ""},
				{Name: "WhitespacePath", Subsystem: "generic", FilePath: "   "},
			},
			inTreeFn:      inTree,
			wantNames:     []string{"Router", "NormalizedPath", "EmptyPath", "WhitespacePath"},
			wantTotal:     5,
			wantKept:      4,
			wantDiscarded: 1,
			wantFallback:  false,
		},
		{
			name: "all hallucinated paths trigger deterministic fallback",
			input: []KeyDataStructure{
				{Name: "Ghost1", Subsystem: "phantom", FilePath: "missing/file1.ts"},
				{Name: "Ghost2", Subsystem: "phantom", FilePath: "missing/file2.ts"},
			},
			inTreeFn:          inTree,
			wantNames:         []string{"FallbackConfig"},
			wantTotal:         2,
			wantKept:          0,
			wantDiscarded:     2,
			wantFallback:      true,
			wantDeterministic: true,
		},
		{
			name: "nil tree verifier passes through all",
			input: []KeyDataStructure{
				{Name: "Unchecked1", Subsystem: "any", FilePath: "any/path1.ts"},
				{Name: "Unchecked2", Subsystem: "any", FilePath: "any/path2.ts"},
			},
			inTreeFn:      nil,
			wantNames:     []string{"Unchecked1", "Unchecked2"},
			wantTotal:     2,
			wantKept:      2,
			wantDiscarded: 0,
			wantFallback:  false,
		},
		{
			name:              "empty input returns empty and no fallback",
			input:             []KeyDataStructure{},
			inTreeFn:          inTree,
			wantNames:         []string{},
			wantTotal:         0,
			wantKept:          0,
			wantDiscarded:     0,
			wantFallback:      false,
			wantDeterministic: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, audit := GroundKeyDataStructures(tt.input, tt.inTreeFn, deterministicFallback)

			assert.Equal(t, tt.wantTotal, audit.TotalProposed)
			assert.Equal(t, tt.wantKept, audit.KeptCount)
			assert.Equal(t, tt.wantDiscarded, audit.DiscardedCount)
			assert.Equal(t, tt.wantFallback, audit.FallbackTriggered)

			gotNames := make([]string, 0, len(got))
			for _, item := range got {
				gotNames = append(gotNames, item.Name)
			}
			assert.Equal(t, tt.wantNames, gotNames)

			if tt.wantDeterministic {
				require.NotEmpty(t, got)
				assert.Equal(t, "packages/core/src/index.ts", got[0].FilePath)
			}
		})
	}
}

func TestMdxConvergencePipeline_EmptyDraftFallback(t *testing.T) {
	tests := []struct {
		name     string
		rawDraft string
	}{
		{
			name:     "completely empty draft",
			rawDraft: "",
		},
		{
			name:     "whitespace only draft",
			rawDraft: "   \n\t  \r\n  ",
		},
		{
			name:     "sentinel wrapping whitespace only",
			rawDraft: "===CONTENT_BEGIN===\n   \n===CONTENT_END===",
		},
		{
			name:     "manifest only draft without body content",
			rawDraft: "<concept_manifest>\n```json\n{\"concepts\": [{\"name\": \"Solo\"}]}\n```\n</concept_manifest>",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fallbackTemplate := "# Deterministic Lesson\n\nGenerated safely without hallucination."
			pipeline := MdxConvergencePipeline{
				DocPath: "docs/empty.mdx",
				FallbackBuilder: func() string {
					return fallbackTemplate
				},
			}

			res := pipeline.Execute(context.Background(), tt.rawDraft, nil)

			assert.False(t, res.WasRepaired)
			assert.True(t, res.WasFallbackUsed)
			assert.Equal(t, fallbackTemplate, res.FinalContent)
			assert.Equal(t, "empty mdx content", res.ValidationError)
		})
	}
}

func TestMdxConvergencePipeline_SummaryOnlyManifest(t *testing.T) {
	rawDraft := "# Architecture Overview\n\n" +
		"Explaining the system design.\n\n" +
		"<concept_manifest>\n" +
		"```json\n" +
		"{\"summary\": \"System architecture explanation from XML manifest\"}\n" +
		"```\n" +
		"</concept_manifest>"

	pipeline := MdxConvergencePipeline{
		DocPath: "docs/arch.mdx",
		FallbackBuilder: func() string {
			return "# Fallback"
		},
	}

	res := pipeline.Execute(context.Background(), rawDraft, nil)

	assert.False(t, res.WasRepaired)
	assert.False(t, res.WasFallbackUsed)
	assert.Empty(t, res.ValidationError)
	require.NotNil(t, res.Manifest)
	assert.Equal(t, "System architecture explanation from XML manifest", res.Manifest.Summary)
	assert.NotContains(t, res.FinalContent, "<concept_manifest>")
	assert.Contains(t, res.FinalContent, "# Architecture Overview")
}

func TestMdxConvergencePipeline_MalformedJsxAttribute(t *testing.T) {
	rawDraft := "# Broken Component\n\n<CustomBadge title={invalid syntax + ? : 123} />"
	repairOutput := "# Repaired Component\n\n<CustomBadge title=\"Valid Title\" />"

	mockLlm := &mockConvergenceLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			assert.Equal(t, "mdx_repair", purpose)
			assert.Contains(t, vars["compileError"], "JSX attribute expression")
			return LlmTextResult{Text: repairOutput, FinishReason: "stop"}, nil
		},
	}

	pipeline := MdxConvergencePipeline{
		LlmClient:     mockLlm,
		RepairPurpose: "mdx_repair",
		DocPath:       "components/badge.mdx",
		FallbackBuilder: func() string {
			return "# Fallback"
		},
	}

	res := pipeline.Execute(context.Background(), rawDraft, nil)

	assert.True(t, res.WasRepaired)
	assert.False(t, res.WasFallbackUsed)
	assert.Empty(t, res.ValidationError)
	assert.Contains(t, res.FinalContent, "title=\"Valid Title\"")
}

func TestEnsureMermaidArchitecture(t *testing.T) {
	skeleton := "```mermaid\nflowchart TD\n  fn1[\"Engine()\"] --> fn2[\"Run()\"]\n```"

	t.Run("有效图表原样保留不被覆盖", func(t *testing.T) {
		content := "# Chapter 1\n\n## 1. 架构总览\n\n```mermaid\nflowchart TD\n  A[\"Caller\"] -->|calls| B[\"Callee\"]\n```\n\n## 2. 细节"
		got := EnsureMermaidArchitecture(content, skeleton)
		assert.Equal(t, content, got)
		assert.Contains(t, got, "Caller")
		assert.NotContains(t, got, "fn1")
	})

	t.Run("缺少 Mermaid 图表时自动注入到首个 H2 导言之后", func(t *testing.T) {
		content := "# Chapter 1\n\n## 1. 架构总览\n\n这是本章的架构导言段落。\n\n## 2. 详细实现\n\n代码如下："
		got := EnsureMermaidArchitecture(content, skeleton)
		assert.Contains(t, got, skeleton)
		expected := "# Chapter 1\n\n## 1. 架构总览\n\n这是本章的架构导言段落。\n\n" + skeleton + "\n\n## 2. 详细实现\n\n代码如下："
		assert.Equal(t, expected, got)
	})

	t.Run("破损/空的 Mermaid 块自动替换为确定性骨架", func(t *testing.T) {
		content := "# Chapter 1\n\n## 1. 架构总览\n\n```mermaid\n```\n\n## 2. 详细实现"
		got := EnsureMermaidArchitecture(content, skeleton)
		assert.Contains(t, got, skeleton)
		assert.NotContains(t, got, "```mermaid\n```")
	})

	t.Run("文末截断未闭合但语法完备的 Mermaid 围栏经 Layer 1 内存自愈配平闭合并保留原图", func(t *testing.T) {
		content := "# Chapter 1\n\n## 1. 架构总览\n\n```mermaid\nflowchart TD\n  A --> B"
		got := EnsureMermaidArchitecture(content, skeleton)
		assert.Contains(t, got, "A --> B")
		assert.Equal(t, 1, strings.Count(got, "```mermaid"))
		assert.True(t, strings.HasSuffix(got, "```"))
		assert.NotContains(t, got, "fn1")
	})

	t.Run("文末截断且严重损坏无法自愈的 Mermaid 围栏被骨架干净替换且无残留", func(t *testing.T) {
		content := "# Chapter 1\n\n## 1. 架构总览\n\n```mermaid\nflowchart TD\n  ??? >>>"
		got := EnsureMermaidArchitecture(content, skeleton)
		assert.Contains(t, got, skeleton)
		assert.Equal(t, 1, strings.Count(got, "```mermaid"))
		assert.True(t, strings.HasSuffix(got, "```"))
	})

	t.Run("标签含括号未转义与未闭合 subgraph 在 0ms 瞬间自愈且不被骨架覆盖", func(t *testing.T) {
		content := "# Chapter 1\n\n```mermaid\nflowchart TD\n  subgraph Engine\n  A[Init(ctx)] --> B[Exec(task)]\n```"
		got := EnsureMermaidArchitecture(content, skeleton)
		assert.Contains(t, got, `A["Init(ctx)"] --> B["Exec(task)"]`)
		assert.Contains(t, got, "end")
		assert.NotContains(t, got, "fn1")
	})

	t.Run("无任何标题时前置骨架", func(t *testing.T) {
		content := "纯文本正文内容，无任何 Markdown 标题。"
		got := EnsureMermaidArchitecture(content, skeleton)
		assert.True(t, strings.HasPrefix(got, skeleton+"\n\n"))
	})

	t.Run("骨架为空时不作任何变更", func(t *testing.T) {
		content := "# Chapter 1\n\n无图表正文"
		got := EnsureMermaidArchitecture(content, "")
		assert.Equal(t, content, got)
	})
}

func TestMdxConvergencePipeline_ArchitectureSkeletonIntegration(t *testing.T) {
	skeleton := "```mermaid\nflowchart TD\n  fn1[\"Init()\"] --> fn2[\"Execute()\"]\n```"
	rawDraft := "===CONTENT_BEGIN===\n# Engine\n\n## 1. Overview\n\nCore engine overview without diagram.\n\n## 2. Implementation\n===CONTENT_END==="

	pipeline := MdxConvergencePipeline{
		DocPath:              "core/engine.mdx",
		ArchitectureSkeleton: skeleton,
	}

	res := pipeline.Execute(context.Background(), rawDraft, nil)
	assert.Empty(t, res.ValidationError)
	assert.Contains(t, res.FinalContent, skeleton)
	assert.Contains(t, res.FinalContent, "fn1[\"Init()\"] --> fn2[\"Execute()\"]")
}

func TestEnsureGroundedMermaidArchitecture_DecoupledHealing(t *testing.T) {
	skeleton := "```mermaid\nflowchart TD\n  fn1[\"InitScheduler()<br/>scheduler.go\"] --> fn2[\"ExecuteTask()<br/>task.go\"]\n```"
	verifiedSymbols := []string{"InitScheduler", "ExecuteTask"}

	t.Run("自然语言概念与业务拓扑图表 100% 尊重并保留 (认知 2: 语法 ≠ 意图)", func(t *testing.T) {
		content := "# Scheduler Engine\n\n## 1. 架构总览\n\n```mermaid\nflowchart TD\n  Client[\"Client Web Browser\"] --> Server[\"Backend Server\"]\n```\n\n## 2. 详细实现"
		got := EnsureGroundedMermaidArchitecture(content, skeleton, verifiedSymbols)
		assert.Contains(t, got, "Client Web Browser")
		assert.Contains(t, got, "Backend Server")
		assert.NotContains(t, got, "InitScheduler")
	})

	t.Run("包含真实 AST 符号的语义扩展图表予以保留", func(t *testing.T) {
		content := "# Scheduler Engine\n\n## 1. 架构总览\n\n```mermaid\nflowchart TD\n  Trigger[\"Cron Trigger\"] --> fn1[\"InitScheduler()\"]\n  fn1 --> Worker[\"Worker Pool\"]\n```\n\n## 2. 详细实现"
		got := EnsureGroundedMermaidArchitecture(content, skeleton, verifiedSymbols)
		assert.Contains(t, got, "Cron Trigger")
		assert.Contains(t, got, "InitScheduler()")
		assert.NotContains(t, got, "task.go")
	})

	t.Run("流水线端到端在存在概念拓扑图表时完整保留其教学负熵", func(t *testing.T) {
		rawDraft := "===CONTENT_BEGIN===\n# Scheduler\n\n## 1. Overview\n\n```mermaid\nflowchart LR\n  Frontend --> Backend\n```\n\n## 2. Detail\n===CONTENT_END==="
		pipeline := MdxConvergencePipeline{
			DocPath:              "core/scheduler.mdx",
			ArchitectureSkeleton: skeleton,
		}
		res := pipeline.Execute(context.Background(), rawDraft, nil)
		assert.Empty(t, res.ValidationError)
		assert.Contains(t, res.FinalContent, "Frontend --> Backend")
		assert.NotContains(t, res.FinalContent, "InitScheduler")
	})

	t.Run("无 AST 符号的概览章保留 LLM 合法概念流程图而不覆盖", func(t *testing.T) {
		dummySkeleton := "```mermaid\nflowchart TD\n  subgraph ChapterMod[\"第 1 章：全景导览与配置驱动实验系统\"]\n    fn1[\"第 1 章：全景导览与配置驱动实验系统 Core\"]\n  end\n```"
		symbols := extractSkeletonSymbols(dummySkeleton)
		assert.Empty(t, symbols, "容器名与 Core 单节点不应作为 AST 符号")

		content := "# Chapter 1\n\n## 1. 全景流程\n\n```mermaid\nflowchart LR\n  A[\"数据准备\"] --> B[\"分词编码\"]\n  B --> C[\"训练循环\"]\n  C --> D[\"采样生成\"]\n```\n\n## 2. 细节"
		got := EnsureGroundedMermaidArchitecture(content, dummySkeleton, symbols)
		assert.Contains(t, got, "数据准备")
		assert.Contains(t, got, "采样生成")
		assert.NotContains(t, got, "Core")
	})

	t.Run("严重破损图表在提供真实骨架时进行真实骨架保底", func(t *testing.T) {
		content := "# Scheduler Engine\n\n## 1. 架构总览\n\n```mermaid\nflowchart TD\n  ??? >>>\n```\n\n## 2. 详细实现"
		got := EnsureGroundedMermaidArchitecture(content, skeleton, verifiedSymbols)
		assert.Contains(t, got, "InitScheduler")
		assert.Contains(t, got, "ExecuteTask")
	})

	t.Run("严重破损图表在仅有 dummy 骨架时坚决不注水直接剥离 (Layer 3: 零注水)", func(t *testing.T) {
		dummySkeleton := "```mermaid\nflowchart TD\n  subgraph ChapterMod[\"Dummy\"]\n    fn1[\"Dummy Core\"]\n  end\n```"
		content := "# Chapter 1\n\n## 1. 架构总览\n\n```mermaid\nflowchart TD\n  ??? >>>\n```\n\n## 2. 详细实现"
		got := EnsureGroundedMermaidArchitecture(content, dummySkeleton, nil)
		assert.NotContains(t, got, "Core")
		assert.NotContains(t, got, "```mermaid")
		assert.Contains(t, got, "## 1. 架构总览")
		assert.Contains(t, got, "## 2. 详细实现")
	})
}

func TestMdxConvergencePipeline_Stage1_5_CodeSlotSnapping(t *testing.T) {
	refs := []armor.ArmorFileRef{
		{Path: "pkg/scheduler.go"},
	}

	realCode := `func InitScheduler(cfg *Config) (*Scheduler, error) {
	return &Scheduler{workers: cfg.Workers}, nil
}`

	resolver := func(fileIndex int, relPath, symbol string, reqStart, reqEnd int) (string, int, int, bool) {
		if fileIndex == 1 && symbol == "InitScheduler" {
			return realCode, 45, 47, true
		}
		return "", 0, 0, false
	}

	t.Run("隐式吸附：将草稿中的代码槽位和幻觉代码确定性替换为真实切片并完成句柄还原", func(t *testing.T) {
		rawDraft := "===CONTENT_BEGIN===\n# 调度器教程\n\n```go // [File 1#InitScheduler:core]\n// 幻觉代码：此处随意写的错误逻辑\n```\n\n教程完毕。\n===CONTENT_END==="

		pipeline := MdxConvergencePipeline{
			DocPath:      "chapters/01.mdx",
			Refs:         refs,
			CodeResolver: resolver,
		}

		res := pipeline.Execute(context.Background(), rawDraft, nil)
		assert.Empty(t, res.ValidationError)
		assert.Contains(t, res.FinalContent, "func InitScheduler(cfg *Config) (*Scheduler, error)")
		assert.Contains(t, res.FinalContent, "return &Scheduler{workers: cfg.Workers}, nil")
		assert.NotContains(t, res.FinalContent, "幻觉代码：此处随意写的错误逻辑")
		assert.Contains(t, res.FinalContent, "pkg/scheduler.go")
	})
}

func TestMdxConvergencePipeline_TerminalCliffhangerPruning(t *testing.T) {
	rawDraft := "===CONTENT_BEGIN===\n# 神经网络教程\n\n本章完成 MLP 构建。\n\n下一课时，我们将把这些微构件接到真实数据与损失函数上，跑通一次完整的训练循环。\n===CONTENT_END==="

	t.Run("终章模式下修剪末尾下一课时幻觉预告", func(t *testing.T) {
		pipeline := MdxConvergencePipeline{
			DocPath:        "chapters/02.mdx",
			IsFinalChapter: true,
		}
		res := pipeline.Execute(context.Background(), rawDraft, nil)
		assert.Empty(t, res.ValidationError)
		assert.Contains(t, res.FinalContent, "本章完成 MLP 构建。")
		assert.NotContains(t, res.FinalContent, "下一课时")
	})

	t.Run("非终章模式下保留末尾过渡", func(t *testing.T) {
		pipeline := MdxConvergencePipeline{
			DocPath:        "chapters/01.mdx",
			IsFinalChapter: false,
		}
		res := pipeline.Execute(context.Background(), rawDraft, nil)
		assert.Empty(t, res.ValidationError)
		assert.Contains(t, res.FinalContent, "下一课时，我们将把这些微构件接到真实数据与损失函数上")
	})
}

func TestMdxConvergencePipeline_Layer1ZeroLlmRescue(t *testing.T) {
	mockLlm := &mockConvergenceLlm{}
	rawDraft := "{\n  \"lessonMarkdown\": \"# Lesson 1\\n\\n<Callout type=\\\"info\\\">\\nImportant note inside callout\\n\\n```go\\nfunc test() {\\n  return 1\\\"\\n}"

	pipeline := MdxConvergencePipeline{
		DocPath:   "chapters/01.mdx",
		LlmClient: mockLlm,
	}

	res := pipeline.Execute(context.Background(), rawDraft, nil)

	assert.Empty(t, res.ValidationError)
	assert.False(t, res.WasRepaired, "Layer 1 must be 0ms pure memory compute, WasRepaired remains false")
	assert.False(t, res.WasFallbackUsed)
	assert.Len(t, mockLlm.calls, 0, "Zero LLM calls for Layer 1 deterministic rescue")

	assert.Contains(t, res.FinalContent, "# Lesson 1")
	assert.Contains(t, res.FinalContent, "func test()")
	assert.Contains(t, res.FinalContent, "```")
	assert.Contains(t, res.FinalContent, "</Callout>")
}

func TestMdxConvergencePipeline_Layer2SurgicalLinePatch(t *testing.T) {
	lines := make([]string, 100)
	for i := 0; i < 100; i++ {
		lines[i] = fmt.Sprintf("Line %d of narrative and code explanation.", i+1)
	}
	lines[44] = "<Component value={invalid + ? : 99} />"
	longDraft := strings.Join(lines, "\n")

	var capturedSource string
	mockLlm := &mockConvergenceLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			capturedSource = vars["mdxSource"].(string)
			repairedSlice := strings.ReplaceAll(capturedSource, "{invalid + ? : 99}", "{99}")
			return LlmTextResult{
				Text:         "===CONTENT_BEGIN===\n" + repairedSlice + "\n===CONTENT_END===",
				FinishReason: "stop",
			}, nil
		},
	}

	pipeline := MdxConvergencePipeline{
		DocPath:   "chapters/03.mdx",
		LlmClient: mockLlm,
	}

	res := pipeline.Execute(context.Background(), longDraft, nil)

	assert.Empty(t, res.ValidationError)
	assert.True(t, res.WasRepaired, "Layer 2 targeted repair must mark WasRepaired=true")
	assert.False(t, res.WasFallbackUsed)
	require.Len(t, mockLlm.calls, 1)

	capturedLines := strings.Split(capturedSource, "\n")
	assert.LessOrEqual(t, len(capturedLines), 35, "mdxSource must be a small surgical slice (<= 35 lines), not full document")
	assert.GreaterOrEqual(t, len(capturedLines), 25)
	assert.Contains(t, capturedSource, "<Component value={invalid + ? : 99} />")

	finalLines := strings.Split(res.FinalContent, "\n")
	assert.GreaterOrEqual(t, len(finalLines), 95)
	assert.Contains(t, res.FinalContent, "Line 1 of narrative")
	assert.Contains(t, res.FinalContent, "Line 100 of narrative")
	assert.Contains(t, res.FinalContent, "<Component value={99} />")
}

func TestMdxConvergencePipeline_DecoupledMermaidDoctor_EndToEnd(t *testing.T) {
	chapterText := "# Lesson on Architecture\n\nIntroduction prose explaining concepts.\n\n```mermaid\nflowchart TD\n  ??? >>> corrupted\n```\n\n## 2. Implementation\n\nCode details and explanations."

	var calledPurpose string
	var calledVars map[string]any
	mockLlm := &mockConvergenceLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			calledPurpose = purpose
			calledVars = vars
			if purpose == "mermaid_resilience" {
				return LlmTextResult{
					Text: "```mermaid\nflowchart TD\n  A[\"Data Input\"] --> B[\"Process Core\"]\n```",
				}, nil
			}
			return LlmTextResult{}, errors.New("unexpected purpose")
		},
	}

	pipeline := MdxConvergencePipeline{
		DocPath:   "chapters/04.mdx",
		LlmClient: mockLlm,
	}

	res := pipeline.Execute(context.Background(), chapterText, nil)
	assert.Empty(t, res.ValidationError)
	assert.Equal(t, "mermaid_resilience", calledPurpose)
	assert.Contains(t, calledVars["rawMermaid"].(string), "corrupted")
	assert.NotContains(t, calledVars, "lessonMarkdown")

	assert.Contains(t, res.FinalContent, "# Lesson on Architecture")
	assert.Contains(t, res.FinalContent, "Introduction prose explaining concepts.")
	assert.Contains(t, res.FinalContent, `A["Data Input"] --> B["Process Core"]`)
	assert.Contains(t, res.FinalContent, "## 2. Implementation")
	assert.NotContains(t, res.FinalContent, "corrupted")
}

func TestMdxConvergencePipeline_Stage3NormalizesDeepDiveBlocks(t *testing.T) {
	mockLlm := &mockConvergenceLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			return LlmTextResult{}, fmt.Errorf("unexpected LLM repair call for %s", purpose)
		},
	}

	rawDraft := "===CONTENT_BEGIN===\n" +
		"## 调度主线\n\n" +
		"参考 [File 1#hydratePublisher:core] 与 [File 1#L10-L20:core]。\n\n" +
		"<details data-layer=\"deep\"><summary>源码深潜：内部缓冲</summary>" +
		"内部参见 [File 1#L30-L40:contract] 细节。</details>\n" +
		"===CONTENT_END==="

	p := MdxConvergencePipeline{
		DocPath:   "chapters/05.mdx",
		LlmClient: mockLlm,
		Refs:      []armor.ArmorFileRef{{Path: "src/gateway.ts"}},
	}

	res := p.Execute(context.Background(), rawDraft, nil)

	assert.Empty(t, res.ValidationError)
	assert.False(t, res.WasRepaired, "compact details block should normalize deterministically without LLM repair")
	assert.False(t, res.WasFallbackUsed)
	assert.Empty(t, mockLlm.calls)

	assert.Contains(t, res.FinalContent, "`gateway.ts#hydratePublisher`")
	assert.Contains(t, res.FinalContent, "[gateway.ts](code:src/gateway.ts:L10-L20)")
	assert.Contains(t, res.FinalContent, "[gateway.ts](code:src/gateway.ts:L30-L40)")
	assert.NotContains(t, res.FinalContent, ":core")
	assert.NotContains(t, res.FinalContent, ":contract")
	assert.Contains(t, res.FinalContent, "<details data-layer=\"deep\">\n<summary>源码深潜：内部缓冲</summary>\n\n内部参见 [gateway.ts](code:src/gateway.ts:L30-L40) 细节。\n\n</details>")
}

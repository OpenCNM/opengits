package chunker

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCleanMarkdownHeading(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "clean simple heading",
			input:    "## Getting Started",
			expected: "Getting Started",
		},
		{
			name:     "clean heading with link and custom anchor",
			input:    "## [系统架构设计](https://example.com/arch) {#system-arch} ###",
			expected: "系统架构设计",
		},
		{
			name:     "clean heading with badge tags and comments",
			input:    "### <!-- comment --> <Badge>Beta</Badge> API Reference",
			expected: "Beta API Reference",
		},
		{
			name:     "pure anchor heading produces empty string",
			input:    "## {#only-anchor}",
			expected: "",
		},
		{
			name:     "heading with image",
			input:    "# ![Logo](https://example.com/logo.png) Home Page",
			expected: "Home Page",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CleanMarkdownHeading(tt.input)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestDetermineContentType(t *testing.T) {
	tests := []struct {
		name       string
		content    string
		sourceFile string
		expected   string
	}{
		{
			name:     "mermaid backticks",
			content:  "```mermaid\ngraph LR\n  A --> B\n```",
			expected: "architecture_diagram",
		},
		{
			name:     "mermaid tildes with spaces",
			content:  "~~~  mermaid\nsequenceDiagram\n  A->>B: msg\n~~~",
			expected: "architecture_diagram",
		},
		{
			name:       "entry point file",
			content:    "console.log('bootstrapping server');",
			sourceFile: "src/server.ts",
			expected:   "entry_point",
		},
		{
			name:     "type definition keywords",
			content:  "export interface UserProfile {\n  id: string;\n  name: string;\n}",
			expected: "type_definition",
		},
		{
			name:     "standard function implementation",
			content:  "function calculateDiscount(price: number) { return price * 0.9; }",
			expected: "function_impl",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := determineContentType(tt.content, tt.sourceFile)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestSplitLargeChunk_ZeroLoss(t *testing.T) {
	tests := []struct {
		name      string
		generator func() string
		joinSep   string
	}{
		{
			name: "12,000 char single-line string with zero loss",
			generator: func() string {
				return strings.Repeat("A", 4000) + strings.Repeat("B", 4000) + strings.Repeat("C", 4000)
			},
			joinSep: "",
		},
		{
			name: "5,000 char multi-line string across line boundaries with zero loss",
			generator: func() string {
				var lines []string
				for i := 0; i < 50; i++ {
					lines = append(lines, fmt.Sprintf("Line %03d: %s", i, strings.Repeat("X", 90)))
				}
				return strings.Join(lines, "\n")
			},
			joinSep: "\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			original := tt.generator()
			chunks := splitLargeChunk(original, defaultMaxChunkChars)
			require.Greater(t, len(chunks), 1)

			for _, c := range chunks {
				assert.LessOrEqual(t, len(c), defaultMaxChunkChars)
			}

			joined := strings.Join(chunks, tt.joinSep)
			assert.Equal(t, original, joined)
		})
	}
}

func TestExtractL2Headings_FenceProtection(t *testing.T) {
	tests := []struct {
		name              string
		mdx               string
		expectedHeadings  []string
		forbiddenHeadings []string
	}{
		{
			name: "code fences with fake ## headings",
			mdx: `
This is module overview.

## Real Section One {#sec-1}

Here is a bash snippet:
` + "```bash\n## This is a bash comment, not an L2 heading!\necho \"hello\"\n```" + `

~~~python
## Another comment in tilde block
x = 1
~~~

## Real Section Two
Final explanation.
`,
			expectedHeadings:  []string{"Real Section One", "Real Section Two"},
			forbiddenHeadings: []string{"This is a bash comment", "Another comment"},
		},
		{
			name: "nested 4-backtick code block enclosing 3-backticks",
			mdx: `
Overview.

## Outer Section

` + "````markdown\nHere is a nested 3-backtick code block:\n```js\n## This is inside nested code block\nconsole.log(\"nested\");\n```\nStill inside the 4-backtick outer block!\n## Another comment inside 4-backticks\n````" + `

## Genuine Next Section
Out of code block.
`,
			expectedHeadings:  []string{"Outer Section", "Genuine Next Section"},
			forbiddenHeadings: []string{"This is inside nested code block", "Another comment inside 4-backticks"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			nodes := extractL2Headings(tt.mdx)
			var titles []string
			for _, n := range nodes {
				titles = append(titles, n.Title)
			}
			for _, exp := range tt.expectedHeadings {
				assert.Contains(t, titles, exp)
			}
			for _, forb := range tt.forbiddenHeadings {
				for _, title := range titles {
					assert.NotContains(t, title, forb)
				}
			}
		})
	}
}

func TestChunkCodeModule(t *testing.T) {
	tests := []struct {
		name          string
		req           CodeModuleChunkRequest
		minChunks     int
		verifyClosure func(t *testing.T, chunks []CodeChunk)
	}{
		{
			name: "oversized section auto secondary split",
			req: CodeModuleChunkRequest{
				ModuleName:  "CoreEngine",
				SourceFiles: []string{"src/core.ts"},
				MdxContent:  "## 核心实现\n\n" + strings.Repeat(strings.Repeat("这是非常详细的代码实现与原理解析段落。", 20)+"\n\n", 20),
			},
			minChunks: 2,
			verifyClosure: func(t *testing.T, chunks []CodeChunk) {
				for _, c := range chunks {
					assert.LessOrEqual(t, len(c.Content), 4500)
					assert.Contains(t, c.Heading, "CoreEngine > 核心实现")
				}
			},
		},
		{
			name: "empty mdx fallback",
			req: CodeModuleChunkRequest{
				ModuleName: "EmptyModule",
				MdxContent: "",
			},
			minChunks: 1,
			verifyClosure: func(t *testing.T, chunks []CodeChunk) {
				require.Len(t, chunks, 1)
				assert.Equal(t, "EmptyModule", chunks[0].Heading)
				assert.Equal(t, "module_overview", chunks[0].ContentType)
			},
		},
		{
			name: "plain text without headings produces overview chunk",
			req: CodeModuleChunkRequest{
				ModuleName: "PlainModule",
				MdxContent: "Plain text with no headings",
			},
			minChunks: 1,
			verifyClosure: func(t *testing.T, chunks []CodeChunk) {
				require.Len(t, chunks, 1)
				assert.Equal(t, "PlainModule > 概述", chunks[0].Heading)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chunks := ChunkCodeModule(tt.req)
			require.GreaterOrEqual(t, len(chunks), tt.minChunks)
			if tt.verifyClosure != nil {
				tt.verifyClosure(t, chunks)
			}
		})
	}
}

func TestClassifyChunk(t *testing.T) {
	tests := []struct {
		name          string
		content       string
		headingPath   string
		blueprintRole string
		expected      string
	}{
		{
			name:     "mermaid backticks as architecture_diagram",
			content:  "```mermaid\ngraph TD\n  Client --> Gateway\n```",
			expected: "architecture_diagram",
		},
		{
			name:     "warning callout [!WARNING]",
			content:  "> [!WARNING]\n> Modifying this directly causes issues.",
			expected: "warning",
		},
		{
			name:     "docusaurus warning :::warning",
			content:  ":::warning\nBe careful with this operation\n:::",
			expected: "warning",
		},
		{
			name:     "code ratio >= 50% identified as code",
			content:  "Intro:\n```typescript\nfunction add(a: number, b: number) { return a + b; }\n```",
			expected: "code",
		},
		{
			name:     "markdown table as api_reference",
			content:  "| Param | Type | Description |\n| --- | --- | --- |\n| id | string | User ID |",
			expected: "api_reference",
		},
		{
			name:          "physical code takes priority over macro blueprint role",
			content:       "```typescript\nexport function auth() { return true; }\n```",
			blueprintRole: "architecture",
			expected:      "code",
		},
		{
			name:          "blueprint role fallback",
			content:       "Generic text without code blocks.",
			blueprintRole: "architecture",
			expected:      "architecture_diagram",
		},
		{
			name:        "heading path keyword fallback",
			content:     "System topology discussion.",
			headingPath: "Docs > Architecture Overview",
			expected:    "architecture_diagram",
		},
		{
			name:     "fallback to prose",
			content:  "Welcome to the project! This guide will help you get started.",
			expected: "prose",
		},
		{
			name:        "heading substring 'rapid' no longer hits api keyword",
			content:     "Rapid prototyping guide.",
			headingPath: "Docs > Rapid Prototyping",
			expected:    "prose",
		},
		{
			name:        "heading substring 'ecosystem' no longer hits system keyword",
			content:     "Tooling ecosystem notes.",
			headingPath: "Docs > Ecosystem",
			expected:    "prose",
		},
		{
			name:        "heading word-boundary api still classifies",
			content:     "Endpoint listing.",
			headingPath: "Docs > API Reference",
			expected:    "api_reference",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClassifyChunk(tt.content, tt.headingPath, tt.blueprintRole)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestEstimateChunkerTokens(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected float64
	}{
		{
			name:     "ascii string",
			input:    "abcd",
			expected: 1.0, // 4 * 0.25
		},
		{
			name:     "cjk string",
			input:    "你好世界",
			expected: 5.2, // 4 * 1.3（审计 §10：chunker 收敛 token-counter.ts 真值 1.3/0.25）
		},
		{
			name:     "mixed string",
			input:    "Go语言",
			expected: 3.1, // 2 * 0.25 + 2 * 1.3 = 0.5 + 2.6
		},
		{
			name:     "kana counted as cjk（旧块集假名失明已修）",
			input:    "アイウエオ",
			expected: 6.5, // 5 * 1.3
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := estimateChunkerTokens(tt.input)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestFormatContextualHeader(t *testing.T) {
	tests := []struct {
		name        string
		docPath     string
		parentTitle string
		heading     string
	}{
		{
			name:        "standard header fits well",
			docPath:     "guide/intro.md",
			parentTitle: "Guide",
			heading:     "Introduction",
		},
		{
			name:        "oversized deep path and long title",
			docPath:     "deeply/nested/directory/structure/and/very/long/file/path/name/docs/specification.md",
			parentTitle: "Super Extremely Long Parent Section Title That Exceeds Token Limits By Far",
			heading:     "Detailed Implementation Architecture And Microservice Specifications",
		},
		{
			name:        "empty path defaults to root",
			docPath:     "",
			parentTitle: "",
			heading:     "Home",
		},
		{
			name:        "long path triggers path truncation",
			docPath:     "very/long/nested/directory/structure/and/many/levels/of/folders/document.md",
			parentTitle: "Docs",
			heading:     "Overview",
		},
		{
			name:        "long section triggers section truncation",
			docPath:     "api/overview.md",
			parentTitle: "Comprehensive Developer API Reference Guide For Integrations",
			heading:     "Authentication and Authorization Flows for Enterprise Systems",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			header := formatContextualHeader(tt.docPath, tt.parentTitle, tt.heading)
			assert.Contains(t, header, "[Path:")
			assert.Contains(t, header, "Section:")
			assert.LessOrEqual(t, estimateChunkerTokens(header), maxHeaderTokens)
		})
	}
}

func TestChunkMarkdown(t *testing.T) {
	sampleMarkdown := `
# Next.js 15 Migration Guide

[Path: docs/upgrade | Section: Intro]

Welcome to Next.js 15! This document outlines breaking changes. Read this guide before upgrading to understand the new async APIs.

## Async Request API

In Next.js 15, headers, cookies, and params are async Promises.

` + "```typescript\nexport async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {\n  const { id } = await params;\n  return Response.json({ id });\n}\n```" + `

> [!WARNING]
> Do not call synchronous params properties directly!

## Metadata API

Metadata generation now requires async resolution as well.
`

	tests := []struct {
		name          string
		req           MarkdownChunkRequest
		verifyClosure func(t *testing.T, chunks []MarkdownChunk)
	}{
		{
			name: "sample markdown splitting with contextual header and closed fences",
			req: MarkdownChunkRequest{
				Content:   sampleMarkdown,
				MaxTokens: 40,
				Overlap:   50,
				DocPath:   "docs/upgrade.md",
			},
			verifyClosure: func(t *testing.T, chunks []MarkdownChunk) {
				require.NotEmpty(t, chunks)
				for _, c := range chunks {
					assert.Contains(t, c.Content, "[Path:")
					fences := strings.Count(c.Content, "```")
					assert.True(t, fences%2 == 0, "code fences must be closed")
				}
				h1 := findMarkdownChunk(chunks, "Next.js 15 Migration Guide")
				require.NotNil(t, h1)
				assert.Equal(t, "Next.js 15 Migration Guide", *h1.HeadingPath)

				h2 := findMarkdownChunk(chunks, "Async Request API")
				require.NotNil(t, h2)
				assert.Equal(t, "Next.js 15 Migration Guide > Async Request API", *h2.HeadingPath)
			},
		},
		{
			name: "no heading document produces single General chunk without headingPath",
			req: MarkdownChunkRequest{
				Content:   "只有正文，没有任何标题。\n第二行正文。",
				MaxTokens: 500,
				Overlap:   50,
				DocPath:   "docs/plain.md",
			},
			verifyClosure: func(t *testing.T, chunks []MarkdownChunk) {
				require.Len(t, chunks, 1)
				assert.Equal(t, "General", chunks[0].Heading)
				assert.Nil(t, chunks[0].HeadingPath)
			},
		},
		{
			name: "sibling H2 sections without H1 do not collapse",
			req: MarkdownChunkRequest{
				Content: `
## 第一章：快速入门
入门指南详细内容。

## 第二章：系统配置
系统配置详细内容。

## 第三章：核心应用
核心应用详细内容。
`,
				MaxTokens: 10,
				Overlap:   5,
				DocPath:   "docs/guide.md",
			},
			verifyClosure: func(t *testing.T, chunks []MarkdownChunk) {
				c2 := findMarkdownChunk(chunks, "第二章：系统配置")
				require.NotNil(t, c2)
				assert.Equal(t, "第二章：系统配置", *c2.HeadingPath)

				c3 := findMarkdownChunk(chunks, "第三章：核心应用")
				require.NotNil(t, c3)
				assert.Equal(t, "第三章：核心应用", *c3.HeadingPath)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chunks := ChunkMarkdown(tt.req)
			tt.verifyClosure(t, chunks)
		})
	}
}

func findMarkdownChunk(chunks []MarkdownChunk, heading string) *MarkdownChunk {
	for i := range chunks {
		if chunks[i].Heading == heading {
			return &chunks[i]
		}
	}
	return nil
}

func TestHandleCodeModule(t *testing.T) {
	tests := []struct {
		name           string
		payload        string
		expectedStatus int
		verifyResponse func(t *testing.T, body []byte)
	}{
		{
			name:           "valid code module payload",
			payload:        `{"moduleName":"Core","mdxContent":"## S1\nBody1\n## S2\nBody2"}`,
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, body []byte) {
				var resp CodeModuleChunkResponse
				err := json.Unmarshal(body, &resp)
				require.NoError(t, err)
				assert.GreaterOrEqual(t, len(resp.Chunks), 2)
			},
		},
		{
			name:           "invalid json payload",
			payload:        `{bad-json}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/chunk/code-module", strings.NewReader(tt.payload))
			rec := httptest.NewRecorder()
			HandleCodeModule(rec, req)

			assert.Equal(t, tt.expectedStatus, rec.Code)
			if tt.verifyResponse != nil {
				tt.verifyResponse(t, rec.Body.Bytes())
			}
		})
	}
}

func TestHandleMarkdown(t *testing.T) {
	tests := []struct {
		name           string
		payload        string
		expectedStatus int
		verifyResponse func(t *testing.T, body []byte)
	}{
		{
			name:           "valid markdown payload",
			payload:        `{"content":"# Title\nParagraph text.","docPath":"docs/a.md"}`,
			expectedStatus: http.StatusOK,
			verifyResponse: func(t *testing.T, body []byte) {
				var resp MarkdownChunkResponse
				err := json.Unmarshal(body, &resp)
				require.NoError(t, err)
				require.Len(t, resp.Chunks, 1)
				assert.Equal(t, "Title", resp.Chunks[0].Heading)
			},
		},
		{
			name:           "invalid json payload",
			payload:        `{bad-json}`,
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/chunk/markdown", strings.NewReader(tt.payload))
			rec := httptest.NewRecorder()
			HandleMarkdown(rec, req)

			assert.Equal(t, tt.expectedStatus, rec.Code)
			if tt.verifyResponse != nil {
				tt.verifyResponse(t, rec.Body.Bytes())
			}
		})
	}
}

// TestOverlapSnapshotEquivalence fence 快照版 vs 从头重放版的差分等价锁
// （确定性随机行集，fence 密集；含重置后再追加的链式快照场景）。
func TestOverlapSnapshotEquivalence(t *testing.T) {
	linePool := []string{
		"```ts", "```", "~~~python", "~~~", "````md", "````",
		"const x = 1;", "text line", "# Heading", "", "  indented",
		"```js const y = 2;", "~~~~", "`````", "plain `code` tick",
	}
	rng := rand.New(rand.NewSource(20261010))
	for round := 0; round < 500; round++ {
		n := 1 + rng.Intn(40)
		lines := make([]string, n)
		for i := range lines {
			lines[i] = linePool[rng.Intn(len(linePool))]
		}
		snaps := buildFenceSnapshots(lines)
		for _, sliceCount := range []int{0, 1, 5, 10, 12, 50} {
			want := GetOverlapLinesWithBoundary(lines, sliceCount, 800.0)
			got := getOverlapLinesWithSnapshots(lines, snaps, sliceCount, 800.0)
			require.Equal(t, want, got, "round=%d n=%d sliceCount=%d", round, n, sliceCount)
		}
	}
}

// TestChunkMarkdownLongDocCrossBoundaryFence 长文多级标题 + 跨块边界
// 未闭合 fence：块边界处重叠注入的合成 fence 行必须保证 fence 语义连续
// （重放版与快照版在此前是高危分歧点）。
func TestChunkMarkdownLongDocCrossBoundaryFence(t *testing.T) {
	var sb strings.Builder
	for h := 1; h <= 30; h++ {
		fmt.Fprintf(&sb, "## Section %d\n\n", h)
		for p := 0; p < 8; p++ {
			fmt.Fprintf(&sb, "Paragraph %d.%d with some content text to accumulate tokens quickly enough.\n\n", h, p)
		}
		if h == 10 {
			// 跨块边界的未闭合围栏：内容行落在后续块内
			sb.WriteString("```typescript\n")
			for c := 0; c < 60; c++ {
				fmt.Fprintf(&sb, "const value%d = compute%d(a, b); // long code body line\n", c, c)
			}
			sb.WriteString("```\n")
		}
	}
	chunks := ChunkMarkdown(MarkdownChunkRequest{
		Content: sb.String(),
		DocPath: "docs/long.md",
	})
	require.NotEmpty(t, chunks)
	// 全量代码行不丢：每个 const 行都出现在某块中
	joined := strings.Join(chunkContents(chunks), "\n")
	for c := 0; c < 60; c++ {
		require.Contains(t, joined, fmt.Sprintf("const value%d =", c), "代码行 %d 丢失", c)
	}
	// 每块内容 fence 平衡：围栏行数为偶数（开闭配对，含合成行）
	for i, ch := range chunks {
		fenceCount := strings.Count(ch.Content, "```")
		assert.True(t, fenceCount%2 == 0 || strings.Contains(ch.Content, "~~~"), "chunk %d fence 不平衡: %d", i, fenceCount)
	}
}

func chunkContents(chunks []MarkdownChunk) []string {
	out := make([]string, len(chunks))
	for i, c := range chunks {
		out[i] = c.Content
	}
	return out
}

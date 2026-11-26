package concept

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExtractConceptManifest_TableDriven(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		docPath  string
		assertFn func(t *testing.T, res ExtractedManifestResult)
	}{
		{
			name:    "empty input returns clean empty result without frontmatter",
			content: "",
			docPath: "docs/test",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.False(t, res.HasFrontmatter)
				assert.Equal(t, "", res.CleanMdx)
				assert.Equal(t, "", res.CleanContent)
				assert.Empty(t, res.Concepts)
			},
		},
		{
			name:    "whitespace only input returns clean empty result",
			content: "   \n\t  \r\n  ",
			docPath: "docs/test",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.False(t, res.HasFrontmatter)
				assert.Equal(t, "", res.CleanMdx)
				assert.Equal(t, "", res.CleanContent)
				assert.Empty(t, res.Concepts)
			},
		},
		{
			name: "valid frontmatter envelope with all fields",
			content: `---
summary: "章节概要总结"
concepts:
  - name: "核心架构模式"
    category: "architecture"
    sourceHeading: "系统设计总览"
    reflection: "解耦核心层"
quizzes:
  - question: "如何处理未匹配路由？"
    options: ["转交404", "抛出致命异常"]
    correctIndex: 0
    explanation: "系统默认降级处理"
takeaways:
  - "掌握解耦设计"
  - "理解分发机制"
---

# 系统设计总览

正文内容...
`,
			docPath: "docs/core",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				assert.Equal(t, "章节概要总结", res.Summary)
				assert.Contains(t, res.CleanMdx, "# 系统设计总览")
				assert.NotContains(t, res.CleanMdx, "---")
				assert.Equal(t, res.CleanMdx, res.CleanContent)

				require.Len(t, res.Concepts, 1)
				c := res.Concepts[0]
				assert.Equal(t, "核心架构模式", c.ConceptName)
				assert.Equal(t, "architecture", c.Category)
				assert.Equal(t, "系统设计总览", c.SourceHeading)
				assert.Equal(t, "解耦核心层", c.AuthorReflections)

				require.Len(t, res.Quizzes, 1)
				assert.Equal(t, "如何处理未匹配路由？", res.Quizzes[0].Question)
				assert.Equal(t, 0, res.Quizzes[0].CorrectIndex)
				assert.Equal(t, "系统默认降级处理", res.Quizzes[0].Explanation)

				require.Len(t, res.Takeaways, 2)
				assert.Equal(t, "掌握解耦设计", res.Takeaways[0])
			},
		},
		{
			name: "frontmatter enclosed in code fences tolerance",
			content: `---
` + "```yaml" + `
summary: "围栏包裹容错"
concepts:
  - name: "围栏测试"
    category: "workflow"
` + "```" + `
---

# 正文标题
正文内容测试。`,
			docPath: "docs/fence",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				assert.Equal(t, "围栏包裹容错", res.Summary)
				assert.Contains(t, res.CleanMdx, "# 正文标题")
				assert.NotContains(t, res.CleanMdx, "```yaml")
				require.Len(t, res.Concepts, 1)
				assert.Equal(t, "围栏测试", res.Concepts[0].ConceptName)
				assert.Equal(t, "workflow", res.Concepts[0].Category)
			},
		},
		{
			name: "corrupt frontmatter syntax safely falls back without contaminating MDX",
			content: `---
[this is: invalid yaml: { unclosed
---

# 纯正文标题
正文内容不可被损坏 frontmatter 污染。`,
			docPath: "docs/corrupt",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				assert.Contains(t, res.CleanMdx, "# 纯正文标题")
				assert.NotContains(t, res.CleanMdx, "unclosed")
				assert.Equal(t, res.CleanMdx, res.CleanContent)
				assert.Empty(t, res.Concepts)
			},
		},
		{
			name: "plain markdown without frontmatter",
			content: `# 简单文档

纯粹正文，没有任何 frontmatter 信封。`,
			docPath: "docs/plain",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.False(t, res.HasFrontmatter)
				assert.Contains(t, res.CleanMdx, "# 简单文档")
				assert.Equal(t, strings.TrimSpace(res.CleanMdx), strings.TrimSpace(res.CleanContent))
				assert.Empty(t, res.Concepts)
			},
		},
		{
			name: "concept name truncation to 60 runes",
			content: `---
concepts:
  - name: "这是一段极其冗长的超长概念名称超过六十个中文字符用来测试系统确定性截断防护机制防止知识图谱超限溢出"
    category: "principle"
---

# 标题`,
			docPath: "docs/trunc",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				require.Len(t, res.Concepts, 1)
				assert.LessOrEqual(t, len([]rune(res.Concepts[0].ConceptName)), 60)
			},
		},
		{
			name: "category synonyms normalization",
			content: `---
concepts:
  - name: "C1"
    category: "build pipeline step"
  - name: "C2"
    category: "Trade-Off Lesson"
  - name: "C3"
    category: "System Module Structure"
  - name: "C4"
    category: "Unknown Custom"
---

# 正文`,
			docPath: "docs/cat",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				require.Len(t, res.Concepts, 4)
				assert.Equal(t, "workflow", res.Concepts[0].Category)
				assert.Equal(t, "reflection", res.Concepts[1].Category)
				assert.Equal(t, "architecture", res.Concepts[2].Category)
				assert.Equal(t, "principle", res.Concepts[3].Category)
			},
		},
		{
			name:    "windows CRLF line endings in frontmatter and body",
			content: "---\r\nsummary: \"CRLF测试概要\"\r\nconcepts:\r\n  - name: \"CRLF概念\"\r\n    category: \"workflow\"\r\n---\r\n\r\n# CRLF标题\r\n\r\n正文使用CRLF换行符。\r\n",
			docPath: "docs/crlf",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				assert.Equal(t, "CRLF测试概要", res.Summary)
				assert.Contains(t, res.CleanMdx, "# CRLF标题")
				assert.NotContains(t, res.CleanMdx, "---")
				require.Len(t, res.Concepts, 1)
				assert.Equal(t, "CRLF概念", res.Concepts[0].ConceptName)
				assert.Equal(t, "workflow", res.Concepts[0].Category)
			},
		},
		{
			name:    "UTF-8 BOM prefix handled transparently",
			content: "\ufeff---\nsummary: \"BOM测试\"\nconcepts:\n  - name: \"BOM概念\"\n    category: \"architecture\"\n---\n\n# BOM标题\n正文",
			docPath: "docs/bom",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				assert.Equal(t, "BOM测试", res.Summary)
				assert.Contains(t, res.CleanMdx, "# BOM标题")
				require.Len(t, res.Concepts, 1)
				assert.Equal(t, "BOM概念", res.Concepts[0].ConceptName)
			},
		},
		{
			name:    "JSON frontmatter with trailing comma tolerance",
			content: "---\n{\n  \"summary\": \"容错尾随逗号\",\n  \"concepts\": [\n    {\n      \"name\": \"逗号概念\",\n      \"category\": \"principle\",\n    },\n  ],\n}\n---\n\n# 正文",
			docPath: "docs/trailing-comma",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				assert.Equal(t, "容错尾随逗号", res.Summary)
				require.Len(t, res.Concepts, 1)
				assert.Equal(t, "逗号概念", res.Concepts[0].ConceptName)
			},
		},
		{
			name:    "summary only frontmatter guarantees non-nil concepts array in JSON",
			content: "---\nsummary: \"仅有概要无概念列表\"\n---\n\n# 标题\n正文",
			docPath: "docs/summary-only",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				assert.Equal(t, "仅有概要无概念列表", res.Summary)
				assert.NotNil(t, res.Concepts)
				assert.Empty(t, res.Concepts)

				b, err := json.Marshal(res)
				require.NoError(t, err)
				assert.Contains(t, string(b), `"concepts":[]`)
				assert.NotContains(t, string(b), `"concepts":null`)
			},
		},
		{
			name:    "markdown with horizontal rule in body does not truncate body",
			content: "---\nsummary: \"水平线测试\"\n---\n\n# 标题一\n\n正文段落一\n\n---\n\n## 标题二\n\n正文段落二",
			docPath: "docs/hr",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.True(t, res.HasFrontmatter)
				assert.Contains(t, res.CleanMdx, "# 标题一")
				assert.Contains(t, res.CleanMdx, "正文段落一")
				assert.Contains(t, res.CleanMdx, "---")
				assert.Contains(t, res.CleanMdx, "## 标题二")
				assert.Contains(t, res.CleanMdx, "正文段落二")
			},
		},
		{
			name: "markdown with prose containing Note: between horizontal rules is preserved",

			content: "---\nNote: \"unclosed quote without closing\n---\n\n# 核心内容\n\n正文",
			docPath: "docs/note",
			assertFn: func(t *testing.T, res ExtractedManifestResult) {
				assert.False(t, res.HasFrontmatter)
				assert.Contains(t, res.CleanMdx, "Note: \"unclosed quote without closing")
				assert.Contains(t, res.CleanMdx, "# 核心内容")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := ExtractConceptManifest(tt.content, tt.docPath)
			tt.assertFn(t, res)
		})
	}
}

func TestExtractConceptsFromHeadings(t *testing.T) {
	tests := []struct {
		name       string
		content    string
		wantNames  []string
		wantCats   map[string]string
		extraCheck func(t *testing.T, out []ExtractedConcept)
	}{
		{
			name: "headings become concepts with category rules and max 5",
			content: "" +
				"# Introduction\nintro body\n\n" +
				"# Event Loop\n\nThe event loop is the core mechanism.\n\n> Design philosophy: single thread.\n\n" +
				"# Install Steps\n\nStep 1 Download the binary\nStep 2 Run the installer\n\n" +
				"# Deep Internals\n\n" + strings.Repeat("principle text ", 40) + "\n\n" +
				"# Plain Section\n\nshort\n\n" +
				"# Extra One\n\nbody one with enough content\n# Extra Two\n\nbody two with enough content\n",
			wantNames: []string{"Event Loop", "Install Steps", "Deep Internals", "Extra One", "Extra Two"},
			wantCats:  map[string]string{"Event Loop": "reflection", "Install Steps": "workflow", "Deep Internals": "principle", "Extra One": "architecture"},
			extraCheck: func(t *testing.T, out []ExtractedConcept) {
				assert.Len(t, out, 5, "MAX_CONCEPTS_PER_DOC=5")
				assert.Equal(t, "Event Loop", out[0].SourceHeading)
				assert.Contains(t, out[0].AuthorReflections, "single thread")
				assert.Equal(t, []string{"Download the binary", "Run the installer"}, out[1].SopSteps)
			},
		},
		{
			name:      "headings inside code fences are not concepts",
			content:   "# Real\n\nreal body\n\n```md\n# Fake Heading\n```\n",
			wantNames: []string{"Real"},
		},
		{
			name:      "headingless doc gets untitled concept",
			content:   "plain intro text without any heading at all",
			wantNames: []string{"概述设计"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := ExtractConceptsFromHeadings(tt.content, "docs/a.md", "")
			got := make([]string, 0, len(out))
			for _, c := range out {
				got = append(got, c.ConceptName)
			}
			assert.Equal(t, tt.wantNames, got)
			for name, cat := range tt.wantCats {
				for _, c := range out {
					if c.ConceptName == name {
						assert.Equal(t, cat, c.Category, "category of %s", name)
					}
				}
			}
			if tt.extraCheck != nil {
				tt.extraCheck(t, out)
			}
			for _, c := range out {
				assert.NotEmpty(t, c.Slug, "slug must never be empty")
				assert.Contains(t, c.SubTopics, "导师指引")
				assert.Contains(t, c.Tags, "实战经验")
			}
		})
	}
}

func TestExtractConceptsFromHeadingsEnglishLabels(t *testing.T) {
	out := ExtractConceptsFromHeadings("# Hooks\n\nbody text here\n", "docs/b.md", "en-US")
	require.NotEmpty(t, out)
	assert.Contains(t, out[0].SubTopics, "Mentor Guide")
	assert.Contains(t, out[0].Tags, "Field Experience")
}

func TestPlanCanonicalGroups(t *testing.T) {
	groups := map[string][]CanonicalVariant{
		"event-loop": {
			{Name: "1. 事件循环", Count: 2},
			{Name: "事件循环", Count: 5},
			{Name: "事件循环机制", Count: 5},
		},
	}
	reps := PlanCanonicalGroups(groups)
	assert.Equal(t, "事件循环", reps["event-loop"], "同频取更短名")

	tie := map[string][]CanonicalVariant{
		"k": {{Name: "b", Count: 1}, {Name: "a", Count: 1}},
	}
	assert.Equal(t, "a", PlanCanonicalGroups(tie)["k"], "同频同长取字典序")
}

func TestExtractConceptsFromHeadings_AstPhysicalFallback(t *testing.T) {
	tests := []struct {
		name      string
		content   string
		docPath   string
		wantNames []string
		wantCats  map[string]string
	}{
		{
			name:      "headingless markdown with Go code block extracts exported types and functions",
			content:   "```go\npackage core\n\ntype EngineConfig struct {\n\tTimeout int\n}\n\nfunc NewEngine() *EngineConfig {\n\treturn &EngineConfig{}\n}\n```",
			docPath:   "docs/engine.md",
			wantNames: []string{"EngineConfig", "NewEngine"},
			wantCats: map[string]string{
				"EngineConfig": "architecture",
				"NewEngine":    "workflow",
			},
		},
		{
			name:      "pure Go source file without headings extracts symbols via file extension",
			content:   "package service\n\ntype UserService interface {\n\tFindByID(id string)\n}\n\nfunc HandleRequest() error {\n\treturn nil\n}\n",
			docPath:   "services/user.go",
			wantNames: []string{"UserService", "HandleRequest"},
			wantCats: map[string]string{
				"UserService":   "architecture",
				"HandleRequest": "workflow",
			},
		},
		{
			name:      "headingless markdown with TypeScript code block extracts exported types and functions",
			content:   "```ts\nexport interface AuthToken {\n\tjwt: string;\n}\n\nexport function verifyToken(token: string): boolean {\n\treturn true;\n}\n```",
			docPath:   "docs/auth.md",
			wantNames: []string{"AuthToken", "verifyToken"},
			wantCats: map[string]string{
				"AuthToken":   "architecture",
				"verifyToken": "workflow",
			},
		},
		{
			name:      "markdown with headings prioritizes headings over code physical concepts",
			content:   "# 架构设计总览\n\n```go\ntype InternalFoo struct {}\n```\n",
			docPath:   "docs/arch.md",
			wantNames: []string{"架构设计总览"},
			wantCats: map[string]string{
				"架构设计总览": "principle",
			},
		},
		{
			name:      "headingless markdown with code fence info string params extracts AST concepts",
			content:   "```go {1-5}\npackage config\n\ntype DatabasePool struct {\n\tSize int\n}\n\nfunc NewPool() *DatabasePool {\n\treturn &DatabasePool{}\n}\n```",
			docPath:   "docs/db.md",
			wantNames: []string{"DatabasePool", "NewPool"},
			wantCats: map[string]string{
				"DatabasePool": "architecture",
				"NewPool":      "workflow",
			},
		},
		{
			name:      "headings with only stopword overview falls back to AST physical concepts",
			content:   "# Overview\n\n```go\ntype CacheManager struct {}\n```\n",
			docPath:   "docs/cache.md",
			wantNames: []string{"CacheManager"},
			wantCats: map[string]string{
				"CacheManager": "architecture",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := ExtractConceptsFromHeadings(tt.content, tt.docPath, "")
			got := make([]string, 0, len(out))
			for _, c := range out {
				got = append(got, c.ConceptName)
			}
			assert.Equal(t, tt.wantNames, got)
			for name, cat := range tt.wantCats {
				for _, c := range out {
					if c.ConceptName == name {
						assert.Equal(t, cat, c.Category, "category of %s", name)
					}
				}
			}

			if !strings.HasPrefix(tt.name, "markdown with headings") {
				for _, c := range out {
					assert.Contains(t, c.Tags, "physical")
					assert.Contains(t, c.SubTopics, "physical_symbol")
				}
			}
		})
	}
}

func TestHorizontalRuleNotFrontmatter(t *testing.T) {
	body := "---\n\n# 标题\n\n这是两个分割线之间的正文，绝不能被当 frontmatter 吞掉。\n\n---\n\n分割线之后的正文。\n"
	res := ExtractConceptManifest(body, "docs/x.md")
	assert.False(t, res.HasFrontmatter, "HR 开头的文档不得误报 frontmatter")
	assert.Contains(t, res.CleanContent, "绝不能被当 frontmatter 吞掉", "HR 之间的正文必须保留")
	assert.Contains(t, res.CleanContent, "分割线之后的正文", "后续正文必须保留")

	real := "---\nsummary: 真摘要\nconcepts:\n  - name: 概念A\n---\n\n正文。\n"
	res2 := ExtractConceptManifest(real, "docs/y.md")
	assert.True(t, res2.HasFrontmatter, "真 frontmatter 必须仍然识别")
	assert.Equal(t, "真摘要", res2.Summary)
	assert.NotContains(t, res2.CleanContent, "summary:")
}

func TestLooksLikeYamlAttempt(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected bool
	}{
		{name: "summary with broken unclosed quote", input: `summary: 损坏的 yaml "未闭合`, expected: true},
		{name: "quoted summary key", input: `"summary": 损坏的 yaml`, expected: true},
		{name: "single-quoted title key", input: `'title': 损坏的 yaml`, expected: true},
		{name: "concepts broken mapping", input: "concepts:\n  - broken: :", expected: true},
		{name: "quizzes broken", input: "quizzes:\n  - broken", expected: true},
		{name: "takeaways broken", input: "takeaways:\n  - broken", expected: true},
		{name: "json array start", input: `[{"some": "json"}`, expected: true},
		{name: "json object start", input: `{"some": "json"}`, expected: true},
		{name: "json with leading whitespace", input: "  \n  {\"some\": \"json\"}", expected: true},
		{name: "prose with note", input: "Note: this is just a note", expected: false},
		{name: "prose with warning", input: "Warning: be careful with this step", expected: false},
		{name: "prose with chapter title", input: "Chapter 1: Introduction to Architecture", expected: false},
		{name: "prose without colon", input: "plain prose without any colon", expected: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, looksLikeYamlAttempt(tt.input))
		})
	}
}

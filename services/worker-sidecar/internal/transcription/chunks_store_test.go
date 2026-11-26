package transcription

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

func TestResolveHeadingPath(t *testing.T) {
	tests := []struct {
		name        string
		heading     string
		headingPath string
		docPath     string
		expected    string
	}{
		{
			name:        "显式 headingPath 优先",
			heading:     "Intro",
			headingPath: "H1 > H2",
			docPath:     "docs/a.md",
			expected:    "H1 > H2",
		},
		{
			name:     "缺省回落 path#heading",
			heading:  "Intro",
			docPath:  "docs/a.md",
			expected: "docs/a.md#Intro",
		},
		{
			name:     "无 docPath 时回落裸 heading",
			heading:  "Intro",
			expected: "Intro",
		},
		{
			name:     "path 标记提取（read_section 代码块寻址依赖）",
			heading:  "📄 `src/index.ts` <!-- path: src/index.ts -->",
			docPath:  "docs/a.md",
			expected: "src/index.ts",
		},
		{
			name:     "📄 前缀回落 docPath",
			heading:  "📄 `src/index.ts`",
			docPath:  "docs/a.md",
			expected: "docs/a.md",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, resolveHeadingPath(tt.heading, tt.headingPath, tt.docPath))
		})
	}
}

func TestResolveVersionLabel(t *testing.T) {
	tests := []struct {
		name         string
		semVerLabel  string
		branch       string
		defaultBrand string
		expected     string
	}{
		{name: "semVerLabel 优先", semVerLabel: "v2.1.0", branch: "dev", defaultBrand: "main", expected: "v2.1.0"},
		{name: "非默认分支兜底", branch: "dev", defaultBrand: "main", expected: "dev"},
		{name: "默认分支不落版本", branch: "main", defaultBrand: "main", expected: ""},
		{name: "全空", expected: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, resolveVersionLabel(tt.semVerLabel, tt.branch, tt.defaultBrand))
		})
	}
}

func TestBuildChunkInsertBatch(t *testing.T) {
	rows := []storedChunkRow{
		{heading: "Intro", headingPath: "docs/a.md#Intro", contentType: "prose", content: "text-1", order: 0},
		{heading: "", headingPath: "", contentType: "code", content: "```go\nx()\n```", order: 1},
	}
	query, args := buildChunkInsertBatch("doc-1", rows, "v2.1.0", 0)

	t.Run("列清单与 TS raw INSERT 逐字对齐", func(t *testing.T) {
		require.True(t, strings.HasPrefix(query, `INSERT INTO "DocumentChunk" ("id", "documentId", "heading", "headingPath", "contentType", "content", "order", "updatedAt", "semVerLabel") VALUES `))
	})
	t.Run("id 在 SQL 内生成（searchVector 生成列绝不出现）", func(t *testing.T) {
		assert.Contains(t, query, "gen_random_uuid()::text")
		assert.NotContains(t, query, "searchVector")
		assert.NotContains(t, query, "createdAt")
	})
	t.Run("每行 7 参 × 行数，占位符连续", func(t *testing.T) {
		require.Len(t, args, 14)
		assert.Equal(t, "doc-1", args[0])
		assert.Equal(t, "doc-1", args[7])
		assert.Equal(t, nil, args[7+1], "空 heading 落 NULL")
		assert.Equal(t, 1, args[7+5], "order 为批内全局序")
		assert.Equal(t, "v2.1.0", args[13])
	})
	t.Run("批内 order 起点平移（第二批从 100 续编）", func(t *testing.T) {
		_, args2 := buildChunkInsertBatch("doc-1", rows[:1], "", 100)
		assert.Equal(t, 100, args2[5])
		assert.Equal(t, nil, args2[6], "空版本标签落 NULL")
	})
}

func TestChunkContentTypeResolution(t *testing.T) {
	tests := []struct {
		name          string
		chunk         chunker.MarkdownChunk
		docPath       string
		blueprintRole string
		expectedCT    string
	}{
		{
			name: "保留既有 ContentType（不被 ClassifyChunk 覆盖）",
			chunk: chunker.MarkdownChunk{
				Heading:     "架构总览",
				Content:     "这是系统架构说明...",
				ContentType: "architecture_diagram",
			},
			docPath:    "docs/arch.md",
			expectedCT: "architecture_diagram",
		},
		{
			name: "保留代码课时 entry_point 标记",
			chunk: chunker.MarkdownChunk{
				Heading:     "main 入口",
				Content:     "package main\nfunc main() {}",
				ContentType: "entry_point",
			},
			docPath:    "chapters/01-main.mdx",
			expectedCT: "entry_point",
		},
		{
			name: "既有 ContentType 为空时回退 ClassifyChunk（代码块）",
			chunk: chunker.MarkdownChunk{
				Heading:     "代码实现",
				Content:     "```go\nfunc main() {}\n```",
				ContentType: "",
			},
			docPath:    "docs/arch.md",
			expectedCT: "code",
		},
		{
			name: "既有 ContentType 为空且有空白时回退 ClassifyChunk（散文）",
			chunk: chunker.MarkdownChunk{
				Heading:     "说明",
				Content:     "普通文字描述段落",
				ContentType: "   ",
			},
			docPath:    "docs/arch.md",
			expectedCT: "prose",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hp := resolveHeadingPath(tt.chunk.Heading, derefStrPtr(tt.chunk.HeadingPath), tt.docPath)
			ct := strings.TrimSpace(tt.chunk.ContentType)
			if ct == "" {
				ct = chunker.ClassifyChunk(tt.chunk.Content, hp, tt.blueprintRole)
			}
			assert.Equal(t, tt.expectedCT, ct)
		})
	}
}

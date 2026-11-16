package ogis

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestExtractContextSnippetNoQuery(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "剥离文档起始 frontmatter",
			input: "---\ntitle: T\n---\n\n正文内容开始",
			want:  "正文内容开始",
		},
		{
			name:  "整段 fenced 代码块清除",
			input: "前文\n```bash\nnpm install next\n```\n后文",
			want:  "前文 后文",
		},
		{
			name:  "行内代码与 HTML 注释清除",
			input: "使用 `next` 启动 <!-- note --> 服务",
			want:  "使用 启动 服务",
		},
		{
			name:  "图片清除、链接保留锚文本",
			input: "见 ![logo](https://x/l.png) 与 [文档](https://x/d)",
			want:  "见 与 文档",
		},
		{
			name:  "标题标记与粗斜体剥除（对齐 Node：前缀类吃掉开栏 ** 后剩单个 *）",
			input: "## **重要** 章节\n\n*强调* 与 __下划线__",
			want:  "重要* 章节 强调 与 下划线",
		},
		{
			name:  "超过 160 字符截断加省略号",
			input: "x" + strings.Repeat("a", 200),
			want:  "x" + strings.Repeat("a", 159) + "...",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, extractContextSnippetNoQuery(tt.input, 160))
		})
	}
}

func TestStripFencedBlocks(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "成对 ``` 围栏整块清除",
			input: "a\n```go\nfmt.Println(1)\n```\nb",
			want:  "a\n \nb",
		},
		{
			name:  "成对 ~~~ 围栏清除（缩进 ≤3 空格）",
			input: "a\n   ~~~\ncode\n   ~~~\nb",
			want:  "a\n \nb",
		},
		{
			name:  "未闭合围栏：整块保留原样（JS 非贪婪语义，残留反引号由标点剥除清理）",
			input: "a\n```\nunclosed",
			want:  "a\n```\nunclosed",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, StripFencedBlocks(tt.input))
		})
	}
}

func TestCleanMarkdownForSnippetFenceAwareCommentStripping(t *testing.T) {
	// 讲解 HTML 注释的文档：注释剥离必须在围栏剥离之后，
	// 否则跨两个围栏的 <!-- ... --> 会被错配吞掉中间正文。
	doc := "前文。\n\n```html\n<!-- 未闭合注释示例\n```\n\n中间正文必须保留。\n\n```html\n结束 -->\n```\n\n后文。"
	out := CleanMarkdownForSnippet(doc)
	assert.Contains(t, out, "前文")
	assert.Contains(t, out, "中间正文必须保留")
	assert.Contains(t, out, "后文")
}

func TestCleanMarkdownForSnippetUnclosedFencesNotMispaired(t *testing.T) {
	// 两个未闭合围栏：行内 tick 二次配对不得跨行吞掉两栏之间的正文。
	doc := "```js\nconst a = 1;\n\n中间正文必须保留。\n\n```python\nx = 2\n"
	out := CleanMarkdownForSnippet(doc)
	assert.Contains(t, out, "中间正文必须保留")
}

package chapter

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// chapterMapLinkPattern URL 捕获回归：CommonMark 允许 URL 内一层平衡括号
// （Wikipedia/MDN 链接），旧模式 `[^)"'\r\n]+` 会在首个 ')' 截断。
func TestChapterMapLinkPatternURLCapture(t *testing.T) {
	tests := []struct {
		name  string
		line  string
		want  string
		match bool
	}{
		{
			name:  "普通相对链接",
			line:  "- [Intro](docs/intro.md)",
			want:  "docs/intro.md",
			match: true,
		},
		{
			name:  "带平衡括号的 Wikipedia URL 不截断",
			line:  "- [Go](https://en.wikipedia.org/wiki/Go_(programming_language))",
			want:  "https://en.wikipedia.org/wiki/Go_(programming_language)",
			match: true,
		},
		{
			name:  "URL 带 title 不吞入捕获",
			line:  "- [Go](docs/go.md \"Go 指南\")",
			want:  "docs/go.md",
			match: true,
		},
		{
			name:  "尖括号 URL（含空格）",
			line:  "- [X](<my file.md>)",
			want:  "my file.md",
			match: true,
		},
		{
			name:  "裸文本不匹配",
			line:  "普通正文一行",
			match: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := chapterMapLinkPattern.FindStringSubmatch(tt.line)
			if !tt.match {
				assert.Nil(t, m)
				return
			}
			if assert.NotNil(t, m) {
				url := m[1]
				if url == "" {
					url = m[2]
				}
				assert.Equal(t, tt.want, strings.TrimSpace(url))
			}
		})
	}
}

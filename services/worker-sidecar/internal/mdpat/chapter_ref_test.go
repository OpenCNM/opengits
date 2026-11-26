package mdpat_test

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func TestFindChapterRefs(t *testing.T) {
	t.Helper()
	tests := []struct {
		name     string
		input    string
		expected []int
	}{
		{name: "无引用", input: "本章介绍调度器的整体结构。", expected: nil},
		{name: "中文章号", input: "如第 12 章所述的架构。", expected: []int{12}},
		{name: "中文课号", input: "回顾第3课的内容。", expected: []int{3}},
		{name: "英文章号", input: "As shown in Chapter 7, the router dispatches.", expected: []int{7}},
		{name: "按出现顺序保留重复", input: "第 1 章与 Chapter 2，再回到第 1 章。", expected: []int{1, 2, 1}},
		{name: "小节不是章", input: "见第 4 节与第 9 部分。", expected: nil},
		{name: "空文本", input: "", expected: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, mdpat.FindChapterRefs(tt.input))
		})
	}
}

func TestTruncateRunes(t *testing.T) {
	t.Helper()
	cjk := strings.Repeat("章", 10)
	tests := []struct {
		name     string
		input    string
		max      int
		ellipsis string
		expected string
	}{
		{name: "未超长原样返回", input: cjk, max: 10, ellipsis: "…", expected: cjk},
		{name: "按字符而非字节截断", input: cjk, max: 4, ellipsis: "…", expected: strings.Repeat("章", 4) + "…"},
		{name: "max 为零不截断", input: cjk, max: 0, ellipsis: "…", expected: cjk},
		{name: "max 为负不截断", input: cjk, max: -1, ellipsis: "…", expected: cjk},
		{name: "ASCII 同样适用", input: "abcdef", max: 3, ellipsis: "", expected: "abc"},
		{name: "空串", input: "", max: 3, ellipsis: "…", expected: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mdpat.TruncateRunes(tt.input, tt.max, tt.ellipsis)
			assert.Equal(t, tt.expected, got)
			assert.True(t, utf8.ValidString(got), "截断结果必须是合法 UTF-8")
		})
	}
}

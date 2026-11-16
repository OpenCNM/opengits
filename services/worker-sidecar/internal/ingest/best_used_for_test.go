package ingest

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 1.3.6.1 bestUsedFor 解析（自 TS best-used-for.test 移植，2026-11 收口）：
// 伴生产物 ≥2 条有效优先透传，否则确定性模板兜底（零 LLM）。
func TestResolveBestUsedFor(t *testing.T) {
	t.Helper()

	withStack := &envelopeRepoProfile{CodebaseProfile: &codebaseProfileEnvelope{
		Framework:        "Next.js",
		PrimaryLanguages: []string{"TypeScript", "JavaScript"},
	}}

	tests := []struct {
		name       string
		fromDraft  []string
		provided   *envelopeRepoProfile
		owner      string
		repo       string
		want       []string
		wantNotice string
	}{
		{
			name:      "伴生产物 ≥2 条有效：修剪空串/重复后优先透传",
			fromDraft: []string{"深入理解调度机制", "查阅模块演进", "", "   ", "深入理解调度机制"},
			want:      []string{"深入理解调度机制", "查阅模块演进"},
		},
		{
			name:      "伴生产物仅 1 条有效：不足采信门槛，模板兜底",
			fromDraft: []string{"唯一一条"},
			provided:  withStack,
			owner:     "vercel",
			repo:      "next.js",
			want: []string{
				"学习 vercel/next.js 的Next.js (TypeScript/JavaScript)架构设计与核心概念",
				"参考 next.js 的代码示例与 API 使用方法",
				"了解 vercel/next.js 的模块结构与项目配置",
			},
		},
		{
			name:  "无伴生产物且无栈信息：无栈模板兜底（不编造 specifics）",
			owner: "o",
			repo:  "r",
			want: []string{
				"学习 o/r 的核心架构设计与基本概念",
				"参考 r 的代码示例与 API 使用方法",
				"了解 o/r 的模块结构与项目配置",
			},
		},
		{
			name:      "超 4 条伴生产物：截断至 4 条",
			fromDraft: []string{"a", "b", "c", "d", "e"},
			want:      []string{"a", "b", "c", "d"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveBestUsedFor(tt.fromDraft, tt.provided, tt.owner, tt.repo)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestSanitizeOutlineBestUsedFor(t *testing.T) {
	require.Equal(t, []string{}, SanitizeOutlineBestUsedFor(nil))
	require.Equal(t, []string{}, SanitizeOutlineBestUsedFor([]string{"", "  "}))
	// 单条超长截断 120 字
	long := strings.Repeat("x", 200)
	got := SanitizeOutlineBestUsedFor([]string{long})
	require.Len(t, got, 1)
	require.Len(t, got[0], 120)
}

package transcription

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 接力契约对拍锚点：本表与 apps/client tests/unit/relay-contract.test.ts
// 逐向量镜像——两侧任何骨架/阈值语义变更必须同步（编译器与硬门的
// 单一语义契约）。

func relaySampleOutput() RelayTranscription {
	var obj RelayTranscription
	obj.Title = "本章标题"
	obj.Sections = []RelaySection{
		{Type: "intro", Heading: "导语", Content: "这是导语内容。"},
		{Type: "prose", Heading: "概念", Content: "讲解内容。"},
		{Type: "code", Heading: "示例", Content: "```ts\nconst a = 1;\n```"},
		{Type: "summary", Heading: "小结", Content: "本章要点。"},
	}
	obj.ConceptAnchors = []RelayConceptAnchor{{Term: "agent loop", Translation: "智能体循环"}}
	obj.Coverage.SourceSections, obj.Coverage.CoveredSections = 4, 4
	return obj
}

func relaySampleSource(codeBlocks, headings int) string {
	var parts []string
	for i := 0; i < headings; i++ {
		parts = append(parts, "# 标题"+itoa(i)+"\n\n"+strings.Repeat("正文内容。", 16))
	}
	for i := 0; i < codeBlocks; i++ {
		parts = append(parts, "```ts\nconst x = 1;\n```")
	}
	return strings.Join(parts, "\n\n")
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func relayGateDefaults() relayGateThresholds {
	return relayGateThresholds{CodeBlockRetention: 0.9, HeadingCoverage: 0.7, LengthRatioMin: 0.4, LengthRatioMax: 3}
}

func TestCompileRelayMdxSkeleton(t *testing.T) {
	tests := []struct {
		name   string
		obj    RelayTranscription
		checks func(t *testing.T, mdx string)
	}{
		{
			name: "骨架固定：H1=title，intro 直排，其余段 ##，锚点尾注",
			obj:  relaySampleOutput(),
			checks: func(t *testing.T, mdx string) {
				lines := strings.Split(mdx, "\n")
				require.NotEmpty(t, lines)
				assert.Equal(t, "# 本章标题", lines[0])
				assert.Contains(t, mdx, "这是导语内容。")
				assert.Contains(t, mdx, "## 概念")
				assert.Contains(t, mdx, "## 示例")
				assert.Contains(t, mdx, "## 小结")
				assert.Contains(t, mdx, "<!-- relay-anchors: agent loop=智能体循环 -->")
				// H1 恰 1（行首锚定），## 恰 3
				assert.Equal(t, 1, countLinesStartingWith(mdx, "# "))
				assert.Equal(t, 3, countLinesStartingWith(mdx, "## "))
			},
		},
		{
			name: "无锚点时不输出尾注",
			obj:  RelayTranscription{Title: "T", Sections: relaySampleOutput().Sections},
			checks: func(t *testing.T, mdx string) {
				assert.NotContains(t, mdx, "relay-anchors")
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.checks(t, compileRelayMdx(tt.obj))
		})
	}
}

func countLinesStartingWith(s, prefix string) int {
	n := 0
	for _, l := range strings.Split(s, "\n") {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

func TestRelayGate(t *testing.T) {
	g := relayGateDefaults()

	t.Run("健康译文通过（代码块全保 + 标题覆盖 + 长度带宽内）", func(t *testing.T) {
		src := relaySampleSource(3, 4)
		mdxParts := []string{"# 译文标题", "导语内容。"}
		for i := 0; i < 4; i++ {
			mdxParts = append(mdxParts, "## 译节"+itoa(i)+"\n\n"+strings.Repeat("讲解正文。", 16))
		}
		for i := 0; i < 3; i++ {
			mdxParts = append(mdxParts, "## 示例\n\n```ts\nconst x = 1;\n```")
		}
		r := relayGate(g, strings.Join(mdxParts, "\n\n"), src)
		assert.True(t, r.Passed, "healthy relay must pass, got: %s", r.Reason)
	})

	t.Run("代码块丢失拒绝", func(t *testing.T) {
		src := relaySampleSource(6, 4)
		mdx := "# 译\n\n## 节\n\n" + strings.Repeat("正文内容。", 60) + "\n\n```ts\nconst a=1;\n```"
		r := relayGate(g, mdx, src)
		assert.False(t, r.Passed)
		assert.Contains(t, r.Reason, "代码块丢失")
	})

	t.Run("小节覆盖不足拒绝（源标题多、译文整段吞并）", func(t *testing.T) {
		src := relaySampleSource(0, 20)
		mdx := "# 译\n\n## 唯一一节\n\n" + strings.Repeat("正文内容。", 80)
		r := relayGate(g, mdx, src)
		assert.False(t, r.Passed)
		assert.Contains(t, r.Reason, "小节覆盖不足")
	})

	t.Run("长度带宽：过瘦拒绝、过胖拒绝", func(t *testing.T) {
		src := relaySampleSource(0, 2) // 标题 ≤2 跳过覆盖检查，聚焦长度
		thin := "# 译\n\n## 节\n\n" + strings.Repeat("短内容。", 12)
		assert.Contains(t, relayGate(g, thin, src).Reason, "长度仅为源文")
		fat := "# 译\n\n## 节\n\n" + strings.Repeat("灌水内容。", 2000)
		assert.Contains(t, relayGate(g, fat, src).Reason, "倍")
	})

	t.Run("源缺失 / 译文过短直接拒绝", func(t *testing.T) {
		assert.Contains(t, relayGate(g, strings.Repeat("# 译\n\n## 节\n\n足够长的正文内容", 5), "").Reason, "源文件缺失")
		assert.Contains(t, relayGate(g, "短", relaySampleSource(3, 4)).Reason, "译文过短")
	})

	t.Run("Unicode字符数而非字节数计算长度比例（中文源文+英文译文不被误拒）", func(t *testing.T) {
		// 中文源文：100字符（300字节）。英文译文：80字符（80字节）。
		// 字符比例: 80/100 = 0.8 (通过: 0.4 <= 0.8 <= 3.0)
		// 若按字节计算: 80/300 = 0.266 (< 0.4 会被误拒为"译文长度仅为源文 26%")
		src := "# 标题\n\n" + strings.Repeat("中", 94)    // 总共 100 runes
		mdx := "# Title\n\n" + strings.Repeat("a", 72) // 80 runes (>= 50 runes)
		res := relayGate(g, mdx, src)
		assert.True(t, res.Passed, "utf8 rune-based ratio should pass, got: %s", res.Reason)
	})
}

func TestCountCodeBlocksFences(t *testing.T) {
	assert.Equal(t, 3, countCodeBlocks("```ts\na\n```\n```ts\nb\n```\n```ts\nc\n```"))
	assert.Equal(t, 1, countCodeBlocks("    indented code\n    more")) // 缩进式兜底计 1
	assert.Equal(t, 0, countCodeBlocks("plain text only"))
	// 不平衡围栏向上取整（容错）
	assert.Equal(t, 2, countCodeBlocks("```\na\n```\n```\nb"))
}

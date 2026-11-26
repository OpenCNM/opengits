package mdpat

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestIsRunRecordDump_TableDriven(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected bool
	}{
		{name: "UUID 命名的 txt 转储", input: "records/track_3_optimization/results/20260501_contra_muon/08cd60f9-99e2-4e28-b1ac-19136dd42a05.txt", expected: true},
		{name: "大写 UUID txt", input: "08CD60F9-99E2-4E28-B1AC-19136DD42A05.txt", expected: true},
		{name: "md5 散列 txt", input: "benchmarks/d4bfb25f688d4da587433926fad4842.txt", expected: true},
		{name: "sha256 散列 out", input: "evals/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2.out", expected: true},
		{name: "任意路径 .log 恒转储", input: "var/log/train.log", expected: true},
		{name: "requirements.txt 是配置非转储", input: "records/track_3_optimization/results/20260506_trustlight/requirements.txt", expected: false},
		{name: "README.md 是文档", input: "records/track_1_short/2025-01-16_Sub3Min/README.md", expected: false},
		{name: "UUID 命名的 md 不按转储处理", input: "notes/08cd60f9-99e2-4e28-b1ac-19136dd42a05.md", expected: false},
		{name: "短十六进制名不误伤", input: "docs/abc.txt", expected: false},
		{name: "下划线命名的人类可读 txt 不误伤", input: "evals/20260506_trustlight.txt", expected: false},
		{name: "空路径", input: "", expected: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, IsRunRecordDump(tt.input))
		})
	}
}

func TestUsableChapterH1_TableDriven(t *testing.T) {
	tests := []struct {
		name       string
		title      string
		requireCJK bool
		expected   bool
	}{
		{name: "中文教学标题", title: "NanoGPT 速通优化器对比", requireCJK: true, expected: true},
		{name: "含 CJK 的中英混排", title: "Snoo 优化器：用前瞻动量省下 60 步训练时间", requireCJK: true, expected: true},
		{name: "纯英文行在中文讲法下拦截", title: "Update Smoothing + Snoo", requireCJK: true, expected: false},
		{name: "纯英文行在英文讲法下放行", title: "Update Smoothing + Snoo", requireCJK: false, expected: true},
		{name: "显著性统计行 p=0.0049 拦截", title: "p=0.0049", requireCJK: false, expected: false},
		{name: "纯百分比拦截", title: "99.2%", requireCJK: false, expected: false},
		{name: "纯数字拦截", title: "3.28", requireCJK: false, expected: false},
		{name: "含 # 代码引用拦截", title: "Record #360's FA3 build", requireCJK: false, expected: false},
		{name: "英文代码注释行在中文讲法下拦截", title: "nvrtc needs the CUDA headers; CUDA_HOME is what torch uses", requireCJK: true, expected: false},
		{name: "单字符拦截", title: "A", requireCJK: false, expected: false},
		{name: "空串拦截", title: "", requireCJK: false, expected: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, UsableChapterH1(tt.title, tt.requireCJK))
		})
	}
}

func TestRequireCJKTitle(t *testing.T) {
	tests := []struct {
		lang     string
		expected bool
	}{
		{lang: "", expected: true},
		{lang: "zh-CN", expected: true},
		{lang: "zh", expected: true},
		{lang: "ja", expected: true},
		{lang: "ko", expected: true},
		{lang: "en", expected: false},
		{lang: "en-US", expected: false},
	}

	for _, tt := range tests {
		name := tt.lang
		if name == "" {
			name = "(empty)"
		}
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, tt.expected, RequireCJKTitle(tt.lang))
		})
	}
}

func TestFirstAtxHeading_TableDriven(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "普通 H1",
			input:    "# Sub-3 Minute Record\n\n正文内容",
			expected: "Sub-3 Minute Record",
		},
		{
			name:     "尾部 # 装饰剥离",
			input:    "# New Record #\n",
			expected: "New Record",
		},
		{
			name:     "围栏代码块内的伪 H1 不命中",
			input:    "```python\n# this is a comment\n```\n\n# Real Title",
			expected: "Real Title",
		},
		{
			name:     "波浪线围栏内的伪 H1 不命中",
			input:    "~~~\n# fenced fake\n~~~\n# Real",
			expected: "Real",
		},
		{
			name:     "frontmatter 内的 YAML 注释不命中",
			input:    "---\ntitle: x\n# yaml comment\n---\n# Actual Title",
			expected: "Actual Title",
		},
		{
			name:     "强调符包裹剥离",
			input:    "# **Bold Title**",
			expected: "Bold Title",
		},
		{
			name:     "反引号包裹剥离",
			input:    "# `Code Title`",
			expected: "Code Title",
		},
		{
			name:     "仅 H2 无 H1 返回空",
			input:    "## Section Only\n正文",
			expected: "",
		},
		{
			name:     "裸 # 空标题继续扫描",
			input:    "#\n# Real Title",
			expected: "Real Title",
		},
		{
			name:     "无标题文档返回空",
			input:    "plain text without headings",
			expected: "",
		},
		{
			name:     "缩进 3 空格内的合法 H1",
			input:    "   # Indented Title",
			expected: "Indented Title",
		},
		{
			name:     "超长 H1 截断到 80 runes",
			input:    "# " + strings.Repeat("x", 120),
			expected: strings.Repeat("x", 80),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, FirstAtxHeading(tt.input))
		})
	}
}

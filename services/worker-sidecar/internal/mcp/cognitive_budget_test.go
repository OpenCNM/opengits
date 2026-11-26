package mcp

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ptrFloat(f float64) *float64 {
	return &f
}

func TestEstimateTokens_Parity(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		expected int
	}{
		{
			name:     "empty string",
			text:     "",
			expected: 0,
		},
		{
			name:     "ascii english sentence",
			text:     "Hello, world! This is a fast token counter test with 12345 numbers and symbols: []{}.",
			expected: 22,
		},
		{
			name:     "cjk chinese text",
			text:     "这是一个针对大语言模型的快速 Token 计数器，专门优化了 CJK 字符估算精度。",
			expected: 40,
		},
		{
			name:     "cjk japanese kana and kanji",
			text:     "こんにちは世界。日本語のトークンカウンターのテストです。ひらがな、カタカナ、漢字。",
			expected: 49,
		},
		{
			name:     "cjk korean hangul",
			text:     "안녕하세요 세계. 한국어 토큰 계산기 테스트입니다. 한글 자모와 완성형.",
			expected: 41,
		},
		{
			name:     "mixed cjk and ascii",
			text:     "OpenGits 知识库构建引擎使用 Go worker-sidecar 承载高密计算，消除 Node.js 内存开销。",
			expected: 38,
		},
		{
			name:     "emojis and astral symbols",
			text:     "AI 智能体开发 🚀 探索未知领域 🌟 编程语言：Go 🐹 & TS 🦕 ~!@#",
			expected: 27,
		},
		{
			name:     "code block with indentation",
			text:     "```go\nfunc add(a, b int) int {\n\treturn a + b\n}\n```",
			expected: 13,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EstimateTokens(tt.text)
			assert.Equal(t, tt.expected, got, "case %s: EstimateTokens token count mismatch", tt.name)
		})
	}
}

func TestEstimateTokens_ZeroAlloc(t *testing.T) {
	sample := "OpenGits 知识库构建引擎使用 Go worker-sidecar 承载高密计算，消除 Node.js 内存开销。"
	allocs := testing.AllocsPerRun(1000, func() {
		_ = EstimateTokens(sample)
	})
	assert.Equal(t, float64(0), allocs, "EstimateTokens must have zero heap allocations")
}

func TestTokenCounterGoldenParity(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/token-counter.golden.json")
	require.NoError(t, err, "token-counter.golden.json missing")

	var fixture struct {
		EstimateCases []struct {
			Name  string `json:"name"`
			Input struct {
				Text string `json:"text"`
			} `json:"input"`
			Expected int `json:"expected"`
		} `json:"estimateCases"`
		TruncateCases []struct {
			Name  string `json:"name"`
			Input struct {
				Text      string  `json:"text"`
				MaxTokens int     `json:"maxTokens"`
				Suffix    *string `json:"suffix"`
			} `json:"input"`
			Expected string `json:"expected"`
		} `json:"truncateCases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))

	t.Run("EstimateTokens 数值对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.EstimateCases)
		for _, tc := range fixture.EstimateCases {
			t.Run(tc.Name, func(t *testing.T) {
				got := EstimateTokens(tc.Input.Text)
				assert.Equal(t, tc.Expected, got, "case %s: EstimateTokens 数值不一致", tc.Name)
			})
		}
	})

	t.Run("TruncateWithSuffix 逐字对拍", func(t *testing.T) {
		require.NotEmpty(t, fixture.TruncateCases)
		for _, tc := range fixture.TruncateCases {
			t.Run(tc.Name, func(t *testing.T) {
				suffix := DefaultTruncateSuffix
				if tc.Input.Suffix != nil {
					suffix = *tc.Input.Suffix
				}
				got := TruncateWithSuffix(tc.Input.Text, tc.Input.MaxTokens, suffix)
				assert.Equal(t, tc.Expected, got, "case %s: TruncateWithSuffix 逐字不一致", tc.Name)
			})
		}
	})
}

func TestResolveCognitiveBudget_Precedence(t *testing.T) {
	tests := []struct {
		name         string
		quota        UserQuota
		policyBudget int
		userBudget   *float64
		expected     int
	}{
		{
			name:         "all unset defaults to 4000",
			quota:        UserQuota{Role: "USER", TokenCap: 0},
			policyBudget: 0,
			userBudget:   nil,
			expected:     4000,
		},
		{
			name:         "user quota cap only",
			quota:        UserQuota{Role: "USER", TokenCap: 2000},
			policyBudget: 0,
			userBudget:   nil,
			expected:     2000,
		},
		{
			name:         "policy budget lower than quota takes policy",
			quota:        UserQuota{Role: "USER", TokenCap: 5000},
			policyBudget: 3000,
			userBudget:   nil,
			expected:     3000,
		},
		{
			name:         "user requested budget lower than both takes user budget",
			quota:        UserQuota{Role: "USER", TokenCap: 5000},
			policyBudget: 3000,
			userBudget:   ptrFloat(1500),
			expected:     1500,
		},
		{
			name:         "policy budget lower than user budget takes policy",
			quota:        UserQuota{Role: "USER", TokenCap: 8000},
			policyBudget: 2000,
			userBudget:   ptrFloat(4000),
			expected:     2000,
		},
		{
			name:         "admin role relaxes cap to 32000",
			quota:        UserQuota{Role: "ADMIN", TokenCap: 0},
			policyBudget: 0,
			userBudget:   nil,
			expected:     32000,
		},
		{
			name:         "super admin role relaxes cap to 32000",
			quota:        UserQuota{Role: "SUPER_ADMIN", TokenCap: 1000},
			policyBudget: 0,
			userBudget:   nil,
			expected:     32000,
		},
		{
			name:         "admin with policy budget takes policy if smaller",
			quota:        UserQuota{Role: "ADMIN", TokenCap: 0},
			policyBudget: 8000,
			userBudget:   nil,
			expected:     8000,
		},
		{
			name:         "quota below 256 clamped to 256",
			quota:        UserQuota{Role: "USER", TokenCap: 100},
			policyBudget: 0,
			userBudget:   nil,
			expected:     256,
		},
		{
			name:         "user budget below 256 clamped to 256",
			quota:        UserQuota{Role: "USER", TokenCap: 4000},
			policyBudget: 2000,
			userBudget:   ptrFloat(50),
			expected:     256,
		},
		{
			name:         "negative user budget ignored",
			quota:        UserQuota{Role: "USER", TokenCap: 2000},
			policyBudget: 3000,
			userBudget:   ptrFloat(-100),
			expected:     2000,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveCognitiveBudget(tt.quota, tt.policyBudget, tt.userBudget)
			assert.Equal(t, tt.expected, got, "case %s: budget resolution mismatch", tt.name)
		})
	}
}

func TestSyntaxArmor_CodeFencesAndHtmlComments(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "already balanced markdown untouched",
			input:    "# Title\n\n```go\nfmt.Println(1)\n```\n\nDone.",
			expected: "# Title\n\n```go\nfmt.Println(1)\n```\n\nDone.",
		},
		{
			name:     "unclosed 3-backtick fence",
			input:    "```go\nfmt.Println(1)",
			expected: "```go\nfmt.Println(1)\n```\n\n",
		},
		{
			name:     "unclosed 4-backtick fence",
			input:    "````markdown\n```go\ncode\n```",
			expected: "````markdown\n```go\ncode\n```\n```\n\n",
		},
		{
			name:     "unclosed tilde fence",
			input:    "~~~bash\necho hello",
			expected: "~~~bash\necho hello\n```\n\n",
		},
		{
			name:     "unclosed html comment",
			input:    "# Section\n<!-- unfinished note",
			expected: "# Section\n<!-- unfinished note -->\n\n",
		},
		{
			name:     "unclosed inline backtick on last line",
			input:    "Here is `some variable",
			expected: "Here is `some variable`",
		},
		{
			name:     "already closed inline backticks on last line untouched",
			input:    "Here is `var1` and `var2`",
			expected: "Here is `var1` and `var2`",
		},
		{
			name:     "inline backtick after closed code block",
			input:    "```ts\nconst x = 1;\n```\nRun `npm test",
			expected: "```ts\nconst x = 1;\n```\nRun `npm test`",
		},
		{
			name:     "both unclosed code fence and html comment",
			input:    "<!-- note\n```python\nprint(1)",
			expected: "<!-- note\n```python\nprint(1)\n```\n\n -->\n\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := BalanceMarkdownSyntax(tt.input)
			assert.Equal(t, tt.expected, got, "case %s: balanced syntax mismatch", tt.name)
		})
	}
}

func TestCognitiveNavigationAnchors(t *testing.T) {
	tests := []struct {
		name               string
		toolName           string
		target             string
		origTokens         int
		showTokens         int
		expectedSubstrings []string
	}{
		{
			name:       "read tool with doc target",
			toolName:   "read",
			target:     "README.md",
			origTokens: 1000,
			showTokens: 200,
			expectedSubstrings: []string{
				"[Showing ~200 of ~1000 tokens (20%)]",
				`"outline"`,
				`target="README.md#heading"`,
				`"start_line"`,
				`"end_line"`,
			},
		},
		{
			name:       "read tool with section target",
			toolName:   "read",
			target:     "README.md#Usage",
			origTokens: 500,
			showTokens: 100,
			expectedSubstrings: []string{
				"[Showing ~100 of ~500 tokens (20%)]",
				`"outline"`,
				`target="path#heading"`,
				`"start_line"`,
				`"end_line"`,
			},
		},
		{
			name:       "read_document facade",
			toolName:   "read_document",
			target:     "",
			origTokens: 2000,
			showTokens: 500,
			expectedSubstrings: []string{
				"[Showing ~500 of ~2000 tokens (25%)]",
				`"outline"`,
				`target="path#heading"`,
				`"start_line"`,
				`"end_line"`,
			},
		},
		{
			name:       "outline tool",
			toolName:   "outline",
			target:     "",
			origTokens: 4000,
			showTokens: 1000,
			expectedSubstrings: []string{
				"[Showing ~1000 of ~4000 tokens (25%)]",
				`path="path/to/doc.md"`,
				`"search"`,
			},
		},
		{
			name:       "search tool",
			toolName:   "search",
			target:     "",
			origTokens: 3000,
			showTokens: 600,
			expectedSubstrings: []string{
				"[Showing ~600 of ~3000 tokens (20%)]",
				`filter="exact"`,
				`mode="title"`,
			},
		},
		{
			name:       "explore_concept tool",
			toolName:   "explore_concept",
			target:     "",
			origTokens: 1500,
			showTokens: 300,
			expectedSubstrings: []string{
				"[Showing ~300 of ~1500 tokens (20%)]",
				`action="related"`,
			},
		},
		{
			name:       "generic fallback",
			toolName:   "unknown_custom_tool",
			target:     "",
			origTokens: 1000,
			showTokens: 500,
			expectedSubstrings: []string{
				"[Showing ~500 of ~1000 tokens (50%)]",
				`"token_budget"`,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			anchor := BuildCognitiveNavigationAnchor(tt.toolName, tt.target, tt.origTokens, tt.showTokens)
			for _, sub := range tt.expectedSubstrings {
				assert.Contains(t, anchor, sub, "case %s: anchor should contain %q", tt.name, sub)
			}
		})
	}
}

func TestApplyCognitiveBudget_LineSnapping(t *testing.T) {
	tests := []struct {
		name       string
		toolName   string
		input      string
		budget     int
		target     string
		assertFunc func(t *testing.T, res CognitiveBudgetResult)
	}{
		{
			name:     "within budget unchanged",
			toolName: "read",
			input:    "# Short Doc\n\nThis fits comfortably in budget.",
			budget:   500,
			assertFunc: func(t *testing.T, res CognitiveBudgetResult) {
				assert.False(t, res.WasTruncated)
				assert.Equal(t, "# Short Doc\n\nThis fits comfortably in budget.", res.Text)
				assert.Equal(t, res.OriginalTokens, res.FinalTokens)
			},
		},
		{
			name:     "snaps cleanly at line boundary avoiding table splitting",
			toolName: "read",
			target:   "README.md",
			input: "# Title\n\nLine 1: description\nLine 2: details\n| Col A | Col B |\n| Val 1 | Val 2 |\nLine 3: conclusion\n" +
				strings.Repeat("Long paragraph of additional content to exceed the budget limit.\n", 30),
			budget: 300,
			assertFunc: func(t *testing.T, res CognitiveBudgetResult) {
				require.True(t, res.WasTruncated)
				assert.Contains(t, res.Text, DefaultTruncateSuffix)
				assert.Contains(t, res.Text, "[Showing ~")
				assert.Contains(t, res.Text, `target="README.md#heading"`)
				assert.LessOrEqual(t, res.FinalTokens, 300)

				cutPoint := strings.Index(res.Text, DefaultTruncateSuffix)
				prefix := res.Text[:cutPoint]
				assert.False(t, strings.HasSuffix(prefix, "| Col"))
				assert.False(t, strings.HasSuffix(prefix, "| Val"))
			},
		},
		{
			name:     "balances unclosed code block inside truncated section",
			toolName: "read",
			input:    "# Code Section\n\n```go\n" + strings.Repeat("x := calculateSomeValue(100, 200, 300)\n", 60) + "```\n",
			budget:   300,
			assertFunc: func(t *testing.T, res CognitiveBudgetResult) {
				require.True(t, res.WasTruncated)
				assert.Contains(t, res.Text, "```\n\n"+DefaultTruncateSuffix)
				assert.LessOrEqual(t, res.FinalTokens, 300)
			},
		},
		{
			name:     "balances unclosed inline backtick on truncated line",
			toolName: "read",
			input: "# Inline Section\n\n" + strings.Repeat("Intro line with regular text.\n", 60) +
				"Here is a line that introduces `broken inline code that was truncated" + strings.Repeat(" extra words", 30),
			budget: 280,
			assertFunc: func(t *testing.T, res CognitiveBudgetResult) {
				require.True(t, res.WasTruncated)
				assert.LessOrEqual(t, res.FinalTokens, 280)
				cutPoint := strings.Index(res.Text, DefaultTruncateSuffix)
				prefix := res.Text[:cutPoint]

				if strings.Contains(prefix, "broken inline code") {
					assert.True(t, strings.HasSuffix(prefix, "`"), "inline code must be closed at boundary")
				}
			},
		},
		{
			name:     "extreme long target string with tight 256 budget",
			toolName: "read",
			target:   strings.Repeat("deeply/nested/sub/path/", 20) + "guide.md",
			input:    "# Long Target Doc\n\n" + strings.Repeat("Content paragraph with plenty of tokens.\n", 40),
			budget:   256,
			assertFunc: func(t *testing.T, res CognitiveBudgetResult) {
				require.True(t, res.WasTruncated)
				assert.NotEmpty(t, res.Text)
				assert.LessOrEqual(t, res.FinalTokens, 256, "final tokens must strictly adhere to 256 budget even with long target")
			},
		},
		{
			name:     "single massive line without newlines",
			toolName: "read",
			target:   "doc.md",
			input:    strings.Repeat("SingleMassiveTokenWithoutAnyNewlineCharacterInThisHugeLine", 200),
			budget:   256,
			assertFunc: func(t *testing.T, res CognitiveBudgetResult) {
				require.True(t, res.WasTruncated)
				assert.NotEmpty(t, res.Text)
				assert.LessOrEqual(t, res.FinalTokens, 256, "tokens must strictly adhere to 256 budget even with 0 newlines")
			},
		},
		{
			name:     "dense CJK text with 256 budget",
			toolName: "read",
			target:   "chinese.md",
			input:    strings.Repeat("这是一段用于认知预算压力测试的高密中文字符串，包含各种专有名词与标点符号。\n", 50),
			budget:   256,
			assertFunc: func(t *testing.T, res CognitiveBudgetResult) {
				require.True(t, res.WasTruncated)
				assert.NotEmpty(t, res.Text)
				assert.LessOrEqual(t, res.FinalTokens, 256, "tokens must strictly adhere to 256 budget with dense CJK")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := ApplyCognitiveBudget(tt.toolName, tt.input, tt.budget, tt.target)
			tt.assertFunc(t, res)
		})
	}
}

func TestTruncateWithSuffix_LocalBehavior(t *testing.T) {
	tests := []struct {
		name      string
		text      string
		maxTokens int
		suffix    string
		expected  func(t *testing.T, got string)
	}{
		{
			name:      "zero or negative tokens returns empty",
			text:      "some text",
			maxTokens: 0,
			suffix:    "...[trunc]",
			expected: func(t *testing.T, got string) {
				assert.Empty(t, got)
			},
		},
		{
			name:      "fits within budget",
			text:      "Short text",
			maxTokens: 50,
			suffix:    "...[trunc]",
			expected: func(t *testing.T, got string) {
				assert.Equal(t, "Short text", got)
			},
		},
		{
			name:      "truncates and balances code block with custom suffix",
			text:      "```python\n" + strings.Repeat("a = 1 + 2\n", 50) + "```",
			maxTokens: 30,
			suffix:    "\n\n...[Summary truncated]",
			expected: func(t *testing.T, got string) {
				assert.Contains(t, got, "...[Summary truncated]")
				assert.Contains(t, got, "```")
				assert.LessOrEqual(t, EstimateTokens(got), 35)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := TruncateWithSuffix(tt.text, tt.maxTokens, tt.suffix)
			tt.expected(t, got)
		})
	}
}

package pipeline

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestEnsureQuotedMermaidLabels 验证特殊字符节点标签自动双引号加固（0ms 纯状态机）。
func TestEnsureQuotedMermaidLabels(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		contains string
	}{
		{
			name:     "函数调用带括号标签自动加引号",
			input:    "flowchart TD\n  A[Init(cfg, ctx)] --> B[Run()]",
			contains: `A["Init(cfg, ctx)"] --> B["Run()"]`,
		},
		{
			name:     "泛型尖括号自动加引号",
			input:    "flowchart TD\n  A[Map<string, int>] --> B[List<T>]",
			contains: `A["Map<string, int>"] --> B["List<T>"]`,
		},
		{
			name:     "冒号说明标签自动加引号",
			input:    "flowchart TD\n  A[Step 1: Parse AST] --> B[Step 2: Emit]",
			contains: `A["Step 1: Parse AST"] --> B["Step 2: Emit"]`,
		},
		{
			name:     "已有双引号包裹的保持不变（幂等性）",
			input:    `flowchart TD\n  A["Already (Quoted)"] --> B["Clean"]`,
			contains: `A["Already (Quoted)"] --> B["Clean"]`,
		},
		{
			name:     "subgraph 标题特殊字符加固",
			input:    "subgraph Core [Core Engine: Execution Loop]\n  A --> B\nend",
			contains: `subgraph Core ["Core Engine: Execution Loop"]`,
		},
		{
			name:     "连线标签特殊字符加固",
			input:    "A -->|calls: start()| B",
			contains: `A -->|" calls: start() "| B`,
		},
		{
			name:     "中文全角括号与符号规整",
			input:    "flowchart TD\n  A[解析（语法树）] --> B",
			contains: `A["解析(语法树)"] --> B`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EnsureQuotedMermaidLabels(tt.input)
			assert.Contains(t, got, tt.contains)
		})
	}
}

// TestHealMermaidSyntax_Layer1 验证 Layer 1 内存 0ms 语法急救能力。
func TestHealMermaidSyntax_Layer1(t *testing.T) {
	t.Run("缺少图表头自动补齐 flowchart LR", func(t *testing.T) {
		input := "A --> B\nB --> C"
		healed, ok := HealMermaidSyntax(input)
		require.True(t, ok)
		assert.True(t, strings.HasPrefix(healed, "flowchart LR"))
		assert.Contains(t, healed, "A --> B")
	})

	t.Run("未闭合 subgraph 自动配平 end", func(t *testing.T) {
		input := "flowchart TD\n  subgraph Engine [Core: Runner]\n    A --> B"
		healed, ok := HealMermaidSyntax(input)
		require.True(t, ok)
		assert.Contains(t, healed, "end")
		assert.Contains(t, healed, `subgraph Engine ["Core: Runner"]`)
	})

	t.Run("剥离外壳代码围栏与思考块", func(t *testing.T) {
		input := "```mermaid\nflowchart LR\n  A[Init(x)] --> B[Run()]\n```"
		healed, ok := HealMermaidSyntax(input)
		require.True(t, ok)
		assert.NotContains(t, healed, "```")
		assert.Contains(t, healed, `A["Init(x)"]`)
	})

	t.Run("纯空文本返回 invalid", func(t *testing.T) {
		input := "   \n\n  "
		_, ok := HealMermaidSyntax(input)
		assert.False(t, ok)
	})

	t.Run("末尾悬空连线自动剔除", func(t *testing.T) {
		input := "flowchart TD\n  A --> B\n  C -->"
		healed, ok := HealMermaidSyntax(input)
		require.True(t, ok)
		assert.Contains(t, healed, "A --> B")
		assert.NotContains(t, healed, "C -->")
	})

	t.Run("乱码语法行正确判定为 invalid", func(t *testing.T) {
		input := "flowchart TD\n  ??? >>>"
		_, ok := HealMermaidSyntax(input)
		assert.False(t, ok)
	})
}

// mockMermaidDoctorLlm 模拟 Layer 2 与主题解耦的 Mermaid 专属修复调用。
type mockMermaidDoctorLlm struct {
	repairedCode string
	calledVars   map[string]any
}

func (m *mockMermaidDoctorLlm) Complete(_ context.Context, purpose string, vars map[string]any, _ *string) (LlmTextResult, error) {
	m.calledVars = vars
	if purpose != "mermaid_resilience" {
		return LlmTextResult{}, errors.New("unexpected purpose")
	}
	return LlmTextResult{Text: m.repairedCode}, nil
}

// TestRepairMermaidWithLlm_Layer2 验证与主题完全解耦的 300ms 靶向修复。
func TestRepairMermaidWithLlm_Layer2(t *testing.T) {
	broken := "flowchart TD\n  A -->>? ??? broken syntax"
	fixed := "```mermaid\nflowchart TD\n  A[\"Start\"] --> B[\"Done\"]\n```"

	mock := &mockMermaidDoctorLlm{repairedCode: fixed}
	healed, err := RepairMermaidWithLlm(context.Background(), mock, broken, nil)
	require.NoError(t, err)
	assert.Contains(t, healed, "flowchart TD")
	assert.Contains(t, healed, `A["Start"] --> B["Done"]`)
	// 验证解耦：变量中仅传递 rawMermaid 代码，绝无任何全仓代码或章节长文
	assert.Equal(t, broken, mock.calledVars["rawMermaid"])
	assert.NotContains(t, mock.calledVars, "repoMap")
	assert.NotContains(t, mock.calledVars, "content")
}

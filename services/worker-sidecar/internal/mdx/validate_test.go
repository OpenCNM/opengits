package mdx

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// MDX 校验 Go 单实现 黄金对拍（D组端点1）：
// 夹具以 Node validateMdxDetailed（快扫+编译+heal）真实裁定生成，
// Go 裁定口径与其逐例一致——「invalid ⇔ 渲染编译器必败且 heal 救不回」。
// ─────────────────────────────────────────────────────────────

func TestMdxValidateGoldenParity(t *testing.T) {
	// 2.12.12.1 mdx-validate.golden.json 双端 37 例对拍
	raw, err := os.ReadFile("../../testdata/mdx-validate.golden.json")
	require.NoError(t, err, "mdx-validate.golden.json missing")

	var fixture struct {
		GeneratedBy string `json:"generatedBy"`
		Cases       []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
			Valid  bool   `json:"valid"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			valid, errMsg := ValidateDetailed(tc.Source)
			assert.Equal(t, tc.Valid, valid, "verdict mismatch: %s", tc.Name)
			if !tc.Valid {
				assert.NotEmpty(t, errMsg, "invalid case must carry repair hint error")
			}
		})
	}
}

func TestValidateDetailed(t *testing.T) {
	tests := []struct {
		name          string
		source        string
		wantValid     bool
		wantErrSubstr string
	}{
		{
			name:          "泛型碰撞给出修复提示",
			source:        "# T\n\nContainer<T> is generic.\n",
			wantValid:     false,
			wantErrSubstr: "generic type parameter collision",
		},
		{
			name:          "未闭合 JSX 标签点名标签",
			source:        "# T\n\n<Card title=\"A\">\n  content\n",
			wantValid:     false,
			wantErrSubstr: "Expected a closing tag for `<Card>`",
		},
		{
			name:          "坏 JSX 属性表达式点名表达式",
			source:        "# T\n\n<Card title={1 + }>x</Card>\n",
			wantValid:     false,
			wantErrSubstr: "JSX attribute expression",
		},
		{
			name:          "超限源码显式拒绝",
			source:        string(make([]byte, MaxSourceBytes+1)),
			wantValid:     false,
			wantErrSubstr: "exceeds",
		},
		{
			name:      "干净文档零错误文案",
			source:    "# T\n\nplain\n",
			wantValid: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			valid, errMsg := ValidateDetailed(tt.source)
			assert.Equal(t, tt.wantValid, valid)
			if tt.wantErrSubstr != "" {
				assert.Contains(t, errMsg, tt.wantErrSubstr)
			} else {
				assert.Empty(t, errMsg)
			}
		})
	}
}

func TestIsValidJsExpression(t *testing.T) {
	// 2.12.12.2 JS 表达式确定性校验 15 例
	tests := []struct {
		name  string
		expr  string
		valid bool
	}{
		{name: "算术表达式", expr: "1 + 2 * 3", valid: true},
		{name: "三元与比较", expr: "x > 5 ? `a` : 'b'", valid: true},
		{name: "对象字面量", expr: "{ a: 1, b: [2, 3] }", valid: true},
		{name: "函数调用链", expr: "items.filter(x => x.ok).length", valid: true},
		{name: "属性访问链", expr: "obj.prop.deep", valid: true},
		{name: "TS 类型断言", expr: "val as string", valid: true},
		{name: "后缀增量", expr: "count++", valid: true},
		{name: "一元负号", expr: "-1", valid: true},
		{name: "空表达式", expr: "   ", valid: false},
		{name: "悬挂二元操作符（LLM 截断）", expr: "1 + ", valid: false},
		{name: "悬挂属性点（LLM 截断）", expr: "obj.", valid: false},
		{name: "未闭合括号", expr: "fn(1, ", valid: false},
		{name: "值邻接两个标识符", expr: "a b", valid: false},
		{name: "未闭合字符串", expr: "'abc", valid: false},
		{name: "闭括号失配", expr: "(a]", valid: false},
		{name: "跨行相邻断言不再被整体吞掉后误判有效", expr: "a as string\nb as number", valid: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.valid, isValidJsExpression(tt.expr))
		})
	}
}

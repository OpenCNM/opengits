package mdx

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/armor"
)

func TestValidateDetailedDeepDive(t *testing.T) {
	tests := []struct {
		name      string
		source    string
		wantValid bool
		wantErr   string
	}{
		{
			name: "闭合良好的深潜块：含代码槽、GFM alert 与列表，通过",
			source: "## 机制\n\n正文。\n\n<details data-layer=\"deep\">\n<summary>源码深潜：内部状态</summary>\n\n深潜正文。\n\n" +
				"```ts // src/a.ts#run\nexport function run() {}\n```\n\n> [!WARNING] 注意\n> 正文\n\n- 条目一\n- 条目二\n\n" +
				"</details>\n\n## 小结\n\n收尾。\n",
			wantValid: true,
		},
		{
			name:      "未规整紧凑写法：开标签与 summary 同行，对齐 @mdx-js/mdx 拒绝",
			source:    "<details data-layer=\"deep\"><summary>标题</summary>\n\n内容。\n\n</details>\n",
			wantValid: false,
			wantErr:   "details",
		},
		{
			name:      "未规整写法：summary 闭合后缺空行紧接正文（导致 <p><summary>），拒绝",
			source:    "<details data-layer=\"deep\">\n<summary>标题</summary>\n内容。\n\n</details>\n",
			wantValid: false,
			wantErr:   "summary",
		},
		{
			name:      "未规整写法：/details 与正文同行粘连，拒绝",
			source:    "<details data-layer=\"deep\">\n<summary>标题</summary>\n\n内容。</details>\n",
			wantValid: false,
			wantErr:   "details",
		},
		{
			name:      "行内代码与围栏中的未规整写法不触发误杀，通过",
			source:    "使用 `<details data-layer=\"deep\"><summary>x</summary>y</details>` 示例。\n\n```html\n<details data-layer=\"deep\"><summary>x</summary>\n正文</details>\n```\n",
			wantValid: true,
		},
		{
			name:      "两个相邻的深潜块，通过",
			source:    "<details data-layer=\"deep\">\n<summary>一</summary>\n\n内容一。\n\n</details>\n\n<details data-layer=\"deep\">\n<summary>二</summary>\n\n内容二。\n\n</details>\n",
			wantValid: true,
		},
		{
			name:      "未闭合的深潜块：拒绝",
			source:    "## 机制\n\n<details data-layer=\"deep\">\n<summary>源码深潜</summary>\n\n内容。\n\n## 之后的小节\n\n正文。\n",
			wantValid: false,
			wantErr:   "details",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			valid, errMsg := ValidateDetailed(tt.source)
			assert.Equal(t, tt.wantValid, valid, "err=%q", errMsg)
			if tt.wantErr != "" {
				assert.Contains(t, errMsg, tt.wantErr)
			}
		})
	}
}

func TestNormalizeAndHealDeepDiveEndToEnd(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "开标签与 summary 同行且缺空行",
			raw:  "<details data-layer=\"deep\"><summary>标题</summary>\n内容。\n</details>\n",
		},
		{
			name: "单行全紧凑写法夹杂花括号",
			raw:  "前文<details data-layer=\"deep\"><summary>源码 {x}</summary>正文含 {brace}</details>后文",
		},
		{
			name: "summary 后紧接行内代码无空行且 /details 粘连代码围栏",
			raw:  "<details data-layer=\"deep\"><summary>分析</summary>\n`run()` 执行流程。\n```ts\nconst x = 1;\n```\n</details>\n后文",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			preValid, _ := ValidateDetailed(tt.raw)
			assert.False(t, preValid)

			normalized := armor.NormalizeDeepDiveBlocks(tt.raw)
			normValid, normErr := ValidateDetailed(normalized)
			assert.True(t, normValid, "normalized should pass ValidateDetailed, got err=%q\nnormalized:\n%s", normErr, normalized)

			healed, err := HealSource(tt.raw)
			require.NoError(t, err)
			healedValid, healedErr := ValidateDetailed(healed)
			assert.True(t, healedValid, "healed should pass ValidateDetailed, got err=%q\nhealed:\n%s", healedErr, healed)
		})
	}
}

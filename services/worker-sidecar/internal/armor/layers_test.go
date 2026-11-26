package armor

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	layerSlotFence  = "```ts // src/gateway.ts#hydratePublisher\nthis.hydrate()\n```"
	layerPlainFence = "```bash\necho hi\n```"
	layerMermaid    = "```mermaid\nflowchart LR\nA-->B\n```"
)

func layerRegionTexts(regions []LayerRegion) string {
	var sb strings.Builder
	for _, r := range regions {
		sb.WriteString(r.Text)
	}
	return sb.String()
}

func TestSplitLayerRegions(t *testing.T) {
	tests := []struct {
		name      string
		content   string
		wantFlags []string
		coverage  bool
	}{
		{
			name:      "无深潜块的常规章节",
			content:   "## 机制\n\n正文。\n\n" + layerSlotFence + "\n\n" + layerPlainFence + "\n\n" + layerMermaid + "\n",
			wantFlags: []string{"P", "A", "P", "F", "P", "M", "P"},
			coverage:  true,
		},
		{
			name:      "深潜块内的围栏计入深潜",
			content:   "主线正文。\n\n<details data-layer=\"deep\">\n<summary>源码深潜</summary>\n\n" + layerSlotFence + "\n\n深潜正文。\n\n</details>\n\n收尾正文。\n",
			wantFlags: []string{"P", "D", "S", "D", "P"},
			coverage:  true,
		},
		{
			name:      "翻译漂移 data-layer=深挖 仍被识别为深潜块",
			content:   "主线正文。\n\n<details data-layer=\"深挖\">\n<summary>深挖：状态机</summary>\n\n" + layerSlotFence + "\n\n深潜正文。\n\n</details>\n\n收尾正文。\n",
			wantFlags: []string{"P", "D", "S", "D", "P"},
			coverage:  true,
		},
		{
			name:      "未带 data-layer=deep 的 details 不算深潜",
			content:   "<details>\n<summary>普通折叠</summary>\n\n" + layerSlotFence + "\n\n</details>\n",
			wantFlags: []string{"P", "A", "P"},
			coverage:  true,
		},
		{
			name:      "围栏内的标签文本不参与配对",
			content:   "<details data-layer=\"deep\">\n\n" + layerSlotFence + "\n\n```md\n</details>\n```\n\n仍在深潜内。\n\n</details>\n\n回到主线。\n",
			wantFlags: []string{"D", "S", "D", "G", "D", "P"},
			coverage:  true,
		},
		{
			name:      "未闭合的深潜块延续到文末（不假装闭合）",
			content:   "开头。\n\n<details data-layer=\"deep\">\n\n" + layerSlotFence + "\n\n## 之后的小节\n\n正文。\n",
			wantFlags: []string{"P", "D", "S", "D"},
			coverage:  true,
		},
		{
			name:      "自闭合 details 与散文中的尖括号不触发分层",
			content:   "当 a < b 且 c>d 时。\n\n<details data-layer=\"deep\" />\n\n" + layerSlotFence + "\n",
			wantFlags: []string{"P", "A", "P"},
			coverage:  true,
		},
		{
			name:      "嵌套：深潜内的普通 details 仍属深潜",
			content:   "<details data-layer='deep'>\n\n<details>\n\n" + layerSlotFence + "\n\n</details>\n\n</details>\n\n尾。\n",
			wantFlags: []string{"D", "S", "D", "P"},
			coverage:  true,
		},
		{
			name:      "空内容",
			content:   "",
			wantFlags: []string{},
			coverage:  true,
		},
		{
			name:      "行内单反引号提及 details 标签不触发深潜（U2）",
			content:   "讲解深潜块语法时使用 `<details data-layer=\"deep\">` 与 `</details>` 标签。\n\n" + layerSlotFence + "\n",
			wantFlags: []string{"P", "A", "P"},
			coverage:  true,
		},
		{
			name:      "行内双反引号包裹单反引号提及 details 标签不触发深潜（U2）",
			content:   "用法示例：`` `<details data-layer=\"deep\">` `` 可用于折叠。\n\n" + layerSlotFence + "\n",
			wantFlags: []string{"P", "A", "P"},
			coverage:  true,
		},
		{
			name:      "HTML 注释内提及 details 标签不触发深潜（U2）",
			content:   "<!-- <details data-layer=\"deep\"> 仅注释说明 -->\n\n" + layerSlotFence + "\n",
			wantFlags: []string{"P", "A", "P"},
			coverage:  true,
		},
		{
			name:      "深潜块内部行内代码与注释中的闭合标签不提前结束深潜",
			content:   "<details data-layer=\"deep\">\n<summary>深潜</summary>\n\n内部提到 `</details>` 与 <!-- </details> --> 不应截断。\n\n" + layerSlotFence + "\n\n</details>\n\n外部。\n",
			wantFlags: []string{"D", "S", "D", "P"},
			coverage:  true,
		},
		{
			name:      "前段孤立未闭合反引号不吞并后续段落的真实深潜块",
			content:   "前文误写了一个 ` 孤立反引号。\n\n<details data-layer=\"deep\">\n\n" + layerSlotFence + "\n\n</details>\n",
			wantFlags: []string{"P", "D", "S", "D", "P"},
			coverage:  true,
		},
	}

	flagOf := func(r LayerRegion) string {
		switch {
		case r.IsFence && r.IsDiagram:
			return "M"
		case r.IsFence && r.IsDeepDive && r.HasSlot:
			return "S"
		case r.IsFence && r.IsDeepDive:
			return "G"
		case r.IsFence && r.HasSlot:
			return "A"
		case r.IsFence:
			return "F"
		case r.IsDeepDive:
			return "D"
		default:
			return "P"
		}
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			regions := SplitLayerRegions(tt.content)
			got := make([]string, 0, len(regions))
			for _, r := range regions {
				got = append(got, flagOf(r))
			}
			assert.Equal(t, tt.wantFlags, got)
			if tt.coverage {
				assert.Equal(t, tt.content, layerRegionTexts(regions), "区域必须首尾相接覆盖全文")
			}
		})
	}
}

func TestMeasureLayers(t *testing.T) {
	dense := "状态机由 `A`、`B`、`C` 与 `D` 共同维护。"
	spars := "冷恢复就是订阅时按需重建投影（见 `hydrate`）。"
	tests := []struct {
		name    string
		content string
		want    LayerMetrics
	}{
		{
			name:    "主线与深潜分别计数，mermaid 不计代码块",
			content: dense + "\n\n" + layerSlotFence + "\n\n" + layerMermaid + "\n\n<details data-layer=\"deep\">\n\n" + spars + "\n\n" + layerSlotFence + "\n\n" + layerPlainFence + "\n\n</details>\n",
			want:    LayerMetrics{MainBlocks: 1, MainAnchored: 1, DeepBlocks: 2, DeepAnchored: 1, DeepDives: 1, DenseParas: 1},
		},
		{
			name:    "只有深潜里有代码：主线代码块为 0",
			content: "## 机制\n\n泛泛而谈。\n\n<details data-layer=\"deep\">\n\n" + layerSlotFence + "\n\n</details>\n",
			want:    LayerMetrics{DeepBlocks: 1, DeepAnchored: 1, DeepDives: 1},
		},
		{
			name:    "无深潜块的历史章节：全部计入主线",
			content: spars + "\n\n" + layerSlotFence + "\n\n" + layerPlainFence + "\n",
			want:    LayerMetrics{MainBlocks: 2, MainAnchored: 1},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, MeasureLayers(tt.content))
		})
	}

	t.Run("主线超密段计数：豁免深潜块、列表与表格，计入 code: 胶囊", func(t *testing.T) {
		capsules := "连续引用 [a.ts](code:a.ts)、[b.ts](code:b.ts)、[c.ts](code:c.ts) 与 [d.ts](code:d.ts)。"
		bulletList := "- `A` 说明\n- `B` 说明\n- `C` 说明\n- `D` 说明"
		table := "| 文件 | 职责 |\n| --- | --- |\n| `A` | 入口 |\n| `B` | 调度 |\n| `C` | 校验 |\n| `D` | 落库 |"
		content := strings.Join([]string{dense, capsules, bulletList, table}, "\n\n") +
			"\n\n<details data-layer=\"deep\">\n\n" + dense + "\n\n</details>\n"
		require.Equal(t, 2, MeasureLayers(content).DenseParas)
		multiLine := "`A` 与 `B`\n`C` 与 `D`\n"
		assert.Equal(t, 1, MeasureLayers(multiLine).DenseParas)
	})
}

func TestNormalizeDeepDiveBlocks(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "空输入与无标签内容原样返回",
			in:   "## 机制\n\n普通正文与 <Summary title=\"要点\">\n\n- 条目\n\n</Summary>\n",
			want: "## 机制\n\n普通正文与 <Summary title=\"要点\">\n\n- 条目\n\n</Summary>\n",
		},
		{
			name: "已规整的深潜块字节级不变",
			in:   "## 机制\n\n正文。\n\n<details data-layer=\"deep\">\n<summary>源码深潜：内部状态</summary>\n\n深潜正文。\n\n```ts\nconst a = 1;\n```\n\n</details>\n\n## 小结\n",
			want: "## 机制\n\n正文。\n\n<details data-layer=\"deep\">\n<summary>源码深潜：内部状态</summary>\n\n深潜正文。\n\n```ts\nconst a = 1;\n```\n\n</details>\n\n## 小结\n",
		},
		{
			name: "紧凑写法拆分 details 与 summary 并补齐 summary 后空行",
			in:   "<details data-layer=\"deep\"><summary>标题</summary>\n内容。\n\n</details>\n",
			want: "<details data-layer=\"deep\">\n<summary>标题</summary>\n\n内容。\n\n</details>\n",
		},
		{
			name: "单行全紧凑写法拆分为多行合法块",
			in:   "前文<details data-layer=\"deep\"><summary>标题</summary>正文内容</details>后文",
			want: "前文\n\n<details data-layer=\"deep\">\n<summary>标题</summary>\n\n正文内容\n\n</details>\n\n后文",
		},
		{
			name: "summary 后紧跟围栏且 /details 紧贴围栏时均补齐空行",
			in:   "<details data-layer=\"deep\"><summary>Title</summary>\n```ts\nconst x = 1;\n```\n</details>\n后文\n",
			want: "<details data-layer=\"deep\">\n<summary>Title</summary>\n\n```ts\nconst x = 1;\n```\n\n</details>\n\n后文\n",
		},
		{
			name: "围栏、行内反引号、HTML 注释中的标签原样保留不误改",
			in:   "行内 `<details data-layer=\"deep\"><summary>x</summary>y</details>` 与双反引号 `` `<details><summary>a</summary>b</details>` ``。\n\n<!-- <details data-layer=\"deep\"><summary>c</summary>d</details> -->\n\n```html\n<details data-layer=\"deep\"><summary>code</summary>body</details>\n```\n",
			want: "行内 `<details data-layer=\"deep\"><summary>x</summary>y</details>` 与双反引号 `` `<details><summary>a</summary>b</details>` ``。\n\n<!-- <details data-layer=\"deep\"><summary>c</summary>d</details> -->\n\n```html\n<details data-layer=\"deep\"><summary>code</summary>body</details>\n```\n",
		},
		{
			name: "自闭合 details 与摘要内含行内代码均正确处理",
			in:   "<details data-layer=\"deep\" />\n\n<details data-layer=\"deep\"><summary>分析 `a < b` 路径</summary>\n细节\n</details>",
			want: "<details data-layer=\"deep\" />\n\n<details data-layer=\"deep\">\n<summary>分析 `a < b` 路径</summary>\n\n细节\n\n</details>",
		},
		{
			name: "嵌套 details 与连续闭合标签不产生多余空行",
			in:   "<details data-layer=\"deep\"><summary>Outer</summary>\n<details><summary>Inner</summary>Body</details></details>",
			want: "<details data-layer=\"deep\">\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nBody\n\n</details>\n\n</details>",
		},
		{
			name: "空体 details/summary 对仅留单一空行",
			in:   "<details data-layer=\"deep\"><summary>Empty</summary></details>",
			want: "<details data-layer=\"deep\">\n<summary>Empty</summary>\n\n</details>",
		},
		{
			name: "翻译漂移 data-layer=深挖 与 deep-dive 归一为正典 deep，非深潜属性保持原样",
			in:   "<details data-layer=\"深挖\"><summary>深挖：事务 Map</summary>\n细节\n</details>\n\n<details data-layer='deep-dive'>\n<summary>More</summary>\n\nBody\n\n</details>\n\n<details data-layer=\"main\">\n<summary>Plain</summary>\n\nKeep\n\n</details>",
			want: "<details data-layer=\"deep\">\n<summary>深挖：事务 Map</summary>\n\n细节\n\n</details>\n\n<details data-layer='deep'>\n<summary>More</summary>\n\nBody\n\n</details>\n\n<details data-layer=\"main\">\n<summary>Plain</summary>\n\nKeep\n\n</details>",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NormalizeDeepDiveBlocks(tt.in)
			assert.Equal(t, tt.want, got)
			assert.Equal(t, got, NormalizeDeepDiveBlocks(got), "NormalizeDeepDiveBlocks must be idempotent")
		})
	}
}

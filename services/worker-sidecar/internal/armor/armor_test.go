package armor

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveFileHandlesEngine(t *testing.T) {
	files := []ArmorFileRef{{Path: "a.ts"}, {Path: "b.go"}}
	nested := []ArmorFileRef{{Path: "ch01/a/x.md"}, {Path: "ch02/c/x.md"}, {Path: "b.go"}}

	tests := []struct {
		name    string
		content string
		files   []ArmorFileRef
		want    string
	}{
		{
			name:    "空内容与空文件原样返回",
			content: "",
			files:   nil,
			want:    "",
		},
		{
			name:    "围栏头保持历史形态，正文引用升级 code: 锚点链接",
			content: "```ts // [File 1]\n```\n见 [File 2#L3-L9]",
			files:   files,
			want:    "```ts // a.ts\n```\n见 [b.go](code:b.go:L3-L9)",
		},
		{
			name:    "简写代号省略File关键词还原真实路径",
			content: "```python // [1#create_tasks_prompt:core]\n```\n```python // [1#chat_prompt]\n```",
			files:   []ArmorFileRef{{Path: "platform/reworkd_platform/web/api/agent/prompts.py"}},
			want:    "```python // platform/reworkd_platform/web/api/agent/prompts.py#create_tasks_prompt\n```\n```python // platform/reworkd_platform/web/api/agent/prompts.py#chat_prompt\n```",
		},
		{
			name:    "越界句柄原样保留",
			content: "[File 9] 不变",
			files:   files,
			want:    "[File 9] 不变",
		},
		{
			name:    "L0 非空字符串按 JS 真值处理",
			content: "[File 1#L0]",
			files:   files,
			want:    "[a.ts](code:a.ts:L0)",
		},
		{
			name:    "符号锚回退历史 span 形态",
			content: "见 [File 1#RunParser]",
			files:   files,
			want:    "见 `a.ts#RunParser`",
		},
		{
			name:    "非重复相邻句柄互不吸收",
			content: "对比 [File 1] 与 [File 2]",
			files:   files,
			want:    "对比 [a.ts](code:a.ts) 与 [b.go](code:b.go)",
		},
		{
			name:    "去重A：句柄连写两次只发射一次",
			content: "双写 [File 1] [File 1] 讲解，紧凑 [File 2][File 2] 收尾",
			files:   files,
			want:    "双写 [a.ts](code:a.ts) 讲解，紧凑 [b.go](code:b.go) 收尾",
		},
		{
			name:    "去重B：模型路径 span + 句柄连写截断升级为链接",
			content: "见 `a.ts` [File 1] 说明",
			files:   files,
			want:    "见 [a.ts](code:a.ts) 说明",
		},
		{
			name:    "去重B：basename span + 句柄同样吸收",
			content: "入口 `x.md` [File 1] 与深路径 `ch01/a/x.md` [File 1] 两次",
			files:   nested,
			want:    "入口 [a/x.md](code:ch01/a/x.md) 与深路径 [a/x.md](code:ch01/a/x.md) 两次",
		},
		{
			name:    "去重C：裸 basename 紧邻句柄吸收（词边界 + 仅空白分隔）",
			content: "入口 x.md [File 1] 与 b.go[File 3] 相邻",
			files:   nested,
			want:    "入口 [a/x.md](code:ch01/a/x.md) 与 [b.go](code:b.go) 相邻",
		},
		{
			name:    "basename 跨文件冲突时末两段消歧",
			content: "两个 [File 1] 与 [File 2]",
			files:   nested,
			want:    "两个 [a/x.md](code:ch01/a/x.md) 与 [c/x.md](code:ch02/c/x.md)",
		},
		{
			name:    "围栏内部字节级保持历史 span 形态且不参与去重",
			content: "```\n[File 1] [File 1]\n```\n见 [File 1]",
			files:   files,
			want:    "```\n`a.ts` `a.ts`\n```\n见 [a.ts](code:a.ts)",
		},
		{
			name:    "正文内联带 :aspect 后缀的符号句柄干净剥离 aspect",
			content: "详见 [File 1#hydratePublisher:core] 与 `[File 2#RunParser:contract]` 的交互。",
			files:   files,
			want:    "详见 `a.ts#hydratePublisher` 与 `b.go#RunParser` 的交互。",
		},
		{
			name:    "正文内联带 :aspect 后缀的行号句柄转为 code: 链接且不泄漏 aspect",
			content: "参考 [File 1#L10-L20:core]、[File 2#L5:full] 与 [File 1:contract]。",
			files:   files,
			want:    "参考 [a.ts](code:a.ts:L10-L20)、[b.go](code:b.go:L5) 与 [a.ts](code:a.ts)。",
		},
		{
			name:    "越界或围栏内的带 :aspect 句柄表现一致",
			content: "越界 [File 9#fn:core] 不变。\n\n```\n[File 1#fn:core]\n```",
			files:   files,
			want:    "越界 [File 9#fn:core] 不变。\n\n```\n`a.ts#fn`\n```",
		},
		{
			name:    "深路径符号在散文使用消歧短名，围栏内保留全路径",
			content: "散文提及 [File 1#InitScheduler:core]。\n\n```\n[File 1#InitScheduler:core]\n```",
			files:   []ArmorFileRef{{Path: "services/worker-sidecar/internal/scheduler/engine.go"}},
			want:    "散文提及 `engine.go#InitScheduler`。\n\n```\n`services/worker-sidecar/internal/scheduler/engine.go#InitScheduler`\n```",
		},
		{
			name:    "同段多次裸 [File N] 仅首处发射胶囊、后续降噪为短名，跨段重置",
			content: "首句由 [File 1] 初始化，接着 [File 1] 校验并 [File 1] [File 1] 收尾。\n\n第二段再次从 [File 1] 读取。",
			files:   []ArmorFileRef{{Path: "src/core/engine.ts"}},
			want:    "首句由 [engine.ts](code:src/core/engine.ts) 初始化，接着 engine.ts 校验并 engine.ts 收尾。\n\n第二段再次从 [engine.ts](code:src/core/engine.ts) 读取。",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ResolveFileHandles(tt.content, tt.files))
		})
	}
}

func TestSanitizeMdxForCompilationEngine(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "空输入返回空串",
			in:   "",
			want: "",
		},
		{
			name: "孤立小于号后接空白等号数字转义，串尾孤立不转义",
			in:   "a < b <5 x<=1 <",
			want: "a &lt; b &lt;5 x&lt;=1 <",
		},
		{
			name: "JSX 组件保留与泛型转义并存",
			in:   "<Callout> 与 <T> 与 <K, V>",
			want: "<Callout> 与 &lt;T&gt; 与 &lt;K, V&gt;",
		},
		{
			name: "已自闭合 void tag 原样保留",
			in:   "<hr/> 与 <br />",
			want: "<hr/> 与 <br />",
		},
		{
			name: "未闭合 manifest 至串尾全剥",
			in:   "<concept_manifest>payload without boundary",
			want: "",
		},
		{
			name: "闭合 manifest 双名交叉剥离",
			in:   "<pedagogy_manifest>{}</concept_manifest>tail",
			want: "tail",
		},
		{
			name: "2.16.1.3 围栏捕获组切分后仅偶数位 prose 参与转义，代码块 100% 原样",
			in:   "正文 <T>\n\n```ts\nconst x: Map<K, V> = new Map();\n```\n\n后续 <br/>",
			want: "正文 &lt;T&gt;\n\n```ts\nconst x: Map<K, V> = new Map();\n```\n\n后续 <br/>",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, SanitizeMdxForCompilation(tt.in))
		})
	}
}

func TestAllocateBalancedSourceSnippetsEngine(t *testing.T) {
	gen := func(path string, n int) ArmorSourceFile {
		return ArmorSourceFile{Path: path, TotalLines: 1, RawContent: strings.Repeat("x", n)}
	}

	t.Run("零预算回落默认 40000", func(t *testing.T) {
		got := AllocateBalancedSourceSnippets([]ArmorSourceFile{gen("only.ts", 100000)}, 0)
		require.Len(t, got, 1)
		assert.Equal(t, 40000, len(got[0].Snippet))
	})

	t.Run("空文件列表返回空数组非 null", func(t *testing.T) {
		got := AllocateBalancedSourceSnippets(nil, 40000)
		assert.NotNil(t, got)
		assert.Empty(t, got)
	})

	t.Run("预算不足保底时均分（floor 语义）", func(t *testing.T) {
		got := AllocateBalancedSourceSnippets(
			[]ArmorSourceFile{gen("a", 5000), gen("b", 5000), gen("c", 5000)},
			1500,
		)
		require.Len(t, got, 3)
		for _, s := range got {
			assert.Equal(t, 500, len(s.Snippet))
		}
	})

	t.Run("保底 + 按体积比例分配剩余", func(t *testing.T) {
		got := AllocateBalancedSourceSnippets(
			[]ArmorSourceFile{gen("big", 30000), gen("small", 500)},
			20000,
		)
		require.Len(t, got, 2)
		assert.Equal(t, 19200, len(got[0].Snippet))
		assert.Equal(t, 500, len(got[1].Snippet))
	})
}

func TestPruneTerminalCliffhanger(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "空文本直接返回",
			in:   "",
			want: "",
		},
		{
			name: "末尾独立段落的下一课时预告被整段剥离",
			in:   "## 4. 总结\n\n本章完成 MLP 构建。\n\n下一课时，我们将把这些微构件接到真实数据与损失函数上，跑通一次完整的训练循环——届时你会看到，本章搭好的表达式图如何被第 1 章的引擎'点亮'。\n",
			want: "## 4. 总结\n\n本章完成 MLP 构建。\n",
		},
		{
			name: "末尾行内句号后的下一课时预告被剥离并保留句号",
			in:   "这是本课最终收官。下一课时，我们将把这些微构件接到真实数据上。\n",
			want: "这是本课最终收官。\n",
		},
		{
			name: "在下一章中预告被剥离",
			in:   "至此微内核解析完毕。在下一章中，我们将进一步学习分布式训练。\n",
			want: "至此微内核解析完毕。\n",
		},
		{
			name: "无逗号连续中文下节课预告被剥离",
			in:   "架构全景已梳理完成。下节课我们将探讨算子融合。\n",
			want: "架构全景已梳理完成。\n",
		},
		{
			name: "英文 In the next lesson 预告被剥离",
			in:   "We have built the entire computational graph. In the next lesson, we will wire this into real datasets.",
			want: "We have built the entire computational graph.\n",
		},
		{
			name: "代码块内的下一课时字符串绝对不被触碰",
			in:   "## 代码示例\n\n```python\n# 下一课时预告：print('next lesson')\nprint('done')\n```\n\n本章系统闭环达成。\n",
			want: "## 代码示例\n\n```python\n# 下一课时预告：print('next lesson')\nprint('done')\n```\n\n本章系统闭环达成。\n",
		},
		{
			name: "无幻觉预告的普通结尾完全保持原样",
			in:   "## 4. 总结\n\n至此，全课程核心架构已全部解析完毕并实现系统闭环。\n",
			want: "## 4. 总结\n\n至此，全课程核心架构已全部解析完毕并实现系统闭环。\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := PruneTerminalCliffhanger(tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}

package pipelineb

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// TestSalvageOutlineChapters 截断流残文的章节抢救（表驱动）：
// 物理输入是「流被预算切断」的真实形态——外层容器永不闭合、
// 已完整落章的对象必须 100% 回收、截断残章必须丢弃。
func TestSalvageOutlineChapters(t *testing.T) {
	tests := []struct {
		name      string
		truncated string
		wantChaps int
		wantFirst string
	}{
		{
			name:      "完整两章+第三章截断",
			truncated: `{"chapters":[{"name":"第 1 章：LoRA 核心","summary":"低秩适配核心","files":["src/peft/tuners/lora.py"],"phase":"入门"},{"name":"第 2 章：配置契约","summary":"配置规范","files":["src/peft/utils/config.py"],"phase":"进阶"},{"name":"第 3 章：截断章","summary":"被切`,
			wantChaps: 2,
			wantFirst: "第 1 章：LoRA 核心",
		},
		{
			name:      "截断发生在字符串内的花括号处",
			truncated: `{"chapters":[{"name":"第 1 章：\"{\" 嵌套引号\"","summary":"s","files":["a.py"],"phase":"入门"},{"name":"第 2 章：截`,
			wantChaps: 1,
		},
		{
			name:      "转义反斜杠与花括号混排",
			truncated: `{"chapters":[{"name":"路径 C:\\{weird\\} 名","summary":"s","files":["b.py"],"phase":"实战"},{"nam`,
			wantChaps: 1,
			wantFirst: `路径 C:\{weird\} 名`,
		},
		{
			name:      "截断发生在第一个对象之前",
			truncated: `{"chapters":[{`,
			wantChaps: 0,
		},
		{
			name:      "空输入",
			truncated: ``,
			wantChaps: 0,
		},
		{
			name:      "无 JSON 的思考散文",
			truncated: `让我想想这个仓库的结构。{"看起来像对象其实是散文":{"a":1}`,
			wantChaps: 0,
		},
		{
			name:      "完整章节但缺 files 的无效章被校验闸丢弃",
			truncated: `{"chapters":[{"name":"无文件章","summary":"s","phase":"入门"},{"name":"有效章","summary":"s","files":["c.py"],"phase":"入门"}`,
			wantChaps: 1,
			wantFirst: "有效章",
		},
		{
			name:      "markdown 围栏与 think 标签包裹截断",
			truncated: "<think>模型思考过程...</think>\n```json\n{\"chapters\":[{\"name\":\"第 1 章：核心架构\",\"summary\":\"架构设计\",\"files\":[\"a.py\"],\"phase\":\"入门\"},{\"name\":\"第 2 章：未完章\",\"summary\":\"切断",
			wantChaps: 1,
			wantFirst: "第 1 章：核心架构",
		},
		{
			name:      "超过 14 章上限截断",
			truncated: `{"chapters":[` + repeatChapters(20) + `{"name":"截`,
			wantChaps: 14,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SalvageOutlineChapters(tt.truncated)
			assert.Len(t, got, tt.wantChaps)
			if tt.wantFirst != "" && len(got) > 0 {
				assert.Equal(t, tt.wantFirst, got[0].Name)
			}
		})
	}
}

// repeatChapters 生成 n 个合法章节 JSON 片段（含尾逗号）。
func repeatChapters(n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += `{"name":"章 ` + string(rune('A'+i)) + `","summary":"s","files":["f` + string(rune('a'+i)) + `.py"],"phase":"入门"},`
	}
	return out
}

// TestScanChapterArrayElements 章节数组元素扫描器的锚定与边界（表驱动）。
func TestScanChapterArrayElements(t *testing.T) {
	tests := []struct {
		name  string
		text  string
		limit int
		want  []string
	}{
		{name: "外层容器嵌套章节（容器永不闭合）", text: `{"chapters":[{"a":1},{"b":2}},{"name":"截`, limit: 10, want: []string{`{"a":1}`, `{"b":2}`}},
		{name: "裸数组形态回退", text: `[{"a":1},{"b":2},{"c":`, limit: 10, want: []string{`{"a":1}`, `{"b":2}`}},
		{name: "数组闭合后即止", text: `{"chapters":[{"a":1}],"other":[{"b":2}]}`, limit: 10, want: []string{`{"a":1}`}},
		{name: "字符串内花括号不计数", text: `{"chapters":[{"a":"}{ 不影响"}]`, limit: 10, want: []string{`{"a":"}{ 不影响"}`}},
		{name: "转义引号内花括号", text: `{"chapters":[{"a":"\"}{\""}`, limit: 10, want: []string{`{"a":"\"}{\""}`}},
		{name: "limit 生效", text: `{"chapters":[{"a":1},{"b":2},{"c":3}]`, limit: 2, want: []string{`{"a":1}`, `{"b":2}`}},
		{name: "无数组", text: `{"chapters": 关闭思考了`, limit: 10, want: nil},
		{name: "转义反斜杠结尾防悬挂", text: `{"chapters":[{"a":"x\\`, limit: 10, want: nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := scanChapterArrayElements(tt.text, tt.limit)
			assert.Equal(t, tt.want, got)
		})
	}
}

// TestOutlineLlmBudget 动态预算推导钳制（表驱动）。
func TestOutlineLlmBudget(t *testing.T) {
	t.Run("无 deadline 取缺省 30s", func(t *testing.T) {
		assert.Equal(t, outlineLlmDefaultBudget, outlineLlmBudget(context.Background()))
	})
	t.Run("剩余充足钳到上限 90s", func(t *testing.T) {
		ctx, cancel := contextWithDeadlineForTest(t, 10*time.Minute)
		defer cancel()
		assert.Equal(t, outlineLlmBudgetCeiling, outlineLlmBudget(ctx))
	})
	t.Run("剩余紧张扣预留后取实值", func(t *testing.T) {
		ctx, cancel := contextWithDeadlineForTest(t, 40*time.Second)
		defer cancel()
		// 墙钟推导存在微秒级流逝：40s − 8s 预留 ≈ 32s（±0.5s 容差）
		assert.InDelta(t, 32.0, outlineLlmBudget(ctx).Seconds(), 0.5)
	})
	t.Run("剩余枯竭钳到下限 10s", func(t *testing.T) {
		ctx, cancel := contextWithDeadlineForTest(t, 5*time.Second)
		defer cancel()
		assert.Equal(t, outlineLlmBudgetFloor, outlineLlmBudget(ctx))
	})
}

// contextWithDeadlineForTest 构造带 deadline 的 ctx（测试专用）。
func contextWithDeadlineForTest(t *testing.T, d time.Duration) (context.Context, context.CancelFunc) {
	t.Helper()
	return context.WithDeadline(context.Background(), time.Now().Add(d))
}

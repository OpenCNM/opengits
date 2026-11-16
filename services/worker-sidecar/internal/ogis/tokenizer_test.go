package ogis

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestTokenizeSearchText(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []string
	}{
		{
			name:  "英文小写化 + 短词过滤（<2 剔除）",
			input: "The Fast HTTP2 server",
			want:  []string{"the", "fast", "http2", "server"},
		},
		{
			name:  "camelCase 拆解：整词 + 驼峰边界子词",
			input: "usePackageManager",
			want:  []string{"usepackagemanager", "use", "package", "manager"},
		},
		{
			name:  "snake_case 与 kebab-case 拆解（整词 + 子词）",
			input: "get_server_side_props app-router",
			want:  []string{"get_server_side_props", "get", "server", "side", "props", "app-router", "app", "router"},
		},
		{
			name:  "CJK：短段整收 + 单字 + 二元组",
			input: "线性内存",
			want:  []string{"线性内存", "线", "性", "内", "存", "线性", "性内", "内存"},
		},
		{
			name:  "去重保序：重复 token 只保留首现",
			input: "server server client SERVER",
			want:  []string{"server", "client"},
		},
		{
			name:  "混合：标题 + 标识符 + 中文（词法域先行，CJK 段补单字/二元组）",
			input: "App Router 的 appRouter 组件",
			want:  []string{"app", "router", "approuter", "的", "组件", "组", "件"},
		},
		{
			name:  "点号不触发拆解（Node 仅 _ 和 - 触发），连字符触发",
			input: "next.config.js worker-sidecar",
			want:  []string{"next.config.js", "worker-sidecar", "worker", "sidecar"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, TokenizeSearchText(tt.input))
		})
	}
}

func TestTokenizeSearchTextCJKScriptCoverage(t *testing.T) {
	// 日文假名纳入 CJK 分词（窄区间 4e00-9fa5 会把假名整体剥空）
	got := TokenizeSearchText("はじめて")
	assert.Contains(t, got, "はじめて")
	assert.Contains(t, got, "はじ")
	// 韩文谚文同样参与
	got = TokenizeSearchText("안녕하세요")
	assert.Contains(t, got, "안녕하세요")
	assert.Contains(t, got, "안녕")
}

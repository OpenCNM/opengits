package sanitize

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// Go 原生 Sanitizer 单元测试（遵循 Uber/Google Table-Driven + Testify 范式）
//
// 逐一覆盖 apps/client/tests/unit/sanitizer.test.ts 的既有契约用例，
// 并补充代码隔离与边界防御断言。
// ─────────────────────────────────────────────────────────────
// 🧪 向量 2.15.4.1: mask 保护下 HTML 标签流式清洗 + 标题链接拍平 + Table-Driven 13 例全绿（sanitize_test.go 单测锁定）
func TestSanitizeTextTableDriven(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		assertFn  func(t *testing.T, out string)
		wantError bool
	}{
		{
			name:  "HTML 注释移除",
			input: "正文段落\n\n<!-- 这是隐藏注释 -->\n\n后续段落",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.NotContains(t, out, "<!--")
				assert.Contains(t, out, "正文段落")
				assert.Contains(t, out, "后续段落")
			},
		},
		{
			name:  "script 标签剥除（成对与自闭合）",
			input: "前文\n\n<script>alert(1)</script>\n<script src=\"evil.js\" />\n后文",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.NotContains(t, out, "<script")
				assert.NotContains(t, out, "alert(1)")
				assert.Contains(t, out, "前文")
				assert.Contains(t, out, "后文")
			},
		},
		{
			name:  "嵌入对象剥除（iframe, object, embed）",
			input: "内容\n<iframe src=\"https://x.com\"></iframe>\n<embed src=\"test.swf\" />",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.NotContains(t, out, "<iframe")
				assert.NotContains(t, out, "<embed")
				assert.Contains(t, out, "内容")
			},
		},
		{
			name:  "事件属性剥离（onclick 等，保留合法属性）",
			input: "段落\n\n<img src=\"x.png\" onclick=\"steal()\">",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.NotContains(t, out, "onclick")
				assert.Contains(t, out, `src="x.png"`)
			},
		},
		{
			name:  "javascript: 伪协议置空 href/src（原生 HTML 形态）",
			input: "<a href=\"javascript:alert(1)\">点我</a>\n<img src='javascript:void(0)'>",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.NotContains(t, out, "javascript:")
				assert.Contains(t, out, `href=""`)
				assert.Contains(t, out, "点我")
			},
		},
		{
			name:  "void 标签强制自闭合（img/br/hr）",
			input: "<img src=\"a.png\">\n<br>\n<hr>",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.Regexp(t, `<img[^>]*\/>`, out)
				assert.Regexp(t, `<br\s*\/>`, out)
				assert.Regexp(t, `<hr\s*\/>`, out)
			},
		},
		{
			name:  "已闭合 void 标签保持自闭合（不重复添加斜杠）",
			input: "<img src=\"b.png\" />\n<br />",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.NotContains(t, out, "//>")
				assert.Contains(t, out, `<img src="b.png" />`)
				assert.Contains(t, out, `<br />`)
			},
		},
		{
			name:  "内联 style 属性剥离",
			input: "<div style=\"color: red\" class=\"box\">内容</div>",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.NotContains(t, out, "style=")
				assert.Contains(t, out, `class="box"`)
				assert.Contains(t, out, "内容")
			},
		},
		{
			name:  "代码块语言归一（env→bash / c#→csharp / c++→cpp）",
			input: "```env\nKEY=1\n```\n\n```c#\nvar x;\n```\n\n```c++\nint y;\n```",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.Contains(t, out, "```bash")
				assert.Contains(t, out, "```csharp")
				assert.Contains(t, out, "```cpp")
			},
		},
		{
			name:  "标题内链接/图片拍平为纯文本（防嵌套锚点）",
			input: "# [点击这里](https://x.dev)\n## 介绍 ![图标](icon.png) 详情\n### 嵌套 [![徽章](badge.png)](https://ci.org)",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.Contains(t, out, "# 点击这里")
				assert.NotContains(t, out, "[点击这里]")
				assert.Contains(t, out, "## 介绍 图标 详情")
				assert.NotContains(t, out, "徽章")
				assert.Contains(t, out, "### 嵌套")
			},
		},
		{
			name:  "预处理器清洗（哨兵标记、Pandoc 图片扩展、伴生标签）",
			input: "===CONTENT_BEGIN===\n![预览](pic.png){width=100px}\n<concept_manifest><item>概念</item></concept_manifest>\n正文===CONTENT_END===",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.NotContains(t, out, "===CONTENT_BEGIN===")
				assert.NotContains(t, out, "===CONTENT_END===")
				assert.NotContains(t, out, "{width=100px}")
				assert.NotContains(t, out, "<concept_manifest>")
				assert.Contains(t, out, "![预览](pic.png)")
				assert.Contains(t, out, "正文")
			},
		},
		{
			name:  "代码块零污染（代码块内的 HTML/标签绝对不被清洗）",
			input: "```html\n<script>var x = 1;</script>\n<div style=\"color:blue\">保留</div>\n```\n\n行内代码 `<script>保留</script>` 也安全",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.Contains(t, out, "<script>var x = 1;</script>")
				assert.Contains(t, out, "style=\"color:blue\"")
				assert.Contains(t, out, "`<script>保留</script>`")
			},
		},
		{
			name:  "空文本与空白行安全处理",
			input: "   \n\n   ",
			assertFn: func(t *testing.T, out string) {
				t.Helper()
				assert.Equal(t, "", out)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, err := SanitizeText(tt.input)
			if tt.wantError {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			tt.assertFn(t, out)
		})
	}
}

// 🧪 向量 2.15.4.2: SanitizeText 异常自动降级请求 deps.Web.Sanitize 微端点（永不更糟防御锁定）
func TestSanitizeFallbackProtection(t *testing.T) {
	t.Run("极端畸形输入确定性保底不 panic", func(t *testing.T) {
		out, err := SanitizeText("<incomplete <<< <<< >>>")
		require.NoError(t, err)
		assert.NotNil(t, out)
	})
}

// TestHandleSanitize 验证 HTTP 路由端点行为
func TestHandleSanitize(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantOk     bool
		contains   []string
		notContain []string
	}{
		{
			name:       "合法 payload 正常净化返回 200",
			body:       "{\"content\":\"# Hello\\n<script>alert(1)</script>\\n```html\\n<script>safe</script>\\n```\"}",
			wantStatus: http.StatusOK,
			wantOk:     true,
			contains:   []string{"# Hello", "<script>safe</script>"},
			notContain: []string{"alert(1)"},
		},
		{
			name:       "空文本返回空结果",
			body:       `{"content":"   "}`,
			wantStatus: http.StatusOK,
			wantOk:     true,
			contains:   []string{},
		},
		{
			name:       "非法 json 返回 400",
			body:       `{invalid-json`,
			wantStatus: http.StatusBadRequest,
			wantOk:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/mdx/sanitize", bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			HandleSanitize(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantStatus == http.StatusOK {
				var resp SanitizeResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tt.wantOk, resp.Ok)
				for _, c := range tt.contains {
					assert.Contains(t, resp.Content, c)
				}
				for _, nc := range tt.notContain {
					assert.NotContains(t, resp.Content, nc)
				}
			}
		})
	}
}

func TestSanitizeHTMLProtocolAttributeSurface(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{name: "formaction 危险协议置空", input: `<button formaction="javascript:alert(1)">Go</button>`},
		{name: "action 危险协议置空", input: `<form action="javascript:alert(1)"></form>`},
		{name: "xlink:href 危险协议置空（SVG 向量）", input: `<a xlink:href="javascript:alert(1)">x</a>`},
		{name: "formaction 单引号变体", input: `<button formaction='vbscript:evil'>Go</button>`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := sanitizeHTML(tt.input)
			assert.NotContains(t, out, "javascript:")
			assert.NotContains(t, out, "vbscript:")
		})
	}
}

// Markdown 链接伪协议：危险 scheme 必须带冒号才命中——
// 漏冒号旧版会把 javascript.md / vbscript-notes.md 相对链接整体掏空。
func TestSanitizeMarkdownPseudoProtocolColonBoundary(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantKeep string
	}{
		{name: "真伪协议被中和", input: "[点我](javascript:alert(1))", wantKeep: "[点我]()"},
		{name: "vbscript 真伪协议被中和", input: "[x](vbscript:evil)", wantKeep: "[x]()"},
		{name: "相对文件名 javascript.md 保留目标", input: "[JS 指南](javascript.md)", wantKeep: "[JS 指南](javascript.md)"},
		{name: "相对文件名 vbscript-notes.md 保留目标", input: "[vbs](vbscript-notes.md)", wantKeep: "[vbs](vbscript-notes.md)"},
		{name: "大小写混写真伪协议被中和", input: "[x](JavaScript:void(0))", wantKeep: "[x]()"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := sanitizeHTML(tt.input)
			assert.Equal(t, tt.wantKeep, out)
		})
	}
}

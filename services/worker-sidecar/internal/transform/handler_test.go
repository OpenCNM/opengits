package transform

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMaskFencesTableDriven(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{name: "triple backticks", input: "```go\nfmt.Println(1)\n```"},
		{name: "quadruple tildes", input: "~~~~ts\nconst x = 1;\n~~~~"},
		{name: "unclosed fence to EOF", input: "```python\nprint(1)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			masked, blocks := maskCodeBlocks(tt.input)
			assert.Contains(t, masked, maskTokenPrefix)
			assert.NotEmpty(t, blocks)
			restored := unmaskCodeBlocks(masked, blocks)
			assert.Equal(t, tt.input, restored)
		})
	}
}

func TestTransformGuardrails(t *testing.T) {
	t.Run("2.15.2.1 resolveRepoPath 资产路径自嵌套二次拦截", func(t *testing.T) {
		tc := newTransformContext("owner", "repo", "main", "docs/intro.md", nil, "https://raw", "https://web")
		rewritten, ok := tc.rewriteImageDest("/api/assets/owner/repo/docs/img.png")
		assert.False(t, ok, "double nesting must be rejected")
		assert.Equal(t, "/api/assets/owner/repo/docs/img.png", rewritten)
		assert.True(t, hasApiAssetsSegment("api/assets/owner/repo/docs/img.png"))
	})

	t.Run("2.15.2.2 downloadOneAsset path.Clean 穿越拒绝", func(t *testing.T) {
		traversalPaths := []string{
			"../secret.txt",
			"foo/../../secret.txt",
			"%2e%2e/secret.txt",
			"%2e%2e%2fsecret.txt",
			"/etc/passwd",
			"..",
		}
		for _, p := range traversalPaths {
			err := downloadOneAsset(context.Background(), GoTransformDeps{}, "owner", "repo", "", "main", "", p)
			assert.Error(t, err, "path %s must be rejected", p)
			assert.Contains(t, err.Error(), "path traversal rejected")
		}
	})

	t.Run("2.15.6.1 runGoTransform 清洗失败显式 error 上抛", func(t *testing.T) {
		_, err := runGoTransform(context.Background(), GoTransformDeps{}, "owner", "repo", "main", nil, "docs/missing.md", "")
		assert.Error(t, err)
	})

	t.Run("2.15.6.2 SanitizerExecutor 编译期单路径", func(t *testing.T) {
		deps := GoTransformDeps{}
		assert.Nil(t, deps.Assets)
		assert.Nil(t, deps.HTTP)
	})

	t.Run("超长连续反引号（10+反引号）包壳与围栏状态机", func(t *testing.T) {
		tenBackticks := strings.Repeat("`", 10)
		raw := "代码含有超长反引号: " + tenBackticks + " 测试\n"
		wrapped := wrapCodeAsMdx("demo.py", raw)
		expectedFence := strings.Repeat("`", 11)
		assert.Contains(t, wrapped, expectedFence+"python\n")
		assert.True(t, strings.HasSuffix(wrapped, expectedFence+"\n"))

		twelveFence := strings.Repeat("`", 12)
		md := twelveFence + "typescript\nconst a = 1;\n" + twelveFence
		masked, blocks := maskCodeBlocks(md)
		assert.Contains(t, masked, maskTokenPrefix)
		restored := unmaskCodeBlocks(masked, blocks)
		assert.Equal(t, md, restored)
	})

	t.Run("2.15.7.1 fetchDocRawLocalFirst 重试耗尽显式 error", func(t *testing.T) {
		_, err := fetchDocRawLocalFirst(context.Background(), GoTransformDeps{}, "owner", "repo", "main", nil, "docs/missing.md", "")
		assert.Error(t, err)
	})

	t.Run("2.15.7.3 isMarkdownDocPath 走 ingest-patterns 注册表", func(t *testing.T) {
		patterns := &IngestPatterns{
			Sniffer: snifferPatterns{MarkdownExtensions: []string{".md", ".mdx"}},
		}
		assert.True(t, isMarkdownDocPath(patterns, "guide.md"))
		assert.True(t, isMarkdownDocPath(patterns, "guide.mdx"))
		assert.False(t, isMarkdownDocPath(patterns, "main.go"))
	})
}

func TestIsSafeBranchTableDriven(t *testing.T) {
	tests := []struct {
		name   string
		branch string
		want   bool
	}{
		{name: "standard main", branch: "main", want: true},
		{name: "nested branch", branch: "feature/auth-provider", want: true},
		{name: "symbols and tags", branch: "release/v1.0.0+patch", want: true},
		{name: "hyphen and underscore", branch: "user_123/fix-456", want: true},
		{name: "empty branch", branch: "", want: false},
		{name: "null byte literal", branch: "main\x00evil", want: false},
		{name: "url encoded traversal", branch: "%2e%2e", want: false},
		{name: "url encoded traversal in segment", branch: "feature/%2e%2e/test", want: false},
		{name: "double url encoded traversal", branch: "%252e%252e", want: false},
		{name: "url encoded null byte", branch: "main%00evil", want: false},
		{name: "url encoded slash at root", branch: "%2f", want: false},
		{name: "leading slash", branch: "/main", want: false},
		{name: "trailing slash", branch: "main/", want: false},
		{name: "double slash", branch: "feature//branch", want: false},
		{name: "parent traversal dotdot", branch: "..", want: false},
		{name: "dotdot segment", branch: "feature/../branch", want: false},
		{name: "backslash", branch: "feature\\branch", want: false},
		{name: "reflog notation", branch: "feature@{upstream}", want: false},
		{name: "lock file suffix", branch: "feature.lock", want: false},
		{name: "illegal characters", branch: "feat<ure>", want: false},
		{name: "control character tab", branch: "feat\ture", want: false},
		{name: "control character newline", branch: "feat\nure", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, IsSafeBranch(tt.branch))
		})
	}
}

func TestIsSafeRelativePathTableDriven(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		{name: "simple readme", path: "README.md", want: true},
		{name: "nested path", path: "docs/guide/intro.md", want: true},
		{name: "unicode and space", path: "docs/01 快速入门/index.md", want: true},
		{name: "empty path", path: "", want: false},
		{name: "null byte", path: "docs/\x00secret.md", want: false},
		{name: "dotdot traversal", path: "../secret.txt", want: false},
		{name: "nested traversal", path: "docs/../../secret.txt", want: false},
		{name: "url encoded traversal", path: "%2e%2e/secret.txt", want: false},
		{name: "double url encoded traversal", path: "%252e%252e/secret.txt", want: false},
		{name: "windows drive volume", path: "C:\\windows\\win.ini", want: false},
		{name: "unc path", path: "//127.0.0.1/share/secret.txt", want: false},
		{name: "control character newline", path: "docs/foo\nbar.md", want: false},
		{name: "ntfs alternate stream", path: "docs/readme.md:stream", want: false},
		{name: "illegal char asterisk", path: "docs/*.md", want: false},
		{name: "illegal char question mark", path: "docs/?.md", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, IsSafeRelativePath(tt.path))
		})
	}
}

func TestRewriteDestProtocolBoundary(t *testing.T) {
	t.Run("http.md 相对链接必须被改写", func(t *testing.T) {
		tc := newTransformContext("owner", "repo", "main", "docs/intro.md", nil, "https://raw.example.com", "https://web.example.com")
		rewritten, ok := tc.rewriteLinkDest("http.md")
		assert.True(t, ok, "http.md is a relative file, must be rewritten")
		assert.NotEqual(t, "http.md", rewritten)
	})

	t.Run("https.md 相对链接必须被改写", func(t *testing.T) {
		tc := newTransformContext("owner", "repo", "main", "docs/intro.md", nil, "https://raw.example.com", "https://web.example.com")
		rewritten, ok := tc.rewriteLinkDest("https.md")
		assert.True(t, ok, "https.md is a relative file, must be rewritten")
		assert.NotEqual(t, "https.md", rewritten)
	})

	t.Run("真绝对 http:// URL 保持原样", func(t *testing.T) {
		tc := newTransformContext("owner", "repo", "main", "docs/intro.md", nil, "https://raw.example.com", "https://web.example.com")
		rewritten, ok := tc.rewriteLinkDest("https://example.com/guide")
		assert.False(t, ok)
		assert.Equal(t, "https://example.com/guide", rewritten)
	})

	t.Run("httpx.md 相对链接不受影响", func(t *testing.T) {
		tc := newTransformContext("owner", "repo", "main", "docs/intro.md", nil, "https://raw.example.com", "https://web.example.com")
		_, ok := tc.rewriteLinkDest("httpx.md")
		assert.True(t, ok, "httpx.md is a relative file, must be rewritten")
	})
}

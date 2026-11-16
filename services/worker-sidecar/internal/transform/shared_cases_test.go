package transform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func loadTestFixture(t *testing.T, filename string) []byte {
	t.Helper()
	candidates := []string{
		filepath.Join("../../testdata", filename),
		filepath.Join("testdata", filename),
		filepath.Join("services/worker-sidecar/testdata", filename),
		filepath.Join("/src/services/worker-sidecar/testdata", filename),
	}
	for _, c := range candidates {
		if b, err := os.ReadFile(c); err == nil {
			return b
		}
	}
	b, err := os.ReadFile(filename)
	require.NoError(t, err, "fixture %s missing", filename)
	return b
}

// ── 共享断言夹具（与 tests/unit/transform-shared-cases.test.ts 双消费）──

type sharedAssertion struct {
	Contains    *string  `json:"contains"`
	NotContains *string  `json:"notContains"`
	CountOf     []any    `json:"countOf"`
	Either      []string `json:"either"`
}

type sharedCase struct {
	Name       string            `json:"name"`
	Input      string            `json:"input"`
	Assertions []sharedAssertion `json:"assertions"`
}

type sharedFixture struct {
	Ctx struct {
		Owner          string   `json:"owner"`
		Repo           string   `json:"repo"`
		Branch         string   `json:"branch"`
		CurrentFile    string   `json:"currentFilePath"`
		ValidFilePaths []string `json:"validFilePaths"`
		RawBase        string   `json:"rawBase"`
		WebBase        string   `json:"webBase"`
	} `json:"ctx"`
	Cases []sharedCase `json:"cases"`
}

func TestTransformSharedCases(t *testing.T) {
	raw := loadTestFixture(t, "transform-cases.json")
	var fx sharedFixture
	require.NoError(t, json.Unmarshal(raw, &fx))
	require.NotEmpty(t, fx.Cases)

	for _, c := range fx.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			tc := newTransformContext(fx.Ctx.Owner, fx.Ctx.Repo, fx.Ctx.Branch,
				fx.Ctx.CurrentFile, fx.Ctx.ValidFilePaths, fx.Ctx.RawBase, fx.Ctx.WebBase)
			output, err := goTransformText(c.Input, tc)
			require.NoError(t, err)

			for _, a := range c.Assertions {
				if a.Contains != nil {
					assert.Contains(t, output, *a.Contains)
				}
				if a.NotContains != nil {
					assert.NotContains(t, output, *a.NotContains)
				}
				if len(a.Either) > 0 {
					hit := false
					for _, cand := range a.Either {
						if strings.Contains(output, cand) {
							hit = true
							break
						}
					}
					assert.True(t, hit, "none of %v found in output", a.Either)
				}
				if len(a.CountOf) == 2 {
					substr, _ := a.CountOf[0].(string)
					want := int(a.CountOf[1].(float64))
					assert.Equal(t, want, strings.Count(output, substr))
				}
			}
		})
	}
}

// ── mask/unmask 字节级（PUA 定界符逐字节对齐 Node transformer.ts）──

func TestMaskCodeBlocksBytes(t *testing.T) {
	open := "\uE800"
	clos := "\uE001"
	tests := []struct {
		name  string
		input string
		want  string // 期望 masked（token 形态显式拼出）
	}{
		{
			name:  "fenced 块整体收编为单 token 行",
			input: "a\n```go\nx < 1\n```\nb",
			want:  "a\n" + open + "CODE_BLOCK_0" + clos + "\nb",
		},
		{
			name:  "inline code 行内 mask",
			input: "use `<div>` now",
			want:  "use " + open + "CODE_BLOCK_0" + clos + " now",
		},
		{
			name:  "未闭合围栏到文末收编",
			input: "x\n```\ncode",
			want:  "x\n" + open + "CODE_BLOCK_0" + clos,
		},
		{
			name:  "~~~ 围栏与缩进（≤3 空格）",
			input: "   ~~~js\ny\n   ~~~",
			want:  open + "CODE_BLOCK_0" + clos,
		},
		{
			name:  "闭栏 info 非空不算闭合（同字符同长）",
			input: "```\ncode\n``` text\nmore\n```",
			want:  open + "CODE_BLOCK_0" + clos,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			masked, blocks := maskCodeBlocks(tt.input)
			assert.Equal(t, tt.want, masked)
			require.NotEmpty(t, blocks)
			// unmask 完全还原
			assert.Equal(t, tt.input, unmaskCodeBlocks(masked, blocks))
		})
	}
}

func TestUnmaskCodeBlocksOutOfRange(t *testing.T) {
	_, blocks := maskCodeBlocks("```\nx\n```")
	// 越界序号回空串（对齐 Node ?? ''）
	assert.Equal(t, "", unmaskCodeBlocks("\uE800CODE_BLOCK_9\uE001", blocks))
}

// ── 正则趟 / 链接改写专项 ──

func TestApplyIsolatedLessThanEscape(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"数字后随", "I <3 it", "I &lt;3 it"},
		{"空白后随", "v < 0", "v &lt; 0"},
		{"字母不转义", "a<b", "a<b"},
		{"行尾不转义", "end <", "end <"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, applyIsolatedLessThanEscape(tt.input))
		})
	}
}

func TestNormalizeFenceLang(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"env 别名", "```env", "```bash"},
		{"dos 别名带缩进", "  ```dos", "  ```bat"},
		{"剥 | 后缀", "```ts|highlight", "```ts"},
		{"已规范保持", "```go", "```go"},
		{"空 info 保持", "```", "```"},
		{"附加内容保留", "```c# title=x.cs", "```csharp title=x.cs"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, normalizeFenceLang(tt.input))
		})
	}
}

func TestRewriteLinksImagesNested(t *testing.T) {
	tc := newTransformContext("o", "r", "main", "docs/a.md", []string{"docs/a.md"},
		"https://raw.githubusercontent.com", "https://github.com")
	// link label 内嵌 image：内外层都改写
	out := rewriteLinksImages("[![alt](img/x.png)](https://youtube.com)", tc)
	assert.Contains(t, out, "/api/assets/o/r/docs/img/x.png")
	assert.Contains(t, out, "(https://youtube.com)")
	assert.Contains(t, out, "assets/o/r/docs/img/x.png")
}


package armor

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSanitizeKeepsDeepDiveMarkup(t *testing.T) {
	src := "## 机制\n\n正文。\n\n<details data-layer=\"deep\">\n<summary>源码深潜：内部状态</summary>\n\n" +
		"当 a < b 时走容错。\n\n```ts\nconst compare = (a, b) => a < b;\n```\n\n泛型 <T> 不受影响。\n\n</details>\n\n收尾。\n"

	got := SanitizeMdxForCompilation(src)

	assert.Contains(t, got, "<details data-layer=\"deep\">")
	assert.Contains(t, got, "<summary>源码深潜：内部状态</summary>")
	assert.Contains(t, got, "</details>")
	assert.Contains(t, got, "当 a &lt; b 时走容错。")
	assert.Contains(t, got, "泛型 &lt;T&gt; 不受影响。")
	assert.Contains(t, got, "const compare = (a, b) => a < b;")

	layers := MeasureLayers(got)
	assert.Equal(t, 1, layers.DeepDives)
	assert.Equal(t, 1, layers.DeepBlocks)
}

func TestNormalizeAndSanitizeCompactDeepDive(t *testing.T) {
	src := "## 机制\n\n<details data-layer=\"deep\"><summary>源码深潜：内部状态</summary>当 a < b 时走容错。\n```ts\nconst ok = a < b;\n```\n泛型 <T> 受保护。</details>\n\n收尾。\n"
	normalized := NormalizeDeepDiveBlocks(SanitizeMdxForCompilation(src))

	want := "## 机制\n\n<details data-layer=\"deep\">\n<summary>源码深潜：内部状态</summary>\n\n当 a &lt; b 时走容错。\n```ts\nconst ok = a < b;\n```\n泛型 &lt;T&gt; 受保护。\n\n</details>\n\n收尾。\n"
	assert.Equal(t, want, normalized)

	layers := MeasureLayers(normalized)
	assert.Equal(t, 1, layers.DeepDives)
	assert.Equal(t, 1, layers.DeepBlocks)
}

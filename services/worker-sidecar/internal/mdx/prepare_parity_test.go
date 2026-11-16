package mdx

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/sanitize"
)

// ─────────────────────────────────────────────────────────────
// MDX 预处理双轨对拍（渲染态 = 摄取态的机器不变式）：
// TS lib/mdx/prepareMdxSource（web 渲染前处理，golden 事实源）
// ↔ Go 生产等价组合 sanitize.PrepareMdxSource → MaskCodeBlocks
//   → normalizeVoidTags → UnmaskCodeBlocksRaw（sidecar 摄取管线同序）。
// 任一侧算法改动必须手工同步冻结 golden 夹具并双端全绿（原生成脚本
// npm run gen:mdx-prepare-golden 已于 2026-11 死代码清算退役）。
// ─────────────────────────────────────────────────────────────

type prepareGoldenCase struct {
	Name     string `json:"name"`
	Input    string `json:"input"`
	Expected string `json:"expected"`
}

// composePrepare 按 HealSource 生产同序组合（仅剥离花括号转义步——那是
// 摄取独有的愈合维度，不属于 TS prepare 契约面）。
func composePrepare(raw string) string {
	cleaned := sanitize.PrepareMdxSource(raw)
	masked, blocks := sanitize.MaskCodeBlocks(cleaned)
	return sanitize.UnmaskCodeBlocksRaw(normalizeVoidTags(masked), blocks)
}

func loadPrepareGolden(t *testing.T) []prepareGoldenCase {
	t.Helper()
	candidates := []string{
		"testdata/mdx-prepare.golden.json",
		"../../testdata/mdx-prepare.golden.json",
		"services/worker-sidecar/testdata/mdx-prepare.golden.json",
		"/src/services/worker-sidecar/testdata/mdx-prepare.golden.json",
	}
	for _, c := range candidates {
		raw, err := os.ReadFile(c)
		if err != nil {
			continue
		}
		var fixture struct {
			Cases []prepareGoldenCase `json:"cases"`
		}
		require.NoError(t, json.Unmarshal(raw, &fixture), "golden 解析失败：%s", c)
		require.NotEmpty(t, fixture.Cases, "golden 为空：%s", c)
		return fixture.Cases
	}
	t.Fatal("mdx-prepare.golden.json missing (frozen contract fixture)")
	return nil
}

func TestPrepareMdxSourceParity(t *testing.T) {
	tests := loadPrepareGolden(t)
	for _, tt := range tests {
		t.Run(tt.Name, func(t *testing.T) {
			got := composePrepare(tt.Input)
			assert.Equal(t, tt.Expected, got,
				"MDX 预处理双轨漂移：渲染态(TS)与摄取态(Go)不一致——改任一侧后需手工同步冻结夹具并双端对齐")
		})
	}
}

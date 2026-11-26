package mdx

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/sanitize"
)

type prepareGoldenCase struct {
	Name     string `json:"name"`
	Input    string `json:"input"`
	Expected string `json:"expected"`
}

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

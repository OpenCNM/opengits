package mcp

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mcpGoldenFixture 黄金夹具形态（testdata/mcp-tool-output.golden.json 契约）。
type mcpGoldenCase struct {
	Name     string `json:"name"`
	CtxFlags struct {
		Fallback         bool   `json:"fallback"`
		RequestedEdition string `json:"requestedEdition"`
		Edition          string `json:"edition"`
		EditionLabel     string `json:"editionLabel"`
	} `json:"ctxFlags"`
	Result struct {
		Preamble string `json:"preamble"`
		Header   string `json:"header"`
		Body     string `json:"body"`
		Footer   string `json:"footer"`
	} `json:"result"`
	WantText string `json:"wantText"`
}

func findMcpGoldenPath() string {
	candidates := []string{
		"testdata/mcp-tool-output.golden.json",
		"../../testdata/mcp-tool-output.golden.json",
		"services/worker-sidecar/testdata/mcp-tool-output.golden.json",
		"/app/testdata/mcp-tool-output.golden.json",
		"/src/services/worker-sidecar/testdata/mcp-tool-output.golden.json",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "testdata/mcp-tool-output.golden.json"
}

// 🧪 TS/Go 渲染孪生黄金对拍：同一夹具双侧逐字节一致（双实现锁死为受保护的复制）。
func TestRenderPipelineGoldenParity(t *testing.T) {
	raw, err := os.ReadFile(findMcpGoldenPath())
	require.NoError(t, err)

	var fixture struct {
		Comment string          `json:"_comment"`
		Cases   []mcpGoldenCase `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases, "golden fixture is empty (frozen contract fixture)")

	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			warn := ""
			if tc.CtxFlags.Fallback {
				warn = RenderFallbackWarning(tc.CtxFlags.RequestedEdition, tc.CtxFlags.Edition, tc.CtxFlags.EditionLabel)
			}
			got := RenderToolResult(warn, tc.Result.Preamble, tc.Result.Header, tc.Result.Body, tc.Result.Footer)
			assert.Equal(t, tc.WantText, got,
				"渲染孪生漂移：改实现后必须重跑 npx tsx scripts/gen-parity-goldens.ts mcp 并保证双侧同绿")
		})
	}
}

// 🧪 回退警告文案锁定（与 TS fallbackWarning 逐字节对齐的表驱动快照）。
func TestRenderFallbackWarningText(t *testing.T) {
	tests := []struct {
		name             string
		requestedEdition string
		edition          string
		editionLabel     string
		wantContains     []string
	}{
		{
			name:             "回退到基础讲法",
			requestedEdition: "ed_deep",
			wantContains:     []string{`⚠ Edition fallback: requested "ed_deep" was not found; results below come from the BASE edition.`},
		},
		{
			name:             "回退到讲法行带显示名",
			requestedEdition: "v16",
			edition:          "ed_deep",
			editionLabel:     "深度剖析版",
			wantContains:     []string{`results below come from edition "深度剖析版"`},
		},
		{
			name:         "无请求描述兜底",
			wantContains: []string{"requested the requested edition/version was not found"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RenderFallbackWarning(tt.requestedEdition, tt.edition, tt.editionLabel)
			for _, want := range tt.wantContains {
				assert.Contains(t, got, want)
			}
			assert.True(t, strings.HasSuffix(got, "\n\n"))
		})
	}
}

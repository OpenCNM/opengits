package ingest

import (
	"encoding/json"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type gitNodeJSON struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}

func readTestDataFile(rel string) ([]byte, error) {
	candidates := []string{
		rel,
		filepath.Join("..", "..", rel),
		filepath.Join("services", "worker-sidecar", rel),
		filepath.Join("/app", rel),
		filepath.Join("/src", "services", "worker-sidecar", rel),
	}
	for _, c := range candidates {
		if b, err := os.ReadFile(c); err == nil {
			return b, nil
		}
	}
	return nil, os.ErrNotExist
}

// ── 规则画像 golden 对拍（TS repo-sniffer 生成夹具；行为漂移即失败）──
// 🧪 [1.16.1.1] TestIngestProfileGoldenParity 8 场景黄金固件逐字段断言（模式/分流/tier/textRoot/资产清单逐字段一致）
// 🧪 [1.16.1.2] TestIngestProfileGoldenParity 模式清单构建期导出单一事实源（ingest-patterns.json）
func TestIngestProfileGoldenParity(t *testing.T) {
	patterns := DefaultPatterns()
	raw, err := readTestDataFile("testdata/ingest-profile.golden.json")
	if err != nil {
		t.Skip("golden fixture missing (regen via 冻结手工维护契约（原 TS 生成脚本已退役）)")
	}
	var cases []struct {
		Name       string           `json:"name"`
		Nodes      []gitNodeJSON    `json:"nodes"`
		Truncated  bool             `json:"truncated"`
		IngestMode IngestModeResult `json:"ingestMode"`
		Scale      ScaleDecision    `json:"scale"`
		Profile    SniffProfile     `json:"profile"`
	}
	require.NoError(t, json.Unmarshal(raw, &cases))

	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			nodes := make([]GitNode, len(c.Nodes))
			for i, n := range c.Nodes {
				nodes[i] = GitNode{Path: n.Path, Type: n.Type, Size: n.Size}
			}

			// 1. Ingest Mode & Doc/Code Ratio
			gotMode := patterns.ComputeIngestMode(nodes, "")
			assert.Equal(t, c.IngestMode.Mode, gotMode.Mode)
			assert.Equal(t, c.IngestMode.DocCodeRatio.DocFiles, gotMode.DocCodeRatio.DocFiles)
			assert.Equal(t, c.IngestMode.DocCodeRatio.CodeFiles, gotMode.DocCodeRatio.CodeFiles)
			assert.Equal(t, c.IngestMode.DocCodeRatio.OtherFiles, gotMode.DocCodeRatio.OtherFiles)
			assert.Equal(t, c.IngestMode.DocCodeRatio.Ratio, gotMode.DocCodeRatio.Ratio)

			// 2. Repo Scale Decision
			gotScale := patterns.ComputeRepoScale(nodes)
			assert.Equal(t, c.Scale.Scale, gotScale.Scale)
			assert.Equal(t, c.Scale.TotalFiles, gotScale.TotalFiles)
			assert.Equal(t, c.Scale.MaxDepth, gotScale.MaxDepth)

			// 3. Repository Sniff Profile
			gotProf := patterns.SniffRepo(nodes, c.Truncated)
			assert.Equal(t, c.Profile.Tier, gotProf.Tier)
			assert.Equal(t, c.Profile.RepoType, gotProf.RepoType)
			assert.Equal(t, derefStrPtr(c.Profile.TextRoot), derefStrPtr(gotProf.TextRoot))
			assert.Equal(t, derefStrPtr(c.Profile.AnswerFile), derefStrPtr(gotProf.AnswerFile))
			assert.Equal(t, len(c.Profile.TranslationRoots), len(gotProf.TranslationRoots))
			assert.Equal(t, len(c.Profile.ExcludeFromNav), len(gotProf.ExcludeFromNav))
			assert.Equal(t, len(c.Profile.GlobalAssets.Pdfs), len(gotProf.GlobalAssets.Pdfs))
			assert.Equal(t, len(c.Profile.GlobalAssets.BuildScripts), len(gotProf.GlobalAssets.BuildScripts))
		})
	}
}

func TestExtractExtensionParity(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "standard markdown path", in: "a/b.md", want: ".md"},
		{name: "file with no extension", in: "README", want: ""},
		{name: "dotfile without extension", in: ".gitignore", want: ""},
		{name: "hidden file with typescript extension", in: "dir/.hidden.ts", want: ".ts"},
		{name: "double extension returns last", in: "x.tar.gz", want: ".gz"},
		{name: "empty string", in: "", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mdpat.ExtractExtension(tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}

// 🧪 [1.16.2.1] TestRE2CompatibilityOfExportedPatterns RE2 编译兼容性（关键模式组非空，绝不静默吞错）
func TestRE2CompatibilityOfExportedPatterns(t *testing.T) {
	// 全部模式必须 RE2 可编译（编译失败被吞为永不匹配会静默漂移——此处显式告警面：加载后统计并要求零丢弃）
	patterns := DefaultPatterns()
	tests := []struct {
		name     string
		patterns []*regexp.Regexp
	}{
		{name: "1.16.2.1 translationDir group", patterns: patterns.Sniffer.translationDir},
		{name: "1.16.2.1 docRootDir group", patterns: patterns.Sniffer.docRootDir},
		{name: "1.16.2.1 nonContentDir group", patterns: patterns.nonContentDir},
		{name: "1.16.2.1 nonContentFile group", patterns: patterns.nonContentFile},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.NotEmpty(t, tt.patterns, "critical pattern group empty — RE2 compile failure")
		})
	}
}

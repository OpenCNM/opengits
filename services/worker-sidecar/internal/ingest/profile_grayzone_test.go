package ingest

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestComputeIngestModeMassAccumulation(t *testing.T) {
	patterns := DefaultPatterns()
	require.NotNil(t, patterns)

	tests := []struct {
		name      string
		nodes     []GitNode
		wantMode  string
		docBytes  int64
		codeBytes int64
	}{
		{
			name: "cline 形态：文档微弱多数 + docs 根触发教程仓保护，质量证据完整累计",
			nodes: func() []GitNode {
				nodes := make([]GitNode, 0, 271)
				for i := 0; i < 144; i++ {
					nodes = append(nodes, GitNode{Path: "docs/doc.mdx", Type: "blob", Size: 6000})
				}
				for i := 0; i < 127; i++ {
					nodes = append(nodes, GitNode{Path: "sdk/packages/core/src/mod.ts", Type: "blob", Size: 40000})
				}
				return nodes
			}(),
			wantMode:  "text_only",
			docBytes:  144 * 6000,
			codeBytes: 127 * 40000,
		},
		{
			name: "size 缺省计 0，不阻断累计（docFiles=1 命中 override 2 → code_only）",
			nodes: []GitNode{
				{Path: "docs/a.md", Type: "blob", Size: 1000},
				{Path: "src/b.ts", Type: "blob"},
				{Path: "src/c.ts", Type: "blob", Size: 2500},
			},
			wantMode:  "code_only",
			docBytes:  1000,
			codeBytes: 2500,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := patterns.ComputeIngestMode(tt.nodes, "")
			assert.Equal(t, tt.docBytes, got.DocCodeRatio.DocBytes)
			assert.Equal(t, tt.codeBytes, got.DocCodeRatio.CodeBytes)
			if tt.wantMode != "" {
				assert.Equal(t, tt.wantMode, got.Mode)
			}
		})
	}
}

func TestMergeProvidedProfilePhysicalGuard(t *testing.T) {
	textPtr := "docs/"
	ruleWithCode := SniffProfile{
		IngestMode: "text_only",
		Tier:       "B",
		RepoType:   "docs",
		TextRoot:   &textPtr,
		DocCodeRatio: DocCodeRatio{
			DocFiles:  144,
			CodeFiles: 127,
			Ratio:     0.53,
			CodeBytes: 5 * 1024 * 1024,
		},
	}
	ruleZeroCode := SniffProfile{
		IngestMode: "text_only",
		Tier:       "B",
		RepoType:   "docs",
		TextRoot:   &textPtr,
		DocCodeRatio: DocCodeRatio{
			DocFiles:  50,
			CodeFiles: 0,
			Ratio:     1.0,
		},
	}

	tests := []struct {
		name         string
		providedMode string
		rule         SniffProfile
		wantMode     string
	}{
		{
			name:         "信封 hybrid 且物理有代码 → 信封权威（scout LLM 仲裁结果）",
			providedMode: "hybrid",
			rule:         ruleWithCode,
			wantMode:     "hybrid",
		},
		{
			name:         "信封 hybrid 但物理零代码 → 物理反证拒收，回退规则 text_only",
			providedMode: "hybrid",
			rule:         ruleZeroCode,
			wantMode:     "text_only",
		},
		{
			name:         "信封 code_only 但物理零代码 → 拒收（RSG 格会硬失败）",
			providedMode: "code_only",
			rule:         ruleZeroCode,
			wantMode:     "text_only",
		},
		{
			name:         "信封 text_only → 不拦（灰区意图裁决权在 scout 侧）",
			providedMode: "text_only",
			rule:         ruleWithCode,
			wantMode:     "text_only",
		},
		{
			name:         "信封缺省 → 规则补位（既有行为）",
			providedMode: "",
			rule:         ruleWithCode,
			wantMode:     "text_only",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provided := &envelopeRepoProfile{SniffProfile: SniffProfile{IngestMode: tt.providedMode}}
			merged := mergeProvidedProfile(provided, tt.rule)
			assert.Equal(t, tt.wantMode, merged.IngestMode)
		})
	}
}

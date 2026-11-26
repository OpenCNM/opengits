package pipelineb

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestExtractPromptPathPatterns_TableDriven(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		want   []string
	}{
		{
			name:   "CJK-adjacent glob pattern without spaces",
			prompt: "保留并深化第5、6章，围绕apps/examples/*/src/index.ts深入剖析Agent的底层设计",
			want:   []string{"apps/examples/*/src/index.ts"},
		},
		{
			name:   "multiple paths and anchors with punctuation",
			prompt: "结合`apps/cli/src/main.ts#bootstrap`与目录 apps/examples/code-review/，忽略https://github.com/cline/cline/blob/main/README.md",
			want:   []string{"apps/cli/src/main.ts", "apps/examples/code-review"},
		},
		{
			name:   "colon label before path does not look like URL",
			prompt: "重点路径:apps/examples/*/src/index.ts，排除apps/desktop",
			want:   []string{"apps/examples/*/src/index.ts", "apps/desktop"},
		},
		{
			name:   "empty or no-slash prose returns nil",
			prompt: "聚焦核心架构与状态流转设计，忽略 README.md",
			want:   nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ExtractPromptPathPatterns(tt.prompt))
		})
	}
}

func TestMatchRepoGlob_TableDriven(t *testing.T) {
	tests := []struct {
		name      string
		pattern   string
		candidate string
		want      bool
	}{
		{
			name:      "single segment wildcard matches nested example index",
			pattern:   "apps/examples/*/src/index.ts",
			candidate: "apps/examples/cli-agent/src/index.ts",
			want:      true,
		},
		{
			name:      "single segment wildcard rejects extra depth",
			pattern:   "apps/examples/*/src/index.ts",
			candidate: "apps/examples/a/b/src/index.ts",
			want:      false,
		},
		{
			name:      "double star matches zero or more segments",
			pattern:   "apps/examples/**/index.ts",
			candidate: "apps/examples/multi-agent/nested/src/index.ts",
			want:      true,
		},
		{
			name:      "double star matches zero intermediate segments",
			pattern:   "apps/examples/**/index.ts",
			candidate: "apps/examples/index.ts",
			want:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, MatchRepoGlob(tt.pattern, tt.candidate))
		})
	}
}

func TestMatchPromptPathsInLeaves_TableDriven(t *testing.T) {
	leaves := []FileMap{
		{Path: "apps/examples/cli-agent/src/index.ts", LOC: 120, Hotness: 30},
		{Path: "apps/examples/multi-agent/src/index.ts", LOC: 180, Hotness: 50},
		{Path: "apps/examples/cli-agent/src/index.test.ts", LOC: 80, IsTest: true},
		{Path: "apps/examples/cli-agent/package.json", LOC: 20, IsConfig: true},
		{Path: "apps/cli/src/index.ts", LOC: 90, Hotness: 40},
		{Path: "apps/desktop/src/app.ts", LOC: 200, Hotness: 60},
	}

	tests := []struct {
		name        string
		prompt      string
		scopePrefix string
		want        []string
	}{
		{
			name:        "glob matches non-test code entrypoints ordered by hotness",
			prompt:      "围绕apps/examples/*/src/index.ts深入剖析",
			scopePrefix: "apps",
			want: []string{
				"apps/examples/multi-agent/src/index.ts",
				"apps/examples/cli-agent/src/index.ts",
			},
		},
		{
			name:        "relative glob under scopePrefix resolves full paths",
			prompt:      "深入 examples/*/src/index.ts 与 cli/src/index.ts",
			scopePrefix: "apps/",
			want: []string{
				"apps/examples/multi-agent/src/index.ts",
				"apps/cli/src/index.ts",
				"apps/examples/cli-agent/src/index.ts",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, MatchPromptPathsInLeaves(tt.prompt, leaves, tt.scopePrefix))
		})
	}
}

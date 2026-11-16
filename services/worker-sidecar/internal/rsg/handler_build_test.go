package rsg

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubGuardPatterns 巨仓护栏计数用的最小 Patterns 桩（node_modules 段判非内容目录）。
type stubGuardPatterns struct{}

func (stubGuardPatterns) IsNonContentDir(path string) bool {
	return strings.Contains(path, "node_modules")
}
func (stubGuardPatterns) IsNonContentFile(_ string) bool { return false }
func (stubGuardPatterns) IsCodeFile(_ string) bool       { return true }
func (stubGuardPatterns) IsDocFile(_ string) bool        { return true }

// 🧪 [1.8.6.4] TestCountValidBlobs 有效文件计数：tree 节点与非内容文件不计数
func TestCountValidBlobs(t *testing.T) {
	tests := []struct {
		name  string
		nodes []GitNode
		want  int
	}{
		{
			name: "tree nodes and non-content dirs are excluded",
			nodes: []GitNode{
				{Path: "src", Type: "tree"},
				{Path: "src/a.ts", Type: "blob"},
				{Path: "node_modules/pkg/b.js", Type: "blob"},
				{Path: "src/c.ts", Type: "blob"},
			},
			want: 2,
		},
		{
			name: "empty node list counts zero",
			want: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, countValidBlobs(tt.nodes, stubGuardPatterns{}))
		})
	}
}

// 🧪 [1.8.6.5] TestBuildGraphArtifactGiantGuard 巨仓拒绝建图
// （对齐证据阶梯「巨型禁 RSG 格」资格裁定：有效文件 > 1000 即拒绝，
// 拒绝回落 404 语义——客户端按既有契约走 TS 投影兜底）
func TestBuildGraphArtifactGiantGuard(t *testing.T) {
	makeBlobs := func(n int) []GitNode {
		nodes := make([]GitNode, 0, n)
		for i := 0; i < n; i++ {
			nodes = append(nodes, GitNode{
				Path: fmt.Sprintf("src/mod_%d/file_%d.ts", i%10, i),
				Type: "blob",
				Size: 100,
			})
		}
		return nodes
	}

	tests := []struct {
		name       string
		nodes      []GitNode
		wantGiant  bool
		wantErrMsg string
	}{
		{
			name:      "1001 valid blobs are refused as giant",
			nodes:     makeBlobs(graphBuildMaxValidFiles + 1),
			wantGiant: true,
		},
		{
			name:       "1000 valid blobs pass the guard and reach the real build stage",
			nodes:      makeBlobs(graphBuildMaxValidFiles),
			wantGiant:  false,
			wantErrMsg: "no parseable source files",
		},
		{
			name: "non-content files do not count toward the guard",
			nodes: func() []GitNode {
				nodes := makeBlobs(10)
				for i := 0; i < graphBuildMaxValidFiles; i++ {
					nodes = append(nodes, GitNode{
						Path: fmt.Sprintf("node_modules/dep/file_%d.js", i),
						Type: "blob",
						Size: 100,
					})
				}
				return nodes
			}(),
			wantGiant: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := NewHandler(Config{}, nil, func() Patterns { return stubGuardPatterns{} })
			artifact, err := h.buildGraphArtifact(context.Background(), GraphBuildRequest{
				Owner: "o", Repo: "r", Sha: "sha-guard", Nodes: tt.nodes,
			})
			require.Error(t, err, "guard tests must not succeed against a fixtureless archive")
			assert.Nil(t, artifact)
			if tt.wantGiant {
				assert.ErrorIs(t, err, errGiantRepoBuild, "oversized repo must be refused by the giant guard")
			} else {
				assert.NotErrorIs(t, err, errGiantRepoBuild, "repos within threshold must pass the guard")
				if tt.wantErrMsg != "" {
					assert.Contains(t, err.Error(), tt.wantErrMsg)
				}
			}
		})
	}
}

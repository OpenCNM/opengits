package update

import (
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/diff"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMapFileToMacroNode(t *testing.T) {
	nodes := []pipelineb.MacroTopologyNode{
		{ID: "node_entry", Path: ".", Name: "Entrypoint"},
		{ID: "node_auth", Path: "pkg/auth", Name: "auth"},
		{ID: "node_api", Path: "pkg/api", Name: "api"},
		{ID: "node_utils", Path: "pkg/common/utils", Name: "utils"},
	}

	tests := []struct {
		file     string
		expected string
	}{
		{file: "main.go", expected: "node_entry"},
		{file: "pkg/auth/token.go", expected: "node_auth"},
		{file: "pkg/auth/sub/oauth.go", expected: "node_auth"},
		{file: "pkg/api/handler.go", expected: "node_api"},
		{file: "pkg/common/utils/strings.go", expected: "node_utils"},
		{file: "other/misc.go", expected: "node_utils"},
	}

	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			got := MapFileToMacroNode(tt.file, nodes)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func TestComputeArchitectureDrift_TableDriven(t *testing.T) {
	topo := &pipelineb.MacroTopology{
		Scale: 1,
		Nodes: []pipelineb.MacroTopologyNode{
			{ID: "node_auth", Path: "auth", Name: "auth"},
			{ID: "node_api", Path: "api", Name: "api"},
			{ID: "node_core", Path: "core", Name: "core"},
		},
		Edges: []pipelineb.MacroTopologyEdge{
			{From: "node_api", To: "node_auth", Symbols: []string{"VerifyToken"}},
			{From: "node_api", To: "node_core", Symbols: []string{"Execute"}},
		},
		RawMermaid: "flowchart TD\nnode_api --> node_auth\nnode_api --> node_core\n",
	}

	t.Run("pure_internal_modification_remains_safe", func(t *testing.T) {
		diffResult := &UpdateArchiveDiff{
			Modified: []string{"auth/hash.go"},
		}
		fileDiffs := map[string]diff.FileSemanticDiff{
			"auth/hash.go": {
				Path:     "auth/hash.go",
				Category: diff.FileCategoryPrivateOnly,
				Details:  "仅内部私有函数修改",
			},
		}
		rippleCallers := map[string][]diff.SurgicalAnchor{}

		drift := ComputeArchitectureDrift(topo, diffResult, fileDiffs, rippleCallers)
		require.NotNil(t, drift)
		assert.True(t, drift.HasDrift)
		assert.False(t, drift.IsCrossBoundary)
		assert.Contains(t, drift.Verdict, "子系统内部实现平滑升级")

		var authNode, apiNode, coreNode *NodeDriftInfo
		for i := range drift.AffectedNodes {
			n := &drift.AffectedNodes[i]
			switch n.NodeID {
			case "node_auth":
				authNode = n
			case "node_api":
				apiNode = n
			case "node_core":
				coreNode = n
			}
		}
		require.NotNil(t, authNode)
		require.NotNil(t, apiNode)
		require.NotNil(t, coreNode)

		assert.Equal(t, NodeDriftModified, authNode.Status)
		assert.Equal(t, NodeDriftStable, apiNode.Status)
		assert.Equal(t, NodeDriftStable, coreNode.Status)

		assert.Empty(t, drift.AffectedEdges)
	})

	t.Run("cross_boundary_breaking_change_triggers_alarm", func(t *testing.T) {
		diffResult := &UpdateArchiveDiff{
			Modified: []string{"auth/token.go"},
		}
		fileDiffs := map[string]diff.FileSemanticDiff{
			"auth/token.go": {
				Path:     "auth/token.go",
				Category: diff.FileCategoryExportedChanged,
				SymbolDiffs: []diff.SymbolDiffItem{
					{Name: "VerifyToken", Exported: true, Change: "modified"},
				},
				Details: "公共导出函数 VerifyToken 签名变更",
			},
		}
		rippleCallers := map[string][]diff.SurgicalAnchor{
			"api/handler.go": {
				{
					File:       "api/handler.go",
					SymbolName: "HandleAuth",
					Change:     "ripple",
					Reason:     "调用了已变更的上游导出符号 auth/token.go::VerifyToken (modified)",
				},
			},
		}

		drift := ComputeArchitectureDrift(topo, diffResult, fileDiffs, rippleCallers)
		require.NotNil(t, drift)
		assert.True(t, drift.HasDrift)
		assert.True(t, drift.IsCrossBoundary)
		assert.Contains(t, drift.Verdict, "跨子系统契约漂移")

		var authNode, apiNode *NodeDriftInfo
		for i := range drift.AffectedNodes {
			n := &drift.AffectedNodes[i]
			if n.NodeID == "node_auth" {
				authNode = n
			} else if n.NodeID == "node_api" {
				apiNode = n
			}
		}
		require.NotNil(t, authNode)
		require.NotNil(t, apiNode)

		assert.Equal(t, NodeDriftBreaking, authNode.Status)
		assert.Contains(t, authNode.Summary, "VerifyToken")

		require.Len(t, drift.AffectedEdges, 1)
		edge := drift.AffectedEdges[0]
		assert.Equal(t, "node_api", edge.From)
		assert.Equal(t, "node_auth", edge.To)
		assert.Equal(t, EdgeDriftBroken, edge.Status)

		mermaid := drift.DriftMermaid
		assert.Contains(t, mermaid, "class node_auth nodeBreaking;")
		assert.Contains(t, mermaid, "class node_api nodeModified;")
		assert.Contains(t, mermaid, "classDef nodeBreaking")
	})
}

func TestComputeArchitectureDrift_MultiPackageMonorepoRegression(t *testing.T) {
	patterns := cognitive.DefaultPatterns()

	files := []pipelineb.FileMap{
		{Path: "packages/auth/package.json", LOC: 20, IsConfig: true},
		{Path: "packages/auth/token.go", LOC: 250, Exports: []string{"VerifyToken", "SignClaim"}, Hotness: 90},
		{Path: "packages/auth/hash.go", LOC: 120, Hotness: 40},
		{Path: "packages/api/package.json", LOC: 20, IsConfig: true},
		{Path: "packages/api/handler.go", LOC: 300, Exports: []string{"HandleAuth"}, Hotness: 70},
		{Path: "packages/core/package.json", LOC: 20, IsConfig: true},
		{Path: "packages/core/engine.go", LOC: 400, Exports: []string{"Execute"}, Hotness: 85},
	}
	m := &pipelineb.RepoMap{
		RepoName: "monorepo",
		Files:    files,
		Tree:     pipelineb.BuildRepoTree(files, "monorepo"),
		CallEdges: []pipelineb.ASTCallEdge{
			{Caller: "packages/api/handler.go", Callee: "packages/auth/token.go", Symbol: "VerifyToken"},
			{Caller: "packages/api/handler.go", Callee: "packages/core/engine.go", Symbol: "Execute"},
		},
	}

	topo := pipelineb.BuildMacroTopology(m, "", 1, patterns)
	require.NotNil(t, topo)
	assert.Equal(t, "directory", topo.Strategy)

	nodeByID := make(map[string]pipelineb.MacroTopologyNode, len(topo.Nodes))
	for _, n := range topo.Nodes {
		nodeByID[n.ID] = n
	}
	require.Len(t, topo.Nodes, 3)
	for id, wantPath := range map[string]string{
		"sub_auth": "packages/auth",
		"sub_api":  "packages/api",
		"sub_core": "packages/core",
	} {
		n, ok := nodeByID[id]
		require.True(t, ok, "expected node %s in topology", id)
		assert.Equal(t, wantPath, n.Path)
	}

	mapping := map[string]string{
		"packages/auth/token.go":      "sub_auth",
		"packages/auth/inner/sign.go": "sub_auth",
		"packages/api/handler.go":     "sub_api",
		"packages/core/engine.go":     "sub_core",
	}
	for file, wantID := range mapping {
		assert.Equal(t, wantID, MapFileToMacroNode(file, topo.Nodes), "file %s should map by longest dir prefix", file)
	}
	assert.Empty(t, MapFileToMacroNode("misc/root.go", topo.Nodes), "unmapped file falls back to empty")

	authEdgeFound, coreEdgeFound := false, false
	for _, e := range topo.Edges {
		if e.From != "sub_api" {
			continue
		}
		switch e.To {
		case "sub_auth":
			authEdgeFound = true
			assert.Contains(t, e.Symbols, "VerifyToken")
		case "sub_core":
			coreEdgeFound = true
			assert.Contains(t, e.Symbols, "Execute")
		}
	}
	assert.True(t, authEdgeFound, "expected edge sub_api -> sub_auth")
	assert.True(t, coreEdgeFound, "expected edge sub_api -> sub_core")

	diffResult := &UpdateArchiveDiff{
		Modified: []string{"packages/auth/token.go"},
	}
	fileDiffs := map[string]diff.FileSemanticDiff{
		"packages/auth/token.go": {
			Path:     "packages/auth/token.go",
			Category: diff.FileCategoryExportedChanged,
			SymbolDiffs: []diff.SymbolDiffItem{
				{Name: "VerifyToken", Exported: true, Change: "modified"},
			},
		},
	}
	rippleCallers := map[string][]diff.SurgicalAnchor{
		"packages/api/handler.go": {
			{
				File:       "packages/api/handler.go",
				SymbolName: "HandleAuth",
				Change:     "ripple",
				Reason:     "调用了已变更的上游导出符号 packages/auth/token.go::VerifyToken (modified)",
			},
		},
	}

	drift := ComputeArchitectureDrift(topo, diffResult, fileDiffs, rippleCallers)
	require.NotNil(t, drift)
	assert.True(t, drift.HasDrift)
	assert.True(t, drift.IsCrossBoundary)
	assert.Contains(t, drift.Verdict, "跨子系统契约漂移")

	statusByID := make(map[string]NodeDriftStatus, len(drift.AffectedNodes))
	var authNode *NodeDriftInfo
	for i := range drift.AffectedNodes {
		n := &drift.AffectedNodes[i]
		statusByID[n.NodeID] = n.Status
		if n.NodeID == "sub_auth" {
			authNode = n
		}
	}
	assert.Equal(t, NodeDriftBreaking, statusByID["sub_auth"])
	assert.Equal(t, NodeDriftModified, statusByID["sub_api"])
	assert.Equal(t, NodeDriftStable, statusByID["sub_core"])
	require.NotNil(t, authNode)
	assert.Contains(t, authNode.Summary, "VerifyToken")

	require.Len(t, drift.AffectedEdges, 1)
	assert.Equal(t, "sub_api", drift.AffectedEdges[0].From)
	assert.Equal(t, "sub_auth", drift.AffectedEdges[0].To)
	assert.Equal(t, EdgeDriftBroken, drift.AffectedEdges[0].Status)

	assert.Contains(t, drift.DriftMermaid, "class sub_auth nodeBreaking;")
	assert.Contains(t, drift.DriftMermaid, "class sub_api nodeModified;")
}

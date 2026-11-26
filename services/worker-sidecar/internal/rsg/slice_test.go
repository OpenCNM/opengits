package rsg

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func createTestArtifact() *SemanticGraphArtifact {
	return &SemanticGraphArtifact{
		Version: 2,
		GitSha:  "sha123456",
		Nodes: []SemanticGraphArtifactNode{
			{
				Path:     "src/index.ts",
				Role:     RoleCoreContract,
				PageRank: 0.85,
			},
			{
				Path:     "test/index.test.ts",
				Role:     RoleLeafUtility,
				PageRank: 0.20,
			},
		},
		SymbolsByFile: map[string][]SymbolEntry{
			"src/index.ts": {
				{Name: "EventType", Kind: "type", StartLine: 45, EndLine: 45, Exported: true},
				{Name: "on", Kind: "function", StartLine: 40, EndLine: 50, Exported: true},
				{Name: "emit", Kind: "function", StartLine: 55, EndLine: 70, Exported: true},
				{Name: "internalHelper", Kind: "function", StartLine: 72, EndLine: 80, Exported: false},
			},
		},
		CallEdges: []CallEdge{
			{
				CallerFile:   "test/index.test.ts",
				CallerSymbol: "testEmit",
				CalleeFile:   "src/index.ts",
				CalleeSymbol: "emit",
				Line:         89,
			},
			{
				CallerFile:   "src/index.ts",
				CallerSymbol: "emit",
				CalleeFile:   "src/handler.ts",
				CalleeSymbol: "dispatch",
				Line:         62,
			},
		},
	}
}

func TestExtractTopologySlice_ExactSymbolAndCallEdges(t *testing.T) {
	artifact := createTestArtifact()

	req := TopologySliceRequest{
		Owner:  "developit",
		Repo:   "mitt",
		Sha:    "sha123456",
		Path:   "src/index.ts",
		Symbol: "emit",
	}

	res := ExtractTopologySlice(artifact, req)
	require.NotNil(t, res)
	assert.True(t, res.Found)
	assert.Equal(t, "src/index.ts", res.FilePath)
	require.NotNil(t, res.TargetSymbol)
	assert.Equal(t, "emit", res.TargetSymbol.Name)
	assert.Equal(t, 55, res.TargetSymbol.StartLine)

	require.Len(t, res.Callers, 1)
	assert.Equal(t, "test/index.test.ts", res.Callers[0].CallerFile)
	assert.Equal(t, "testEmit", res.Callers[0].CallerSymbol)

	require.Len(t, res.Callees, 1)
	assert.Equal(t, "src/handler.ts", res.Callees[0].CalleeFile)
	assert.Equal(t, "dispatch", res.Callees[0].CalleeSymbol)

	assert.NotEmpty(t, res.PeerSymbols)
	peerNames := make([]string, len(res.PeerSymbols))
	for i, ps := range res.PeerSymbols {
		peerNames[i] = ps.Name
	}
	assert.Contains(t, peerNames, "on")
	assert.Contains(t, peerNames, "EventType")
	assert.NotContains(t, peerNames, "emit", "target symbol itself should not be listed as peer")
	assert.NotContains(t, peerNames, "internalHelper", "unexported symbol should not be listed as peer")

	text := res.TopologyText
	assert.Contains(t, text, "[Physical Code Topology: src/index.ts#emit]")
	assert.Contains(t, text, "Upstream Callers (Who calls this):")
	assert.Contains(t, text, "test/index.test.ts:89 in testEmit")
	assert.Contains(t, text, "Downstream Dependencies (What this calls):")
	assert.Contains(t, text, "src/handler.ts -> dispatch at line 62")
	assert.Contains(t, text, "Related Exported Symbols:")
}

func TestExtractTopologySlice_LineProximityMatch(t *testing.T) {
	artifact := createTestArtifact()

	req := TopologySliceRequest{
		Owner: "developit",
		Repo:  "mitt",
		Sha:   "sha123456",
		Path:  "src/index.ts",
		Line:  58,
	}

	res := ExtractTopologySlice(artifact, req)
	require.NotNil(t, res)
	assert.True(t, res.Found)
	require.NotNil(t, res.TargetSymbol)
	assert.Equal(t, "emit", res.TargetSymbol.Name)
}

func TestExtractTopologySlice_TokenBudgetBound(t *testing.T) {
	artifact := createTestArtifact()

	for i := 1; i <= 20; i++ {
		artifact.CallEdges = append(artifact.CallEdges, CallEdge{
			CallerFile:   "pkg/caller.ts",
			CallerSymbol: "callerFn",
			CalleeFile:   "src/index.ts",
			CalleeSymbol: "emit",
			Line:         100 + i,
		})
		artifact.CallEdges = append(artifact.CallEdges, CallEdge{
			CallerFile:   "src/index.ts",
			CallerSymbol: "emit",
			CalleeFile:   "pkg/callee.ts",
			CalleeSymbol: "calleeFn",
			Line:         200 + i,
		})
	}

	req := TopologySliceRequest{
		Owner:  "developit",
		Repo:   "mitt",
		Sha:    "sha123456",
		Path:   "src/index.ts",
		Symbol: "emit",
	}

	res := ExtractTopologySlice(artifact, req)
	require.NotNil(t, res)

	assert.LessOrEqual(t, len(res.Callers), maxSliceCallers)
	assert.LessOrEqual(t, len(res.Callees), maxSliceCallees)

	tokens := mdpat.EstimateTokens(res.TopologyText)
	assert.LessOrEqual(t, tokens, maxSliceTextTokens, "TopologyText must strictly adhere to 300 token budget")
}

func TestExtractTopologySlice_NilAndEmptyGraceful(t *testing.T) {
	req := TopologySliceRequest{
		Owner: "developit",
		Repo:  "mitt",
		Sha:   "sha123456",
		Path:  "non/existent.ts",
	}

	nilRes := ExtractTopologySlice(nil, req)
	assert.False(t, nilRes.Found)
	assert.Empty(t, nilRes.TopologyText)

	artifact := createTestArtifact()
	notFoundRes := ExtractTopologySlice(artifact, req)
	assert.False(t, notFoundRes.Found)
	assert.Contains(t, notFoundRes.TopologyText, "Upstream Callers")
}

func TestHandleTopologySlice_HttpEndpoint(t *testing.T) {
	cfg := Config{}
	handler := NewHandler(cfg, nil, nil)
	routes := handler.testRoutes("test-token")

	reqBody, _ := json.Marshal(TopologySliceRequest{
		Owner: "test",
		Repo:  "repo",
		Path:  "src/index.ts",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/graph/slice-context", bytes.NewReader(reqBody))
	req.Header.Set("x-internal-token", "test-token")
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	routes.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp TopologySliceResponse
	err := json.NewDecoder(w.Body).Decode(&resp)
	require.NoError(t, err)
	assert.Equal(t, "src/index.ts", resp.FilePath)
}

package cognitive

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestArtifactPayloadRoundTrip(t *testing.T) {
	sample := &SemanticGraphArtifact{
		Version:     2,
		GeneratedAt: "2026-11-18T00:00:00Z",
		GitSha:      "abc1234",
		Nodes: []SemanticGraphArtifactNode{
			{Path: "src/main.go", Role: RoleEntryPoint, PageRank: 0.42},
		},
		EntryPoints: []string{"src/main.go"},
		SymbolsByFile: map[string][]SymbolEntry{
			"src/main.go": {
				{Name: "RunServer", Kind: "function", StartLine: 10, EndLine: 25, Exported: true, Importers: 3},
				{Name: "Config", Kind: "type", StartLine: 1, EndLine: 8, Exported: true},
			},
		},
		GoldenSymbols: []GoldenSymbol{
			{Name: "RunServer", Kind: "function", File: "src/main.go", Importers: 3},
		},
	}

	tests := []struct {
		name      string
		payloadFn func() ([]byte, int, error)
		wantErr   bool
	}{
		{
			name: "encode and decode gzipped v3 payload preserves symbols and nodes",
			payloadFn: func() ([]byte, int, error) {
				return EncodeArtifactPayload(sample)
			},
		},
		{
			name: "empty payload returns error",
			payloadFn: func() ([]byte, int, error) {
				return []byte{}, 0, nil
			},
			wantErr: true,
		},
		{
			name: "invalid format returns error",
			payloadFn: func() ([]byte, int, error) {
				return []byte("not-a-valid-graph"), 0, nil
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, symCount, err := tt.payloadFn()
			require.NoError(t, err)

			decoded, derr := DecodeArtifactPayload(raw)
			if tt.wantErr {
				require.Error(t, derr)
				return
			}

			require.NoError(t, derr)
			require.NotNil(t, decoded)
			assert.Equal(t, 2, symCount)
			assert.Equal(t, sample.GitSha, decoded.GitSha)
			assert.Equal(t, sample.EntryPoints, decoded.EntryPoints)
			assert.Len(t, decoded.SymbolsByFile["src/main.go"], 2)
			assert.Equal(t, "RunServer", decoded.SymbolsByFile["src/main.go"][0].Name)
			assert.Equal(t, 10, decoded.SymbolsByFile["src/main.go"][0].StartLine)
		})
	}
}

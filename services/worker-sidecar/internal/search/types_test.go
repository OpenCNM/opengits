package search

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 静态接口契约断言：验证 PgxStore 满足 search.Engine 接口
var _ Engine = (*PgxStore)(nil)
var _ SearchEngine = (*PgxStore)(nil)

type mockEngine struct {
	fn func(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error)
}

func (m *mockEngine) SearchChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
	if m.fn != nil {
		return m.fn(ctx, req)
	}
	return nil, nil
}

// 🧪 Table-Driven: 验证 SearchChunksRequest 与 SearchChunkHit 序列化与反序列化对拍
func TestSearchTypes_Serialization(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	intPtr := func(i int) *int { return &i }
	floatPtr := func(f float64) *float64 { return &f }

	tests := []struct {
		name     string
		req      SearchChunksRequest
		hit      SearchChunkHit
		validate func(t *testing.T, reqJSON []byte, hitJSON []byte)
	}{
		{
			name: "minimal payload with zero values",
			req: SearchChunksRequest{
				Query: "test query",
			},
			hit: SearchChunkHit{
				ChunkID:    "chunk-1",
				DocID:      "doc-1",
				Title:      "Title 1",
				Path:       "README.md",
				Snippet:    "A snippet",
				Similarity: 0.95,
			},
			validate: func(t *testing.T, reqJSON []byte, hitJSON []byte) {
				var r SearchChunksRequest
				err := json.Unmarshal(reqJSON, &r)
				require.NoError(t, err)
				assert.Equal(t, "test query", r.Query)
				assert.Empty(t, r.RepositoryID)

				var h SearchChunkHit
				err = json.Unmarshal(hitJSON, &h)
				require.NoError(t, err)
				assert.Equal(t, "chunk-1", h.ChunkID)
				assert.Nil(t, h.Heading)
				assert.Nil(t, h.MatchCount)
			},
		},
		{
			name: "rich payload with optional fields and pointers",
			req: SearchChunksRequest{
				RepositoryID:   "repo-123",
				Query:          "ast parsing",
				RawQuery:       "ast parsing raw",
				Limit:          20,
				UserID:         strPtr("user-admin"),
				Locale:         "en",
				Version:        "v1.0",
				ContentTypes:   []string{"markdown", "code"},
				IsGlobal:       false,
				SnippetMaxLen:  300,
				IncludeContent: true,
				TokenBudget:    4000,
			},
			hit: SearchChunkHit{
				ChunkID:      "c-rich",
				DocID:        "d-rich",
				Title:        "Advanced Architecture",
				Path:         "docs/arch.md",
				Heading:      strPtr("Engine Structure"),
				HeadingPath:  strPtr("Docs > Arch > Engine"),
				Snippet:      "Comprehensive overview of engine...",
				Similarity:   0.88,
				Owner:        "opengits",
				Repo:         "worker-sidecar",
				Content:      "Full body content...",
				EditionLabel: strPtr("Architect Edition"),
				MatchCount:   intPtr(5),
				FtsRank:      floatPtr(0.912),
			},
			validate: func(t *testing.T, reqJSON []byte, hitJSON []byte) {
				var r SearchChunksRequest
				err := json.Unmarshal(reqJSON, &r)
				require.NoError(t, err)
				assert.Equal(t, "repo-123", r.RepositoryID)
				assert.Equal(t, "ast parsing", r.Query)
				assert.Equal(t, 20, r.Limit)
				assert.Equal(t, "user-admin", *r.UserID)
				assert.Equal(t, 4000, r.TokenBudget)

				var h SearchChunkHit
				err = json.Unmarshal(hitJSON, &h)
				require.NoError(t, err)
				assert.Equal(t, "c-rich", h.ChunkID)
				assert.Equal(t, "Engine Structure", *h.Heading)
				assert.Equal(t, 5, *h.MatchCount)
				assert.InDelta(t, 0.912, *h.FtsRank, 0.0001)
				assert.Equal(t, "Architect Edition", *h.EditionLabel)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reqBytes, err := json.Marshal(tt.req)
			require.NoError(t, err)
			hitBytes, err := json.Marshal(tt.hit)
			require.NoError(t, err)

			tt.validate(t, reqBytes, hitBytes)
		})
	}
}

// 🧪 Table-Driven: 验证 Engine 接口抽象与实现隔离
func TestSearchEngine_InterfaceContract(t *testing.T) {
	tests := []struct {
		name        string
		engine      Engine
		req         SearchChunksRequest
		expectedLen int
		expectError bool
	}{
		{
			name: "mock engine returns hits successfully",
			engine: &mockEngine{
				fn: func(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {
					return []SearchChunkHit{{ChunkID: "c1"}, {ChunkID: "c2"}}, nil
				},
			},
			req:         SearchChunksRequest{Query: "test"},
			expectedLen: 2,
			expectError: false,
		},
		{
			name: "nil fn mock returns empty nil without error",
			engine:      &mockEngine{},
			req:         SearchChunksRequest{Query: "empty"},
			expectedLen: 0,
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hits, err := tt.engine.SearchChunks(context.Background(), tt.req)
			if tt.expectError {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Len(t, hits, tt.expectedLen)
			}
		})
	}
}

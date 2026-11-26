package mcp

import (
	"context"
	"encoding/json"

	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/outlineloader"
)

func (s *pgxStore) ToolPolicyMap(ctx context.Context) (map[string]ToolPolicy, error) {
	rows, err := db.New(s.pool).MCPListToolPolicies(ctx)
	if err != nil {
		return nil, err
	}
	m := make(map[string]ToolPolicy, len(rows))
	for _, r := range rows {
		m[r.ToolName] = ToolPolicy{
			IsEnabled:       r.IsEnabled,
			TokenBudget:     int(r.TokenBudget),
			TierRequirement: r.TierRequirement,
		}
	}
	return m, nil
}

func (s *pgxStore) InsertCallLog(_ context.Context, e CallLogEntry) error {
	if s.batcher != nil {
		s.batcher.enqueue(e)
		return nil
	}
	if s.pool == nil {
		return nil
	}
	return db.New(s.pool).MCPInsertCallLog(context.Background(), db.MCPInsertCallLogParams{
		ToolName:       e.ToolName,
		UserId:         e.UserID,
		ClientName:     e.ClientName,
		RepositoryId:   e.RepositoryID,
		Dimension:      e.Dimension,
		Status:         e.Status,
		ResultCount:    int32(e.ResultCount),
		ResponseTimeMs: int32(e.ResponseTimeMs),
	})
}

func (s *pgxStore) GetActiveOutline(ctx context.Context, repositoryID string) (*ActiveOutlineInfo, error) {
	tree, err := outlineloader.LoadActiveOutlineTree(ctx, s.pool, repositoryID)
	if err != nil {
		return nil, err
	}
	if tree == nil {
		return nil, nil
	}

	nodes := tree.BuildRawNavTree()
	var navTreeJSON []byte
	if len(nodes) > 0 {
		var marshalErr error
		navTreeJSON, marshalErr = json.Marshal(nodes)
		if marshalErr != nil {
			navTreeJSON = nil
		}
	}

	return &ActiveOutlineInfo{
		OutlineID: tree.OutlineID,
		Mode:      tree.Mode,
		Version:   tree.Version,
		NavTree:   navTreeJSON,
	}, nil
}

package update

import (
	"context"
	"encoding/json"

	"github.com/opengits/worker-sidecar/internal/platform/outlineloader"
)

func (s *PgxStore) LoadEffectiveNavTree(ctx context.Context, q dbExec, repoID, owner, repoName string, fallbackNavTreeJSON []byte) ([]*NavNode, error) {
	tree, err := outlineloader.LoadActiveOutlineTree(ctx, q, repoID)
	if err != nil || tree == nil {
		return parseFallbackNavTree(fallbackNavTreeJSON), nil
	}

	nodes := tree.BuildNavTree(func(nPath string) (string, string) {
		return navNodeBaseName(nPath), buildDocUrl(nPath, owner, repoName)
	})

	if len(nodes) > 0 {
		return nodes, nil
	}

	return parseFallbackNavTree(fallbackNavTreeJSON), nil
}

func parseFallbackNavTree(fallbackNavTreeJSON []byte) []*NavNode {
	if len(fallbackNavTreeJSON) > 0 {
		var tree []*NavNode
		if err := json.Unmarshal(fallbackNavTreeJSON, &tree); err == nil && len(tree) > 0 {
			return tree
		}
	}
	return []*NavNode{}
}

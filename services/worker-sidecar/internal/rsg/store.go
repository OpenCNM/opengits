package rsg

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// GraphArtifactRepo 语义图谱数据库持久化契约。
type GraphArtifactRepo = cognitive.GraphArtifactRepo

// NewPgGraphStore 构建基于 pgxpool 的语义图谱持久化存取器。
func NewPgGraphStore(pool *pgxpool.Pool) *cognitive.PgGraphStore {
	return cognitive.NewPgGraphStore(pool)
}

// AssertSafeSegment ensures a path segment contains no path traversal characters.
// Delegates to httpx.AssertSafeSegment as the canonical source of truth.
func AssertSafeSegment(seg string) error {
	return httpx.AssertSafeSegment(seg)
}

// SemanticGraphPathFor returns the path for an artifact: {storeDir}/{owner}/{repo}/{sha}.json.
func SemanticGraphPathFor(storeDir, owner, repo, sha string) (string, error) {
	return cognitive.SemanticGraphPathFor(storeDir, owner, repo, sha)
}

// SaveSemanticGraphArtifact writes the artifact JSON to disk atomically.
func SaveSemanticGraphArtifact(storeDir, owner, repo, sha string, artifact *SemanticGraphArtifact) (string, error) {
	return cognitive.SaveSemanticGraphArtifact(storeDir, owner, repo, sha, artifact)
}

// LoadSemanticGraphArtifact reads and parses the artifact from disk.
func LoadSemanticGraphArtifact(storeDir, owner, repo, sha string) (*SemanticGraphArtifact, error) {
	return cognitive.LoadSemanticGraphArtifact(storeDir, owner, repo, sha)
}

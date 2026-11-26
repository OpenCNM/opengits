package rsg

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type GraphArtifactRepo = cognitive.GraphArtifactRepo

func NewPgGraphStore(pool *pgxpool.Pool) *cognitive.PgGraphStore {
	return cognitive.NewPgGraphStore(pool)
}

func AssertSafeSegment(seg string) error {
	return httpx.AssertSafeSegment(seg)
}

func SemanticGraphPathFor(storeDir, owner, repo, sha string) (string, error) {
	return cognitive.SemanticGraphPathFor(storeDir, owner, repo, sha)
}

func SaveSemanticGraphArtifact(storeDir, owner, repo, sha string, artifact *SemanticGraphArtifact) (string, error) {
	return cognitive.SaveSemanticGraphArtifact(storeDir, owner, repo, sha, artifact)
}

func LoadSemanticGraphArtifact(storeDir, owner, repo, sha string) (*SemanticGraphArtifact, error) {
	return cognitive.LoadSemanticGraphArtifact(storeDir, owner, repo, sha)
}

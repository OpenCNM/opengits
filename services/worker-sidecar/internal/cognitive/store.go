package cognitive

import (
	"encoding/json"
	"fmt"
	"github.com/opengits/worker-sidecar/internal/platform/filecache"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
	"os"
	"path/filepath"
)

// In-process LRU checks mtime+size so "head" overwrites invalidate safely; returned artifacts are shared read-only.

var semanticGraphCache = filecache.New[*SemanticGraphArtifact](16)

func SemanticGraphPathFor(storeDir, owner, repo, sha string) (string, error) {
	if err := httpx.AssertSafeSegment(owner); err != nil {
		return "", err
	}
	if err := httpx.AssertSafeSegment(repo); err != nil {
		return "", err
	}
	if err := httpx.AssertSafeSegment(sha); err != nil {
		return "", err
	}
	if storeDir == "" {
		storeDir = "storage/graphs"
	}
	return filepath.Join(storeDir, owner, repo, sha+".json"), nil
}

func SaveSemanticGraphArtifact(storeDir, owner, repo, sha string, artifact *SemanticGraphArtifact) (string, error) {
	file, err := SemanticGraphPathFor(storeDir, owner, repo, sha)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return "", fmt.Errorf("ensure dir %s: %w", filepath.Dir(file), err)
	}
	data, err := encodeSegmentedV3(artifact)
	if err != nil {
		return "", fmt.Errorf("encode artifact v3: %w", err)
	}
	tmpFile := fmt.Sprintf("%s.tmp-%d", file, os.Getpid())
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return "", fmt.Errorf("write tmp artifact %s: %w", tmpFile, err)
	}
	if err := os.Rename(tmpFile, file); err != nil {
		_ = os.Remove(tmpFile)
		return "", fmt.Errorf("rename artifact to %s: %w", file, err)
	}
	semanticGraphCache.Put(file, artifact)
	return file, nil
}

func LoadSemanticGraphArtifact(storeDir, owner, repo, sha string) (*SemanticGraphArtifact, error) {
	file, err := SemanticGraphPathFor(storeDir, owner, repo, sha)
	if err != nil {
		return nil, err
	}
	if cached, ok := semanticGraphCache.Get(file); ok {
		return cached, nil
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	// Reads both v3 segmented containers and legacy v2 full JSON while writes emit v3 only.
	if isSegmentedV3(data) {
		seg, serr := decodeSegmentedV3(data)
		if serr != nil {
			return nil, fmt.Errorf("decode segmented artifact %s: %w", file, serr)
		}
		semanticGraphCache.Put(file, seg)
		return seg, nil
	}
	var artifact SemanticGraphArtifact
	if err := json.Unmarshal(data, &artifact); err != nil {
		return nil, fmt.Errorf("unmarshal artifact %s: %w", file, err)
	}
	if artifact.Version != 2 {
		return nil, fmt.Errorf("unsupported artifact version %d in %s", artifact.Version, file)
	}
	semanticGraphCache.Put(file, &artifact)
	return &artifact, nil
}

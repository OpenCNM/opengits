package pipelineb

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"

	"github.com/opengits/worker-sidecar/internal/platform/filecache"
)

const TreeMapCacheVersion = 1

type TreeMapCache struct {
	Version int           `json:"version"`
	GitSha  string        `json:"gitSha"`
	Tree    *RepoTreeNode `json:"tree"`
}

func TreeMapPathFor(storeDir, owner, repo, sha string) (string, error) {
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
		storeDir = "storage/treemaps"
	}
	return filepath.Join(storeDir, owner, repo, sha+".json"), nil
}

func SaveTreeMap(storeDir, owner, repo, sha string, cache *TreeMapCache) (string, error) {
	cache.Version = TreeMapCacheVersion
	file, err := TreeMapPathFor(storeDir, owner, repo, sha)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return "", fmt.Errorf("ensure dir %s: %w", filepath.Dir(file), err)
	}
	data, err := json.Marshal(cache)
	if err != nil {
		return "", fmt.Errorf("marshal treemap: %w", err)
	}
	tmp := fmt.Sprintf("%s.tmp-%d", file, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", fmt.Errorf("write tmp treemap: %w", err)
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("rename treemap: %w", err)
	}
	treemapCache.Put(file, cache)
	return file, nil
}

// In-process LRU validates mtime+size against immutable SHA caches; callers must treat returned trees as read-only.
var treemapCache = filecache.New[*TreeMapCache](16)

func LoadTreeMap(storeDir, owner, repo, sha string) (*TreeMapCache, error) {
	file, err := TreeMapPathFor(storeDir, owner, repo, sha)
	if err != nil {
		return nil, err
	}
	if cached, ok := treemapCache.Get(file); ok {
		return cached, nil
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var cache TreeMapCache
	if err := json.Unmarshal(data, &cache); err != nil {
		return nil, fmt.Errorf("malformed treemap %s: %w", file, err)
	}
	if cache.Version != TreeMapCacheVersion {
		return nil, fmt.Errorf("treemap version mismatch: got %d want %d (%s)", cache.Version, TreeMapCacheVersion, file)
	}
	treemapCache.Put(file, &cache)
	return &cache, nil
}

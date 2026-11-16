package pipelineb

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"

	"github.com/opengits/worker-sidecar/internal/platform/filecache"
)

// ─────────────────────────────────────────────────────────────
// 树地图 SHA 缓存(A4,镜像 cognitive/store.go 模式)。
//
// 重导与增量更新只重建变更子树的前提:地图按 (owner, repo, sha) 内容
// 寻址落盘;原子写(tmp+rename)防半成品;版本不符拒读(结构演化安全)。
// ─────────────────────────────────────────────────────────────

// TreeMapCacheVersion 缓存结构版本(拒读未来/过期版本)。
const TreeMapCacheVersion = 1

// TreeMapCache 缓存载荷:整棵折叠树(含上卷与叶载荷)。
type TreeMapCache struct {
	Version int           `json:"version"`
	GitSha  string        `json:"gitSha"`
	Tree    *RepoTreeNode `json:"tree"`
}

// TreeMapPathFor 目录地图落盘路径(storage/treemaps/{owner}/{repo}/{sha}.json)。
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

// SaveTreeMap 原子写树地图。
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

// treemapCache 进程内 LRU：树大纲/下钻每请求 LoadTreeMap 全量读盘 +
// JSON 反序列化（next.js 仓单文件 5.7MB）。SHA 内容寻址不可变，mtime+size
// 校验兜底覆写。返回共享只读实例，消费方不得原地修改。
var treemapCache = filecache.New[*TreeMapCache](16)

// LoadTreeMap 读取缓存;版本不符或缺失返回 error(调用方重建)。
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

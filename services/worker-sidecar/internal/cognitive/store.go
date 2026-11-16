package cognitive

import (
	"encoding/json"
	"fmt"
	"github.com/opengits/worker-sidecar/internal/platform/filecache"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
	"os"
	"path/filepath"
)

// ─────────────────────────────────────────────────────────────
// 语义图产物进程内 LRU。
//
// 产物按 {owner}/{repo}/{sha}.json 内容寻址（原则不可变；"head" 伪 sha
// 例外，可被新构建覆写）——此前每个请求路径（rsg 符号/接地、MCP 工具、
// 检索、转录闸门）都全量读盘 + JSON 反序列化巨仓数十 MB 的产物。缓存
// 命中前经 mtime+size 校验（覆写即失效，自愈）。返回共享只读实例——
// 全仓消费方无变更行为（grep 锁定）；新增消费方不得原地修改。
// ─────────────────────────────────────────────────────────────

var semanticGraphCache = filecache.New[*SemanticGraphArtifact](16)

// SemanticGraphPathFor returns the path for an artifact: {storeDir}/{owner}/{repo}/{sha}.json.
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

// SaveSemanticGraphArtifact writes the artifact JSON to disk atomically.
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

// LoadSemanticGraphArtifact reads and parses the artifact from disk (LRU 加速)。
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
	// 双读兼容：v3 分段容器走段解码；老产物（v2 全量 JSON）走旧路径——
	// 新写只产 v3，存量 v2 持续可读直至被覆写
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

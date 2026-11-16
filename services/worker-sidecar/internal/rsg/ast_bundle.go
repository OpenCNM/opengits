// 文件级 AST 提取快照 bundle（阶段 6 重定界版：冷启动预热，失效封闭）。
//
// 动机：DefaultAstCache（键 lang:contentSha）让同进程内的图重建对未变
// 文件零解析，但进程重启即清零——冷启动后的首次构建仍全量解析。bundle
// 把提取结果持久化，重建前整包回填缓存；哈希键保证只有未变文件命中，
// 改过的文件自然 miss 走解析（无需差分协议）。
//
// 容器布局（与阶段 5 分段容器同一框架模式，独立实现不泛型化）：
//
//	[magic "OGAST3\n" 8B][headerLen uint32 LE][header JSON][单段：entries JSON]
//
// 失效封闭三护栏（全部静默回退到重新解析 + metrics 计数，绝不阻断构建）：
// schemaVer 不符 / 容器损坏截断 / RSG_AST_BUNDLE=0 kill switch。
package rsg

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

const astBundleMagic = "OGAST3\n"

// extractionSchemaVersion 提取快照数据 schema 版本（红线 2 护栏）：
// 语法 wasm / 查询 scm / 提取代码（symbol_extractor）任一变更必须升版，
// 否则旧 bundle 会以旧规则的结果污染新规则的图。
const extractionSchemaVersion = 1

// bundleKeepCount 同仓保留的 bundle 数（warm-start 只需最近一份，保守留 2）。
const bundleKeepCount = 2

// astBundleHeader 容器头。
type astBundleHeader struct {
	Container int    `json:"container"` // 容器版本 3
	SchemaVer int    `json:"schemaVer"` // 提取 schema 版本（extractionSchemaVersion）
	GitSha    string `json:"gitSha"`
	Entries   int    `json:"entries"`
}

// extractionSnapshot 单文件提取快照（Key = MakeAstCacheKey 输出）。
type extractionSnapshot struct {
	Key        string             `json:"key"`
	Extraction *FileAstExtraction `json:"extraction"`
}

// astBundlePathFor bundle 路径：{graphDir}/{owner}/{repo}/{sha}.astbundle。
// 后缀刻意不以 .json 结尾——避开 handler.go 最新产物扫描（ReadDir+*.json
// 过滤）把 bundle 误选为图谱产物候选。
func astBundlePathFor(graphDir, owner, repo, sha string) (string, error) {
	if err := httpx.AssertSafeSegment(owner); err != nil {
		return "", err
	}
	if err := httpx.AssertSafeSegment(repo); err != nil {
		return "", err
	}
	if err := httpx.AssertSafeSegment(sha); err != nil {
		return "", err
	}
	if graphDir == "" {
		graphDir = "storage/graphs"
	}
	return filepath.Join(graphDir, owner, repo, sha+".astbundle"), nil
}

// encodeAstBundle 编码 bundle 字节。
func encodeAstBundle(gitSha string, snapshots []extractionSnapshot) ([]byte, error) {
	entries := make(map[string]*FileAstExtraction, len(snapshots))
	for _, s := range snapshots {
		if s.Key != "" && s.Extraction != nil {
			entries[s.Key] = s.Extraction
		}
	}
	body, err := json.Marshal(entries)
	if err != nil {
		return nil, fmt.Errorf("marshal ast bundle entries: %w", err)
	}
	header, err := json.Marshal(astBundleHeader{
		Container: 3, SchemaVer: extractionSchemaVersion, GitSha: gitSha, Entries: len(entries),
	})
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.WriteString(astBundleMagic)
	var hl [4]byte
	binary.LittleEndian.PutUint32(hl[:], uint32(len(header)))
	out.Write(hl[:])
	out.Write(header)
	out.Write(body)
	return out.Bytes(), nil
}

// decodeAstBundle 解码并校验护栏；任一不符返回错误（调用方计数并回退）。
func decodeAstBundle(data []byte) (map[string]*FileAstExtraction, error) {
	if len(data) < len(astBundleMagic)+4 || string(data[:len(astBundleMagic)]) != astBundleMagic {
		return nil, fmt.Errorf("not an ast bundle")
	}
	p := len(astBundleMagic)
	headerLen := int(binary.LittleEndian.Uint32(data[p : p+4]))
	p += 4
	if len(data) < p+headerLen {
		return nil, fmt.Errorf("truncated ast bundle header")
	}
	var hdr astBundleHeader
	if err := json.Unmarshal(data[p:p+headerLen], &hdr); err != nil {
		return nil, fmt.Errorf("malformed ast bundle header: %w", err)
	}
	if hdr.Container != 3 {
		return nil, fmt.Errorf("unsupported ast bundle container %d", hdr.Container)
	}
	if hdr.SchemaVer != extractionSchemaVersion {
		return nil, fmt.Errorf("ast bundle schema mismatch: bundle=%d current=%d", hdr.SchemaVer, extractionSchemaVersion)
	}
	var entries map[string]*FileAstExtraction
	if err := json.Unmarshal(data[p+headerLen:], &entries); err != nil {
		return nil, fmt.Errorf("malformed ast bundle entries: %w", err)
	}
	return entries, nil
}

// SaveAstBundle 原子写 bundle（tmp+rename，与图谱产物同款模式）并自清理
// 同仓旧 bundle（保留最新 bundleKeepCount 个——graphs 目录无 GC，靠构建时
// 自清理防止目录体积无限增长）。失败仅告警，绝不阻断构建。
func SaveAstBundle(graphDir, owner, repo, sha string, snapshots []extractionSnapshot) {
	file, err := astBundlePathFor(graphDir, owner, repo, sha)
	if err != nil {
		return
	}
	data, err := encodeAstBundle(sha, snapshots)
	if err != nil {
		log.Printf("[ast-bundle] encode failed for %s/%s@%s: %v", owner, repo, sha, err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		log.Printf("[ast-bundle] mkdir failed: %v", err)
		return
	}
	tmp := fmt.Sprintf("%s.tmp-%d", file, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("[ast-bundle] write failed: %v", err)
		return
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		log.Printf("[ast-bundle] rename failed: %v", err)
		return
	}
	trimOldAstBundles(filepath.Dir(file), file)
}

var astBundleNameRe = regexp.MustCompile(`^[0-9a-fA-F]{40}\.astbundle$`)

// trimOldAstBundles 同目录只保留最新 bundleKeepCount 个 bundle（按 mtime
// 降序；当前刚写的 file 必在保留集内）。
func trimOldAstBundles(dir, keepNewest string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type fileInfo struct {
		name    string
		modTime time.Time
	}
	var bundles []fileInfo
	for _, e := range entries {
		if e.IsDir() || !astBundleNameRe.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		bundles = append(bundles, fileInfo{name: e.Name(), modTime: info.ModTime()})
	}
	if len(bundles) <= bundleKeepCount {
		return
	}
	sort.Slice(bundles, func(i, j int) bool {
		if bundles[i].modTime.Equal(bundles[j].modTime) {
			return bundles[i].name > bundles[j].name
		}
		return bundles[i].modTime.After(bundles[j].modTime)
	})
	for _, b := range bundles[bundleKeepCount:] {
		p := filepath.Join(dir, b.name)
		if p == keepNewest {
			continue
		}
		_ = os.Remove(p)
		metrics.Inc("rsg.astbundle.trimmed")
	}
}

// WarmAstCacheFromBundle 冷启动预热：加载 bundle（优先精确 sha，回退目录
// 内最新）并整包回填 DefaultAstCache。三护栏全部静默回退 + 计数。
// 上限保护：预热量 ≤ 容量一半，超出按字典序截断（防单仓预热挤占全局）。
// 返回实际回填条数。
func WarmAstCacheFromBundle(graphDir, owner, repo, sha string) int {
	if os.Getenv("RSG_AST_BUNDLE") == "0" {
		metrics.IncLabel("rsg.astbundle.skipped", "disabled")
		return 0
	}
	data := loadAstBundleBytes(graphDir, owner, repo, sha)
	if data == nil {
		return 0
	}
	entries, err := decodeAstBundle(data)
	if err != nil {
		metrics.IncLabel("rsg.astbundle.skipped", "corrupt_or_mismatch")
		log.Printf("[ast-bundle] load skipped for %s/%s@%s: %v", owner, repo, sha, err)
		return 0
	}

	cache := GetDefaultAstCache()
	cap := DefaultMaxAstCacheEntries / 2
	keys := make([]string, 0, len(entries))
	for k := range entries {
		keys = append(keys, k)
	}
	sort.Strings(keys) // 确定性截断
	if len(keys) > cap {
		keys = keys[:cap]
	}
	put := 0
	for _, k := range keys {
		if e := entries[k]; e != nil {
			cache.Put(k, e)
			put++
		}
	}
	metrics.Add("rsg.astbundle.warm_entries", uint64(put))
	return put
}

// loadAstBundleBytes 精确 sha 优先，回退目录内最新（跨 sha 复用：哈希键
// 保证只有未变文件命中）。
func loadAstBundleBytes(graphDir, owner, repo, sha string) []byte {
	if file, err := astBundlePathFor(graphDir, owner, repo, sha); err == nil {
		if data, err := os.ReadFile(file); err == nil {
			return data
		}
	}
	// 回退：目录内最新 .astbundle（mtime 降序，平局按文件名字典序）
	dir, err := astBundlePathFor(graphDir, owner, repo, sha)
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(filepath.Dir(dir))
	if err != nil {
		return nil
	}
	type fi struct {
		name    string
		modTime time.Time
	}
	var bundles []fi
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".astbundle") {
			continue
		}
		info, ierr := e.Info()
		if ierr != nil {
			continue
		}
		bundles = append(bundles, fi{name: e.Name(), modTime: info.ModTime()})
	}
	sort.Slice(bundles, func(i, j int) bool {
		if bundles[i].modTime.Equal(bundles[j].modTime) {
			return bundles[i].name > bundles[j].name
		}
		return bundles[i].modTime.After(bundles[j].modTime)
	})
	for _, b := range bundles {
		if data, rerr := os.ReadFile(filepath.Join(filepath.Dir(dir), b.name)); rerr == nil {
			return data
		}
	}
	return nil
}

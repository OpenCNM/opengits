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

// Bump on any grammar WASM, .scm query, or extractor change so stale bundles never poison the cache.
const extractionSchemaVersion = 2

const bundleKeepCount = 2

type astBundleHeader struct {
	Container int    `json:"container"`
	SchemaVer int    `json:"schemaVer"`
	GitSha    string `json:"gitSha"`
	Entries   int    `json:"entries"`
}

type extractionSnapshot struct {
	Key        string             `json:"key"`
	Extraction *FileAstExtraction `json:"extraction"`
}

// Use .astbundle instead of .json so latest-graph directory scans never mistake bundles for RSG artifacts.
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

// Cap warm-start backfill to half the cache capacity to prevent one repo from evicting all others.
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
	sort.Strings(keys)
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

func loadAstBundleBytes(graphDir, owner, repo, sha string) []byte {
	if file, err := astBundlePathFor(graphDir, owner, repo, sha); err == nil {
		if data, err := os.ReadFile(file); err == nil {
			return data
		}
	}

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

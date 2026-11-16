package diff

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/archive"
)

// DefaultRenameSimilarityThreshold 最小行级相似度阈值（0.60 = 60%）。
const DefaultRenameSimilarityThreshold = 0.60

// ArchiveDirFor returns the storage path for an unpacked git archive.
func ArchiveDirFor(root, owner, repo, sha string) string {
	return filepath.Join(root, owner, repo, sha)
}

// HashArchiveFile calculates the sha1 hex digest of a single file.
func HashArchiveFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha1.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// HashArchiveTree walks a directory and produces a path -> sha1 hex map.
func HashArchiveTree(dir string) (map[string]string, error) {
	tree := make(map[string]string)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		h, err := HashArchiveFile(p)
		if err != nil {
			return err
		}
		tree[filepath.ToSlash(rel)] = h
		return nil
	})
	if err != nil {
		return nil, err
	}
	return tree, nil
}

// DiffArchiveTrees compares two hash trees into added, modified, removed and exact-hash renames.
// 向后兼容接口：仅基于 SHA-1 哈希匹配进行重命名判定。
func DiffArchiveTrees(oldTree, newTree map[string]string) *ArchiveDiff {
	return DiffArchiveTreesWithContent(oldTree, newTree, nil, nil, 0)
}

type renameCandidate struct {
	from     string
	to       string
	score    float64
	sameBase bool
}

// DiffArchiveTreesWithContent compares two hash trees with two-phase rename detection:
// Phase 1 (Fast Path): Exact SHA-1 hash matching (O(1)).
// Phase 2 (Slow Path): Line-level content similarity matching (Sorensen-Dice >= threshold)
// for remaining unpaired files when content readers are provided.
func DiffArchiveTreesWithContent(
	oldTree, newTree map[string]string,
	readOld func(path string) ([]byte, error),
	readNew func(path string) ([]byte, error),
	threshold float64,
) *ArchiveDiff {
	if threshold <= 0 {
		threshold = DefaultRenameSimilarityThreshold
	}

	diff := &ArchiveDiff{
		Added:    []string{},
		Modified: []string{},
		Removed:  []string{},
		Renamed:  []ChapterRename{},
	}

	for p, h := range newTree {
		oh, ok := oldTree[p]
		if !ok {
			diff.Added = append(diff.Added, p)
		} else if oh != h {
			diff.Modified = append(diff.Modified, p)
		}
	}
	for p := range oldTree {
		if _, ok := newTree[p]; !ok {
			diff.Removed = append(diff.Removed, p)
		}
	}

	sort.Strings(diff.Added)
	sort.Strings(diff.Modified)

	removedSet := make(map[string]bool, len(diff.Removed))
	for _, p := range diff.Removed {
		removedSet[p] = true
	}
	addedSet := make(map[string]bool, len(diff.Added))
	for _, p := range diff.Added {
		addedSet[p] = true
	}

	// ── Phase 1: 确定性 100% SHA-1 精确哈希配对 ──
	if len(diff.Added) > 0 && len(diff.Removed) > 0 {
		byHash := make(map[string][]string)
		for _, p := range diff.Added {
			byHash[newTree[p]] = append(byHash[newTree[p]], p)
		}

		removedSorted := append([]string(nil), diff.Removed...)
		sort.Strings(removedSorted)
		for _, p := range removedSorted {
			h := oldTree[p]
			targets := byHash[h]
			if len(targets) == 0 {
				continue
			}
			to := targets[len(targets)-1]
			byHash[h] = targets[:len(targets)-1]
			delete(removedSet, p)
			delete(addedSet, to)
			diff.Renamed = append(diff.Renamed, ChapterRename{From: p, To: to})
		}
	}

	// ── Phase 2: 行特征相似度启发式重命名判定（BUG-05 根治） ──
	if len(removedSet) > 0 && len(addedSet) > 0 && readOld != nil && readNew != nil {
		remSorted := sortedSetKeys(removedSet)
		addSorted := sortedSetKeys(addedSet)
		// 每文件事实（行计数 map/行数/可用性）按路径缓存：原双循环对每个
		// (from,to) 组合重新读盘+切行，同一文件被重复读 O(对侧数量) 次。
		oldFacts := newRenameFactsCache(readOld)
		newFacts := newRenameFactsCache(readNew)

		var candidates []renameCandidate
		for _, fromPath := range remSorted {
			extFrom := strings.ToLower(filepath.Ext(fromPath))
			for _, toPath := range addSorted {
				extTo := strings.ToLower(filepath.Ext(toPath))
				if !areExtensionsCompatible(extFrom, extTo) {
					continue
				}

				fa := oldFacts.facts(fromPath)
				if !fa.ok {
					continue
				}
				fb := newFacts.facts(toPath)
				if !fb.ok {
					continue
				}

				sim := lineSimilarityFromFacts(fa, fb)
				sameBase := filepath.Base(fromPath) == filepath.Base(toPath)
				effectiveScore := sim
				if sameBase {
					effectiveScore = math.Min(1.0, sim+0.05)
				}

				if effectiveScore >= threshold {
					candidates = append(candidates, renameCandidate{
						from:     fromPath,
						to:       toPath,
						score:    effectiveScore,
						sameBase: sameBase,
					})
				}
			}
		}

		// 确定性收敛排序：同分/同基础名时依据字典序稳定打破僵局
		sort.Slice(candidates, func(i, j int) bool {
			ci, cj := candidates[i], candidates[j]
			if ci.sameBase != cj.sameBase {
				return ci.sameBase
			}
			if math.Abs(ci.score-cj.score) > 1e-6 {
				return ci.score > cj.score
			}
			if ci.from != cj.from {
				return ci.from < cj.from
			}
			return ci.to < cj.to
		})

		usedFrom := make(map[string]bool)
		usedTo := make(map[string]bool)
		for _, c := range candidates {
			if usedFrom[c.from] || usedTo[c.to] {
				continue
			}
			usedFrom[c.from] = true
			usedTo[c.to] = true
			delete(removedSet, c.from)
			delete(addedSet, c.to)
			diff.Renamed = append(diff.Renamed, ChapterRename{From: c.from, To: c.to})
		}
	}

	diff.Added = sortedSetKeys(addedSet)
	diff.Removed = sortedSetKeys(removedSet)

	sort.Slice(diff.Renamed, func(i, j int) bool {
		if diff.Renamed[i].From != diff.Renamed[j].From {
			return diff.Renamed[i].From < diff.Renamed[j].From
		}
		return diff.Renamed[i].To < diff.Renamed[j].To
	})
	sort.Strings(diff.Added)
	sort.Strings(diff.Modified)
	sort.Strings(diff.Removed)
	return diff
}

func areExtensionsCompatible(extA, extB string) bool {
	if extA == extB {
		return true
	}
	// Markdown / MDX 互认
	if (extA == ".md" && extB == ".mdx") || (extA == ".mdx" && extB == ".md") {
		return true
	}
	return false
}

func isBinaryContent(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	limit := len(b)
	if limit > 8000 {
		limit = 8000
	}
	return bytes.IndexByte(b[:limit], 0) >= 0
}

// renameFacts 单文件的行特征事实（Phase 2 重命名判定的缓存单元）。
type renameFacts struct {
	ok     bool
	counts map[string]int
	lines  int
}

// renameFactsCache 按路径惰性缓存文件事实（读取失败/二进制记为 !ok，
// 与原「err 或 binary → continue」语义一致）。
type renameFactsCache struct {
	read  func(rel string) ([]byte, error)
	cache map[string]*renameFacts
}

func newRenameFactsCache(read func(rel string) ([]byte, error)) *renameFactsCache {
	return &renameFactsCache{read: read, cache: make(map[string]*renameFacts)}
}

func (c *renameFactsCache) facts(rel string) *renameFacts {
	if f, ok := c.cache[rel]; ok {
		return f
	}
	f := &renameFacts{}
	if b, err := c.read(rel); err == nil && !isBinaryContent(b) {
		lines := extractLines(b)
		counts := make(map[string]int, len(lines))
		for _, l := range lines {
			counts[l]++
		}
		f.ok = true
		f.counts = counts
		f.lines = len(lines)
	}
	c.cache[rel] = f
	return f
}

// lineSimilarityFromFacts 与 computeLineSimilarity 同公式（整数 common
// 累加顺序无关，浮点结果逐位一致）。
func lineSimilarityFromFacts(a, b *renameFacts) float64 {
	if a.lines == 0 && b.lines == 0 {
		return 1.0
	}
	if a.lines == 0 || b.lines == 0 {
		return 0.0
	}
	common := 0
	for line, countA := range a.counts {
		if countB, ok := b.counts[line]; ok {
			if countA < countB {
				common += countA
			} else {
				common += countB
			}
		}
	}
	total := a.lines + b.lines
	return float64(2*common) / float64(total)
}

// computeLineSimilarity 计算两个文本字节切片的行级 Sorensen-Dice 相似度 [0.0, 1.0]。
func computeLineSimilarity(a, b []byte) float64 {
	linesA := extractLines(a)
	linesB := extractLines(b)
	if len(linesA) == 0 && len(linesB) == 0 {
		return 1.0
	}
	if len(linesA) == 0 || len(linesB) == 0 {
		return 0.0
	}

	countsA := make(map[string]int, len(linesA))
	for _, l := range linesA {
		countsA[l]++
	}

	countsB := make(map[string]int, len(linesB))
	for _, l := range linesB {
		countsB[l]++
	}

	common := 0
	for line, countA := range countsA {
		if countB, ok := countsB[line]; ok {
			if countA < countB {
				common += countA
			} else {
				common += countB
			}
		}
	}

	total := len(linesA) + len(linesB)
	return float64(2*common) / float64(total)
}

func extractLines(b []byte) []string {
	var lines []string
	start := 0
	for i := 0; i < len(b); i++ {
		if b[i] == '\n' {
			line := strings.TrimRight(string(b[start:i]), "\r")
			line = strings.TrimSpace(line)
			if line != "" {
				lines = append(lines, line)
			}
			start = i + 1
		}
	}
	if start < len(b) {
		line := strings.TrimRight(string(b[start:]), "\r")
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func sortedSetKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ComputeArchiveDiffFromDisk compares unpacked archive directories on disk.
func ComputeArchiveDiffFromDisk(archiveRoot, owner, repo, fromSha, toSha string) (*ArchiveDiff, bool, error) {
	oldDir := ArchiveDirFor(archiveRoot, owner, repo, fromSha)
	if st, err := os.Stat(oldDir); err != nil || !st.IsDir() {
		lowerOld := archive.ArchiveDirFor(archiveRoot, owner, repo, fromSha)
		if st2, err2 := os.Stat(lowerOld); err2 == nil && st2.IsDir() {
			oldDir = lowerOld
		} else {
			if _, err3 := archive.DecompactArchive(context.Background(), archiveRoot, owner, repo, fromSha); err3 == nil {
				oldDir = lowerOld
			}
		}
	}
	newDir := ArchiveDirFor(archiveRoot, owner, repo, toSha)
	if st, err := os.Stat(newDir); err != nil || !st.IsDir() {
		lowerNew := archive.ArchiveDirFor(archiveRoot, owner, repo, toSha)
		if st2, err2 := os.Stat(lowerNew); err2 == nil && st2.IsDir() {
			newDir = lowerNew
		} else {
			if _, err3 := archive.DecompactArchive(context.Background(), archiveRoot, owner, repo, toSha); err3 == nil {
				newDir = lowerNew
			}
		}
	}
	oldFi, errOld := os.Stat(oldDir)
	newFi, errNew := os.Stat(newDir)
	hasOld := errOld == nil && oldFi.IsDir()
	if !hasOld || errNew != nil || !newFi.IsDir() {
		return nil, hasOld, fmt.Errorf("archive directories not available on disk for %s/%s (%s, %s)", owner, repo, fromSha, toSha)
	}
	oldTree, err := HashArchiveTree(oldDir)
	if err != nil {
		return nil, hasOld, fmt.Errorf("hash old archive failed: %w", err)
	}
	newTree, err := HashArchiveTree(newDir)
	if err != nil {
		return nil, hasOld, fmt.Errorf("hash new archive failed: %w", err)
	}
	readOld := func(rel string) ([]byte, error) {
		return os.ReadFile(filepath.Join(oldDir, filepath.FromSlash(rel)))
	}
	readNew := func(rel string) ([]byte, error) {
		return os.ReadFile(filepath.Join(newDir, filepath.FromSlash(rel)))
	}
	return DiffArchiveTreesWithContent(oldTree, newTree, readOld, readNew, DefaultRenameSimilarityThreshold), hasOld, nil
}

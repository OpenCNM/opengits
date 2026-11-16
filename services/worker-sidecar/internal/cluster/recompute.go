package cluster

import (
	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// MatchModuleFiles matches files in nodes that belong to the specified directories.
// Filters out non-content directories and files, non-code/non-doc files, and sorts entrypoint files first.
func MatchModuleFiles(nodes []GitNode, directories []string, patterns Patterns) []string {
	var prefixes []string
	for _, d := range directories {
		norm := strings.TrimSpace(strings.ReplaceAll(d, "\\", "/"))
		norm = strings.Trim(norm, "/")
		if norm != "" && norm != "." {
			prefixes = append(prefixes, norm+"/")
		}
	}

	matched := make([]string, 0)
	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		if patterns != nil {
			if patterns.IsNonContentDir(n.Path) || patterns.IsNonContentFile(n.Path) {
				continue
			}
			if !patterns.IsCodeFile(n.Path) && !patterns.IsDocFile(n.Path) {
				continue
			}
		}

		if len(prefixes) == 0 {
			if strings.Contains(n.Path, "/") {
				continue
			}
		} else {
			hasPrefix := false
			for _, p := range prefixes {
				if strings.HasPrefix(n.Path, p) {
					hasPrefix = true
					break
				}
			}
			if !hasPrefix {
				continue
			}
		}

		matched = append(matched, n.Path)
	}

	SortFilesWithEntrypoints(matched, patterns)
	return matched
}

// SortFilesWithEntrypoints sorts files placing entry point files first, then stable alphabetical.
func SortFilesWithEntrypoints(files []string, patterns Patterns) {
	isEntry := func(p string) bool {
		if patterns == nil {
			return false
		}
		return patterns.IsEntryPoint(p)
	}

	sort.SliceStable(files, func(i, j int) bool {
		a := files[i]
		b := files[j]
		aEntry := 1
		bEntry := 1
		if isEntry(a) {
			aEntry = 0
		}
		if isEntry(b) {
			bEntry = 0
		}
		if aEntry != bEntry {
			return aEntry < bEntry
		}
		// WP-J：模块快照 files[] 序对齐 TS localeCompare 契约（mdpat shim）
		// ——byte-wise 序在大小写/标点路径上漂移
		return mdpat.JsLocaleCompare(a, b) < 0
	})
}

// InferDirectories infers top-level module directories from a list of files.
func InferDirectories(files []string) []string {
	seen := make(map[string]bool)
	var dirs []string
	for _, f := range files {
		idx := strings.Index(f, "/")
		if idx > 0 {
			dir := f[:idx+1]
			if !seen[dir] {
				seen[dir] = true
				dirs = append(dirs, dir)
			}
		}
	}
	sort.Strings(dirs)
	if dirs == nil {
		dirs = make([]string, 0)
	}
	return dirs
}

// JaccardSimilarity calculates Jaccard similarity between two string slices. Returns 0 on empty sets.
func JaccardSimilarity(a, b []string) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	setB := make(map[string]struct{}, len(b))
	for _, x := range b {
		setB[x] = struct{}{}
	}
	inter := 0
	unionSet := make(map[string]struct{}, len(a)+len(b))
	for _, x := range b {
		unionSet[x] = struct{}{}
	}
	for _, x := range a {
		if _, exists := setB[x]; exists {
			inter++
		}
		unionSet[x] = struct{}{}
	}
	if len(unionSet) == 0 {
		return 0
	}
	return float64(inter) / float64(len(unionSet))
}

// jaccardFacts Jaccard 预计算事实：去重集合 + a 切片多重计数（inter 语义
// 保留 a 含重复元素的多重计数；union=|setA∪setB| 严格相等）。
type jaccardFacts struct {
	set   map[string]struct{}
	count map[string]int
	size  int
}

func buildJaccardFacts(a []string) jaccardFacts {
	f := jaccardFacts{set: make(map[string]struct{}, len(a)), count: make(map[string]int, len(a))}
	for _, x := range a {
		f.set[x] = struct{}{}
		f.count[x]++
	}
	f.size = len(a)
	return f
}

// jaccardFactsPair 与 JaccardSimilarity 同结果（贪心配对的 old×new 双重
// 循环里同一簇的集合被重建 len(对侧) 次，预计算后 pair 计算零分配）。
func jaccardFactsPair(fa jaccardFacts, fb jaccardFacts) float64 {
	if fa.size == 0 || fb.size == 0 {
		return 0
	}
	inter := 0
	for x, cnt := range fa.count {
		if _, ok := fb.set[x]; ok {
			inter += cnt
		}
	}
	union := len(fa.set) + len(fb.set)
	for x := range fa.set {
		if _, ok := fb.set[x]; ok {
			union--
		}
	}
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

// DiffCodeClusters performs greedy matching between old and new module snapshots using Jaccard similarity.
func DiffCodeClusters(oldClusters, newClusters []ModuleSnapshot) ClusterDiffResult {
	for i := range oldClusters {
		if oldClusters[i].Directories == nil {
			oldClusters[i].Directories = make([]string, 0)
		}
		if oldClusters[i].Files == nil {
			oldClusters[i].Files = make([]string, 0)
		}
	}
	for i := range newClusters {
		if newClusters[i].Directories == nil {
			newClusters[i].Directories = make([]string, 0)
		}
		if newClusters[i].Files == nil {
			newClusters[i].Files = make([]string, 0)
		}
	}

	matched := make([]ClusterMatchedPair, 0)
	usedNew := make(map[int]bool)
	removed := make([]ClusterRemovedItem, 0)

	oldFacts := make([]jaccardFacts, len(oldClusters))
	for i, oc := range oldClusters {
		oldFacts[i] = buildJaccardFacts(oc.Files)
	}
	newFacts := make([]jaccardFacts, len(newClusters))
	for i, nc := range newClusters {
		newFacts[i] = buildJaccardFacts(nc.Files)
	}

	for oi, old := range oldClusters {
		bestIdx := -1
		bestSim := 0.0
		for i := range newClusters {
			if usedNew[i] {
				continue
			}
			sim := jaccardFactsPair(oldFacts[oi], newFacts[i])
			if sim > bestSim {
				bestSim = sim
				bestIdx = i
			}
		}

		if bestIdx >= 0 && bestSim >= ModuleMatchThreshold {
			usedNew[bestIdx] = true
			neuMatched := newClusters[bestIdx]
			chNo := old.ChapterNo
			if chNo == 0 {
				chNo = old.TeachingOrder
			}
			neuMatched.ChapterNo = chNo
			newClusters[bestIdx].ChapterNo = chNo
			matched = append(matched, ClusterMatchedPair{
				Old:        old,
				Neu:        neuMatched,
				Similarity: bestSim,
			})
		} else {
			removed = append(removed, ClusterRemovedItem{
				TeachingOrder: old.TeachingOrder,
				Title:         old.Title,
			})
		}
	}

	added := make([]ModuleSnapshot, 0)
	for i, neu := range newClusters {
		if !usedNew[i] {
			added = append(added, neu)
		}
	}

	return ClusterDiffResult{
		Added:   added,
		Removed: removed,
		Matched: matched,
	}
}

// RecomputeModuleSnapshots re-matches module files on a new tree for each old module snapshot.
func RecomputeModuleSnapshots(oldModules []ModuleSnapshot, nodes []GitNode, patterns Patterns) []ModuleSnapshot {
	var recomputed []ModuleSnapshot
	for _, m := range oldModules {
		dirs := m.Directories
		if len(dirs) == 0 {
			dirs = InferDirectories(m.Files)
		}
		matchedFiles := MatchModuleFiles(nodes, dirs, patterns)
		if len(matchedFiles) == 0 {
			continue
		}
		chNo := m.ChapterNo
		if chNo == 0 {
			chNo = m.TeachingOrder
		}
		granularity := m.Granularity
		if granularity == "" {
			granularity = "standard"
		}
		mDirs := dirs
		if mDirs == nil {
			mDirs = make([]string, 0)
		}
		snap := ModuleSnapshot{
			TeachingOrder: m.TeachingOrder,
			ChapterNo:     chNo,
			Title:         m.Title,
			Summary:       m.Summary,
			Directories:   mDirs,
			Granularity:   granularity,
			Files:         matchedFiles,
			Cognitive:     m.Cognitive,
		}
		recomputed = append(recomputed, snap)
	}
	if recomputed == nil {
		recomputed = make([]ModuleSnapshot, 0)
	}
	return recomputed
}

// GroupModulesByDirectory groups files by top-level directory as fallback module snapshots.
func GroupModulesByDirectory(nodes []GitNode, patterns Patterns) []ModuleSnapshot {
	dirMap := make(map[string][]string)
	var dirOrder []string
	seenDir := make(map[string]bool)

	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		if patterns != nil {
			if patterns.IsNonContentDir(n.Path) || patterns.IsNonContentFile(n.Path) {
				continue
			}
			if !patterns.IsCodeFile(n.Path) && !patterns.IsDocFile(n.Path) {
				continue
			}
		}
		dir := ""
		if idx := strings.Index(n.Path, "/"); idx >= 0 {
			dir = n.Path[:idx] + "/"
		}
		if !seenDir[dir] {
			seenDir[dir] = true
			dirOrder = append(dirOrder, dir)
		}
		dirMap[dir] = append(dirMap[dir], n.Path)
	}

	var snapshots []ModuleSnapshot
	order := 1
	for _, dir := range dirOrder {
		files := dirMap[dir]
		if len(files) == 0 {
			continue
		}
		SortFilesWithEntrypoints(files, patterns)
		displayName := "Root"
		dirs := make([]string, 0)
		if dir != "" {
			displayName = strings.TrimSuffix(dir, "/")
			dirs = []string{dir}
		}
		snapshots = append(snapshots, ModuleSnapshot{
			TeachingOrder: order,
			ChapterNo:     order,
			Title:         displayName,
			Summary:       "",
			Directories:   dirs,
			Files:         files,
		})
		order++
	}

	if snapshots == nil {
		snapshots = make([]ModuleSnapshot, 0)
	}
	return snapshots
}

// BuildModuleSnapshots constructs module snapshots from draft outline modules, falling back to directory grouping.
func BuildModuleSnapshots(modules []DraftModuleInput, nodes []GitNode, patterns Patterns) []ModuleSnapshot {
	if len(modules) > 0 {
		var snapshots []ModuleSnapshot
		for idx, m := range modules {
			files := MatchModuleFiles(nodes, m.Directories, patterns)
			if len(files) == 0 {
				continue
			}
			title := m.Name
			if title == "" {
				title = fmt.Sprintf("Module %d", idx+1)
			}
			dirs := m.Directories
			if dirs == nil {
				dirs = make([]string, 0)
			}
			granularity := m.Granularity
			if granularity == "" {
				granularity = "standard"
			}
			order := idx + 1
			snapshots = append(snapshots, ModuleSnapshot{
				TeachingOrder: order,
				ChapterNo:     order,
				Title:         title,
				Summary:       m.Summary,
				Directories:   dirs,
				Granularity:   granularity,
				Files:         files,
			})
		}
		if snapshots == nil {
			snapshots = make([]ModuleSnapshot, 0)
		}
		return snapshots
	}

	return GroupModulesByDirectory(nodes, patterns)
}

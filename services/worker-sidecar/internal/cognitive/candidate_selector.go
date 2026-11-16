package cognitive

import (
	"fmt"
	"sort"
	"strings"
)

type fileRoleRule struct {
	matches func(p Patterns, path, lowerName string) bool
	role    string
}

var fileRoleRules = []fileRoleRule{
	{
		matches: func(p Patterns, path, lowerName string) bool { return p.IsEntryPointFile(lowerName) },
		role:    "entry_point",
	},
	{
		matches: func(p Patterns, path, lowerName string) bool { return p.IsBuildSystemFile(lowerName) },
		role:    "build_system",
	},
	{
		matches: func(p Patterns, path, lowerName string) bool { return p.IsConfigFile(path) },
		role:    "configuration",
	},
	{
		matches: func(p Patterns, path, lowerName string) bool { return p.IsDataModelFile(path) },
		role:    "data_model",
	},
	{
		matches: func(p Patterns, path, lowerName string) bool { return p.IsTypeHubFile(path) },
		role:    "type_hub",
	},
	{
		matches: func(p Patterns, path, lowerName string) bool { return p.IsUtilityFile(path) },
		role:    "utility",
	},
}

// InferFlatFileRole 推断源文件轻量角色标注（表驱动规则引擎，与 TS inferFlatFileRole 100% 对齐）
func InferFlatFileRole(path string, patterns Patterns) string {
	if patterns == nil {
		return "core_logic"
	}
	if patterns.IsBinaryOrArchiveFile(path) || patterns.IsNonContentFile(path) {
		return "asset_or_non_code"
	}
	parts := strings.Split(path, "/")
	fileName := parts[len(parts)-1]
	lowerName := strings.ToLower(fileName)

	for _, rule := range fileRoleRules {
		if rule.matches(patterns, path, lowerName) {
			return rule.role
		}
	}
	return "core_logic"
}

// IsFlatOrShallowRepo 探测是否为扁平或浅层结构仓库（内容目录 <= 2 且包含平铺源码文件 >= 6）
func IsFlatOrShallowRepo(nodes []GitNode, patterns Patterns) bool {
	topDirs := make(map[string]bool)
	codeBlobCount := 0

	for _, n := range nodes {
		if n.Type == "tree" {
			trimmed := strings.Trim(n.Path, "/")
			if trimmed != "" {
				parts := strings.Split(trimmed, "/")
				if len(parts) > 0 && parts[0] != "" {
					topDirs[parts[0]] = true
				}
			}
		} else if n.Type == "blob" {
			trimmed := strings.Trim(n.Path, "/")
			parts := strings.Split(trimmed, "/")
			if len(parts) > 1 && parts[0] != "" {
				topDirs[parts[0]] = true
			}
			lower := strings.ToLower(n.Path)
			isMd := false
			for _, ext := range patterns.MarkdownExtensions() {
				if strings.HasSuffix(lower, ext) {
					isMd = true
					break
				}
			}
			if !isMd && !patterns.IsNonContentDir(n.Path) {
				codeBlobCount++
			}
		}
	}

	contentDirCount := 0
	for dir := range topDirs {
		if !patterns.IsNonContentDir(dir) {
			contentDirCount++
		}
	}
	return contentDirCount <= 2 && codeBlobCount >= 6
}

// ExtractFlatRepoHints 为扁平/浅层仓库抽取关键源文件角色提示（最多 maxFiles 个）
func ExtractFlatRepoHints(nodes []GitNode, maxFiles int, patterns Patterns) string {
	if maxFiles <= 0 {
		maxFiles = 20
	}
	type scoredItem struct {
		path   string
		role   string
		weight int
	}
	var scored []scoredItem

	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		lower := strings.ToLower(n.Path)
		isMd := false
		for _, ext := range patterns.MarkdownExtensions() {
			if strings.HasSuffix(lower, ext) {
				isMd = true
				break
			}
		}
		if isMd || patterns.IsNonContentDir(n.Path) || patterns.IsTestFile(n.Path) {
			continue
		}

		role := InferFlatFileRole(n.Path, patterns)
		roleWeight := map[string]int{
			"entry_point":   10,
			"data_model":    8,
			"configuration": 7,
			"core_logic":    6,
			"utility":       4,
			"type_hub":      3,
			"build_system":  2,
		}
		w, ok := roleWeight[role]
		if !ok {
			w = 5
		}
		scored = append(scored, scoredItem{
			path:   n.Path,
			role:   role,
			weight: w,
		})
	}

	if len(scored) == 0 {
		return ""
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].weight != scored[j].weight {
			return scored[i].weight > scored[j].weight
		}
		return scored[i].path < scored[j].path
	})

	if len(scored) > maxFiles {
		scored = scored[:maxFiles]
	}

	var lines []string
	for _, item := range scored {
		lines = append(lines, fmt.Sprintf("- %s [%s]", item.path, item.role))
	}
	return "Key Source Components (detected flat/shallow structure):\n" + strings.Join(lines, "\n")
}

// SelectCandidateFilesForOutline 精选大纲候选文件清单（管道模式 + 父目录 Round-Robin 桶轮询）
func SelectCandidateFilesForOutline(
	nodes []GitNode,
	maxFiles int,
	patterns Patterns,
) []CandidateOutlineFile {
	if maxFiles <= 0 {
		maxFiles = 60
	}

	blobs := filterEligibleOutlineBlobs(nodes, patterns)
	if len(blobs) == 0 {
		return []CandidateOutlineFile{}
	}

	candidates := classifyCandidateBlobs(blobs, patterns)
	if len(candidates) <= maxFiles {
		return finalizeCandidateRankings(candidates)
	}

	return sampleCandidateFilesByRoundRobin(candidates, maxFiles)
}

func filterEligibleOutlineBlobs(nodes []GitNode, patterns Patterns) []GitNode {
	var blobs []GitNode
	for _, n := range nodes {
		if n.Type == "blob" &&
			!patterns.IsNonContentDir(n.Path) &&
			!patterns.IsNonContentFile(n.Path) &&
			!patterns.IsBinaryOrArchiveFile(n.Path) &&
			(patterns.IsCodeFile(n.Path) || patterns.IsDocFile(n.Path)) &&
			!patterns.IsTestFile(n.Path) {
			blobs = append(blobs, n)
		}
	}
	return blobs
}

func classifyCandidateBlobs(blobs []GitNode, patterns Patterns) []CandidateOutlineFile {
	var candidates []CandidateOutlineFile
	for _, n := range blobs {
		lower := strings.ToLower(n.Path)
		isMd := false
		for _, ext := range patterns.MarkdownExtensions() {
			if strings.HasSuffix(lower, ext) {
				isMd = true
				break
			}
		}

		if isMd {
			parts := strings.Split(lower, "/")
			fileName := parts[len(parts)-1]
			isReadme := patterns.IsReadme(fileName)
			if !isReadme && patterns.IsMetaOrProtocolDoc(fileName) {
				continue
			}
			weight := 10
			if isReadme {
				weight = 25
			} else if patterns.IsCoreDocEntryKeyword(fileName) {
				weight += 8
			}
			firstSegment := parts[0]
			if patterns.IsTopLevelDocDir(firstSegment) {
				weight += 5
			}
			candidates = append(candidates, CandidateOutlineFile{
				Path:   n.Path,
				IsDoc:  true,
				Weight: weight,
			})
		} else {
			role := InferFlatFileRole(n.Path, patterns)
			if role == "asset_or_non_code" {
				continue
			}
			roleWeight := map[string]int{
				"entry_point":   15,
				"data_model":    10,
				"core_logic":    8,
				"configuration": 7,
				"type_hub":      6,
				"utility":       5,
				"build_system":  3,
			}
			w, ok := roleWeight[role]
			if !ok {
				w = 5
			}
			candidates = append(candidates, CandidateOutlineFile{
				Path:   n.Path,
				IsDoc:  false,
				Role:   role,
				Weight: w,
			})
		}
	}
	return candidates
}

func finalizeCandidateRankings(candidates []CandidateOutlineFile) []CandidateOutlineFile {
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Weight != candidates[j].Weight {
			return candidates[i].Weight > candidates[j].Weight
		}
		return candidates[i].Path < candidates[j].Path
	})
	for i := range candidates {
		candidates[i].Handle = i + 1
	}
	return candidates
}

func sampleCandidateFilesByRoundRobin(candidates []CandidateOutlineFile, maxFiles int) []CandidateOutlineFile {
	buckets := make(map[string][]CandidateOutlineFile)
	var dirList []string

	for _, c := range candidates {
		parent := ""
		if idx := strings.LastIndex(c.Path, "/"); idx >= 0 {
			parent = c.Path[:idx]
		}
		if parent == "" {
			parent = "__root__"
		}
		if _, exists := buckets[parent]; !exists {
			dirList = append(dirList, parent)
		}
		buckets[parent] = append(buckets[parent], c)
	}

	for _, list := range buckets {
		sort.Slice(list, func(i, j int) bool {
			if list[i].Weight != list[j].Weight {
				return list[i].Weight > list[j].Weight
			}
			return list[i].Path < list[j].Path
		})
	}

	sort.Slice(dirList, func(i, j int) bool {
		maxA := buckets[dirList[i]][0].Weight
		maxB := buckets[dirList[j]][0].Weight
		if maxA != maxB {
			return maxA > maxB
		}
		return dirList[i] < dirList[j]
	})

	var selected []CandidateOutlineFile
	itemIdx := 0
	hasMore := true

	for len(selected) < maxFiles && hasMore {
		hasMore = false
		for _, dir := range dirList {
			bucket := buckets[dir]
			if itemIdx < len(bucket) {
				selected = append(selected, bucket[itemIdx])
				hasMore = true
				if len(selected) >= maxFiles {
					break
				}
			}
		}
		itemIdx++
	}

	return finalizeCandidateRankings(selected)
}

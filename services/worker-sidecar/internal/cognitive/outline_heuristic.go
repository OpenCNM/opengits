package cognitive

import (
	"sort"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// 启发式教学大纲草稿生成器与门面编排器（Unit 1.3）
// 编排底层 AnchorExtractor、CandidateSelector 与 OutlineSanitizer 算子。
// 消除 Node.js 事件循环延迟（Event Loop Lag），实现 Zero-Tree 原生计算。
// ─────────────────────────────────────────────────────────────

// FindReadmePath 从 tree 节点查找 README 路径（优先前缀目录，回退根目录，最终任意层级）
func FindReadmePath(nodes []GitNode, prefix string, patterns Patterns) string {
	cleanPrefix := strings.Trim(strings.Trim(prefix, " "), "/")

	if cleanPrefix != "" {
		for _, n := range nodes {
			if n.Type == "blob" {
				parts := strings.Split(n.Path, "/")
				fileName := parts[len(parts)-1]
				dir := strings.Join(parts[:len(parts)-1], "/")
				if dir == cleanPrefix && patterns.IsReadme(fileName) {
					return n.Path
				}
			}
		}
	}

	// 回退匹配根目录 README
	for _, n := range nodes {
		if n.Type == "blob" {
			parts := strings.Split(n.Path, "/")
			fileName := parts[len(parts)-1]
			if patterns.IsReadme(fileName) && !strings.Contains(n.Path, "/") {
				return n.Path
			}
		}
	}

	// 最终保底：搜索任意层级命中的 README
	for _, n := range nodes {
		if n.Type == "blob" {
			parts := strings.Split(n.Path, "/")
			fileName := parts[len(parts)-1]
			if patterns.IsReadme(fileName) {
				return n.Path
			}
		}
	}

	return ""
}

// BuildRuleFallbackOutline 纯规则保底大纲生成器
func BuildRuleFallbackOutline(
	nodes []GitNode,
	prefix string,
	targetLanguage string,
	patterns Patterns,
	opts ...OutlineSignalOptions,
) []OutlineChapter {
	// 决策体已表格化至 outline_rules.go（兜底梯/微仓五段式/文档+代码追加器）
	return buildRuleFallbackOutline(newOutlineCtx(nodes, prefix, targetLanguage, patterns, opts))
}

// PrepareOutlineSignalsWithOptions combines candidate selection, flat repo detection, and micro-repo anchor extraction.
func PrepareOutlineSignalsWithOptions(
	nodes []GitNode,
	prefix string,
	maxFiles int,
	patterns Patterns,
	opts OutlineSignalOptions,
) (candidates []CandidateOutlineFile, isFlat bool, flatRepoHints string, fileCount int) {
	candidates = SelectCandidateFilesForOutline(nodes, maxFiles, patterns)
	isFlat = IsFlatOrShallowRepo(nodes, patterns)
	flatRepoHints = ""
	if isFlat {
		hintLimit := 20
		if maxFiles > 0 && maxFiles < hintLimit {
			hintLimit = maxFiles
		}
		flatRepoHints = ExtractFlatRepoHints(nodes, hintLimit, patterns)
	}
	fileCount = 0
	for _, n := range nodes {
		if n.Type == "blob" {
			fileCount++
		}
	}
	if fileCount == 0 {
		fileCount = len(nodes)
	}

	var codeCandidates []CandidateOutlineFile
	var docCandidates []CandidateOutlineFile
	for _, c := range candidates {
		if c.IsDoc {
			docCandidates = append(docCandidates, c)
		} else {
			codeCandidates = append(codeCandidates, c)
		}
	}

	if len(codeCandidates) > 0 && len(codeCandidates) <= 3 && opts.FileReader != nil {
		anchors := ExtractSubFileAnchors(codeCandidates, docCandidates, nodes, opts.FileReader, opts.SymbolExtractor, patterns)
		if len(anchors) > 0 {
			candidates = append(candidates, anchors...)
			sort.Slice(candidates, func(i, j int) bool {
				if candidates[i].Weight != candidates[j].Weight {
					return candidates[i].Weight > candidates[j].Weight
				}
				if candidates[i].Path != candidates[j].Path {
					return candidates[i].Path < candidates[j].Path
				}
				return candidates[i].Anchor < candidates[j].Anchor
			})
			if maxFiles > 0 && len(candidates) > maxFiles {
				candidates = candidates[:maxFiles]
			}
			for i := range candidates {
				candidates[i].Handle = i + 1
			}
		}
	}

	return
}

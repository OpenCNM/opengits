package cognitive

import (
	"sort"
	"strings"
)

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

	for _, n := range nodes {
		if n.Type == "blob" {
			parts := strings.Split(n.Path, "/")
			fileName := parts[len(parts)-1]
			if patterns.IsReadme(fileName) && !strings.Contains(n.Path, "/") {
				return n.Path
			}
		}
	}

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

func BuildRuleFallbackOutline(
	nodes []GitNode,
	prefix string,
	targetLanguage string,
	patterns Patterns,
	opts ...OutlineSignalOptions,
) []OutlineChapter {
	return buildRuleFallbackOutline(newOutlineCtx(nodes, prefix, targetLanguage, patterns, opts))
}

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

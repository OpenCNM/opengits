package scout

import (
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

var defaultCodeExtToLang = map[string]string{
	".py":      "python",
	".pyw":     "python",
	".pyi":     "python",
	".ts":      "typescript",
	".tsx":     "typescript",
	".js":      "javascript",
	".jsx":     "javascript",
	".mjs":     "javascript",
	".cjs":     "javascript",
	".go":      "go",
	".rs":      "rust",
	".java":    "java",
	".c":       "c",
	".h":       "c",
	".cpp":     "cpp",
	".cc":      "cpp",
	".cxx":     "cpp",
	".hpp":     "cpp",
	".hh":      "cpp",
	".hxx":     "cpp",
	".cs":      "csharp",
	".rb":      "ruby",
	".php":     "php",
	".swift":   "swift",
	".kt":      "kotlin",
	".kts":     "kotlin",
	".scala":   "scala",
	".sc":      "scala",
	".dart":    "dart",
	".lua":     "lua",
	".sh":      "bash",
	".bash":    "bash",
	".zsh":     "bash",
	".r":       "r",
	".jl":      "julia",
	".zig":     "zig",
	".nim":     "nim",
	".ex":      "elixir",
	".exs":     "elixir",
	".erl":     "erlang",
	".hrl":     "erlang",
	".clj":     "clojure",
	".cljs":    "clojure",
	".cljc":    "clojure",
	".hs":      "haskell",
	".lhs":     "haskell",
	".sql":     "sql",
	".sol":     "solidity",
	".proto":   "protobuf",
	".vue":     "vue",
	".svelte":  "svelte",
	".mojo":    "mojo",
	".typ":     "typst",
	".odin":    "odin",
	".v":       "vlang",
	".mbt":     "moonbit",
	".bend":    "bend",
	".carbon":  "carbon",
	".gleam":   "gleam",
}

type codeCandidate struct {
	filename      string
	isDirect      bool
	isTest        bool
	isBoilerplate bool
	lang          string
}

type dirStats struct {
	mdCount    int
	codeCount  int
	langCounts map[string]int
	codeFiles  []codeCandidate
	children   []string
}

type dirEntry struct {
	dir   string
	parts []string
	depth int
	stats *dirStats
}

type ptrTreeNode struct {
	Path        string
	Name        string
	Depth       int
	MdCount     int
	CodeCount   int
	PrimaryLang string
	KeyFiles    []string
	TotalFiles  int
	Children    []*ptrTreeNode
}

func isTestFile(filename string) bool {
	lower := strings.ToLower(filename)
	return strings.HasPrefix(lower, "test_") ||
		strings.HasPrefix(lower, "test-") ||
		strings.HasSuffix(lower, "_test.go") ||
		strings.HasSuffix(lower, "_test.py") ||
		strings.HasSuffix(lower, "-test.py") ||
		strings.HasSuffix(lower, ".test.ts") ||
		strings.HasSuffix(lower, ".test.tsx") ||
		strings.HasSuffix(lower, ".test.js") ||
		strings.HasSuffix(lower, ".test.jsx") ||
		strings.HasSuffix(lower, ".spec.ts") ||
		strings.HasSuffix(lower, ".spec.tsx") ||
		strings.HasSuffix(lower, ".spec.js") ||
		strings.HasSuffix(lower, ".spec.jsx") ||
		strings.HasSuffix(lower, "_test.rs") ||
		strings.HasSuffix(lower, "-test.rs") ||
		lower == "test.py" ||
		lower == "tests.py" ||
		lower == "test.ts" ||
		lower == "test.js" ||
		lower == "test.go"
}

func isBoilerplateFile(filename string) bool {
	lower := strings.ToLower(filename)
	return lower == "__init__.py" ||
		lower == "index.ts" ||
		lower == "index.js" ||
		lower == "index.tsx" ||
		lower == "index.jsx"
}

func computePrimaryLang(langCounts map[string]int) string {
	if len(langCounts) == 0 {
		return ""
	}
	bestLang := ""
	bestCount := -1
	for lang, count := range langCounts {
		if count > bestCount || (count == bestCount && (bestLang == "" || lang < bestLang)) {
			bestCount = count
			bestLang = lang
		}
	}
	return bestLang
}

func selectKeyFiles(candidates []codeCandidate, primaryLang string) []string {
	if len(candidates) == 0 {
		return nil
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.isTest != b.isTest {
			return !a.isTest
		}
		if a.isDirect != b.isDirect {
			return a.isDirect
		}
		if a.isBoilerplate != b.isBoilerplate {
			return !a.isBoilerplate
		}
		matchA := (a.lang == primaryLang)
		matchB := (b.lang == primaryLang)
		if matchA != matchB {
			return matchA
		}
		return naturalDirOrder(a.filename, b.filename) < 0
	})

	var result []string
	seen := make(map[string]bool)
	for _, c := range candidates {
		if seen[c.filename] {
			continue
		}
		seen[c.filename] = true
		result = append(result, c.filename)
		if len(result) >= 3 {
			break
		}
	}
	return result
}

// DirTreeBuilder 目录树构建与贪心预算剪枝器 (Builder / Pruner)
type DirTreeBuilder struct {
	maxDepth int
	maxNodes int
}

// NewDirTreeBuilder 初始化目录树构建器
func NewDirTreeBuilder(maxDepth, maxNodes int) *DirTreeBuilder {
	if maxDepth <= 0 || maxDepth > DirTreeDefaultMaxDepth {
		maxDepth = DirTreeDefaultMaxDepth
	}
	if maxNodes <= 0 {
		maxNodes = DirTreeMaxNodes
	}
	return &DirTreeBuilder{
		maxDepth: maxDepth,
		maxNodes: maxNodes,
	}
}

// Build 根据 Git 节点全集构建限制深度与自然排序的目录树
func (b *DirTreeBuilder) Build(nodes []GitNode) []DirTreeNode {
	stats := collectDirStats(nodes, []string{".md", ".mdx"})
	var entries []dirEntry
	for dir, s := range stats {
		trimmed := strings.Trim(dir, "/")
		if trimmed == "" {
			continue
		}
		parts := strings.Split(trimmed, "/")
		depth := len(parts)
		if depth >= 1 && depth <= b.maxDepth {
			entries = append(entries, dirEntry{
				dir:   dir,
				parts: parts,
				depth: depth,
				stats: s,
			})
		}
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].depth != entries[j].depth {
			return entries[i].depth < entries[j].depth
		}
		return entries[i].dir < entries[j].dir
	})

	nodeMap := make(map[string]*ptrTreeNode)
	var rootTrees []*ptrTreeNode

	for _, e := range entries {
		primaryLang := computePrimaryLang(e.stats.langCounts)
		keyFiles := selectKeyFiles(e.stats.codeFiles, primaryLang)

		treeNode := &ptrTreeNode{
			Path:        e.dir,
			Name:        e.parts[len(e.parts)-1],
			Depth:       e.depth,
			MdCount:     e.stats.mdCount,
			CodeCount:   e.stats.codeCount,
			PrimaryLang: primaryLang,
			KeyFiles:    keyFiles,
			TotalFiles:  len(e.stats.children),
			Children:    []*ptrTreeNode{},
		}
		nodeMap[e.dir] = treeNode

		if e.depth == 1 {
			rootTrees = append(rootTrees, treeNode)
		} else {
			parentDir := strings.Join(e.parts[:len(e.parts)-1], "/") + "/"
			parentNode, ok := nodeMap[parentDir]
			if ok {
				parentNode.Children = append(parentNode.Children, treeNode)
			} else {
				rootTrees = append(rootTrees, treeNode)
			}
		}
	}

	total := 0
	for _, r := range rootTrees {
		total += countSubtreeNodes(r)
	}

	if total > b.maxNodes {
		sizeMemo := make(map[*ptrTreeNode]int)
		rootTrees = pruneToBudget(rootTrees, b.maxNodes, sizeMemo)
	}

	sortTreeLevels(rootTrees)

	return toDirTreeNodes(rootTrees)
}

func collectDirStats(nodes []GitNode, extensions []string) map[string]*dirStats {
	stats := make(map[string]*dirStats)
	ensure := func(dir string) *dirStats {
		s, ok := stats[dir]
		if !ok {
			s = &dirStats{
				mdCount:    0,
				codeCount:  0,
				langCounts: make(map[string]int),
				codeFiles:  nil,
				children:   []string{},
			}
			stats[dir] = s
		}
		return s
	}

	for _, node := range nodes {
		if node.Type == "tree" {
			selfDir := node.Path
			if !strings.HasSuffix(selfDir, "/") {
				selfDir += "/"
			}
			ensure(selfDir)
			if idx := strings.LastIndex(node.Path, "/"); idx >= 0 {
				parent := node.Path[:idx] + "/"
				childName := node.Path[idx+1:]
				ensure(parent).children = append(ensure(parent).children, childName)
			}
		} else if node.Type == "blob" {
			lower := strings.ToLower(node.Path)
			isMd := false
			for _, ext := range extensions {
				if strings.HasSuffix(lower, ext) {
					isMd = true
					break
				}
			}

			ext := filepath.Ext(lower)
			lang, isCode := defaultCodeExtToLang[ext]

			parts := strings.Split(node.Path, "/")
			filename := parts[len(parts)-1]
			if strings.HasPrefix(filename, ".") {
				isCode = false
			}

			isTest := false
			isBoilerplate := false
			if isCode {
				isTest = isTestFile(filename)
				isBoilerplate = isBoilerplateFile(filename)
			}

			acc := ""
			for i := 0; i < len(parts)-1; i++ {
				if acc == "" {
					acc = parts[i]
				} else {
					acc = acc + "/" + parts[i]
				}
				s := ensure(acc + "/")
				if isMd {
					s.mdCount++
				}
				if isCode {
					s.codeCount++
					s.langCounts[lang]++
					isDirect := (i == len(parts)-2)
					s.codeFiles = append(s.codeFiles, codeCandidate{
						filename:      filename,
						isDirect:      isDirect,
						isTest:        isTest,
						isBoilerplate: isBoilerplate,
						lang:          lang,
					})
				}
			}
		}
	}

	return stats
}

func countSubtreeNodes(node *ptrTreeNode) int {
	count := 1
	for _, c := range node.Children {
		count += countSubtreeNodes(c)
	}
	return count
}

func memoSubtreeSize(node *ptrTreeNode, memo map[*ptrTreeNode]int) int {
	if s, ok := memo[node]; ok {
		return s
	}
	s := 1
	for _, c := range node.Children {
		s += memoSubtreeSize(c, memo)
	}
	memo[node] = s
	return s
}

func pruneToBudget(nodes []*ptrTreeNode, budget int, sizeMemo map[*ptrTreeNode]int) []*ptrTreeNode {
	ordered := make([]*ptrTreeNode, len(nodes))
	copy(ordered, nodes)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].MdCount != ordered[j].MdCount {
			return ordered[i].MdCount > ordered[j].MdCount
		}
		return ordered[i].CodeCount > ordered[j].CodeCount
	})

	var kept []*ptrTreeNode
	remaining := budget

	for _, node := range ordered {
		if remaining <= 0 {
			break
		}
		size := memoSubtreeSize(node, sizeMemo)
		if size <= remaining {
			kept = append(kept, node)
			remaining -= size
		} else {
			descended := pruneToBudget(node.Children, remaining-1, sizeMemo)
			if len(descended) > 0 {
				nodeCopy := *node
				nodeCopy.Children = descended
				kept = append(kept, &nodeCopy)
				descendedTotal := 0
				for _, d := range descended {
					descendedTotal += memoSubtreeSize(d, sizeMemo)
				}
				remaining -= 1 + descendedTotal
			}
		}
	}
	return kept
}

func sortTreeLevels(nodes []*ptrTreeNode) {
	sort.SliceStable(nodes, func(i, j int) bool {
		return naturalDirOrder(nodes[i].Name, nodes[j].Name) < 0
	})
	for _, n := range nodes {
		sortTreeLevels(n.Children)
	}
}

func toDirTreeNodes(nodes []*ptrTreeNode) []DirTreeNode {
	if len(nodes) == 0 {
		return []DirTreeNode{}
	}
	out := make([]DirTreeNode, len(nodes))
	for i, n := range nodes {
		out[i] = DirTreeNode{
			Path:        n.Path,
			Name:        n.Name,
			Depth:       n.Depth,
			MdCount:     n.MdCount,
			CodeCount:   n.CodeCount,
			PrimaryLang: n.PrimaryLang,
			KeyFiles:    n.KeyFiles,
			TotalFiles:  n.TotalFiles,
			Children:    toDirTreeNodes(n.Children),
		}
	}
	return out
}

func naturalDirOrder(a, b string) int {
	i, j := 0, 0
	lenA, lenB := len(a), len(b)
	for i < lenA && j < lenB {
		rA, sizeA := utf8.DecodeRuneInString(a[i:])
		rB, sizeB := utf8.DecodeRuneInString(b[j:])

		isDigitA := unicode.IsDigit(rA) && rA <= '9'
		isDigitB := unicode.IsDigit(rB) && rB <= '9'

		if isDigitA && isDigitB {
			startA := i
			for i < lenA && a[i] >= '0' && a[i] <= '9' {
				i++
			}
			startB := j
			for j < lenB && b[j] >= '0' && b[j] <= '9' {
				j++
			}
			chunkA := a[startA:i]
			chunkB := b[startB:j]

			trimA := strings.TrimLeft(chunkA, "0")
			trimB := strings.TrimLeft(chunkB, "0")

			if len(trimA) != len(trimB) {
				if len(trimA) < len(trimB) {
					return -1
				}
				return 1
			}
			if trimA != trimB {
				if trimA < trimB {
					return -1
				}
				return 1
			}
			if len(chunkA) != len(chunkB) {
				if len(chunkA) < len(chunkB) {
					return -1
				}
				return 1
			}
		} else {
			lowerA := unicode.ToLower(rA)
			lowerB := unicode.ToLower(rB)
			if lowerA != lowerB {
				if lowerA < lowerB {
					return -1
				}
				return 1
			}
			i += sizeA
			j += sizeB
		}
	}
	if i < lenA {
		return 1
	}
	if j < lenB {
		return -1
	}
	return 0
}

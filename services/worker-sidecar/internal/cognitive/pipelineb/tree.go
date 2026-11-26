package pipelineb

import (
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
)

type RepoTreeNode struct {
	Path      string          `json:"path"`
	Name      string          `json:"name"`
	Children  []*RepoTreeNode `json:"children,omitempty"`
	FileCount int             `json:"fileCount"`
	LOC       int             `json:"loc"`
	LangDist  map[string]int  `json:"langDist,omitempty"`
	Hotness   int             `json:"hotness"`
	Files     []FileMap       `json:"files,omitempty"`

	leafMu   sync.Mutex
	leafIdx  map[string]*FileMap
	leafList []FileMap
}

func BuildRepoTree(files []FileMap, repoName string) *RepoTreeNode {
	root := &RepoTreeNode{Path: "", Name: repoName}
	for i := range files {
		f := files[i]
		node := root
		parts := strings.Split(strings.Trim(f.Path, "/"), "/")
		for _, seg := range parts[:len(parts)-1] {
			if seg == "" {
				continue
			}
			child := node.findChild(seg)
			if child == nil {
				child = &RepoTreeNode{Path: joinPath(node.Path, seg), Name: seg}
				node.Children = append(node.Children, child)
			}
			node = child
		}
		node.Files = append(node.Files, f)
	}
	collapseSingleChains(root)
	RollupTree(root)
	return root
}

func (n *RepoTreeNode) findChild(name string) *RepoTreeNode {
	for _, c := range n.Children {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func joinPath(base, seg string) string {
	if base == "" {
		return seg
	}
	return base + "/" + seg
}

func collapseSingleChains(n *RepoTreeNode) {
	for _, c := range n.Children {
		collapseSingleChains(c)
	}
	for len(n.Children) == 1 && len(n.Files) == 0 && n.Path != "" {
		only := n.Children[0]
		n.Name = n.Name + "/" + only.Name
		n.Path = only.Path
		n.Files = only.Files
		n.Children = only.Children
	}
}

func RollupTree(n *RepoTreeNode) {
	if n.LangDist == nil {
		n.LangDist = map[string]int{}
	}
	n.FileCount = len(n.Files)
	n.LOC = 0
	n.Hotness = 0
	for _, f := range n.Files {
		n.LOC += f.LOC
		n.Hotness += f.Hotness
		ext := extOf(f.Path)
		n.LangDist[ext]++
	}
	for _, c := range n.Children {
		RollupTree(c)
		n.FileCount += c.FileCount
		n.LOC += c.LOC
		n.Hotness += c.Hotness
		for k, v := range c.LangDist {
			n.LangDist[k] += v
		}
	}
}

func RenderSkeleton(n *RepoTreeNode) string {
	var sb strings.Builder
	root := skipRootWrapper(n)
	writeNodeLine(&sb, "", root)
	renderChildrenAt(&sb, root, "  ", 1, 1)
	return sb.String()
}

// Unwrap single-child root wrappers holding <10% direct files so monorepo-wrapped repos expose real subsystems.
func skipRootWrapper(n *RepoTreeNode) *RepoTreeNode {
	for len(n.Children) == 1 && float64(len(n.Files))/float64(n.Children[0].FileCount+1) < 0.1 {
		n = n.Children[0]
	}
	return n
}

func RenderSubtreeSkeleton(n *RepoTreeNode, depth int) string {
	var sb strings.Builder
	writeNodeLine(&sb, "", n)
	renderChildrenAt(&sb, n, "  ", 1, depth)
	return sb.String()
}

func RenderSamplingSkeleton(n *RepoTreeNode, maxTotalFiles ...int) string {
	budget := 160
	if len(maxTotalFiles) > 0 && maxTotalFiles[0] > 0 {
		budget = maxTotalFiles[0]
	}
	var sb strings.Builder
	root := skipRootWrapper(n)
	writeNodeLine(&sb, "", root)
	if len(root.Files) > 0 {
		sortedRoot := sortFilesForSampling(root.Files)
		limit := 10
		if len(sortedRoot) < limit {
			limit = len(sortedRoot)
		}
		if limit > budget {
			limit = budget
		}
		for i := 0; i < limit; i++ {
			renderFileSampleLine(&sb, "  ", sortedRoot[i])
			budget--
		}
		if len(sortedRoot) > limit {
			fmt.Fprintf(&sb, "  ... (+%d more root files)\n", len(sortedRoot)-limit)
		}
	}
	renderSamplingChildrenAt(&sb, root, "  ", 1, 3, &budget)
	return sb.String()
}

func renderSamplingChildrenAt(sb *strings.Builder, n *RepoTreeNode, indent string, level, depth int, budget *int) {
	if level > depth || *budget <= 0 {
		return
	}
	kids := append([]*RepoTreeNode(nil), n.Children...)
	sort.Slice(kids, func(i, j int) bool { return kids[i].Name < kids[j].Name })
	for _, c := range kids {
		if *budget <= 0 {
			break
		}
		writeNodeLine(sb, indent, c)
		if len(c.Files) > 0 {
			sorted := sortFilesForSampling(c.Files)
			limit := 6
			if len(sorted) < limit {
				limit = len(sorted)
			}
			if limit > *budget {
				limit = *budget
			}
			for i := 0; i < limit; i++ {
				renderFileSampleLine(sb, indent+"  ", sorted[i])
				*budget--
			}
			if len(sorted) > limit {
				fmt.Fprintf(sb, "%s  ... (+%d more files in %s)\n", indent, len(sorted)-limit, c.Name)
			}
		}
		renderSamplingChildrenAt(sb, c, indent+"  ", level+1, depth, budget)
	}
}

func RenderStratifiedSamplingSkeleton(n *RepoTreeNode, subsystems []SubsystemSpec, maxTotalFiles int) string {
	if len(subsystems) == 0 {
		return RenderSamplingSkeleton(n, maxTotalFiles)
	}
	budget := 160
	if maxTotalFiles > 0 {
		budget = maxTotalFiles
	}

	var sb strings.Builder
	root := skipRootWrapper(n)
	writeNodeLine(&sb, "", root)

	files := root.LeafFiles()
	byPrefix := make(map[string][]FileMap, len(subsystems)+1)
	prefixOf := make(map[string]*SubsystemSpec, len(subsystems))
	for i := range subsystems {
		prefixOf[subsystems[i].Prefix] = &subsystems[i]
	}
	var rootFiles []FileMap
	for _, f := range files {
		owner := longestMatchingPrefix(f.Path, subsystemPrefixes(subsystems))
		if owner == "" {
			rootFiles = append(rootFiles, f)
			continue
		}
		byPrefix[owner] = append(byPrefix[owner], f)
	}

	type bucket struct {
		label  string
		spec   *SubsystemSpec
		files  []FileMap
		cursor int
	}
	buckets := make([]bucket, 0, len(subsystems)+1)
	if len(rootFiles) > 0 {
		buckets = append(buckets, bucket{label: "(root)", files: sortFilesForSampling(rootFiles)})
	}
	for _, s := range subsystems {
		if s.IsAuxiliary {
			continue
		}
		fs := sortFilesForSampling(byPrefix[s.Prefix])
		if len(fs) == 0 {
			continue
		}
		buckets = append(buckets, bucket{label: s.Name, spec: &s, files: fs})
	}

	const guaranteedPerSubsystem = 3
	for bi := range buckets {
		b := &buckets[bi]
		if budget <= 0 {
			break
		}
		if b.spec != nil {
			fmt.Fprintf(&sb, "  %s | files:%d | loc:%d\n", b.label, b.spec.FileCount, b.spec.EstLOC)
		}
		take := min(guaranteedPerSubsystem, len(b.files), budget)
		for i := 0; i < take; i++ {
			renderFileSampleLine(&sb, "    ", b.files[i])
			budget--
		}
		b.cursor = take
	}

	for budget > 0 {
		progressed := false
		for i := range buckets {
			if budget <= 0 {
				break
			}
			b := &buckets[i]
			if b.cursor < len(b.files) {
				renderFileSampleLine(&sb, "    ", b.files[b.cursor])
				b.cursor++
				budget--
				progressed = true
			}
		}
		if !progressed {
			break
		}
	}
	return sb.String()
}

func subsystemPrefixes(subsystems []SubsystemSpec) []string {
	out := make([]string, 0, len(subsystems))
	for _, s := range subsystems {
		out = append(out, s.Prefix)
	}
	return out
}

func sortFilesForSampling(files []FileMap) []FileMap {
	out := append([]FileMap(nil), files...)
	sort.Slice(out, func(i, j int) bool {
		sI, sJ := scoreSamplingFile(out[i]), scoreSamplingFile(out[j])
		if sI != sJ {
			return sI > sJ
		}
		return out[i].Path < out[j].Path
	})
	return out
}

func scoreSamplingFile(f FileMap) int {
	score := 0
	if f.IsConfig {
		score += 50
	}
	if isExplicitEntryPointLocal(f.Path) {
		score += 40
	}
	if f.IsDoc {
		score += 30
	}
	if !f.IsTest {
		score += 20
	}
	if f.LOC > 50 {
		score += 10
	}
	return score
}

func renderFileSampleLine(sb *strings.Builder, indent string, f FileMap) {
	fmt.Fprintf(sb, "%s- %s | loc:%d", indent, f.Path, f.LOC)
	if f.IsConfig {
		sb.WriteString(" | config")
	} else if f.IsDoc {
		sb.WriteString(" | doc")
	} else if f.IsTest {
		sb.WriteString(" | test")
	}
	sb.WriteByte('\n')
}

func writeNodeLine(sb *strings.Builder, indent string, n *RepoTreeNode) {
	fmt.Fprintf(sb, "%s%s | files:%d | loc:%d | hot:%d", indent, n.Name, n.FileCount, n.LOC, n.Hotness)
	if len(n.LangDist) > 0 {
		sb.WriteString(" | " + renderLangDist(n.LangDist))
	}
	sb.WriteByte('\n')
}

func renderChildrenAt(sb *strings.Builder, n *RepoTreeNode, indent string, level, depth int) {
	if level > depth {
		return
	}
	kids := append([]*RepoTreeNode(nil), n.Children...)
	sort.Slice(kids, func(i, j int) bool { return kids[i].Name < kids[j].Name })
	for _, c := range kids {
		writeNodeLine(sb, indent, c)
		renderChildrenAt(sb, c, indent+"  ", level+1, depth)
	}
}

func renderLangDist(d map[string]int) string {
	type kv struct {
		k string
		v int
	}
	var list []kv
	for k, v := range d {
		list = append(list, kv{k, v})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].v != list[j].v {
			return list[i].v > list[j].v
		}
		return list[i].k < list[j].k
	})
	parts := make([]string, 0, len(list))
	for i, e := range list {
		if i >= 4 {
			break
		}
		parts = append(parts, fmt.Sprintf("%s×%d", e.k, e.v))
	}
	return strings.Join(parts, " ")
}

func extOf(p string) string {
	if i := strings.LastIndexByte(p, '.'); i >= 0 && strings.IndexByte(p[i+1:], '/') < 0 {
		return p[i:]
	}
	return "(none)"
}

// Re-sorts tree leaves lexicographically because directory traversal interleaves root files and subtrees; returned slice/map are read-only.
func (n *RepoTreeNode) LeafFiles() []FileMap {
	var out []FileMap
	var walk func(*RepoTreeNode)
	walk = func(node *RepoTreeNode) {
		out = append(out, node.Files...)
		for _, c := range node.Children {
			walk(c)
		}
	}
	walk(n)
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// Guards one-time lazy leaf index construction across concurrent readers on an immutable tree.
func (n *RepoTreeNode) leafFilesIndexed() ([]FileMap, map[string]*FileMap) {
	n.leafMu.Lock()
	defer n.leafMu.Unlock()
	if n.leafIdx == nil {
		files := n.LeafFiles()
		idx := make(map[string]*FileMap, len(files))
		for i := range files {
			idx[files[i].Path] = &files[i]
		}
		n.leafIdx = idx
		n.leafList = files
	}
	return n.leafList, n.leafIdx
}

const (
	thematicSkeletonBudget    = 60
	thematicSparseSymbolRatio = 0.1
)

// Treats empty denominator (no non-test/non-config files) as sparse so callers always include fallback file visibility.
func HasSparseAstSymbols(root *RepoTreeNode) bool {
	var total, withSymbols int
	for _, f := range root.LeafFiles() {
		if f.IsTest || f.IsConfig {
			continue
		}
		total++
		if len(f.Exports) > 0 {
			withSymbols++
		}
	}
	if total == 0 {
		return true
	}
	return float64(withSymbols)/float64(total) < thematicSparseSymbolRatio
}

func RenderThematicSkeleton(root *RepoTreeNode, maxFiles int) string {
	var sb strings.Builder
	sb.WriteString(RenderSkeleton(root))

	budget := thematicSkeletonBudget
	if maxFiles > 0 {
		budget = maxFiles
	}

	leaves := root.LeafFiles()

	symbolFiles := make([]FileMap, 0, len(leaves))
	for _, f := range leaves {
		if !f.IsTest && !f.IsConfig && (len(f.Exports) > 0 || len(f.TopSymbols) > 0) {
			symbolFiles = append(symbolFiles, f)
		}
	}
	if len(symbolFiles) > 0 {
		symbolFiles = sortFilesThematic(symbolFiles)
		limit := min(len(symbolFiles), budget)
		sb.WriteString("=== 定向符号索引(高信噪比 AST 提取文件) ===\n")
		for i := 0; i < limit; i++ {
			writeThematicSymbolLine(&sb, symbolFiles[i])
		}
	}

	if HasSparseAstSymbols(root) {
		renderThematicFallback(&sb, leaves, budget)
	}
	return sb.String()
}

const promptSpotlightMaxFiles = 40
const promptSpotlightSiblingsPerDir = 3

func RenderThematicSkeletonForPrompt(root *RepoTreeNode, maxFiles int, customPrompt string) string {
	base := RenderThematicSkeleton(root, maxFiles)
	if root == nil || strings.TrimSpace(customPrompt) == "" {
		return base
	}
	leaves, leafIdx := root.leafFilesIndexed()
	matched := MatchPromptPathsInLeaves(customPrompt, leaves, root.Path)
	if len(matched) == 0 {
		return base
	}

	byDir := make(map[string][]FileMap)
	for _, f := range leaves {
		if f.IsTest || f.IsConfig || f.IsDoc {
			continue
		}
		d := path.Dir(f.Path)
		byDir[d] = append(byDir[d], f)
	}
	for d, list := range byDir {
		byDir[d] = sortFilesThematic(list)
	}

	seen := make(map[string]bool, promptSpotlightMaxFiles)
	spotlight := make([]FileMap, 0, promptSpotlightMaxFiles)
	addFile := func(f FileMap) {
		if seen[f.Path] || len(spotlight) >= promptSpotlightMaxFiles {
			return
		}
		seen[f.Path] = true
		spotlight = append(spotlight, f)
	}

	for _, mp := range matched {
		if fm, ok := leafIdx[mp]; ok {
			addFile(*fm)
		}
	}
	for _, mp := range matched {
		if len(spotlight) >= promptSpotlightMaxFiles {
			break
		}
		sibs := byDir[path.Dir(mp)]
		addedSib := 0
		for _, sib := range sibs {
			if len(spotlight) >= promptSpotlightMaxFiles || addedSib >= promptSpotlightSiblingsPerDir {
				break
			}
			if !seen[sib.Path] {
				addFile(sib)
				addedSib++
			}
		}
	}

	if len(spotlight) == 0 {
		return base
	}

	var sb strings.Builder
	sb.WriteString(base)
	if !strings.HasSuffix(base, "\n") {
		sb.WriteByte('\n')
	}
	sb.WriteString("=== 用户点名路径与同包核心源码(确定性物理展开) ===\n")
	for _, f := range spotlight {
		fmt.Fprintf(&sb, "%s | loc:%d | hot:%d", f.Path, f.LOC, f.Hotness)
		if syms := effectiveSymbols(f); len(syms) > 0 {
			sb.WriteString(" | exports:" + thematicExportsPreview(syms))
		}
		if len(f.Imports) > 0 {
			sb.WriteString(" | imports:" + previewSymbolList(f.Imports, 4))
		}
		sb.WriteByte('\n')
	}
	return sb.String()
}

func renderThematicFallback(sb *strings.Builder, leaves []FileMap, budget int) {
	buckets := map[string][]FileMap{}
	for _, f := range leaves {
		if f.IsTest || f.IsConfig || len(f.Exports) > 0 || len(f.TopSymbols) > 0 {
			continue
		}
		seg := thematicTopSegment(f.Path)
		buckets[seg] = append(buckets[seg], f)
	}
	if len(buckets) == 0 {
		return
	}
	names := make([]string, 0, len(buckets))
	for k := range buckets {
		names = append(names, k)
	}
	sort.Strings(names)
	// Bucket-sort by LOC desc then Path asc before round-robin because LeafFiles order is purely lexicographic.
	for _, k := range names {
		b := buckets[k]
		sort.SliceStable(b, func(i, j int) bool {
			if b[i].LOC != b[j].LOC {
				return b[i].LOC > b[j].LOC
			}
			return b[i].Path < b[j].Path
		})
		buckets[k] = b
	}
	cursors := make(map[string]int, len(names))
	sb.WriteString("=== 代表性文件清单(未提取符号,按分区配额轮转) ===\n")
	remaining := budget
	for remaining > 0 {
		progressed := false
		for _, name := range names {
			if remaining <= 0 {
				break
			}
			b := buckets[name]
			if cursors[name] >= len(b) {
				continue
			}
			f := b[cursors[name]]
			fmt.Fprintf(sb, "%s | loc:%d\n", f.Path, f.LOC)
			cursors[name]++
			remaining--
			progressed = true
		}
		if !progressed {
			break
		}
	}
}

func thematicTopSegment(path string) string {
	p := strings.Trim(path, "/")
	if i := strings.IndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return "(root)"
}

func effectiveSymbols(f FileMap) []string {
	if len(f.Exports) > 0 {
		return f.Exports
	}
	return f.TopSymbols
}

func effectiveSymbolCount(f FileMap) int {
	return len(effectiveSymbols(f))
}

func writeThematicSymbolLine(sb *strings.Builder, f FileMap) {
	sb.WriteString(f.Path)
	if f.Layer >= LayerFoundation && f.Layer <= LayerInterface {
		fmt.Fprintf(sb, " | layer:%s", multiScaleLayerTag(f.Layer))
	}
	fmt.Fprintf(sb, " | hot:%d | exports:%s\n", f.Hotness, thematicExportsPreview(effectiveSymbols(f)))
}

func previewSymbolList(items []string, capLimit int) string {
	parts := make([]string, 0, min(len(items), capLimit))
	for _, e := range items {
		if e == "" {
			continue
		}
		parts = append(parts, e)
		if len(parts) >= capLimit {
			break
		}
	}
	return strings.Join(parts, ",")
}

func thematicExportsPreview(exports []string) string {
	return previewSymbolList(exports, 8)
}

func RenderSubtreeSkeletonWithFiles(n *RepoTreeNode, depth, fileBudget int) string {
	var sb strings.Builder
	writeNodeLine(&sb, "", n)
	if fileBudget > 0 && len(n.Files) > 0 {
		writeThematicFileLines(&sb, "  ", sortFilesThematic(n.Files), fileBudget)
	}
	renderChildrenAtWithFiles(&sb, n, "  ", 1, depth, fileBudget)
	return sb.String()
}

func renderChildrenAtWithFiles(sb *strings.Builder, n *RepoTreeNode, indent string, level, depth, fileBudget int) {
	if level > depth {
		return
	}
	kids := append([]*RepoTreeNode(nil), n.Children...)
	sort.Slice(kids, func(i, j int) bool { return kids[i].Name < kids[j].Name })
	for _, c := range kids {
		writeNodeLine(sb, indent, c)
		if fileBudget > 0 && len(c.Files) > 0 {
			writeThematicFileLines(sb, indent+"  ", sortFilesThematic(c.Files), fileBudget)
		}
		renderChildrenAtWithFiles(sb, c, indent+"  ", level+1, depth, fileBudget)
	}
}

func writeThematicFileLines(sb *strings.Builder, indent string, files []FileMap, budget int) {
	limit := min(len(files), budget)
	for i := 0; i < limit; i++ {
		fmt.Fprintf(sb, "%s- %s | loc:%d\n", indent, files[i].Path, files[i].LOC)
	}
}

func sortFilesThematic(files []FileMap) []FileMap {
	out := append([]FileMap(nil), files...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Hotness != out[j].Hotness {
			return out[i].Hotness > out[j].Hotness
		}
		si, sj := effectiveSymbolCount(out[i]), effectiveSymbolCount(out[j])
		if si != sj {
			return si > sj
		}
		if out[i].LOC != out[j].LOC {
			return out[i].LOC > out[j].LOC
		}
		return out[i].Path < out[j].Path
	})
	return out
}

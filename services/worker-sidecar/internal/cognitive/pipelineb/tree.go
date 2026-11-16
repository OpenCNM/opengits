package pipelineb

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// ─────────────────────────────────────────────────────────────
// 仓库树(统一树算法的一等公民数据模型,P0)。
//
// 物理公理 P1:仓库 = 目录树 + 文件内 AST 树。本模型承载前者;
// 叶子(FileMap)承载后者的摘要(符号/导入/热度)。
// 上卷(rollup)是纯确定性数值聚合——P2 公理:认知预算靠上卷,
// 不靠截断;LLM 只在决策点出场(A3 原则)。
// ─────────────────────────────────────────────────────────────

// RepoTreeNode 仓库树节点:内部节点=目录(折叠后),叶子=文件集合挂载点。
type RepoTreeNode struct {
	Path     string          `json:"path"` // 折叠后的路径(如 "cmp/internal/diff")
	Name     string          `json:"name"`
	Children []*RepoTreeNode `json:"children,omitempty"`
	// 上卷聚合(RollupTree 自底向上计算):
	FileCount int            `json:"fileCount"`
	LOC       int            `json:"loc"`
	LangDist  map[string]int `json:"langDist,omitempty"` // 扩展名 → 文件数
	Hotness   int            `json:"hotness"`            // 子树热度合计(现语义=一跳计数和;P2 升级 PageRank)
	Files     []FileMap      `json:"files,omitempty"`    // 叶载荷(仅叶子层)

	// 叶子展开只读缓存（树结构化后不变；并发首调用互斥，结果确定）
	leafMu   sync.Mutex
	leafIdx  map[string]*FileMap
	leafList []FileMap
}

// BuildRepoTree 从(已提取的)文件地图构建折叠树:按目录前缀分组;
// 单子目录链折叠为一节点(django 式深嵌套不产生瘦长树)。
// 叶子文件的顺序严格保持输入顺序(调用方保证字典序)——P1 字节等价前提。
func BuildRepoTree(files []FileMap, repoName string) *RepoTreeNode {
	root := &RepoTreeNode{Path: "", Name: repoName}
	for i := range files {
		f := files[i]
		node := root
		parts := strings.Split(strings.Trim(f.Path, "/"), "/")
		// 逐段下钻(末段是文件名,不入目录层级)
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

// collapseSingleChains 单子目录链折叠:目录只有一个子目录且无直属文件时
// 合并为一节点(只影响骨架渲染;Files 保持原序不动)。
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
		// 父指针语义不变(无父指针);LangDist/Hotness 由后续 Rollup 重算
	}
}

// RollupTree 自底向上聚合(P2 公理的实现:子树→数值摘要,零 LLM)。
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

// RenderSkeleton 骨架图:children 上卷渲染(P2 规划调用的输入)。
// 根级单子包装目录跳过(django 全仓包于顶层 django/ 下——直达真实分区)。
func RenderSkeleton(n *RepoTreeNode) string {
	var sb strings.Builder
	root := skipRootWrapper(n)
	writeNodeLine(&sb, "", root)
	renderChildrenAt(&sb, root, "  ", 1, 1)
	return sb.String()
}

// skipRootWrapper 根(或根链)只有一个子目录且直属文件占比 <10% 时下钻取该子
// (django 全仓包于顶层 django/,根仅散 README 等两三个文件——直达真实分区;
// 根散文件仍在全集装甲与扁平地图中,仅不进骨架首行)。
func skipRootWrapper(n *RepoTreeNode) *RepoTreeNode {
	for len(n.Children) == 1 && float64(len(n.Files))/float64(n.Children[0].FileCount+1) < 0.1 {
		n = n.Children[0]
	}
	return n
}

// RenderSubtreeSkeleton 指定子树的骨架(P2 下钻/A5 导航工具的输入):
// 目标节点为根,渲染其下 depth 层 children 的上卷行。
func RenderSubtreeSkeleton(n *RepoTreeNode, depth int) string {
	var sb strings.Builder
	writeNodeLine(&sb, "", n)
	renderChildrenAt(&sb, n, "  ", 1, depth)
	return sb.String()
}

// RenderSamplingSkeleton 渲染供 AI 架构审阅与自主点名采样的骨架图：
// 包含目录折叠上卷统计，同时按认知预算挂载根目录与各核心子系统的物理文件相对路径（物理真实性锚定）。
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

// RenderStratifiedSamplingSkeleton 策略 B 分层采样骨架（WP1）：按子系统均摊
// budget——每个活跃（非辅助且非空）子系统保底展示其排序前列文件（排序器
// 自带清单/入口/大文件优先语义），保证任何子系统不被单一庞大目录挤出预算；
// 随后剩余预算在各子系统间轮转填充。总预算不变（默认 160）。
// subsystems 为契约 C1 SSOT 输出；为空时平滑回退既有 RenderSamplingSkeleton。
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

	// 文件按最长前缀归属子系统；未认领文件归入根桶（根散落代码不被丢弃）
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

	// 首轮：根桶 + 各活跃子系统保底份额（清单/入口/Top LOC 由既有排序器天然优先）
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

	// 次轮：剩余预算跨子系统轮转填充
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

// renderChildrenAt 渲染 children 上卷至 depth 层(0=不渲染 children)。
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

// LeafFiles 叶子按全路径字典序展开。WalkDir 的逐目录排序等价于全路径
// 字典序,但树展开会打乱"顶层文件与子目录交错"的次序——此处重排恢复,
// 保证与 BuildRepoMap 扁平地图逐字节同序(P1 等价前提)。
//
// 展开结果对同一棵树不变——为 runDrillLevel 高频调用方提供叶子索引
// （每 findSubtree 文件目标分支全树遍历+排序降为 map 命中）。树构建
// 后结构只读；返回的 map/切片不得被调用方修改。
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

// leafIndexOnce/leafIndex/leafFiles 树级只读缓存（结构化后不变；
// 多 goroutine 并发首调由 singleflight 语义的锁保护，结果确定性一致）。
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

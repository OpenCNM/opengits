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

// ─────────────────────────────────────────────────────────────
// 专题切片渲染(customPrompt 非空时的"符号可见性"通道)。
// 规划器在专题任务下需要超越 1 层目录上卷的符号级视野:索引段给
// 高信噪比 AST 符号行(Hotness 主序);稀疏仓追加代表性文件轮转
// 清单防止对未提取目录完全失明(失效封闭:无 AST 载荷时退化为
// LOC 中性视图,绝不虚构符号)。全程纯确定性投影,零网络零 LLM。
// ─────────────────────────────────────────────────────────────

const (
	// thematicSkeletonBudget 专题骨架符号索引段默认行预算(调用方未显式传正数 maxFiles 时的认知预算帽)。
	thematicSkeletonBudget = 60
	// thematicSparseSymbolRatio 稀疏判定阈值:非测试非配置文件中带 AST 符号的占比低于此值
	// 视为稀疏仓,追加代表性文件轮转清单,防止规划器对未提取目录完全失明。
	thematicSparseSymbolRatio = 0.1
)

// HasSparseAstSymbols 确定性稀疏判定:非测试非配置文件(口径与符号索引段一致)
// 中带 AST 导出符号的占比是否严格低于 thematicSparseSymbolRatio。分母为 0
// (空仓或全测试/配置)视为稀疏——调用方需兜底清单避免完全失明。
// 纯 FileMap 结构化字段判定,零正则零语法扫描(Chomsky 边界)。
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

// RenderThematicSkeleton 专题切片双段骨架:
// 第一段原样复用 RenderSkeleton 物理上卷行(保证 targetPaths 与骨架物理对齐,
// 规划器引用的目录锚点不漂移);第二段为"定向符号索引"——LeafFiles 中带 AST
// 导出符号的非测试非配置文件,按 Hotness→符号数→LOC→Path 中性序输出摘要行。
// 稀疏仓(HasSparseAstSymbols 同口径)追加"代表性文件清单"兜底段:未进索引的
// 文件按顶层分区桶轮转展示。各段行数为零时对应标题行不输出(避免空段噪声)。
func RenderThematicSkeleton(root *RepoTreeNode, maxFiles int) string {
	var sb strings.Builder
	// 第一段:物理骨架原样输出(targetPaths 物理对齐,逐字节复用既有渲染)
	sb.WriteString(RenderSkeleton(root))

	budget := thematicSkeletonBudget
	if maxFiles > 0 {
		budget = maxFiles
	}

	leaves := root.LeafFiles()

	// 第二段:定向符号索引(带 AST 导出符号的代码文件,中性信噪比排序)
	symbolFiles := make([]FileMap, 0, len(leaves))
	for _, f := range leaves {
		if !f.IsTest && !f.IsConfig && len(f.Exports) > 0 {
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

	// 稀疏兜底段:与 HasSparseAstSymbols 同口径;未进符号索引的文件按顶层分区轮转
	if HasSparseAstSymbols(root) {
		renderThematicFallback(&sb, leaves, budget)
	}
	return sb.String()
}

// renderThematicFallback 稀疏仓兜底清单:未进符号索引(无 AST 符号)的非测试
// 非配置文件按顶层目录段分桶(根散文件归 "(root)"),桶内 LOC 降序→Path 升序,
// 跨桶轮转每次各取 1 行,总行数不超 budget;桶名升序保证跨调用字节确定。
func renderThematicFallback(sb *strings.Builder, leaves []FileMap, budget int) {
	buckets := map[string][]FileMap{}
	for _, f := range leaves {
		if f.IsTest || f.IsConfig || len(f.Exports) > 0 {
			continue // 已进符号索引或按口径排除的文件不入兜底
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
	// 桶内排序：LOC 降序 → Path 升序（与本函数 docstring 契约一致；
	// LeafFiles 原序是纯字典序，不满足 LOC 主序——不排则轮转行序漂移）
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

// thematicTopSegment 顶层分区段:path 第一段;无目录分隔的根散文件归 "(root)"。
func thematicTopSegment(path string) string {
	p := strings.Trim(path, "/")
	if i := strings.IndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return "(root)"
}

// writeThematicSymbolLine 单行符号索引:path | layer:%s | hot:%d | exports:%s。
// layer 用紧凑标签(arch_model 锚点行同款);未知层级(枚举域外,视为"空")
// 整段省略;exports 滤空后截前 8 个逗号连接(信噪比帽,呼应 MaxExportsPerFile)。
func writeThematicSymbolLine(sb *strings.Builder, f FileMap) {
	sb.WriteString(f.Path)
	if f.Layer >= LayerFoundation && f.Layer <= LayerInterface {
		fmt.Fprintf(sb, " | layer:%s", multiScaleLayerTag(f.Layer))
	}
	fmt.Fprintf(sb, " | hot:%d | exports:%s\n", f.Hotness, thematicExportsPreview(f.Exports))
}

// thematicExportsPreview 导出符号预览:滤空后截前 8 个逗号连接。
func thematicExportsPreview(exports []string) string {
	parts := make([]string, 0, min(len(exports), 8))
	for _, e := range exports {
		if e == "" {
			continue
		}
		parts = append(parts, e)
		if len(parts) >= 8 {
			break
		}
	}
	return strings.Join(parts, ",")
}

// RenderSubtreeSkeletonWithFiles 带直属文件行的子树骨架:目录上卷行语义与
// RenderSubtreeSkeleton 完全一致,但每个目录行下追加该目录直属文件的
// Top fileBudget 行(专题中性排序 sortFilesThematic,弃用采样偏置排序器)。
// fileBudget <= 0 时退化为纯目录骨架(与 RenderSubtreeSkeleton 字节等价)。
func RenderSubtreeSkeletonWithFiles(n *RepoTreeNode, depth, fileBudget int) string {
	var sb strings.Builder
	writeNodeLine(&sb, "", n)
	if fileBudget > 0 && len(n.Files) > 0 {
		writeThematicFileLines(&sb, "  ", sortFilesThematic(n.Files), fileBudget)
	}
	renderChildrenAtWithFiles(&sb, n, "  ", 1, depth, fileBudget)
	return sb.String()
}

// renderChildrenAtWithFiles renderChildrenAt 的文件行跟随版:目录行后插入直属文件 Top 行。
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

// writeThematicFileLines 中性文件行:- %s | loc:%d(不带 doc/config/test 标签,
// 与采样语义的 renderFileSampleLine 严格隔离)。
func writeThematicFileLines(sb *strings.Builder, indent string, files []FileMap, budget int) {
	limit := min(len(files), budget)
	for i := 0; i < limit; i++ {
		fmt.Fprintf(sb, "%s- %s | loc:%d\n", indent, files[i].Path, files[i].LOC)
	}
}

// sortFilesThematic 专题中性排序(采样偏置的反面):Hotness 降序 → 导出符号数
// 降序 → LOC 降序 → Path 升序。不引入 doc/config 入口偏置——专题切片关注符号
// 信噪比;Path 终序键保证同键文件跨调用字节确定。
func sortFilesThematic(files []FileMap) []FileMap {
	out := append([]FileMap(nil), files...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Hotness != out[j].Hotness {
			return out[i].Hotness > out[j].Hotness
		}
		if len(out[i].Exports) != len(out[j].Exports) {
			return len(out[i].Exports) > len(out[j].Exports)
		}
		if out[i].LOC != out[j].LOC {
			return out[i].LOC > out[j].LOC
		}
		return out[i].Path < out[j].Path
	})
	return out
}

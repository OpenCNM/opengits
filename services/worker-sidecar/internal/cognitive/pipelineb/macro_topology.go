package pipelineb

import (
	"strconv"

	"hash/fnv"

	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
)

// ─────────────────────────────────────────────────────────────
// 多尺度架构全景图生成 (Multi-Scale Architecture Zooming Diagram)
//
// 符号-神经协同漏斗实现 (P0 核心):
// 1. 确定性拓扑提取:
//    - C4 L1 (Scale 1): 宏观系统上下文 (自然子系统目录分区或基于 TopologicalLayer 拓扑聚类)
//    - C4 L2 (Scale 2): 子系统组件协作图 (指定子系统内部包与边界存根)
//    - C4 L3 (Scale 3): 单章微观函数调用链 (chapter.BuildModuleArchitectureMermaidSkeleton)
// 2. 100% 物理真实性:
//    - 节点锚定物理文件集合，边严格来自 AST 跨文件调用 (m.CallEdges) 与 Import
//    - 严禁路径猜谜，提供 100% 语法闭合的 RawMermaid 骨架图
// ─────────────────────────────────────────────────────────────

// MacroTopologyNode 宏观架构节点 (子系统或拓扑分层组件)。
type MacroTopologyNode struct {
	ID          string   `json:"id"`
	Path        string   `json:"path"`
	Name        string   `json:"name"`
	Role        string   `json:"role,omitempty"` // "interface", "core", "infra", "utility"
	FileCount   int      `json:"fileCount"`
	LOC         int      `json:"loc"`
	Hotness     int      `json:"hotness"`
	TopExports  []string `json:"topExports,omitempty"`
	PrimaryLang string   `json:"primaryLang,omitempty"`
}

// MacroTopologyEdge 宏观调用依赖边。
type MacroTopologyEdge struct {
	From    string   `json:"from"`
	To      string   `json:"to"`
	Weight  int      `json:"weight"`
	Symbols []string `json:"symbols,omitempty"`
	Label   string   `json:"label,omitempty"`
}

// MacroTopology 架构全景图拓扑模型。
type MacroTopology struct {
	Scope      string              `json:"scope"`
	Scale      int                 `json:"scale"`    // 1 = Macro System Context, 2 = Subsystem Component Map
	Strategy   string              `json:"strategy"` // "directory" | "topological_layer"
	Nodes      []MacroTopologyNode `json:"nodes"`
	Edges      []MacroTopologyEdge `json:"edges"`
	RawMermaid string              `json:"rawMermaid"` // 保证 100% 语法的物理骨架
	Mermaid    string              `json:"mermaid"`    // 语义增强图 (或兜底骨架)
	Summary    string              `json:"summary,omitempty"`
}

// BuildMacroTopology 提取多尺度架构全景图拓扑。
// scope: 根目录传 "" (Scale 1)，子系统下钻传分区相对路径如 "hugolib" (Scale 2)。
func BuildMacroTopology(m *RepoMap, scope string, scale int, patterns cognitive.Patterns) *MacroTopology {
	topo := &MacroTopology{
		Scope: scope,
		Scale: scale,
	}
	if m == nil || m.Tree == nil {
		topo.RawMermaid = "```mermaid\nflowchart TD\n  empty[\"Empty Repository\"]\n```"
		topo.Mermaid = topo.RawMermaid
		return topo
	}

	if scale == 2 && scope != "" {
		buildSubsystemTopology(m, scope, topo, patterns)
	} else {
		buildMacroSystemTopology(m, topo, patterns)
	}

	topo.RawMermaid = RenderDeterministicMermaidSkeleton(topo)
	topo.Mermaid = topo.RawMermaid
	return topo
}

// buildMacroSystemTopology 提取 C4 L1 全局宏观系统上下文图。
func buildMacroSystemTopology(m *RepoMap, topo *MacroTopology, patterns cognitive.Patterns) {
	if m == nil || m.Tree == nil {
		return
	}
	root := skipRootWrapper(m.Tree)

	// 1. 检查根目录散落的核心代码文件 (例如 gin.go, context.go, main.go)
	var rootCodeFiles []FileMap
	for _, f := range root.Files {
		if !f.IsTest && !f.IsDoc && !f.IsConfig && patterns.IsCodeFile(f.Path) {
			rootCodeFiles = append(rootCodeFiles, f)
		}
	}

	// 2. 统一子系统发现 SSOT (契约 C1)：monorepo 清单目录 / 自然包目录 /
	//    单包仓库回退为跳过根包装后的活跃一级源码目录；截断沿用现值
	//    (>8 时按 EstLOC 降序取前 7 主干，尾流标记 auxiliary)
	specs := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	primaryCount := 0
	for i := range specs {
		if !specs[i].IsAuxiliary {
			primaryCount++
		}
	}

	candidateCount := primaryCount
	if len(rootCodeFiles) > 0 {
		candidateCount++
	}

	fileToNodeId := make(map[string]string)

	// 3. 自适应分区策略决策 (Path ≠ Architecture 穿透防御)
	if candidateCount >= 3 {
		// 策略 A: 多目录常规仓，以自然子系统为主干
		topo.Strategy = "directory"
		buildDirectoryPartition(m, specs, rootCodeFiles, topo, fileToNodeId)
	} else {
		// 策略 B: 扁平单体仓或浅单包仓 (<3 个子目录)，穿透物理容器，按 TopologicalLayer 聚类
		topo.Strategy = "topological_layer"
		buildTopologicalLayerPartition(m, topo, fileToNodeId)
	}

	// 4. 汇聚跨节点物理边 (AST Calls & Imports)
	aggregateMacroEdges(m, topo, fileToNodeId)
}

// buildDirectoryPartition 针对常规多目录仓进行自然子系统提取与长尾截流聚类。
// 分区统一消费 DiscoverSubsystems SSOT (契约 C1)：主干 spec → 子系统节点
// （排序与 >8 截前 7 的截流已在 SSOT 内完成），尾流 auxiliary → Common & Utilities 聚拢。
func buildDirectoryPartition(
	m *RepoMap,
	specs []SubsystemSpec,
	rootCodeFiles []FileMap,
	topo *MacroTopology,
	fileToNodeId map[string]string,
) {
	// 若存在根核心代码文件，创建 Core Entrypoint 虚拟节点
	if len(rootCodeFiles) > 0 {
		entryLOC := 0
		entryHot := 0
		var entryExports []string
		for _, f := range rootCodeFiles {
			entryLOC += f.LOC
			entryHot += f.Hotness
			entryExports = append(entryExports, f.Exports...)
		}
		entryNode := MacroTopologyNode{
			ID:          "entrypoint",
			Path:        ".",
			Name:        "Core Entrypoint",
			Role:        "interface",
			FileCount:   len(rootCodeFiles),
			LOC:         entryLOC,
			Hotness:     entryHot,
			TopExports:  dedupLimitStrings(entryExports, 4),
			PrimaryLang: detectPrimaryLang(rootCodeFiles),
		}
		topo.Nodes = append(topo.Nodes, entryNode)
		for _, f := range rootCodeFiles {
			fileToNodeId[f.Path] = "entrypoint"
		}
	}

	// 按 spec 最长前缀归属物理文件（嵌套前缀取最长；未被认领的文件不入图，
	// 与现行非候选目录文件行为一致）
	specFiles := make(map[string][]FileMap, len(specs))
	for _, f := range m.Files {
		bestID := ""
		bestLen := -1
		for i := range specs {
			sp := specs[i].Prefix
			if (f.Path == sp || strings.HasPrefix(f.Path, sp+"/")) && len(sp) > bestLen {
				bestLen = len(sp)
				bestID = specs[i].ID
			}
		}
		if bestID != "" {
			specFiles[bestID] = append(specFiles[bestID], f)
		}
	}

	// 构建主干子系统节点（auxiliary 尾流文件聚拢，延后统一处理）
	var auxFiles []FileMap
	for i := range specs {
		spec := specs[i]
		files := specFiles[spec.ID]
		if spec.IsAuxiliary {
			auxFiles = append(auxFiles, files...)
			for _, f := range files {
				fileToNodeId[f.Path] = "common_utils"
			}
			continue
		}
		node := MacroTopologyNode{
			ID:          spec.ID,
			Path:        spec.Prefix,
			Name:        spec.Name,
			Role:        detectRoleName(spec.Name),
			FileCount:   len(files),
			LOC:         sumFileLOC(files),
			Hotness:     sumFileHotness(files),
			TopExports:  extractTopExportsFromFiles(sortFileMapsByPath(files), 4),
			PrimaryLang: detectPrimaryLang(files),
		}
		topo.Nodes = append(topo.Nodes, node)

		for _, f := range files {
			fileToNodeId[f.Path] = spec.ID
		}
	}

	// 聚拢长尾模块至 Common & Utilities
	if len(auxFiles) > 0 {
		auxFiles = sortFileMapsByPath(auxFiles)
		commonNode := MacroTopologyNode{
			ID:          "common_utils",
			Path:        "common",
			Name:        "Common & Utilities",
			Role:        "utility",
			FileCount:   len(auxFiles),
			LOC:         sumFileLOC(auxFiles),
			Hotness:     sumFileHotness(auxFiles),
			TopExports:  extractTopExportsFromFiles(auxFiles, 4),
			PrimaryLang: detectPrimaryLang(auxFiles),
		}
		topo.Nodes = append(topo.Nodes, commonNode)
	}
}

// buildTopologicalLayerPartition 针对扁平仓穿透文件容器，基于 TopologicalLayer 聚类为 3 逻辑层节点。
func buildTopologicalLayerPartition(m *RepoMap, topo *MacroTopology, fileToNodeId map[string]string) {
	var interfaceFiles, pipelineFiles, foundationFiles []FileMap

	for _, f := range m.Files {
		if f.IsTest || f.IsDoc {
			continue
		}
		switch f.Layer {
		case LayerInterface:
			interfaceFiles = append(interfaceFiles, f)
		case LayerPipeline:
			pipelineFiles = append(pipelineFiles, f)
		default:
			foundationFiles = append(foundationFiles, f)
		}
	}

	// 容错：如果所有文件都被归在同一层，按热度高中低再微调
	if len(interfaceFiles) == 0 && len(pipelineFiles) == 0 && len(foundationFiles) > 0 {
		// 全部在 Foundation：将前 20% 高热度文件作为 Pipeline，热度最高的一个作为 Interface
		sorted := append([]FileMap(nil), foundationFiles...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].Hotness > sorted[j].Hotness })
		if len(sorted) >= 3 {
			interfaceFiles = append(interfaceFiles, sorted[0])
			pipelineFiles = append(pipelineFiles, sorted[1:len(sorted)/2]...)
			foundationFiles = sorted[len(sorted)/2:]
		}
	}

	createLayerNode := func(id, name, role string, files []FileMap) {
		if len(files) == 0 {
			return
		}
		loc := 0
		hot := 0
		var exports []string
		for _, f := range files {
			loc += f.LOC
			hot += f.Hotness
			exports = append(exports, f.Exports...)
			fileToNodeId[f.Path] = id
		}
		topo.Nodes = append(topo.Nodes, MacroTopologyNode{
			ID:          id,
			Path:        id,
			Name:        name,
			Role:        role,
			FileCount:   len(files),
			LOC:         loc,
			Hotness:     hot,
			TopExports:  dedupLimitStrings(exports, 4),
			PrimaryLang: detectPrimaryLang(files),
		})
	}

	createLayerNode("layer_interface", "Interface & Entrypoints", "interface", interfaceFiles)
	createLayerNode("layer_pipeline", "Core Engine & Pipelines", "core", pipelineFiles)
	createLayerNode("layer_foundation", "Foundation & Data Models", "infra", foundationFiles)
}

// buildSubsystemTopology 提取 C4 L2 子系统内部组件协作图。
func buildSubsystemTopology(m *RepoMap, scope string, topo *MacroTopology, patterns cognitive.Patterns) {
	scope = strings.Trim(scope, "/ ")
	targetNode := findSubtreeNode(m.Tree, scope)
	if targetNode == nil {
		buildMacroSystemTopology(m, topo, patterns)
		return
	}

	topo.Strategy = "subsystem_components"
	fileToNodeId := make(map[string]string)

	// 1. 提取内部子包或文件分组
	if len(targetNode.Children) >= 2 {
		for _, child := range targetNode.Children {
			if isAuxiliaryDirName(child.Name) {
				continue
			}
			compID := sanitizeMermaidId("comp_" + child.Name)
			role := detectSubtreeRole(child)
			topo.Nodes = append(topo.Nodes, MacroTopologyNode{
				ID:          compID,
				Path:        child.Path,
				Name:        child.Name,
				Role:        role,
				FileCount:   child.FileCount,
				LOC:         child.LOC,
				Hotness:     child.Hotness,
				TopExports:  extractSubtreeTopExports(child, 4),
				PrimaryLang: primaryLangOfTree(child),
			})
			for _, f := range child.LeafFiles() {
				fileToNodeId[f.Path] = compID
			}
		}
	} else {
		// 子系统内部较为扁平，直接使用文件或 Layer 分组
		var localFiles []FileMap
		for _, f := range m.Files {
			if strings.HasPrefix(f.Path+"/", scope+"/") && !f.IsTest && !f.IsDoc {
				localFiles = append(localFiles, f)
			}
		}
		if len(localFiles) > 0 {
			sort.Slice(localFiles, func(i, j int) bool { return localFiles[i].Hotness > localFiles[j].Hotness })
			limit := 6
			if len(localFiles) < limit {
				limit = len(localFiles)
			}
			for i := 0; i < limit; i++ {
				f := localFiles[i]
				baseName := f.Path
				if idx := strings.LastIndexByte(f.Path, '/'); idx >= 0 {
					baseName = f.Path[idx+1:]
				}
				compID := sanitizeMermaidId("comp_" + strings.TrimSuffix(baseName, extOf(baseName)))
				topo.Nodes = append(topo.Nodes, MacroTopologyNode{
					ID:         compID,
					Path:       f.Path,
					Name:       baseName,
					Role:       "core",
					FileCount:  1,
					LOC:        f.LOC,
					Hotness:    f.Hotness,
					TopExports: f.Exports,
				})
				fileToNodeId[f.Path] = compID
			}
		}
	}

	// 2. 检测外部边界调用 (Inbound & Outbound Boundary Connectors)
	hasInbound := false
	hasOutbound := false
	for _, ce := range m.CallEdges {
		inScopeCaller := strings.HasPrefix(ce.Caller+"/", scope+"/")
		inScopeCallee := strings.HasPrefix(ce.Callee+"/", scope+"/")
		if !inScopeCaller && inScopeCallee {
			hasInbound = true
			if targetComp := fileToNodeId[ce.Callee]; targetComp != "" {
				fileToNodeId["__ext_in__"] = "ext_inbound"
			}
		}
		if inScopeCaller && !inScopeCallee {
			hasOutbound = true
			if srcComp := fileToNodeId[ce.Caller]; srcComp != "" {
				fileToNodeId["__ext_out__"] = "ext_outbound"
			}
		}
	}

	if hasInbound {
		topo.Nodes = append([]MacroTopologyNode{{
			ID:   "ext_inbound",
			Name: "External Inbound",
			Role: "interface",
		}}, topo.Nodes...)
	}
	if hasOutbound {
		topo.Nodes = append(topo.Nodes, MacroTopologyNode{
			ID:   "ext_outbound",
			Name: "External Dependencies",
			Role: "infra",
		})
	}

	// 3. 聚合边
	edgeKeyMap := make(map[string]*MacroTopologyEdge)
	for _, ce := range m.CallEdges {
		callerIn := strings.HasPrefix(ce.Caller+"/", scope+"/")
		calleeIn := strings.HasPrefix(ce.Callee+"/", scope+"/")

		from := fileToNodeId[ce.Caller]
		to := fileToNodeId[ce.Callee]

		if !callerIn && calleeIn && hasInbound && to != "" {
			from = "ext_inbound"
		} else if callerIn && !calleeIn && hasOutbound && from != "" {
			to = "ext_outbound"
		}

		if from != "" && to != "" && from != to {
			key := from + "->" + to
			e, ok := edgeKeyMap[key]
			if !ok {
				e = &MacroTopologyEdge{From: from, To: to, Weight: 0}
				edgeKeyMap[key] = e
			}
			e.Weight += 2
			if ce.Symbol != "" {
				e.Symbols = appendStringUnique(e.Symbols, ce.Symbol, 3)
			}
		}
	}

	for _, e := range edgeKeyMap {
		topo.Edges = append(topo.Edges, *e)
	}
	sort.SliceStable(topo.Edges, func(i, j int) bool { return topo.Edges[i].Weight > topo.Edges[j].Weight })
}

// aggregateMacroEdges 汇聚跨节点物理边 (AST Calls 与模块 Imports)。
func aggregateMacroEdges(m *RepoMap, topo *MacroTopology, fileToNodeId map[string]string) {
	edgeMap := make(map[string]*MacroTopologyEdge)

	// 1. 汇聚 AST 物理调用边
	for _, ce := range m.CallEdges {
		from := fileToNodeId[ce.Caller]
		to := fileToNodeId[ce.Callee]
		if from != "" && to != "" && from != to {
			key := from + "->" + to
			e, ok := edgeMap[key]
			if !ok {
				e = &MacroTopologyEdge{From: from, To: to, Weight: 0}
				edgeMap[key] = e
			}
			e.Weight += 2
			if ce.Symbol != "" {
				e.Symbols = appendStringUnique(e.Symbols, ce.Symbol, 3)
			}
		}
	}

	// 2. 补充 Imports 导入边 (未包含在直接函数调用中时)
	for _, f := range m.Files {
		from := fileToNodeId[f.Path]
		if from == "" {
			continue
		}
		for _, imp := range f.Imports {
			for _, targetNode := range topo.Nodes {
				if targetNode.ID == from || targetNode.Path == "." {
					continue
				}
				// 匹配导入包名与节点 Path
				if strings.Contains(imp, "/"+targetNode.Name) || strings.HasSuffix(imp, targetNode.Name) {
					key := from + "->" + targetNode.ID
					e, ok := edgeMap[key]
					if !ok {
						e = &MacroTopologyEdge{From: from, To: targetNode.ID, Weight: 0}
						edgeMap[key] = e
					}
					e.Weight += 1
				}
			}
		}
	}

	// 3. 排序与安全截流 (保持拓扑图清爽，防止蛛网爆炸)
	for _, e := range edgeMap {
		topo.Edges = append(topo.Edges, *e)
	}
	sort.SliceStable(topo.Edges, func(i, j int) bool {
		return topo.Edges[i].Weight > topo.Edges[j].Weight
	})
	const maxEdges = 14
	if len(topo.Edges) > maxEdges {
		topo.Edges = topo.Edges[:maxEdges]
	}
}

// RenderDeterministicMermaidSkeleton 生成 100% 语法闭合的 Mermaid 物理骨架图。
func RenderDeterministicMermaidSkeleton(topo *MacroTopology) string {
	if topo == nil || len(topo.Nodes) == 0 {
		return "```mermaid\nflowchart TD\n  empty[\"Empty Architecture\"]\n```"
	}

	var sb strings.Builder
	sb.WriteString("```mermaid\nflowchart TD\n")

	// 按 Role 分组生成 Subgraph
	roleGroups := map[string][]MacroTopologyNode{
		"interface": nil,
		"core":      nil,
		"infra":     nil,
		"utility":   nil,
	}
	for _, node := range topo.Nodes {
		role := node.Role
		if _, ok := roleGroups[role]; !ok {
			role = "core"
		}
		roleGroups[role] = append(roleGroups[role], node)
	}

	renderGroup := func(title, subId string, nodes []MacroTopologyNode) {
		if len(nodes) == 0 {
			return
		}
		sb.WriteString(fmt.Sprintf("  subgraph %s[\"%s\"]\n", subId, title))
		for _, n := range nodes {
			cleanName := strings.ReplaceAll(n.Name, `"`, "''")
			if n.FileCount > 0 {
				sb.WriteString(fmt.Sprintf("    %s[\"%s<br/>%d files · %s LOC\"]\n",
					n.ID, cleanName, n.FileCount, formatLOC(n.LOC)))
			} else {
				sb.WriteString(fmt.Sprintf("    %s([\"%s\"])\n", n.ID, cleanName))
			}
		}
		sb.WriteString("  end\n")
	}

	renderGroup("接入与调度层", "Interface", roleGroups["interface"])
	renderGroup("核心业务引擎", "Core", roleGroups["core"])
	renderGroup("基础支持与数据底座", "Infra", roleGroups["infra"])
	renderGroup("公共工具集", "Utility", roleGroups["utility"])

	// 渲染边
	sb.WriteByte('\n')
	for _, e := range topo.Edges {
		label := e.Label
		if label == "" {
			if len(e.Symbols) > 0 {
				label = fmt.Sprintf("calls %s", strings.Join(e.Symbols, ", "))
			} else if e.Weight > 0 {
				label = fmt.Sprintf("calls (%d)", e.Weight)
			}
		}
		cleanLabel := strings.ReplaceAll(label, `"`, "''")
		cleanLabel = strings.ReplaceAll(cleanLabel, "|", "/")

		if cleanLabel != "" {
			sb.WriteString(fmt.Sprintf("  %s -->|\"%s\"| %s\n", e.From, cleanLabel, e.To))
		} else {
			sb.WriteString(fmt.Sprintf("  %s --> %s\n", e.From, e.To))
		}
	}

	sb.WriteString("```")
	return sb.String()
}

// ─────────────────────────────────────────────────────────────
// 辅助纯函数
// ─────────────────────────────────────────────────────────────

// isAuxiliaryDirName 前缀必须带边界：`HasPrefix("doc")` 会吞 docker/docx/
// dockutil，`HasPrefix("test")` 会吞 testify-example——这些是仓库常见
// 顶层目录，从架构图静默消失。
func isAuxiliaryDirName(name string) bool {
	lower := strings.ToLower(name)
	return lower == "test" || lower == "tests" || strings.HasPrefix(lower, "test/") ||
		lower == "doc" || lower == "docs" || lower == "documentation" || strings.HasPrefix(lower, "docs/") ||
		lower == "example" || lower == "examples" || strings.HasPrefix(lower, "example/") ||
		strings.HasPrefix(lower, "bench") ||
		lower == "vendor" ||
		lower == "fixtures" ||
		lower == "third_party"
}

// sanitizeMermaidId 非 ASCII（含全部 CJK 目录名）折叠为 `_` 会让不同子系统
// 清洗成同一 ID（"sub_组件"/"sub_模块" → "sub"），架构图节点互相覆盖。
// 宪章 III.5：非 ASCII 标识符回退 FNV-64a 抗碰撞哈希（与 mdpat.Slugify 同法）。
func sanitizeMermaidId(s string) string {
	var sb strings.Builder
	hasNonASCII := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
			sb.WriteRune(r)
		} else {
			hasNonASCII = true
			sb.WriteRune('_')
		}
	}
	res := strings.Trim(sb.String(), "_")
	if hasNonASCII {
		// 保留可读 ASCII 前缀 + 短哈希后缀：同前缀不同 CJK 名不再碰撞，
		// 图上仍可辨识
		h := fnv.New64a()
		_, _ = h.Write([]byte(s))
		res = strings.Trim(res+"_h"+strconv.FormatUint(h.Sum64(), 36), "_")
	}
	if res == "" || (res[0] >= '0' && res[0] <= '9') {
		res = "n_" + res
	}
	return res
}

func detectSubtreeRole(n *RepoTreeNode) string {
	return detectRoleName(n.Name)
}

// detectRoleName 目录段名 → 架构角色（供树节点与 SubsystemSpec 共用）。
func detectRoleName(name string) string {
	lower := strings.ToLower(name)
	if strings.Contains(lower, "cmd") || strings.Contains(lower, "cli") || strings.Contains(lower, "api") || strings.Contains(lower, "server") {
		return "interface"
	}
	if strings.Contains(lower, "util") || strings.Contains(lower, "common") || strings.Contains(lower, "helper") || strings.Contains(lower, "lib") {
		return "utility"
	}
	if strings.Contains(lower, "store") || strings.Contains(lower, "db") || strings.Contains(lower, "model") || strings.Contains(lower, "resource") {
		return "infra"
	}
	return "core"
}

func extractSubtreeTopExports(n *RepoTreeNode, limit int) []string {
	var out []string
	for _, f := range n.LeafFiles() {
		for _, exp := range f.Exports {
			if !strings.HasPrefix(exp, "_") {
				out = appendStringUnique(out, exp, limit)
				if len(out) >= limit {
					return out
				}
			}
		}
	}
	return out
}

// extractTopExportsFromFiles 文件集合版导出提取（语义与 extractSubtreeTopExports
// 一致：调用方须先按路径字典序排序，等价 LeafFiles 序）。
func extractTopExportsFromFiles(files []FileMap, limit int) []string {
	var out []string
	for _, f := range files {
		for _, exp := range f.Exports {
			if !strings.HasPrefix(exp, "_") {
				out = appendStringUnique(out, exp, limit)
				if len(out) >= limit {
					return out
				}
			}
		}
	}
	return out
}

// sortFileMapsByPath 路径字典序（等价 LeafFiles 全序，导出提取的确定性前提）。
func sortFileMapsByPath(files []FileMap) []FileMap {
	out := append([]FileMap(nil), files...)
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func sumFileLOC(files []FileMap) int {
	total := 0
	for _, f := range files {
		total += f.LOC
	}
	return total
}

func sumFileHotness(files []FileMap) int {
	total := 0
	for _, f := range files {
		total += f.Hotness
	}
	return total
}

func primaryLangOfTree(n *RepoTreeNode) string {
	if len(n.LangDist) == 0 {
		return ""
	}
	best := ""
	maxCount := 0
	for lang, count := range n.LangDist {
		if count > maxCount && lang != "(none)" {
			maxCount = count
			best = lang
		}
	}
	return best
}

func detectPrimaryLang(files []FileMap) string {
	counts := make(map[string]int)
	for _, f := range files {
		ext := extOf(f.Path)
		if ext != "(none)" {
			counts[ext]++
		}
	}
	best := ""
	maxC := 0
	for ext, c := range counts {
		if c > maxC {
			maxC = c
			best = ext
		}
	}
	return best
}

func findSubtreeNode(root *RepoTreeNode, path string) *RepoTreeNode {
	if root == nil {
		return nil
	}
	if root.Path == path || root.Name == path {
		return root
	}
	for _, child := range root.Children {
		if found := findSubtreeNode(child, path); found != nil {
			return found
		}
	}
	return nil
}

func appendStringUnique(list []string, s string, limit int) []string {
	for _, item := range list {
		if item == s {
			return list
		}
	}
	if len(list) < limit {
		return append(list, s)
	}
	return list
}

func dedupLimitStrings(items []string, limit int) []string {
	seen := make(map[string]bool)
	var out []string
	for _, it := range items {
		if it != "" && !seen[it] {
			seen[it] = true
			out = append(out, it)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

func formatLOC(loc int) string {
	if loc >= 1000 {
		return fmt.Sprintf("%.1fk", float64(loc)/1000)
	}
	return fmt.Sprintf("%d", loc)
}

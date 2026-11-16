package pipelineb

import (
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

// ─────────────────────────────────────────────────────────────
// A1 热度升级:一跳计数 → PageRank(P2)。
//
// 复用 rsg.ComputePageRank(无权邻接,damping 0.85 × 30 轮,与语义图
// 主建图同参)。aider 先例:图排序显著优于局部计数;此处服务于
// 下钻选择与骨架行信号(信号层转正首职)。归一化:文件分数按仓库内
// 最大值线性缩放到 0-100(展示稳定,排序不变)。
// ─────────────────────────────────────────────────────────────

const (
	hotnessDamping    = 0.85
	hotnessIterations = 30
	hotnessScaleMax   = 100
)

// TopologicalLayer 表示文件在调用依赖拓扑中的教学心智层级。
type TopologicalLayer int

const (
	LayerFoundation TopologicalLayer = 0 // 基础底座/数据契约/底层模型 (入度高、出度低或纯契约)
	LayerPipeline   TopologicalLayer = 1 // 核心引擎/流转管道/业务逻辑 (承上启下的中间调用链)
	LayerInterface  TopologicalLayer = 2 // 交付入口/接口路由/驱动入口 (入度低、出度高或程序入口)
)

func (l TopologicalLayer) String() string {
	switch l {
	case LayerFoundation:
		return "Layer 0: 基础底座与数据契约 (Foundation & Contracts)"
	case LayerPipeline:
		return "Layer 1: 核心引擎与数据管道 (Core Engine & Pipelines)"
	case LayerInterface:
		return "Layer 2: 交付入口与接口路由 (Entrypoints & Interfaces)"
	default:
		return "Layer: 未知层级"
	}
}

// layerEvaluationContext 拓扑分层判定上下文。
type layerEvaluationContext struct {
	file      FileMap
	inDegree  int
	outDegree int
	role      string
}

// layerStrategy 拓扑分层策略契约。
type layerStrategy struct {
	name  string
	match func(ctx layerEvaluationContext) (TopologicalLayer, bool)
}

// layerStrategies 策略梯（按优先级单一有序排列）。
var layerStrategies = []layerStrategy{
	{name: "doc_and_config", match: evalDocAndConfigStrategy},
	{name: "explicit_entrypoint", match: evalExplicitEntryPointStrategy},
	{name: "pure_leaf_dependency", match: evalPureLeafStrategy},
	{name: "pure_root_caller", match: evalPureRootStrategy},
	{name: "intermediate_pipeline", match: evalIntermediatePipelineStrategy},
	{name: "isolated_fallback", match: evalIsolatedFallbackStrategy},
}

// 1. 文档与顶层配置天然属于基础底座（Layer 0）
func evalDocAndConfigStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.file.IsDoc || ctx.file.IsConfig ||
		ctx.role == "configuration" || ctx.role == "type_hub" || ctx.role == "data_model" {
		return LayerFoundation, true
	}
	return LayerFoundation, false
}

// 2. 强入口特征（CLI、main、路由入口）：若入度 <= 1，归入交付入口（Layer 2）
func evalExplicitEntryPointStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.role == "entry_point" || isExplicitEntryPoint(ctx.file.Path) {
		if ctx.inDegree <= 1 {
			return LayerInterface, true
		}
	}
	return LayerInterface, false
}

// 3. 纯叶子依赖（只有别人调它，它不调别人）→ 基础底座（Layer 0）
func evalPureLeafStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.inDegree > 0 && ctx.outDegree == 0 {
		return LayerFoundation, true
	}
	return LayerFoundation, false
}

// 4. 纯调用根节点（只调别人，无人调它）→ 交付入口（Layer 2）
func evalPureRootStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.inDegree == 0 && ctx.outDegree > 0 {
		return LayerInterface, true
	}
	return LayerInterface, false
}

// 5. 承上启下的中间流转节点（有入有出）
func evalIntermediatePipelineStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.inDegree > 0 && ctx.outDegree > 0 {
		if ctx.inDegree >= 3*ctx.outDegree {
			// 入度压倒性大于出度 → 偏底层基础服务
			return LayerFoundation, true
		}
		// 核心业务引擎与数据管道
		return LayerPipeline, true
	}
	return LayerPipeline, false
}

// 6. 孤岛节点 (in == 0 && out == 0)：退化回文件路径语义裁定
func evalIsolatedFallbackStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if isExplicitInterface(ctx.file.Path) {
		return LayerInterface, true
	}
	if ctx.role == "utility" || ctx.role == "build_system" {
		return LayerFoundation, true
	}
	return LayerPipeline, true
}

func computeFileDegrees(files []FileMap, edges [][2]string) (map[string]int, map[string]int) {
	inDegree := make(map[string]int, len(files))
	outDegree := make(map[string]int, len(files))
	nodeset := make(map[string]bool, len(files))
	for _, f := range files {
		nodeset[f.Path] = true
	}

	for _, e := range edges {
		caller, callee := e[0], e[1]
		if caller == callee || !nodeset[caller] || !nodeset[callee] {
			continue
		}
		outDegree[caller]++
		inDegree[callee]++
	}
	return inDegree, outDegree
}

// ComputeTopologicalLayers 计算各文件在 AST 依赖图中的拓扑分层。
// edges: [caller, callee] 有向边。
func ComputeTopologicalLayers(files []FileMap, edges [][2]string, patterns cognitive.Patterns) map[string]TopologicalLayer {
	inDegree, outDegree := computeFileDegrees(files, edges)
	layers := make(map[string]TopologicalLayer, len(files))

	for _, f := range files {
		ctx := layerEvaluationContext{
			file:      f,
			inDegree:  inDegree[f.Path],
			outDegree: outDegree[f.Path],
			role:      cognitive.InferFlatFileRole(f.Path, patterns),
		}

		for _, s := range layerStrategies {
			if layer, matched := s.match(ctx); matched {
				layers[f.Path] = layer
				break
			}
		}
	}
	return layers
}

func isExplicitEntryPoint(p string) bool {
	lower := strings.ToLower(p)
	return strings.HasSuffix(lower, "main.go") ||
		strings.HasSuffix(lower, "index.ts") ||
		strings.HasSuffix(lower, "index.js") ||
		strings.HasSuffix(lower, "app.ts") ||
		strings.HasSuffix(lower, "app.tsx") ||
		strings.HasPrefix(lower, "cmd/") ||
		strings.HasPrefix(lower, "cli/")
}

func isExplicitInterface(p string) bool {
	lower := strings.ToLower(p)
	return isExplicitEntryPoint(lower) ||
		strings.Contains(lower, "api/") ||
		strings.Contains(lower, "routes/") ||
		strings.Contains(lower, "controllers/") ||
		strings.Contains(lower, "handlers/")
}

// ComputeHotnessPageRank 对文件集计算 PageRank 热度。
// edges: 有向调用边(caller 文件 → 被调符号属主文件);内部去重。
func ComputeHotnessPageRank(files []FileMap, edges [][2]string) map[string]int {
	adj := make(map[string]map[string]bool) // from -> set(to) 去重
	nodeset := make(map[string]bool, len(files))
	for _, f := range files {
		nodeset[f.Path] = true
	}
	for _, e := range edges {
		from, to := e[0], e[1]
		if from == to || !nodeset[from] || !nodeset[to] {
			continue
		}
		if adj[from] == nil {
			adj[from] = map[string]bool{}
		}
		adj[from][to] = true
	}
	nodes := make([]string, 0, len(nodeset))
	for p := range nodeset {
		nodes = append(nodes, p)
	}
	sort.Strings(nodes) // 稳定输入序(ComputePageRank 迭代序确定性)
	adjacency := make(map[string][]string, len(adj))
	for from, tos := range adj {
		list := make([]string, 0, len(tos))
		for to := range tos {
			list = append(list, to)
		}
		sort.Strings(list)
		adjacency[from] = list
	}
	scores := rsg.ComputePageRank(nodes, adjacency, hotnessDamping, hotnessIterations)
	return normalizeHotness(nodes, scores)
}

func normalizeHotness(nodes []string, scores map[string]float64) map[string]int {
	// 减去图内最小分:该实现含悬挂质量重分配,公共底价=最小分而非
	// (1-d)/n。min-shift 后无入边节点归 0("无人引用"语义),排序单调保持。
	min := 0.0
	for i, n := range nodes {
		if i == 0 || scores[n] < min {
			min = scores[n]
		}
	}
	shifted := make(map[string]float64, len(nodes))
	max := 0.0
	for _, n := range nodes {
		s := scores[n] - min
		if s < 0 {
			s = 0
		}
		shifted[n] = s
		if s > max {
			max = s
		}
	}
	out := make(map[string]int, len(nodes))
	if max <= 0 {
		for _, n := range nodes {
			out[n] = 0
		}
		return out
	}
	for _, n := range nodes {
		out[n] = int(shifted[n] / max * hotnessScaleMax)
	}
	return out
}

package pipelineb

import (
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

const (
	hotnessDamping    = 0.85
	hotnessIterations = 30
	hotnessScaleMax   = 100
)

type TopologicalLayer int

const (
	LayerFoundation TopologicalLayer = 0
	LayerPipeline   TopologicalLayer = 1
	LayerInterface  TopologicalLayer = 2
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

type layerEvaluationContext struct {
	file      FileMap
	inDegree  int
	outDegree int
	role      string
}

type layerStrategy struct {
	name  string
	match func(ctx layerEvaluationContext) (TopologicalLayer, bool)
}

var layerStrategies = []layerStrategy{
	{name: "doc_and_config", match: evalDocAndConfigStrategy},
	{name: "explicit_entrypoint", match: evalExplicitEntryPointStrategy},
	{name: "pure_leaf_dependency", match: evalPureLeafStrategy},
	{name: "pure_root_caller", match: evalPureRootStrategy},
	{name: "intermediate_pipeline", match: evalIntermediatePipelineStrategy},
	{name: "isolated_fallback", match: evalIsolatedFallbackStrategy},
}

func evalDocAndConfigStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.file.IsDoc || ctx.file.IsConfig ||
		ctx.role == "configuration" || ctx.role == "type_hub" || ctx.role == "data_model" {
		return LayerFoundation, true
	}
	return LayerFoundation, false
}

func evalExplicitEntryPointStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.role == "entry_point" || isExplicitEntryPoint(ctx.file.Path) {
		if ctx.inDegree <= 1 {
			return LayerInterface, true
		}
	}
	return LayerInterface, false
}

func evalPureLeafStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.inDegree > 0 && ctx.outDegree == 0 {
		return LayerFoundation, true
	}
	return LayerFoundation, false
}

func evalPureRootStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.inDegree == 0 && ctx.outDegree > 0 {
		return LayerInterface, true
	}
	return LayerInterface, false
}

func evalIntermediatePipelineStrategy(ctx layerEvaluationContext) (TopologicalLayer, bool) {
	if ctx.inDegree > 0 && ctx.outDegree > 0 {
		if ctx.inDegree >= 3*ctx.outDegree {
			return LayerFoundation, true
		}
		return LayerPipeline, true
	}
	return LayerPipeline, false
}

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

func ComputeHotnessPageRank(files []FileMap, edges [][2]string) map[string]int {
	adj := make(map[string]map[string]bool)
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
	sort.Strings(nodes) // Sort adjacency keys so ComputePageRank iteration order is deterministic.
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
	// Subtract min score after dangling-mass redistribution so unreferenced nodes normalize to 0 while preserving order.
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

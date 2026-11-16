package pipelineb

import (
	"testing"
)

// TestComputeHotnessPageRank 星型图:枢纽文件得分最高,孤岛为 0。
func TestComputeHotnessPageRank(t *testing.T) {
	files := []FileMap{
		{Path: "hub.go", Exports: []string{"Hub"}},
		{Path: "a.go"}, {Path: "b.go"}, {Path: "c.go"},
		{Path: "island.go"},
	}
	edges := [][2]string{
		{"a.go", "hub.go"}, {"b.go", "hub.go"}, {"c.go", "hub.go"},
		{"a.go", "b.go"}, // a 同时依赖 b——b 也应有分但低于 hub
	}
	hot := ComputeHotnessPageRank(files, edges)
	if hot["hub.go"] != 100 {
		t.Errorf("hub 应为满分 100, got %d", hot["hub.go"])
	}
	if hot["island.go"] != 0 {
		t.Errorf("孤岛应为 0, got %d", hot["island.go"])
	}
	if hot["b.go"] <= 0 {
		t.Errorf("被 a 依赖的 b 应有正分, got %d", hot["b.go"])
	}
	if hot["hub.go"] <= hot["b.go"] {
		t.Errorf("hub 应高于 b: hub=%d b=%d", hot["hub.go"], hot["b.go"])
	}
	// 去重幂等:重复边不改变结果
	dup := append(append([][2]string{}, edges...), edges...)
	hot2 := ComputeHotnessPageRank(files, dup)
	for _, f := range files {
		if hot[f.Path] != hot2[f.Path] {
			t.Fatalf("边去重失败: %s %d≠%d", f.Path, hot[f.Path], hot2[f.Path])
		}
	}
}

// TestComputeTopologicalLayers 验证基于 AST 依赖图与角色规则的拓扑分层判定。
func TestComputeTopologicalLayers(t *testing.T) {
	files := []FileMap{
		{Path: "README.md", IsDoc: true},
		{Path: "config/app.json", IsConfig: true},
		{Path: "models/user.go", Exports: []string{"User"}},
		{Path: "engine/pipeline.go", Exports: []string{"Process"}},
		{Path: "api/routes.go", Exports: []string{"RegisterRoutes"}},
		{Path: "cmd/main.go", Exports: []string{"main"}},
		{Path: "utils/helper.go", Exports: []string{"Format"}},
	}
	// edges: caller -> callee
	// cmd/main.go -> api/routes.go -> engine/pipeline.go -> models/user.go
	// engine/pipeline.go -> utils/helper.go
	edges := [][2]string{
		{"cmd/main.go", "api/routes.go"},
		{"api/routes.go", "engine/pipeline.go"},
		{"engine/pipeline.go", "models/user.go"},
		{"engine/pipeline.go", "utils/helper.go"},
	}

	layers := ComputeTopologicalLayers(files, edges, nil)

	// Layer 0: 基础底座 (README, config, models/user.go, utils/helper.go)
	if layers["README.md"] != LayerFoundation {
		t.Errorf("README.md 应为 LayerFoundation, got %v", layers["README.md"])
	}
	if layers["config/app.json"] != LayerFoundation {
		t.Errorf("config/app.json 应为 LayerFoundation, got %v", layers["config/app.json"])
	}
	if layers["models/user.go"] != LayerFoundation {
		t.Errorf("models/user.go (纯叶子被引用) 应为 LayerFoundation, got %v", layers["models/user.go"])
	}
	if layers["utils/helper.go"] != LayerFoundation {
		t.Errorf("utils/helper.go (叶子被引用) 应为 LayerFoundation, got %v", layers["utils/helper.go"])
	}

	// Layer 1: 核心引擎流转 (engine/pipeline.go)
	if layers["engine/pipeline.go"] != LayerPipeline {
		t.Errorf("engine/pipeline.go (承上启下流转) 应为 LayerPipeline, got %v", layers["engine/pipeline.go"])
	}

	// Layer 2: 交付入口 (cmd/main.go)
	if layers["cmd/main.go"] != LayerInterface {
		t.Errorf("cmd/main.go (顶层入口) 应为 LayerInterface, got %v", layers["cmd/main.go"])
	}

	// 验证 String() 透出
	if LayerFoundation.String() == "" || LayerPipeline.String() == "" || LayerInterface.String() == "" {
		t.Error("TopologicalLayer.String() 不应为空")
	}
}

// TestLayerStrategiesExplicitCoverage 验证策略梯（Strategy Ladder）各个具名策略的独立求值契约。
func TestLayerStrategiesExplicitCoverage(t *testing.T) {
	if len(layerStrategies) != 6 {
		t.Fatalf("策略梯应包含 6 条策略, got %d", len(layerStrategies))
	}

	// 1. doc_and_config
	l, ok := evalDocAndConfigStrategy(layerEvaluationContext{file: FileMap{IsDoc: true}})
	if !ok || l != LayerFoundation {
		t.Errorf("evalDocAndConfigStrategy 应命中 LayerFoundation, got %v, %v", l, ok)
	}

	// 2. explicit_entrypoint
	l, ok = evalExplicitEntryPointStrategy(layerEvaluationContext{file: FileMap{Path: "main.go"}, inDegree: 0})
	if !ok || l != LayerInterface {
		t.Errorf("evalExplicitEntryPointStrategy 应命中 LayerInterface, got %v, %v", l, ok)
	}

	// 3. pure_leaf
	l, ok = evalPureLeafStrategy(layerEvaluationContext{inDegree: 2, outDegree: 0})
	if !ok || l != LayerFoundation {
		t.Errorf("evalPureLeafStrategy 应命中 LayerFoundation, got %v, %v", l, ok)
	}

	// 4. pure_root
	l, ok = evalPureRootStrategy(layerEvaluationContext{inDegree: 0, outDegree: 3})
	if !ok || l != LayerInterface {
		t.Errorf("evalPureRootStrategy 应命中 LayerInterface, got %v, %v", l, ok)
	}

	// 5. intermediate_pipeline
	l, ok = evalIntermediatePipelineStrategy(layerEvaluationContext{inDegree: 1, outDegree: 1})
	if !ok || l != LayerPipeline {
		t.Errorf("evalIntermediatePipelineStrategy 应命中 LayerPipeline, got %v, %v", l, ok)
	}
	// 高入度基础服务
	l, ok = evalIntermediatePipelineStrategy(layerEvaluationContext{inDegree: 6, outDegree: 1})
	if !ok || l != LayerFoundation {
		t.Errorf("evalIntermediatePipelineStrategy (in>=3*out) 应命中 LayerFoundation, got %v, %v", l, ok)
	}

	// 6. isolated_fallback
	l, ok = evalIsolatedFallbackStrategy(layerEvaluationContext{file: FileMap{Path: "controllers/user.go"}})
	if !ok || l != LayerInterface {
		t.Errorf("evalIsolatedFallbackStrategy 显式接口应命中 LayerInterface, got %v, %v", l, ok)
	}
	l, ok = evalIsolatedFallbackStrategy(layerEvaluationContext{role: "utility"})
	if !ok || l != LayerFoundation {
		t.Errorf("evalIsolatedFallbackStrategy utility 应命中 LayerFoundation, got %v, %v", l, ok)
	}
}

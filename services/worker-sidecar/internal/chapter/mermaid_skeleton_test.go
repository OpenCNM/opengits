package chapter

import (
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
)

func TestBuildModuleArchitectureMermaidSkeleton_CallFlow(t *testing.T) {
	cog := &cognitive.ModuleCognition{
		Phase:      cognitive.PhasePipeline,
		PhaseOrder: 2,
		Rationale:  "Core scheduling engine",
		CallFlow: []cognitive.ModuleCallStep{
			{Caller: "InitScheduler", Callee: "LoadConfig"},
			{Caller: "LoadConfig", Callee: "ValidateSchema"},
		},
		UpstreamModules:   []string{"ConfigStore"},
		DownstreamModules: []string{"WorkerPool"},
	}

	skeleton := BuildModuleArchitectureMermaidSkeleton(
		"Scheduler Core",
		cog,
		nil,
		SkeletonOptions{MaxCallSteps: 5, IncludeExternal: true},
	)

	assert.Contains(t, skeleton, "```mermaid\nflowchart TD\n")
	assert.Contains(t, skeleton, `subgraph ChapterMod["Scheduler Core"]`)
	assert.Contains(t, skeleton, `fn1["InitScheduler()"]`)
	assert.Contains(t, skeleton, `fn2["LoadConfig()"]`)
	assert.Contains(t, skeleton, `fn1 --> fn2`)
	assert.Contains(t, skeleton, `fn3["ValidateSchema()"]`)
	assert.Contains(t, skeleton, `fn2 --> fn3`)
	assert.Contains(t, skeleton, `up1(["Prerequisite: ConfigStore"]) --> fn1`)
	assert.Contains(t, skeleton, `fn3 --> down1(["Dependent: WorkerPool"])`)
	assert.True(t, skeleton[len(skeleton)-3:] == "```")
}

func TestBuildModuleArchitectureMermaidSkeleton_GoldenSymbolsFallback(t *testing.T) {
	golden := []cognitive.ModuleGoldenSymbol{
		{Name: "Store", Kind: "type", File: "store.go"},
		{Name: "NewStore", Kind: "function", File: "store.go"},
	}

	skeleton := BuildModuleArchitectureMermaidSkeleton(
		"Storage Layer",
		nil,
		golden,
		SkeletonOptions{MaxCallSteps: 5, IncludeExternal: false},
	)

	assert.Contains(t, skeleton, "```mermaid\nflowchart TD\n")
	assert.Contains(t, skeleton, `subgraph ChapterMod["Storage Layer"]`)
	assert.Contains(t, skeleton, `fn1["Store (type)"]`)
	assert.Contains(t, skeleton, `fn2["NewStore (function)"]`)
	assert.Contains(t, skeleton, `fn1 -.-> fn2`)
	assert.NotContains(t, skeleton, "Prerequisite:")
}

func TestBuildModuleArchitectureMermaidSkeleton_EmptyFallback(t *testing.T) {
	// 1. 无内部 AST 节点且无外部依赖时，根据第一性原理不伪造空壳单节点，返回空串
	skeletonEmpty := BuildModuleArchitectureMermaidSkeleton(
		`Weird "Quotes" Title`,
		nil,
		nil,
		SkeletonOptions{MaxCallSteps: 5, IncludeExternal: false},
	)
	assert.Empty(t, skeletonEmpty)

	// 2. 无内部 AST 节点但有外部依赖时，允许作为拓扑连接桩呈现
	cogWithBoundary := &cognitive.ModuleCognition{
		UpstreamModules: []string{"AuthService"},
	}
	skeletonBoundary := BuildModuleArchitectureMermaidSkeleton(
		`Weird "Quotes" Title`,
		cogWithBoundary,
		nil,
		SkeletonOptions{MaxCallSteps: 5, IncludeExternal: true},
	)
	assert.Contains(t, skeletonBoundary, "```mermaid\nflowchart TD\n")
	assert.Contains(t, skeletonBoundary, `subgraph ChapterMod["Weird ''Quotes'' Title"]`)
	assert.Contains(t, skeletonBoundary, `fn1["Weird ''Quotes'' Title Core"]`)
	assert.Contains(t, skeletonBoundary, `Prerequisite: AuthService`)
}

func TestBuildModuleArchitectureMermaidSkeleton_CalleeFile(t *testing.T) {
	cog := &cognitive.ModuleCognition{
		CallFlow: []cognitive.ModuleCallStep{
			{Caller: "ParseHeader", Callee: "Tokenize", CalleeFile: "lexer/scan.go"},
		},
	}

	skeleton := BuildModuleArchitectureMermaidSkeleton("Lexer", cog, nil, SkeletonOptions{MaxCallSteps: 2, IncludeExternal: false})
	assert.Contains(t, skeleton, `fn1["ParseHeader()"]`)
	assert.Contains(t, skeleton, `fn2["Tokenize()<br/>lexer/scan.go"]`)
	assert.Contains(t, skeleton, `fn1 --> fn2`)
}

func TestExtractSymbolsFromSkeleton(t *testing.T) {
	skeleton := "```mermaid\nflowchart TD\n" +
		"  subgraph ChapterMod[\"Scheduler Core\"]\n" +
		"    fn1[\"InitScheduler()\"]\n" +
		"    fn2[\"LoadConfig()<br/>config.go\"]\n" +
		"    fn3[\"Store (type)\"]\n" +
		"    fn1 --> fn2\n" +
		"  end\n" +
		"  up1([\"Prerequisite: ConfigStore\"]) --> fn1\n" +
		"  fn2 --> down1([\"Dependent: WorkerPool\"])\n" +
		"```"

	syms := ExtractSymbolsFromSkeleton(skeleton)
	// subgraph 容器标题不属于代码 AST 符号，不应被计入事实校验符号列表
	assert.NotContains(t, syms, "Scheduler")
	assert.Contains(t, syms, "InitScheduler")
	assert.Contains(t, syms, "LoadConfig")
	assert.Contains(t, syms, "Store")
	assert.Contains(t, syms, "ConfigStore")
	assert.Contains(t, syms, "WorkerPool")
	assert.NotContains(t, syms, "Prerequisite")
	assert.NotContains(t, syms, "Dependent")
	assert.NotContains(t, syms, "flowchart")
}

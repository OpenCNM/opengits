package cognitive

import (
	"fmt"
	"sort"
	"strings"
)

// DetermineModuleCognitivePhase maps files in a module to its optimal cognitive phase via PageRank mass voting.
// DefaultPrimaryEntryMassRatio 主入口质量占比阈值缺省值（行为参数，golden §14
// 分层登记：cognitive-projector.golden.json 记录其输出效应——调值是显式产品
// 决策，连带重生成夹具；历史 0.15 为无源硬编码，BUG-35 对拍修正为 0.25）。
const DefaultPrimaryEntryMassRatio = 0.25

func DetermineModuleCognitivePhase(files []PhaseVoteFile, opts PhaseVoteOptions) (CognitivePhase, int, string) {
	if len(files) == 0 {
		return PhaseAdapter, 4, "No primary files detected; defaulted to infrastructure tier."
	}

	threshold := opts.PrimaryEntryMassRatio
	if threshold <= 0 {
		threshold = DefaultPrimaryEntryMassRatio
	}

	massByRole := make(map[GraphNodeRole]float64)
	countByRole := make(map[GraphNodeRole]int)
	var totalMass float64

	for _, file := range files {
		massByRole[file.Role] += file.PageRank
		countByRole[file.Role]++
		totalMass += file.PageRank
	}

	entryMass := massByRole[RoleEntryPoint]
	contractMass := massByRole[RoleCoreContract]
	pipelineMass := massByRole[RolePipelineFlow]

	var entryRatio float64
	if totalMass > 0 {
		entryRatio = entryMass / totalMass
	}

	if entryRatio >= threshold {
		return PhasePerception, 1, "Contains the system entry points and execution bootstrap logic (topological mass gated)."
	}

	if contractMass > 0 && contractMass >= pipelineMass {
		return PhaseEntity, 2, "Acts as a foundational data contract or domain state referenced across the system."
	}

	if pipelineMass > 0 {
		return PhasePipeline, 3, "Executes core workflow, data transformation, and processing pipelines."
	}

	// Degenerate tie (all masses zero): fall back to role counts
	if countByRole[RoleCoreContract] > 0 {
		return PhaseEntity, 2, "Acts as a foundational data contract or domain state referenced across the system."
	}
	if countByRole[RolePipelineFlow] > 0 {
		return PhasePipeline, 3, "Executes core workflow, data transformation, and processing pipelines."
	}
	if countByRole[RoleEntryPoint] > 0 {
		return PhasePerception, 1, "Contains the system entry points and execution bootstrap logic."
	}

	return PhaseAdapter, 4, "Provides external adapters, utilities, or supporting infrastructure."
}

func ModulePathMatches(filePath string, directories []string) bool {
	normPath := strings.ReplaceAll(filePath, "\\", "/")
	for _, dir := range directories {
		normDir := strings.ReplaceAll(dir, "\\", "/")
		cleanDir := strings.Trim(normDir, "/")
		if cleanDir == "" || cleanDir == "." {
			return true
		}
		if normPath == cleanDir || strings.HasPrefix(normPath, cleanDir+"/") {
			return true
		}
	}
	return false
}

const maxModuleGoldenSymbols = 5
const maxModuleCallSteps = 8

func ProjectModuleIntelligence(artifact *SemanticGraphArtifact, directories []string) ([]ModuleGoldenSymbol, []ModuleCallStep) {
	golden := make([]ModuleGoldenSymbol, 0)
	if artifact != nil {
		for _, g := range artifact.GoldenSymbols {
			if ModulePathMatches(g.File, directories) {
				golden = append(golden, ModuleGoldenSymbol{
					Name: g.Name,
					File: g.File,
					Kind: g.Kind,
				})
				if len(golden) >= maxModuleGoldenSymbols {
					break
				}
			}
		}
	}

	seen := make(map[string]bool)
	callFlow := make([]ModuleCallStep, 0)
	if artifact != nil {
		for _, edge := range artifact.CallEdges {
			if !ModulePathMatches(edge.CallerFile, directories) || !ModulePathMatches(edge.CalleeFile, directories) {
				continue
			}
			if edge.CallerSymbol == edge.CalleeSymbol {
				continue
			}
			key := edge.CallerSymbol + "→" + edge.CalleeSymbol
			if seen[key] {
				continue
			}
			seen[key] = true
			callFlow = append(callFlow, ModuleCallStep{
				Caller:     edge.CallerSymbol,
				Callee:     edge.CalleeSymbol,
				CalleeFile: edge.CalleeFile,
			})
			if len(callFlow) >= maxModuleCallSteps {
				break
			}
		}
	}

	return golden, callFlow
}

// ProjectCognitiveGradient projects modules onto the 4-tier cognitive gradient.
func ProjectCognitiveGradient(artifact *SemanticGraphArtifact, modules []ModuleDraftInput, opts PhaseVoteOptions) []ProjectedModule {
	return ProjectToCognitiveGradient(artifact, modules, opts)
}

func ProjectToCognitiveGradient(artifact *SemanticGraphArtifact, modules []ModuleDraftInput, opts PhaseVoteOptions) []ProjectedModule {
	if artifact == nil {
		projected := make([]ProjectedModule, len(modules))
		for i, mod := range modules {
			projected[i] = ProjectedModule{
				Name:               mod.Name,
				Summary:            mod.Summary,
				Phase:              PhaseAdapter,
				PhaseOrder:         4,
				TeachingOrder:      i + 1,
				Directories:        mod.Directories,
				PrimaryFiles:       make([]string, 0),
				BackboneCount:      0,
				EntryPointCount:    0,
				AveragePageRank:    0,
				CognitiveRationale: "No primary files detected; defaulted to infrastructure tier.",
				UpstreamModules:    make([]string, 0),
				DownstreamModules:  make([]string, 0),
				DraftIndex:         mod.DraftIndex,
				GoldenSymbols:      make([]ModuleGoldenSymbol, 0),
				CallFlow:           make([]ModuleCallStep, 0),
			}
		}
		return projected
	}

	projected := make([]ProjectedModule, 0, len(modules))

	for _, mod := range modules {
		var matchedNodes []SemanticGraphArtifactNode
		for _, node := range artifact.Nodes {
			if ModulePathMatches(node.Path, mod.Directories) {
				matchedNodes = append(matchedNodes, node)
			}
		}

		voteFiles := make([]PhaseVoteFile, len(matchedNodes))
		var backboneCount int
		var entryPointCount int
		var totalPageRank float64
		primaryFiles := make([]string, 0)

		for i, n := range matchedNodes {
			voteFiles[i] = PhaseVoteFile{
				IsEntryPoint: n.IsEntryPoint,
				Role:         n.Role,
				PageRank:     n.PageRank,
			}
			if n.IsBackbone {
				backboneCount++
			}
			if n.IsEntryPoint {
				entryPointCount++
			}
			totalPageRank += n.PageRank
			if len(primaryFiles) < 10 {
				primaryFiles = append(primaryFiles, n.Path)
			}
		}

		phase, phaseOrder, rationale := DetermineModuleCognitivePhase(voteFiles, opts)
		var avgPr float64
		if len(matchedNodes) > 0 {
			avgPr = totalPageRank / float64(len(matchedNodes))
		}

		goldenSymbols, callFlow := ProjectModuleIntelligence(artifact, mod.Directories)

		projected = append(projected, ProjectedModule{
			Name:               mod.Name,
			Summary:            mod.Summary,
			Phase:              phase,
			PhaseOrder:         phaseOrder,
			TeachingOrder:      0, // Assigned after sorting
			Directories:        mod.Directories,
			PrimaryFiles:       primaryFiles,
			BackboneCount:      backboneCount,
			EntryPointCount:    entryPointCount,
			AveragePageRank:    avgPr,
			CognitiveRationale: rationale,
			UpstreamModules:    make([]string, 0),
			DownstreamModules:  make([]string, 0),
			DraftIndex:         mod.DraftIndex,
			GoldenSymbols:      goldenSymbols,
			CallFlow:           callFlow,
		})
	}

	// Module dependency names derived from the graph's file-level edges.
	fileToModule := make(map[string]int)
	for modIdx, mod := range projected {
		for _, node := range artifact.Nodes {
			if ModulePathMatches(node.Path, mod.Directories) {
				fileToModule[node.Path] = modIdx
			}
		}
	}

	upstreamSets := make([]map[string]bool, len(projected))
	downstreamSets := make([]map[string]bool, len(projected))
	for i := range projected {
		upstreamSets[i] = make(map[string]bool)
		downstreamSets[i] = make(map[string]bool)
	}

	// Process Edges and SoftEdges
	addEdge := func(source, target string) {
		sourceIdx, hasSource := fileToModule[source]
		targetIdx, hasTarget := fileToModule[target]
		if !hasSource || !hasTarget || sourceIdx == targetIdx {
			return
		}
		upstreamSets[sourceIdx][projected[targetIdx].Name] = true
		downstreamSets[targetIdx][projected[sourceIdx].Name] = true
	}

	for _, edge := range artifact.Edges {
		addEdge(edge.Source, edge.Target)
	}
	for _, edge := range artifact.SoftEdges {
		addEdge(edge.Source, edge.Target)
	}

	for i := range projected {
		up := make([]string, 0, len(upstreamSets[i]))
		for m := range upstreamSets[i] {
			up = append(up, m)
		}
		sort.Strings(up)
		projected[i].UpstreamModules = up

		down := make([]string, 0, len(downstreamSets[i]))
		for m := range downstreamSets[i] {
			down = append(down, m)
		}
		sort.Strings(down)
		projected[i].DownstreamModules = down
	}

	// Sort by Cognitive Phase (Phase 1 -> 2 -> 3 -> 4), then by Backbone Count / PageRank within same phase
	sort.SliceStable(projected, func(i, j int) bool {
		if projected[i].PhaseOrder != projected[j].PhaseOrder {
			return projected[i].PhaseOrder < projected[j].PhaseOrder
		}
		if projected[i].BackboneCount != projected[j].BackboneCount {
			return projected[i].BackboneCount > projected[j].BackboneCount
		}
		return projected[i].AveragePageRank > projected[j].AveragePageRank
	})

	// Assign 1-indexed teaching order
	for i := range projected {
		projected[i].TeachingOrder = i + 1
	}

	return projected
}

func BuildCognitiveScaffoldSection(cognitive ModuleCognition, teachingOrder int) string {
	lines := []string{
		"### COGNITIVE GRADIENT POSITION",
	}
	if teachingOrder > 0 {
		lines = append(lines, fmt.Sprintf("This chapter is number %d in the teaching sequence and sits at %s.", teachingOrder, PhaseLabels[cognitive.Phase]))
	} else {
		lines = append(lines, fmt.Sprintf("This chapter is part of the teaching sequence and sits at %s.", PhaseLabels[cognitive.Phase]))
	}
	lines = append(lines, fmt.Sprintf("- Role: %s", cognitive.Rationale))

	if len(cognitive.UpstreamModules) > 0 {
		lines = append(lines, fmt.Sprintf("- Depends on: %s", strings.Join(cognitive.UpstreamModules, ", ")))
	}
	if len(cognitive.DownstreamModules) > 0 {
		lines = append(lines, fmt.Sprintf("- Used by: %s", strings.Join(cognitive.DownstreamModules, ", ")))
	}
	if len(cognitive.GoldenSymbols) > 0 {
		symbols := make([]string, len(cognitive.GoldenSymbols))
		for i, s := range cognitive.GoldenSymbols {
			symbols[i] = fmt.Sprintf("`%s` (%s)", s.Name, s.File)
		}
		lines = append(lines, fmt.Sprintf("- Core symbols to analyze in depth (most-referenced across the repository): %s", strings.Join(symbols, ", ")))
	}
	if len(cognitive.CallFlow) > 0 {
		steps := make([]string, len(cognitive.CallFlow))
		for i, step := range cognitive.CallFlow {
			steps[i] = fmt.Sprintf("%s → %s", step.Caller, step.Callee)
		}
		lines = append(lines, fmt.Sprintf("- Observed call flow (verified against the code): %s", strings.Join(steps, "; ")))
	}
	lines = append(lines, "Reference these relationships when explaining how this chapter connects to the rest of the system.")
	return strings.Join(lines, "\n")
}

func BuildCognitivePromptScaffold(projectedModules []ProjectedModule) string {
	lines := []string{
		"### COGNITIVE GRADIENT ARCHITECTURE (TOPOLOGICAL SCAFFOLD)",
		"The repository modules have been mathematically ordered by dependency topology and cognitive hierarchy:",
		"",
	}

	for _, mod := range projectedModules {
		primary := strings.Join(mod.PrimaryFiles, ", ")
		if primary == "" {
			primary = "(Module root)"
		}
		lines = append(
			lines,
			fmt.Sprintf("Chapter %d: %s %s", mod.TeachingOrder, mod.Name, PhaseLabels[mod.Phase]),
			fmt.Sprintf("  - Role Rationale: %s", mod.CognitiveRationale),
			fmt.Sprintf("  - Primary Files: %s", primary),
			fmt.Sprintf("  - Directories: %s", strings.Join(mod.Directories, ", ")),
		)
		if len(mod.UpstreamModules) > 0 {
			lines = append(lines, fmt.Sprintf("  - Depends on: %s", strings.Join(mod.UpstreamModules, ", ")))
		}
		if len(mod.DownstreamModules) > 0 {
			lines = append(lines, fmt.Sprintf("  - Used by: %s", strings.Join(mod.DownstreamModules, ", ")))
		}
		lines = append(lines, "")
	}

	lines = append(lines, "Use this structured progression to write deep, progressive, and cohesive pedagogical lessons.")
	return strings.Join(lines, "\n")
}

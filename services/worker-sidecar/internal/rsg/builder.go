package rsg

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
)

// BuildSemanticGraph constructs the RepositorySemanticGraph from source files using LanguageDefinitions.
// selectParseBudget 在可解析文件（语言已知且体积合规）中按顶层目录
// 轮转选取 ≤budget 个：每个顶层分区（子系统）轮流获得名额，杜绝字典序
// 前段独吞预算。分区顺序取排序后首见序（确定性输出）。
func selectParseBudget(sortedFiles []SourceFileInput, d *LanguageDefinitions, budget int, maxBytes int) map[string]bool {
	byTop := map[string][]SourceFileInput{}
	var order []string
	for _, f := range sortedFiles {
		if d.DetectLanguage(f.Path) == nil || len(f.Content) > maxBytes {
			continue
		}
		top := f.Path
		if i := strings.IndexByte(f.Path, '/'); i >= 0 {
			top = f.Path[:i]
		}
		if _, ok := byTop[top]; !ok {
			order = append(order, top)
		}
		byTop[top] = append(byTop[top], f)
	}
	selected := make(map[string]bool, budget)
	for idx := 0; len(selected) < budget; idx++ {
		progressed := false
		for _, top := range order {
			list := byTop[top]
			if idx < len(list) {
				selected[list[idx].Path] = true
				progressed = true
				if len(selected) >= budget {
					return selected
				}
			}
		}
		if !progressed {
			return selected
		}
	}
	return selected
}


// BuildSemanticGraph constructs the RepositorySemanticGraph from source files.
func (d *LanguageDefinitions) BuildSemanticGraph(files []SourceFileInput) (*RepositorySemanticGraph, error) {
	g, _, err := d.buildSemanticGraphCollecting(context.Background(), files)
	return g, err
}

// buildSemanticGraphCollecting 构建图并收集文件级提取快照（bundle 落盘
// 用；键 = MakeAstCacheKey(lang, contentSha)，与进程内缓存键体系一致）。
// 提取走同一 ExtractFileAstWithSha——缓存命中/解析路径与不收集时完全相同。
func (d *LanguageDefinitions) buildSemanticGraphCollecting(ctx context.Context, files []SourceFileInput) (*RepositorySemanticGraph, []extractionSnapshot, error) {
	sortedFiles := make([]SourceFileInput, len(files))
	copy(sortedFiles, files)
	sort.Slice(sortedFiles, func(i, j int) bool {
		return sortedFiles[i].Path < sortedFiles[j].Path
	})

	maxParse := d.Config.MaxParseFiles
	if maxParse <= 0 {
		maxParse = 3000
	}

	filePathSet := make(map[string]bool, len(sortedFiles))
	allPaths := make([]string, len(sortedFiles))
	var composerFiles []SourceFileInput

	for i, f := range sortedFiles {
		filePathSet[f.Path] = true
		allPaths[i] = f.Path
		if strings.HasSuffix(f.Path, "composer.json") {
			composerFiles = append(composerFiles, f)
		}
		if strings.HasSuffix(f.Path, ".json") && isTsConfigPath(f.Path) {
			composerFiles = append(composerFiles, f) // 复用同一收集通道
		}
	}

	psr4Aliases := ParsePsr4Aliases(composerFiles)
	tsAliases := ParseTsConfigAliases(composerFiles)

	// step 6 后缀回退的 basename 索引（一次构建，替代每次回退对全文件集
	// 的线性扫描）；allPaths 已按字典序排序 → 候选序与旧线性扫描兼容。
	basenameIdx := BuildBasenameIndex(allPaths)

	// import 解析 memo：ResolveImportTarget 是 (import, current, 文件集,
	// 别名) 的纯函数——pass 1 建边与 pass 2 建绑定对同一 module 的重复
	// 解析（含 O(文件集) 回退扫描）合并为一次。
	resolveMemo := make(map[string]string)
	resolveImport := func(importStr, currentPath string) string {
		key := importStr + "\x00" + currentPath
		if t, ok := resolveMemo[key]; ok {
			return t
		}
		t := d.resolveImportTarget(importStr, currentPath, filePathSet, basenameIdx, psr4Aliases, tsAliases)
		resolveMemo[key] = t
		return t
	}

	type fileInfo struct {
		path    string
		lang    string
		imports []string
		isTest  bool
		skipped bool
		ast     *FileAstExtraction
	}

	maxBytes := d.Config.MaxParseFileBytes
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}

	// AST 预算按顶层目录轮转摊开（Path ≠ Architecture：字典序前段独吞
	// 预算会让 z*/w* 子系统在语义图里整体失明）。轮转只吃可解析文件
	//（语言已知且不超限），预算上限语义不变（≤ maxParse 次解析）。
	parseEligible := selectParseBudget(sortedFiles, d, maxParse, maxBytes)

	fileInfos := make([]fileInfo, len(sortedFiles))
	snaps := make([]*extractionSnapshot, len(sortedFiles))
	var parseIndices []int
	for i, f := range sortedFiles {
		lang := d.DetectLanguage(f.Path)
		langName := "unknown"
		if lang != nil {
			langName = lang.Name
		}
		isTest := d.IsTestFile(f.Path)
		if !parseEligible[f.Path] {
			fileInfos[i] = fileInfo{
				path:    f.Path,
				lang:    langName,
				skipped: true,
				isTest:  isTest,
			}
			continue
		}
		fileInfos[i] = fileInfo{
			path:   f.Path,
			lang:   langName,
			isTest: isTest,
		}
		parseIndices = append(parseIndices, i)
	}

	if len(parseIndices) > 0 {
		workers := min(runtime.GOMAXPROCS(0), 4)
		if workers < 1 {
			workers = 1
		}
		if workers > len(parseIndices) {
			workers = len(parseIndices)
		}

		jobsCh := make(chan int, len(parseIndices))
		for _, idx := range parseIndices {
			jobsCh <- idx
		}
		close(jobsCh)

		var wg sync.WaitGroup
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range jobsCh {
					if ctx != nil && ctx.Err() != nil {
						return
					}
					f := sortedFiles[i]
					ast := d.ExtractFileAstWithSha(f.Content, f.Path, f.Sha)
					fileInfos[i].imports = ast.RawImports
					fileInfos[i].ast = ast

					snapSha := f.Sha
					if snapSha == "" {
						snapSha = ComputeContentSha(f.Content)
					}
					snaps[i] = &extractionSnapshot{
						Key:        MakeAstCacheKey(snapSha, fileInfos[i].lang),
						Extraction: ast,
					}
				}
			}()
		}
		wg.Wait()
		if ctx != nil {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
		}
	}

	bundleSnapshots := make([]extractionSnapshot, 0, len(parseIndices))
	for _, i := range parseIndices {
		if snaps[i] != nil {
			bundleSnapshots = append(bundleSnapshots, *snaps[i])
		}
	}

	adjacencyMap := make(map[string][]string, len(allPaths))
	reverseAdjacencyMap := make(map[string][]string, len(allPaths))
	for _, p := range allPaths {
		adjacencyMap[p] = nil
		reverseAdjacencyMap[p] = nil
	}

	var edges []SemanticGraphEdge
	droppedTestEdges := 0
	unresolvedImportCount := 0

	for _, fi := range fileInfos {
		if d.Config.ExcludeTestsFromEdges && fi.isTest {
			droppedTestEdges += len(fi.imports)
			continue
		}

		resolvedTargetSet := make(map[string]bool)
		for _, rawImp := range fi.imports {
			target := resolveImport(rawImp, fi.path)
			if target != "" && target != fi.path {
				resolvedTargetSet[target] = true
			} else if target == "" {
				unresolvedImportCount++
			}
		}

		targets := make([]string, 0, len(resolvedTargetSet))
		for t := range resolvedTargetSet {
			targets = append(targets, t)
		}
		sort.Strings(targets)

		adjacencyMap[fi.path] = targets
		for _, t := range targets {
			reverseAdjacencyMap[t] = append(reverseAdjacencyMap[t], fi.path)
			edges = append(edges, SemanticGraphEdge{Source: fi.path, Target: t})
		}
	}

	// Compute PageRank
	damping := d.Config.DampingFactor
	if damping == 0 {
		damping = 0.85
	}
	iters := d.Config.PagerankIterations
	if iters <= 0 {
		iters = 30
	}
	pageRankMap := ComputePageRank(allPaths, adjacencyMap, damping, iters)

	// Compute Quantiles
	coreQuantile := d.Config.CoreContractInDegreeQuantile
	if coreQuantile == 0 {
		coreQuantile = 0.75
	}
	backboneQuantile := d.Config.BackbonePageRankQuantile
	if backboneQuantile == 0 {
		backboneQuantile = 0.70
	}
	coreContractThreshold, backboneThreshold := ComputeThresholds(
		allPaths,
		reverseAdjacencyMap,
		pageRankMap,
		coreQuantile,
		backboneQuantile,
	)

	// 1. Index symbols, imported bindings, and binding targets
	symbolsByFile := make(map[string][]SymbolEntry, len(allPaths))
	importedBindings := make(map[string]map[string]map[string]bool)
	bindingTargetsBySource := make(map[string]map[string]string)

	for _, fi := range fileInfos {
		if fi.ast != nil && len(fi.ast.Symbols) > 0 {
			symbolsByFile[fi.path] = fi.ast.Symbols
		}
		if fi.ast != nil && len(fi.ast.Imports) > 0 {
			for _, imp := range fi.ast.Imports {
				target := resolveImport(imp.Module, fi.path)
				if target != "" && target != fi.path {
					if bindingTargetsBySource[fi.path] == nil {
						bindingTargetsBySource[fi.path] = make(map[string]string)
					}
					if importedBindings[target] == nil {
						importedBindings[target] = make(map[string]map[string]bool)
					}
					for _, b := range imp.Bindings {
						bindingTargetsBySource[fi.path][b] = target
						if importedBindings[target][b] == nil {
							importedBindings[target][b] = make(map[string]bool)
						}
						importedBindings[target][b][fi.path] = true
					}
				}
			}
		}
	}

	// 2. Compute Golden Symbols
	goldenRatio := d.Config.GoldenSymbolRatio
	if goldenRatio <= 0 {
		goldenRatio = 0.15
	}
	minImporters := d.Config.GoldenSymbolMinImporters
	if minImporters <= 0 {
		minImporters = 2
	}

	type goldenCandidate struct {
		targetFile string
		name       string
		kind       string
		score      float64
		importers  int
	}
	var candidates []goldenCandidate
	for targetFile, symMap := range importedBindings {
		targetSyms := symbolsByFile[targetFile]
		symDefMap := make(map[string]SymbolEntry, len(targetSyms))
		for _, s := range targetSyms {
			symDefMap[s.Name] = s
		}
		for symName, importersSet := range symMap {
			symDef, ok := symDefMap[symName]
			if !ok {
				continue
			}
			if len(importersSet) < minImporters {
				continue
			}
			score := 0.0
			for imp := range importersSet {
				score += pageRankMap[imp]
			}
			candidates = append(candidates, goldenCandidate{
				targetFile: targetFile,
				name:       symName,
				kind:       symDef.Kind,
				score:      score,
				importers:  len(importersSet),
			})
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].name < candidates[j].name
	})

	keep := int(math.Ceil(float64(len(candidates)) * goldenRatio))
	if keep < 1 && len(candidates) > 0 {
		keep = 1
	}

	goldenSet := make(map[string]bool)
	var goldenSymbols []GoldenSymbol
	for i := 0; i < keep && i < len(candidates); i++ {
		c := candidates[i]
		goldenSet[c.targetFile+"::"+c.name] = true
		goldenSymbols = append(goldenSymbols, GoldenSymbol{
			File:      c.targetFile,
			Name:      c.name,
			Kind:      c.kind,
			Score:     c.score,
			Importers: c.importers,
		})
	}

	// Decorate symbols with golden tier and importers count
	for path, syms := range symbolsByFile {
		decorated := make([]SymbolEntry, len(syms))
		for idx, s := range syms {
			key := path + "::" + s.Name
			if goldenSet[key] {
				importersCount := len(importedBindings[path][s.Name])
				s.Golden = true
				s.Importers = importersCount
			}
			decorated[idx] = s
		}
		symbolsByFile[path] = decorated
	}

	// 3. Compute High-confidence CallEdges
	var callEdges []CallEdge
	unresolvedCallSites := 0
	for _, fi := range fileInfos {
		if fi.ast == nil || len(fi.ast.CallSites) == 0 {
			continue
		}
		fileSyms := symbolsByFile[fi.path]
		var funcs []SymbolEntry
		sameFileSyms := make(map[string]bool)
		for _, s := range fileSyms {
			if s.Kind == "function" {
				funcs = append(funcs, s)
			}
			sameFileSyms[s.Name] = true
		}

		for _, cs := range fi.ast.CallSites {
			var callerFunc *SymbolEntry
			for _, fn := range funcs {
				if fn.StartLine <= cs.Line && cs.Line <= fn.EndLine {
					if callerFunc == nil || fn.StartLine > callerFunc.StartLine {
						f := fn
						callerFunc = &f
					}
				}
			}
			if callerFunc == nil {
				continue
			}

			// Skip self-declaration as a call site
			if callerFunc.Name == cs.Name && cs.Line == callerFunc.StartLine {
				continue
			}

			if sameFileSyms[cs.Name] {
				callEdges = append(callEdges, CallEdge{
					CallerFile:   fi.path,
					CallerSymbol: callerFunc.Name,
					CalleeFile:   fi.path,
					CalleeSymbol: cs.Name,
					Line:         cs.Line,
				})
				continue
			}

			if targets, ok := bindingTargetsBySource[fi.path]; ok {
				if targetFile, exists := targets[cs.Name]; exists {
					targetSyms := symbolsByFile[targetFile]
					found := false
					for _, ts := range targetSyms {
						if ts.Name == cs.Name {
							found = true
							break
						}
					}
					if found {
						callEdges = append(callEdges, CallEdge{
							CallerFile:   fi.path,
							CallerSymbol: callerFunc.Name,
							CalleeFile:   targetFile,
							CalleeSymbol: cs.Name,
							Line:         cs.Line,
						})
						continue
					}
				}
			}
			unresolvedCallSites++
		}
	}

	// 4. Compute SoftEdges (reverse identifier matching for constants/classes)
	symbolDefiners := make(map[string][]string)
	for p, syms := range symbolsByFile {
		for _, s := range syms {
			if s.Kind == "type" && s.Exported {
				symbolDefiners[s.Name] = append(symbolDefiners[s.Name], p)
			}
		}
	}
	var softEdges []SoftGraphEdge
	ambiguousSoftRefs := 0
	seenSoftPairs := make(map[string]bool)
	for _, fi := range fileInfos {
		if fi.ast == nil || len(fi.ast.ReferencedConstants) == 0 {
			continue
		}
		ownNames := make(map[string]bool)
		for _, s := range symbolsByFile[fi.path] {
			ownNames[s.Name] = true
		}
		for _, constant := range fi.ast.ReferencedConstants {
			if ownNames[constant] {
				continue
			}
			candidates := symbolDefiners[constant]
			var filtered []string
			for _, cand := range candidates {
				if cand != fi.path {
					filtered = append(filtered, cand)
				}
			}
			if len(filtered) == 0 {
				continue
			}
			if len(filtered) > 1 {
				ambiguousSoftRefs++
				continue
			}
			pairKey := fi.path + "->" + filtered[0] + ":" + constant
			if !seenSoftPairs[pairKey] {
				seenSoftPairs[pairKey] = true
				softEdges = append(softEdges, SoftGraphEdge{
					Source: fi.path,
					Target: filtered[0],
					Kind:   "symbol_reference",
				})
			}
		}
	}

	// 5. Assemble Nodes
	nodesRecord := make(map[string]*SemanticGraphNode, len(allPaths))
	nodeList := make([]*SemanticGraphNode, 0, len(allPaths))
	var entryPoints []string
	var coreContractNodes []string
	var pipelineNodes []string
	var backboneNodes []string

	registryFallbackFiles := 0
	skippedFiles := 0
	astParsedFiles := 0

	for i, p := range allPaths {
		fi := fileInfos[i]
		inDeg := len(reverseAdjacencyMap[p])
		outDeg := len(adjacencyMap[p])
		prScore := pageRankMap[p]

		isIsolatedEntry := d.IsIsolatedNamedEntry(p)
		role, isEntryPoint, isBackbone := ClassifyNodeRole(
			p, inDeg, outDeg, prScore,
			coreContractThreshold, backboneThreshold, isIsolatedEntry,
		)

		if isEntryPoint {
			entryPoints = append(entryPoints, p)
		}
		if role == RoleCoreContract {
			coreContractNodes = append(coreContractNodes, p)
		} else if role == RolePipelineFlow {
			pipelineNodes = append(pipelineNodes, p)
		}
		if isBackbone {
			backboneNodes = append(backboneNodes, p)
		}

		imports := adjacencyMap[p]
		if imports == nil {
			imports = []string{}
		}
		importedBy := reverseAdjacencyMap[p]
		if importedBy == nil {
			importedBy = []string{}
		}

		nodeSyms := symbolsByFile[p]
		if nodeSyms == nil {
			nodeSyms = []SymbolEntry{}
		}

		node := &SemanticGraphNode{
			Path:         p,
			Language:     fi.lang,
			InDegree:     inDeg,
			OutDegree:    outDeg,
			PageRank:     prScore,
			Role:         role,
			ImportedBy:   importedBy,
			Imports:      imports,
			IsBackbone:   isBackbone,
			IsEntryPoint: isEntryPoint,
			Symbols:      nodeSyms,
		}
		nodesRecord[p] = node
		nodeList = append(nodeList, node)

		if fi.skipped {
			skippedFiles++
		} else {
			astParsedFiles++
		}
	}

	if goldenSymbols == nil {
		goldenSymbols = []GoldenSymbol{}
	}
	if callEdges == nil {
		callEdges = []CallEdge{}
	}
	if softEdges == nil {
		softEdges = []SoftGraphEdge{}
	}

	return &RepositorySemanticGraph{
		Nodes:             nodesRecord,
		NodeList:          nodeList,
		Edges:             edges,
		SoftEdges:         softEdges,
		GoldenSymbols:     goldenSymbols,
		CallEdges:         callEdges,
		EntryPoints:       entryPoints,
		BackboneNodes:     backboneNodes,
		CoreContractNodes: coreContractNodes,
		PipelineNodes:     pipelineNodes,
		SymbolsByFile:     symbolsByFile,
		Meta: SemanticGraphMeta{
			TotalFiles:                  len(allPaths),
			ASTParsedFiles:              astParsedFiles,
			RegistryFallbackFiles:       registryFallbackFiles,
			SkippedFiles:                skippedFiles,
			DroppedTestEdges:            droppedTestEdges,
			UnresolvedImportCount:       unresolvedImportCount,
			SoftEdgeCount:               len(softEdges),
			AmbiguousSoftReferenceCount: ambiguousSoftRefs,
			UnresolvedCallSiteCount:     unresolvedCallSites,
			GrammarsUsed:                []string{},
		},
	}, bundleSnapshots, nil
}

// ToArtifact serializes the graph into the compact on-disk artifact structure.
func ToArtifact(graph *RepositorySemanticGraph, gitSha string) *SemanticGraphArtifact {
	artifactNodes := make([]SemanticGraphArtifactNode, len(graph.NodeList))
	for i, n := range graph.NodeList {
		artifactNodes[i] = SemanticGraphArtifactNode{
			Path:         n.Path,
			Language:     n.Language,
			InDegree:     n.InDegree,
			OutDegree:    n.OutDegree,
			PageRank:     n.PageRank,
			Role:         n.Role,
			IsBackbone:   n.IsBackbone,
			IsEntryPoint: n.IsEntryPoint,
		}
	}

	return &SemanticGraphArtifact{
		Version:           2,
		GeneratedAt:       time.Now().UTC().Format(time.RFC3339),
		GitSha:            gitSha,
		Nodes:             artifactNodes,
		EntryPoints:       graph.EntryPoints,
		BackboneNodes:     graph.BackboneNodes,
		CoreContractNodes: graph.CoreContractNodes,
		PipelineNodes:     graph.PipelineNodes,
		SymbolsByFile:     graph.SymbolsByFile,
		Edges:             graph.Edges,
		SoftEdges:         graph.SoftEdges,
		GoldenSymbols:     graph.GoldenSymbols,
		CallEdges:         graph.CallEdges,
		Meta:              graph.Meta,
	}
}

// BuildRepoSemanticGraph reads source files from the local archive directory,
// builds the semantic graph, and saves the artifact to {graphDir}/{owner}/{repo}/{sha}.json.
func BuildRepoSemanticGraph(
	ctx context.Context,
	archiveRoot string,
	graphDir string,
	owner string,
	repo string,
	sha string,
	defs *LanguageDefinitions,
	patterns Patterns,
	nodes []GitNode,
) (*SemanticGraphArtifact, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if defs == nil {
		return nil, fmt.Errorf("language definitions not loaded")
	}

	archiveDir := archive.ArchiveDirFor(archiveRoot, owner, repo, sha)
	maxBytes := defs.Config.MaxParseFileBytes
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}

	var sourceFiles []SourceFileInput
	for _, node := range nodes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if node.Type != "blob" {
			continue
		}
		if patterns != nil && (patterns.IsNonContentDir(node.Path) || patterns.IsNonContentFile(node.Path)) {
			continue
		}
		if defs.DetectLanguage(node.Path) == nil {
			continue
		}
		if node.Size > int64(maxBytes) {
			continue
		}
		fullPath := filepath.Join(archiveDir, filepath.FromSlash(node.Path))
		content, err := os.ReadFile(fullPath)
		if err != nil {
			continue
		}
		sourceFiles = append(sourceFiles, SourceFileInput{
			Path:    node.Path,
			Content: string(content),
		})
	}

	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if len(sourceFiles) == 0 {
		return nil, fmt.Errorf("no parseable source files in archive %s/%s@%s", owner, repo, sha)
	}

	// 冷启动预热：bundle 回填进程内 AST 缓存（哈希键保证只有未变文件命中；
	// 任一护栏不符静默回退全量解析）
	WarmAstCacheFromBundle(graphDir, owner, repo, sha)

	graph, snapshots, err := defs.buildSemanticGraphCollecting(ctx, sourceFiles)
	if err != nil {
		return nil, fmt.Errorf("build semantic graph: %w", err)
	}

	artifact := ToArtifact(graph, sha)
	_, err = SaveSemanticGraphArtifact(graphDir, owner, repo, sha, artifact)
	if err != nil {
		return nil, fmt.Errorf("save semantic graph artifact: %w", err)
	}
	// 提取快照随产物同址落盘（自清理旧 bundle，见 ast_bundle.go）
	SaveAstBundle(graphDir, owner, repo, sha, snapshots)

	return artifact, nil
}

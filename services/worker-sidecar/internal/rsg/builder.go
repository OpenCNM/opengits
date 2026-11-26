package rsg

import (
	"context"
	"fmt"
	"math"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
)

// Round-robin parse budget across top-level directories so lexicographically late subsystems are not starved.
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

func (d *LanguageDefinitions) BuildSemanticGraph(files []SourceFileInput) (*RepositorySemanticGraph, error) {
	g, _, err := d.buildSemanticGraphCollecting(context.Background(), files)
	return g, err
}

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
			composerFiles = append(composerFiles, f)
		}
	}

	psr4Aliases := ParsePsr4Aliases(composerFiles)
	tsAliases := ParseTsConfigAliases(composerFiles)

	basenameIdx := BuildBasenameIndex(allPaths)

	// Memoize pure import resolution across edge-building and binding passes to avoid repeated O(files) suffix scans.
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

	damping := d.Config.DampingFactor
	if damping == 0 {
		damping = 0.85
	}
	iters := d.Config.PagerankIterations
	if iters <= 0 {
		iters = 30
	}
	pageRankMap := ComputePageRank(allPaths, adjacencyMap, damping, iters)

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

	goFileInfos := make([]goFileMeta, 0)
	for _, fi := range fileInfos {
		if fi.lang != "go" {
			continue
		}
		meta := goFileMeta{
			path:   fi.path,
			isTest: fi.isTest,
		}
		if fi.ast != nil {
			meta.pkgName = fi.ast.PackageName
			meta.imports = fi.ast.Imports
			if len(fi.ast.MethodLines) > 0 {
				meta.methodLines = make(map[int]bool, len(fi.ast.MethodLines))
				for _, ln := range fi.ast.MethodLines {
					meta.methodLines[ln] = true
				}
			}
		}
		goFileInfos = append(goFileInfos, meta)
	}
	goPkgIdx := buildGoPkgIndex(sortedFiles, goFileInfos, resolveImport, d.Config.ExcludeTestsFromEdges)
	for _, fi := range fileInfos {
		if fi.lang != "go" || fi.ast == nil || len(fi.ast.CallSites) == 0 {
			continue
		}
		if d.Config.ExcludeTestsFromEdges && fi.isTest {
			continue
		}
		for _, cs := range fi.ast.CallSites {
			if !cs.IsSelector || cs.Qualifier == "" {
				continue
			}
			if targetFile, ok := goPkgIdx.resolveQualifiedCall(fi.path, cs.Qualifier, cs.Name, symbolsByFile); ok {
				if importedBindings[targetFile] == nil {
					importedBindings[targetFile] = make(map[string]map[string]bool)
				}
				if importedBindings[targetFile][cs.Name] == nil {
					importedBindings[targetFile][cs.Name] = make(map[string]bool)
				}
				importedBindings[targetFile][cs.Name][fi.path] = true
			}
		}
	}

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

			if callerFunc.Name == cs.Name && cs.Line == callerFunc.StartLine {
				continue
			}

			if fi.lang == "go" {
				if resolvedEdges, ok := goPkgIdx.resolveGoCallEdges(fi.path, callerFunc.Name, cs, sameFileSyms, symbolsByFile); ok {
					callEdges = append(callEdges, resolvedEdges...)
					continue
				}
				unresolvedCallSites++
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

	SaveAstBundle(graphDir, owner, repo, sha, snapshots)

	return artifact, nil
}

type goModEntry struct {
	rootDir    string
	modulePath string
}

type goFileMeta struct {
	path        string
	isTest      bool
	pkgName     string
	imports     []ImportRecord
	methodLines map[int]bool
}

type goPkgIndex struct {
	filesByDir        map[string][]string
	pkgNameByDir      map[string]string
	methodLinesByFile map[string]map[int]bool
	qualTargetsByFile map[string]map[string][]string
	dotTargetsByFile  map[string][][]string
	mods              []goModEntry
	inferredMods      []string
	dirOrder          []string
}

func buildGoPkgIndex(
	sortedFiles []SourceFileInput,
	goFiles []goFileMeta,
	resolveImport func(string, string) string,
	excludeTests bool,
) *goPkgIndex {
	idx := &goPkgIndex{
		filesByDir:        make(map[string][]string),
		pkgNameByDir:      make(map[string]string),
		methodLinesByFile: make(map[string]map[int]bool, len(goFiles)),
		qualTargetsByFile: make(map[string]map[string][]string, len(goFiles)),
		dotTargetsByFile:  make(map[string][][]string),
		mods:              parseGoModModules(sortedFiles),
	}
	if len(goFiles) == 0 {
		return idx
	}

	for _, gf := range goFiles {
		if len(gf.methodLines) > 0 {
			idx.methodLinesByFile[gf.path] = gf.methodLines
		}
		if gf.isTest {
			continue
		}
		dir := path.Dir(gf.path)
		idx.filesByDir[dir] = append(idx.filesByDir[dir], gf.path)
		if idx.pkgNameByDir[dir] == "" && gf.pkgName != "" && !strings.HasSuffix(gf.pkgName, "_test") {
			idx.pkgNameByDir[dir] = gf.pkgName
		}
	}
	for dir, list := range idx.filesByDir {
		sort.Strings(list)
		idx.filesByDir[dir] = list
		idx.dirOrder = append(idx.dirOrder, dir)
	}

	sort.Slice(idx.dirOrder, func(i, j int) bool {
		if len(idx.dirOrder[i]) != len(idx.dirOrder[j]) {
			return len(idx.dirOrder[i]) > len(idx.dirOrder[j])
		}
		return idx.dirOrder[i] < idx.dirOrder[j]
	})

	if len(idx.mods) == 0 {
		idx.inferredMods = inferGoModulePrefixes(goFiles, resolveImport)
	}

	for _, gf := range goFiles {
		if excludeTests && gf.isTest {
			continue
		}
		if len(gf.imports) == 0 {
			continue
		}
		qualMap := make(map[string][]string, len(gf.imports))
		for _, imp := range gf.imports {
			if imp.Module == "" || imp.Blank {
				continue
			}
			targetFiles, defaultPkg := idx.resolveImportFiles(imp.Module, gf.path)
			if len(targetFiles) == 0 {
				continue
			}
			if imp.Dot {
				idx.dotTargetsByFile[gf.path] = append(idx.dotTargetsByFile[gf.path], targetFiles)
			}
			if len(imp.Bindings) > 0 {
				for _, b := range imp.Bindings {
					if b != "" && b != "_" && b != "." {
						qualMap[b] = targetFiles
					}
				}
			} else if !imp.Dot && defaultPkg != "" {
				qualMap[defaultPkg] = targetFiles
			}
		}
		if len(qualMap) > 0 {
			idx.qualTargetsByFile[gf.path] = qualMap
		}
	}

	return idx
}

func parseGoModModules(files []SourceFileInput) []goModEntry {
	var mods []goModEntry
	for _, f := range files {
		if path.Base(f.Path) != "go.mod" || f.Content == "" {
			continue
		}
		root := path.Dir(f.Path)
		for _, line := range strings.Split(f.Content, "\n") {
			if idx := strings.Index(line, "//"); idx >= 0 {
				line = line[:idx]
			}
			fields := strings.Fields(line)
			if len(fields) >= 2 && fields[0] == "module" {
				modPath := strings.Trim(fields[1], `"'`+"`")
				if modPath != "" {
					mods = append(mods, goModEntry{rootDir: root, modulePath: modPath})
				}
				break
			}
		}
	}
	sort.Slice(mods, func(i, j int) bool {
		if len(mods[i].modulePath) != len(mods[j].modulePath) {
			return len(mods[i].modulePath) > len(mods[j].modulePath)
		}
		return mods[i].modulePath < mods[j].modulePath
	})
	return mods
}

func inferGoModulePrefixes(goFiles []goFileMeta, resolveImport func(string, string) string) []string {
	prefixSet := make(map[string]bool)
	for _, gf := range goFiles {
		for _, imp := range gf.imports {
			if imp.Module == "" || strings.HasPrefix(imp.Module, ".") {
				continue
			}
			t := resolveImport(imp.Module, gf.path)
			if t == "" || !strings.HasSuffix(t, ".go") {
				continue
			}
			dir := path.Dir(t)
			if dir == "." || !strings.Contains(dir, "/") {
				continue
			}
			if strings.HasSuffix(imp.Module, "/"+dir) {
				prefix := strings.TrimSuffix(imp.Module, "/"+dir)
				if prefix != "" {
					prefixSet[prefix] = true
				}
			}
		}
	}
	prefixes := make([]string, 0, len(prefixSet))
	for p := range prefixSet {
		prefixes = append(prefixes, p)
	}
	sort.Slice(prefixes, func(i, j int) bool {
		if len(prefixes[i]) != len(prefixes[j]) {
			return len(prefixes[i]) > len(prefixes[j])
		}
		return prefixes[i] < prefixes[j]
	})
	return prefixes
}

func (g *goPkgIndex) resolveImportFiles(impModule, currentPath string) ([]string, string) {
	if impModule == "" {
		return nil, ""
	}

	for _, m := range g.mods {
		var relDir string
		if impModule == m.modulePath {
			relDir = m.rootDir
		} else if strings.HasPrefix(impModule, m.modulePath+"/") {
			sub := strings.TrimPrefix(impModule, m.modulePath+"/")
			if m.rootDir == "." {
				relDir = sub
			} else {
				relDir = m.rootDir + "/" + sub
			}
		} else {
			continue
		}
		if files := g.filesByDir[relDir]; len(files) > 0 {
			return files, g.defaultPkgName(relDir, impModule)
		}
	}

	for _, prefix := range g.inferredMods {
		if strings.HasPrefix(impModule, prefix+"/") {
			relDir := strings.TrimPrefix(impModule, prefix+"/")
			if files := g.filesByDir[relDir]; len(files) > 0 {
				return files, g.defaultPkgName(relDir, impModule)
			}
		}
	}

	if strings.HasPrefix(impModule, ".") {
		relDir := path.Clean(path.Join(path.Dir(currentPath), impModule))
		if files := g.filesByDir[relDir]; len(files) > 0 {
			return files, g.defaultPkgName(relDir, impModule)
		}
	}

	if len(g.mods) == 0 && len(g.inferredMods) == 0 && strings.Contains(impModule, "/") {
		for _, dir := range g.dirOrder {
			if dir == "." {
				continue
			}
			if impModule == dir || strings.HasSuffix(impModule, "/"+dir) {
				return g.filesByDir[dir], g.defaultPkgName(dir, impModule)
			}
		}
	}

	return nil, ""
}

func (g *goPkgIndex) defaultPkgName(dir, impModule string) string {
	if name := g.pkgNameByDir[dir]; name != "" {
		return name
	}
	return path.Base(impModule)
}

func (g *goPkgIndex) resolveGoCallEdges(
	callerPath, callerSymbol string,
	cs CallSite,
	sameFileSyms map[string]bool,
	symbolsByFile map[string][]SymbolEntry,
) ([]CallEdge, bool) {
	if cs.IsSelector {
		if cs.Qualifier != "" {
			if targetFile, ok := g.resolveQualifiedCall(callerPath, cs.Qualifier, cs.Name, symbolsByFile); ok {
				return []CallEdge{{
					CallerFile:   callerPath,
					CallerSymbol: callerSymbol,
					CalleeFile:   targetFile,
					CalleeSymbol: cs.Name,
					Line:         cs.Line,
				}}, true
			}
			// Never fall back to same-file symbols when a qualifier explicitly targets an imported package.
			if g.qualTargetsByFile[callerPath][cs.Qualifier] != nil {
				return nil, false
			}
		}
		if sameFileSyms[cs.Name] {
			return []CallEdge{{
				CallerFile:   callerPath,
				CallerSymbol: callerSymbol,
				CalleeFile:   callerPath,
				CalleeSymbol: cs.Name,
				Line:         cs.Line,
			}}, true
		}
		return nil, false
	}

	if sameFileSyms[cs.Name] {
		return []CallEdge{{
			CallerFile:   callerPath,
			CallerSymbol: callerSymbol,
			CalleeFile:   callerPath,
			CalleeSymbol: cs.Name,
			Line:         cs.Line,
		}}, true
	}
	if targetFile, ok := g.resolveSamePkgOrDotCall(callerPath, cs.Name, symbolsByFile); ok {
		return []CallEdge{{
			CallerFile:   callerPath,
			CallerSymbol: callerSymbol,
			CalleeFile:   targetFile,
			CalleeSymbol: cs.Name,
			Line:         cs.Line,
		}}, true
	}
	return nil, false
}

func (g *goPkgIndex) resolveQualifiedCall(callerPath, qual, symName string, symbolsByFile map[string][]SymbolEntry) (string, bool) {
	qualMap := g.qualTargetsByFile[callerPath]
	if qualMap == nil {
		return "", false
	}
	targetFiles := qualMap[qual]
	if len(targetFiles) == 0 {
		return "", false
	}
	var matches []string
	for _, tf := range targetFiles {
		if tf == callerPath {
			continue
		}
		for _, ts := range symbolsByFile[tf] {
			if ts.Name == symName && ts.Exported && !g.isReceiverMethod(tf, ts) {
				matches = append(matches, tf)
				break
			}
		}
	}
	if len(matches) == 0 {
		return "", false
	}
	if len(matches) == 1 {
		return matches[0], true
	}
	return PickDeterministicCandidate(matches, callerPath), true
}

func (g *goPkgIndex) resolveSamePkgOrDotCall(callerPath, symName string, symbolsByFile map[string][]SymbolEntry) (string, bool) {
	dir := path.Dir(callerPath)
	var samePkgMatches []string
	for _, tf := range g.filesByDir[dir] {
		if tf == callerPath {
			continue
		}
		for _, ts := range symbolsByFile[tf] {
			if ts.Name == symName && !g.isReceiverMethod(tf, ts) {
				samePkgMatches = append(samePkgMatches, tf)
				break
			}
		}
	}
	if len(samePkgMatches) == 1 {
		return samePkgMatches[0], true
	}
	if len(samePkgMatches) > 1 {
		return PickDeterministicCandidate(samePkgMatches, callerPath), true
	}

	var dotMatches []string
	for _, targetFiles := range g.dotTargetsByFile[callerPath] {
		for _, tf := range targetFiles {
			if tf == callerPath {
				continue
			}
			for _, ts := range symbolsByFile[tf] {
				if ts.Name == symName && ts.Exported && !g.isReceiverMethod(tf, ts) {
					dotMatches = append(dotMatches, tf)
					break
				}
			}
		}
	}
	if len(dotMatches) == 1 {
		return dotMatches[0], true
	}
	if len(dotMatches) > 1 {
		return PickDeterministicCandidate(dotMatches, callerPath), true
	}
	return "", false
}

func (g *goPkgIndex) isReceiverMethod(filePath string, ts SymbolEntry) bool {
	if ts.Kind != "function" {
		return false
	}
	return g.methodLinesByFile[filePath][ts.StartLine]
}

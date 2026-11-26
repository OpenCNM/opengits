package pipelineb

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

type treeCandidate struct {
	path  string
	score int
}

func scoredTreeCandidates(entries []client.GitTreeEntry, patterns cognitive.Patterns, scope string) []treeCandidate {
	var candidates []treeCandidate
	for _, e := range entries {
		if e.Type != "blob" || e.Size <= 0 || e.Size > 1<<20 {
			continue
		}

		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		if scope != "" && !strings.HasPrefix(rel+"/", scope+"/") {
			continue
		}

		parts := strings.Split(rel, "/")
		isExcluded := false
		for i := 0; i < len(parts)-1; i++ {
			seg := parts[i]
			if seg == ".git" || seg == "node_modules" {
				isExcluded = true
				break
			}
			subDir := strings.Join(parts[:i+1], "/")
			if patterns != nil && patterns.IsNonContentDir(subDir) {
				isExcluded = true
				break
			}
		}
		if isExcluded {
			continue
		}

		if patterns != nil {
			if patterns.IsBinaryOrArchiveFile(rel) || patterns.IsNonContentFile(rel) {
				continue
			}
			if !patterns.IsCodeFile(rel) && !patterns.IsDocFile(rel) && !patterns.IsConfigFile(rel) && !isMainConfigFile(strings.ToLower(filepath.Base(rel))) {
				continue
			}
		}

		score := scoreTreeEntry(rel, patterns, scope)
		if score > 0 {
			candidates = append(candidates, treeCandidate{path: rel, score: score})
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].path < candidates[j].path
	})
	return candidates
}

func SelectCoreFilesFromTree(entries []client.GitTreeEntry, patterns cognitive.Patterns, maxFiles int, prefixScope ...string) []string {
	if maxFiles <= 0 {
		maxFiles = 5
	}
	if maxFiles > 8 {
		maxFiles = 8
	}

	var scope string
	if len(prefixScope) > 0 {
		scope = strings.Trim(filepath.ToSlash(prefixScope[0]), "/ ")
	}

	candidates := scoredTreeCandidates(entries, patterns, scope)

	limit := maxFiles
	if len(candidates) < limit {
		limit = len(candidates)
	}

	out := make([]string, 0, limit)
	for i := 0; i < limit; i++ {
		out = append(out, candidates[i].path)
	}
	return out
}

// Guarantees ceil(maxFiles/active) slots per non-auxiliary subsystem before filling remaining cap globally.
func SelectCoreFilesFromTreeSubsystemQuota(entries []client.GitTreeEntry, patterns cognitive.Patterns, maxFiles int, subsystems []SubsystemSpec, prefixScope ...string) []string {
	if len(subsystems) == 0 || maxFiles <= 0 {
		return SelectCoreFilesFromTree(entries, patterns, maxFiles, prefixScope...)
	}
	if maxFiles > 8 {
		maxFiles = 8
	}

	var scope string
	if len(prefixScope) > 0 {
		scope = strings.Trim(filepath.ToSlash(prefixScope[0]), "/ ")
	}

	candidates := scoredTreeCandidates(entries, patterns, scope)

	bySpec := make(map[string][]treeCandidate, len(subsystems))
	var rootCands []treeCandidate
	for _, c := range candidates {
		owner := longestMatchingPrefix(c.path, subsystemPrefixes(subsystems))
		if owner == "" {
			rootCands = append(rootCands, c)
			continue
		}
		bySpec[owner] = append(bySpec[owner], c)
	}

	var active []SubsystemSpec
	for _, s := range subsystems {
		if s.IsAuxiliary || len(bySpec[s.Prefix]) == 0 {
			continue
		}
		active = append(active, s)
	}
	if len(active) == 0 {
		return SelectCoreFilesFromTree(entries, patterns, maxFiles, prefixScope...)
	}

	perQuota := (maxFiles + len(active) - 1) / len(active)
	seen := make(map[string]bool, maxFiles)
	out := make([]string, 0, maxFiles)
	take := func(cands []treeCandidate, from int, n int) int {
		picked := 0
		for i := from; i < len(cands) && picked < n && len(out) < maxFiles; i++ {
			if seen[cands[i].path] {
				continue
			}
			seen[cands[i].path] = true
			out = append(out, cands[i].path)
			picked++
		}
		return from + picked
	}
	for _, s := range active {
		take(bySpec[s.Prefix], 0, perQuota)
	}
	if len(out) < maxFiles {
		take(rootCands, 0, maxFiles-len(out))
		for _, s := range active {
			if len(out) >= maxFiles {
				break
			}
			take(bySpec[s.Prefix], perQuota, maxFiles-len(out))
		}
	}
	return out
}

func FillSubsystemQuotaFiles(sampled []string, entries []client.GitTreeEntry, patterns cognitive.Patterns, subsystems []SubsystemSpec, prefixScope string, totalCap int, quota ...int) []string {
	if len(subsystems) == 0 || len(sampled) == 0 || totalCap <= 0 {
		return sampled
	}
	perQuota := 2
	if len(quota) > 0 && quota[0] > 0 {
		perQuota = quota[0]
	}

	scope := strings.Trim(filepath.ToSlash(prefixScope), "/ ")

	sampledSet := make(map[string]bool, len(sampled))
	for _, p := range sampled {
		sampledSet[p] = true
	}
	covered := make(map[string]bool, len(subsystems))
	for _, p := range sampled {
		owner := longestMatchingPrefix(p, subsystemPrefixes(subsystems))
		if owner != "" {
			covered[owner] = true
		}
	}

	byPrefix := make(map[string][]treeCandidate, len(subsystems))
	for _, c := range scoredTreeCandidates(entries, patterns, scope) {
		if owner := longestMatchingPrefix(c.path, subsystemPrefixes(subsystems)); owner != "" {
			byPrefix[owner] = append(byPrefix[owner], c)
		}
	}

	out := append([]string(nil), sampled...)
	for _, s := range subsystems {
		if len(out) >= totalCap {
			break
		}
		if s.IsAuxiliary || covered[s.Prefix] {
			continue
		}
		picked := 0
		for _, c := range byPrefix[s.Prefix] {
			if picked >= perQuota || len(out) >= totalCap {
				break
			}
			if sampledSet[c.path] {
				continue
			}
			sampledSet[c.path] = true
			out = append(out, c.path)
			picked++
		}
	}
	return out
}

func scoreTreeEntry(rel string, patterns cognitive.Patterns, prefixScope ...string) int {
	var scope string
	if len(prefixScope) > 0 {
		scope = strings.Trim(filepath.ToSlash(prefixScope[0]), "/ ")
	}
	relScoped := rel
	if scope != "" {
		relScoped = strings.TrimPrefix(rel, scope+"/")
	}

	base := filepath.Base(relScoped)
	lowerBase := strings.ToLower(base)
	depth := strings.Count(relScoped, "/")

	if depth == 0 {
		if lowerBase == "readme.md" || lowerBase == "readme" || lowerBase == "readme.rst" || lowerBase == "readme.txt" {
			return 100
		}
		if isMainConfigFile(lowerBase) {
			return 85
		}
		if strings.HasPrefix(lowerBase, "readme") {
			return 75
		}
		if isExplicitEntryPointLocal(relScoped) {
			return 70
		}
		if patterns != nil && patterns.IsConfigFile(rel) {
			return 50
		}
		if patterns != nil && patterns.IsDocFile(rel) {
			return 40
		}
	} else if depth == 1 {
		if isExplicitEntryPointLocal(relScoped) {
			return 65
		}
		if lowerBase == "readme.md" || lowerBase == "readme" || lowerBase == "readme.rst" {
			return 60
		}
		if isMainConfigFile(lowerBase) {
			return 55
		}
		if strings.HasPrefix(lowerBase, "readme") {
			return 45
		}
		if patterns != nil && patterns.IsConfigFile(rel) {
			return 40
		}
		if patterns != nil && patterns.IsDocFile(rel) {
			return 30
		}
	} else {
		if isExplicitEntryPointLocal(relScoped) {
			return 30
		}
		if lowerBase == "readme.md" || lowerBase == "readme" {
			return 25
		}
		if patterns != nil && patterns.IsConfigFile(rel) {
			return 20
		}
		if patterns != nil && patterns.IsDocFile(rel) {
			return 10
		}
	}

	if patterns != nil && patterns.IsCodeFile(rel) {
		return 5
	}
	return 0
}

func isMainConfigFile(lowerBase string) bool {
	return lowerBase == "package.json" ||
		lowerBase == "package-lock.json" ||
		lowerBase == "pnpm-workspace.yaml" ||
		lowerBase == "pnpm-lock.yaml" ||
		lowerBase == "yarn.lock" ||
		lowerBase == "bun.lockb" ||
		lowerBase == "turbo.json" ||
		lowerBase == "lerna.json" ||
		lowerBase == "tsconfig.json" ||
		lowerBase == "go.mod" ||
		lowerBase == "go.sum" ||
		lowerBase == "go.work" ||
		lowerBase == "cargo.toml" ||
		lowerBase == "cargo.lock" ||
		lowerBase == "cmakelists.txt" ||
		lowerBase == "makefile" ||
		lowerBase == "gnumakefile" ||
		lowerBase == "pyproject.toml" ||
		lowerBase == "requirements.txt" ||
		lowerBase == "setup.py" ||
		lowerBase == "setup.cfg" ||
		lowerBase == "pipfile" ||
		lowerBase == "pipfile.lock" ||
		lowerBase == "pom.xml" ||
		lowerBase == "build.gradle" ||
		lowerBase == "build.gradle.kts" ||
		lowerBase == "settings.gradle" ||
		lowerBase == "settings.gradle.kts" ||
		lowerBase == "pubspec.yaml" ||
		lowerBase == "pubspec.lock" ||
		lowerBase == "gemfile" ||
		lowerBase == "gemfile.lock" ||
		lowerBase == "composer.json" ||
		lowerBase == "composer.lock" ||
		lowerBase == "mix.exs" ||
		lowerBase == "package.swift" ||
		lowerBase == "build.zig" ||
		lowerBase == "dune-project" ||
		lowerBase == "gleam.toml"
}

func FilterContentEntries(entries []client.GitTreeEntry, patterns cognitive.Patterns, prefixScope ...string) []client.GitTreeEntry {
	var scope string
	if len(prefixScope) > 0 {
		scope = strings.Trim(filepath.ToSlash(prefixScope[0]), "/ ")
	}

	var contentEntries []client.GitTreeEntry
	for _, e := range entries {
		if e.Type != "blob" || e.Size <= 0 || e.Size > 1<<20 {
			continue
		}

		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		if scope != "" && !strings.HasPrefix(rel+"/", scope+"/") {
			continue
		}

		parts := strings.Split(rel, "/")
		isExcluded := false
		for i := 0; i < len(parts)-1; i++ {
			seg := parts[i]
			if seg == ".git" || seg == "node_modules" {
				isExcluded = true
				break
			}
			subDir := strings.Join(parts[:i+1], "/")
			if patterns != nil && patterns.IsNonContentDir(subDir) {
				isExcluded = true
				break
			}
		}
		if isExcluded {
			continue
		}

		if patterns != nil {
			if patterns.IsBinaryOrArchiveFile(rel) || patterns.IsNonContentFile(rel) {
				continue
			}
			if !patterns.IsCodeFile(rel) && !patterns.IsDocFile(rel) && !patterns.IsConfigFile(rel) && !isMainConfigFile(strings.ToLower(filepath.Base(rel))) {
				continue
			}
		}

		contentEntries = append(contentEntries, e)
	}

	sort.Slice(contentEntries, func(i, j int) bool {
		return contentEntries[i].Path < contentEntries[j].Path
	})
	return contentEntries
}

func BuildRepoMapFromTree(
	treeEntries []client.GitTreeEntry,
	coreFiles map[string]string,
	repoName string,
	prefixScope string,
	defs *rsg.LanguageDefinitions,
	patterns cognitive.Patterns,
	fileCap ...int,
) (*RepoMap, error) {
	contentEntries := FilterContentEntries(treeEntries, patterns, prefixScope)
	if len(contentEntries) == 0 {
		return nil, fmt.Errorf("empty repository: no content files found")
	}

	normalizedCoreFiles := make(map[string]string, len(coreFiles))
	for k, v := range coreFiles {
		normalizedCoreFiles[strings.TrimPrefix(filepath.ToSlash(k), "/")] = v
	}

	// Estimates LOC as size/32+1 for unextracted long-tail entries so full tree budgets remain bounded.
	fullTreeFiles := make([]FileMap, 0, len(contentEntries))
	for _, e := range contentEntries {
		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		loc := int(e.Size)/32 + 1
		if content, ok := normalizedCoreFiles[rel]; ok {
			loc = strings.Count(content, "\n") + 1
		}
		fullTreeFiles = append(fullTreeFiles, FileMap{
			Path:     rel,
			LOC:      loc,
			IsDoc:    patterns != nil && patterns.IsDocFile(rel),
			IsTest:   patterns != nil && patterns.IsTestFile(rel),
			IsConfig: patterns != nil && (patterns.IsConfigFile(rel) || isMainConfigFile(strings.ToLower(filepath.Base(rel)))),
		})
	}

	cap := MaxFilesInMap(fileCap...)
	m := &RepoMap{RepoName: repoName, Truncated: len(contentEntries) > cap}

	selectedEntries := contentEntries
	if m.Truncated {
		selectedEntries = spreadSelectTreeEntries(contentEntries, normalizedCoreFiles, cap, patterns, prefixScope)
	}

	extracted := make([]FileMap, 0, len(selectedEntries))
	fileAsts := make([]*rsg.FileAstExtraction, len(selectedEntries))

	for i, e := range selectedEntries {
		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		content, hasContent := normalizedCoreFiles[rel]
		loc := int(e.Size)/32 + 1
		if hasContent {
			loc = strings.Count(content, "\n") + 1
		}
		fm := FileMap{
			Path:     rel,
			LOC:      loc,
			IsDoc:    patterns != nil && patterns.IsDocFile(rel),
			IsTest:   patterns != nil && patterns.IsTestFile(rel),
			IsConfig: patterns != nil && (patterns.IsConfigFile(rel) || isMainConfigFile(strings.ToLower(filepath.Base(rel)))),
		}

		if hasContent && defs != nil {
			ext := defs.ExtractFileAst(content, rel)
			fileAsts[i] = ext
			if ext != nil {
				for _, s := range ext.Symbols {
					if s.Exported && len(fm.Exports) < MaxExportsPerFile {
						fm.Exports = append(fm.Exports, s.Name)
					}
				}
				fm.TopSymbols = collectFallbackTopSymbols(ext, len(fm.Exports) > 0)
				for _, imp := range ext.Imports {
					if len(fm.Imports) < MaxImportsPerFile {
						fm.Imports = append(fm.Imports, imp.Module)
					}
				}
			}
		}
		extracted = append(extracted, fm)
	}

	var edges [][2]string
	if defs != nil {
		exportOwner := map[string]string{}
		ambiguous := map[string]bool{}
		for i := range extracted {
			for _, e := range extracted[i].Exports {
				if prev, dup := exportOwner[e]; dup && prev != extracted[i].Path {
					ambiguous[e] = true
				} else if !dup {
					exportOwner[e] = extracted[i].Path
				}
			}
		}
		for i, e := range selectedEntries {
			ext := fileAsts[i]
			if ext == nil {
				continue
			}
			rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
			localNames := make(map[string]bool, len(ext.Symbols))
			for _, sym := range ext.Symbols {
				localNames[sym.Name] = true
			}
			for _, cs := range ext.CallSites {
				if ambiguous[cs.Name] || localNames[cs.Name] {
					continue
				}
				if owner, ok := exportOwner[cs.Name]; ok && owner != rel {
					edges = append(edges, [2]string{rel, owner})
					m.CallEdges = append(m.CallEdges, ASTCallEdge{
						Caller: rel,
						Callee: owner,
						Symbol: cs.Name,
					})
				}
			}
		}
		hot := ComputeHotnessPageRank(extracted, edges)
		for i := range extracted {
			extracted[i].Hotness = hot[extracted[i].Path]
		}
	}

	layers := ComputeTopologicalLayers(extracted, edges, patterns)
	for i := range extracted {
		extracted[i].Layer = layers[extracted[i].Path]
	}

	m.Files = extracted
	for _, fm := range extracted {
		m.TotalLOC += fm.LOC
	}

	var codeCandidates, docCandidates []cognitive.CandidateOutlineFile
	for _, f := range extracted {
		if f.IsDoc {
			docCandidates = append(docCandidates, cognitive.CandidateOutlineFile{Path: f.Path, IsDoc: true})
		} else if !f.IsTest && !f.IsConfig && (patterns == nil || patterns.IsCodeFile(f.Path)) {
			codeCandidates = append(codeCandidates, cognitive.CandidateOutlineFile{Path: f.Path, IsDoc: false})
		}
	}
	if len(codeCandidates) > 0 && len(codeCandidates) <= 3 {
		m.IsMicroRepo = true
		allNodes := make([]cluster.GitNode, 0, len(contentEntries))
		for _, e := range contentEntries {
			allNodes = append(allNodes, cluster.GitNode{Path: e.Path, Type: "blob", Size: e.Size})
		}
		fileReader := func(path string) ([]byte, error) {
			cleanPath := strings.TrimPrefix(filepath.ToSlash(path), "/")
			if c, ok := normalizedCoreFiles[cleanPath]; ok {
				return []byte(c), nil
			}
			return nil, os.ErrNotExist
		}
		m.Anchors = cognitive.ExtractSubFileAnchors(codeCandidates, docCandidates, allNodes, fileReader, defs, patterns)
	}

	extractedByPath := make(map[string]FileMap, len(extracted))
	for _, fm := range extracted {
		extractedByPath[fm.Path] = fm
	}
	for i := range fullTreeFiles {
		if fm, ok := extractedByPath[fullTreeFiles[i].Path]; ok {
			fullTreeFiles[i].Exports = fm.Exports
			fullTreeFiles[i].TopSymbols = fm.TopSymbols
			fullTreeFiles[i].Imports = fm.Imports
			fullTreeFiles[i].Hotness = fm.Hotness
			fullTreeFiles[i].Layer = fm.Layer
			fullTreeFiles[i].LOC = fm.LOC
		}
	}

	m.Tree = BuildRepoTree(fullTreeFiles, m.RepoName)
	m.EstTokens = mdpat.EstimateTokens(RenderMap(m))

	return m, nil
}

func topSegmentScoped(p, scope string) string {
	p = strings.TrimPrefix(filepath.ToSlash(p), "/")
	if scope != "" {
		p = strings.TrimPrefix(p, strings.Trim(filepath.ToSlash(scope), "/")+"/")
	}
	if idx := strings.Index(p, "/"); idx > 0 {
		return p[:idx]
	}
	return "(root)"
}

func spreadSelectTreeEntries(
	entries []client.GitTreeEntry,
	coreFiles map[string]string,
	cap int,
	patterns cognitive.Patterns,
	prefixScope ...string,
) []client.GitTreeEntry {
	var scope string
	if len(prefixScope) > 0 {
		scope = strings.Trim(filepath.ToSlash(prefixScope[0]), "/ ")
	}

	byTop := map[string][]client.GitTreeEntry{}
	var order []string
	for _, e := range entries {
		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		top := topSegmentScoped(rel, scope)
		if _, ok := byTop[top]; !ok {
			byTop[top] = nil
			order = append(order, top)
		}
		byTop[top] = append(byTop[top], e)
	}

	out := make([]client.GitTreeEntry, 0, cap)
	seen := map[string]bool{}

	for _, e := range entries {
		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		if _, ok := coreFiles[rel]; ok {
			out = append(out, e)
			seen[rel] = true
			if len(out) >= cap {
				return out
			}
		}
	}

	for _, e := range entries {
		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		relScoped := rel
		if scope != "" {
			relScoped = strings.TrimPrefix(rel, scope+"/")
		}
		if !seen[rel] && patterns != nil && patterns.IsDocFile(rel) && strings.Count(relScoped, "/") == 0 {
			out = append(out, e)
			seen[rel] = true
			if len(out) >= cap {
				return out
			}
		}
	}

	idx := 0
	for len(out) < cap {
		progressed := false
		for _, top := range order {
			list := byTop[top]
			if idx < len(list) {
				candidate := list[idx]
				rel := strings.TrimPrefix(filepath.ToSlash(candidate.Path), "/")
				if !seen[rel] {
					out = append(out, candidate)
					seen[rel] = true
					progressed = true
					if len(out) >= cap {
						return out
					}
				}
			}
		}
		if !progressed {
			break
		}
		idx++
	}

	return out
}

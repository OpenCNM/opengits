package pipelineb

import (
	"strconv"

	"hash/fnv"

	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
)

type MacroTopologyNode struct {
	ID          string   `json:"id"`
	Path        string   `json:"path"`
	Name        string   `json:"name"`
	Role        string   `json:"role,omitempty"`
	FileCount   int      `json:"fileCount"`
	LOC         int      `json:"loc"`
	Hotness     int      `json:"hotness"`
	TopExports  []string `json:"topExports,omitempty"`
	PrimaryLang string   `json:"primaryLang,omitempty"`
}

type MacroTopologyEdge struct {
	From    string   `json:"from"`
	To      string   `json:"to"`
	Weight  int      `json:"weight"`
	Symbols []string `json:"symbols,omitempty"`
	Label   string   `json:"label,omitempty"`
}

type MacroTopology struct {
	Scope      string              `json:"scope"`
	Scale      int                 `json:"scale"`
	Strategy   string              `json:"strategy"`
	Nodes      []MacroTopologyNode `json:"nodes"`
	Edges      []MacroTopologyEdge `json:"edges"`
	RawMermaid string              `json:"rawMermaid"`
	Mermaid    string              `json:"mermaid"`
	Summary    string              `json:"summary,omitempty"`
}

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

func buildMacroSystemTopology(m *RepoMap, topo *MacroTopology, patterns cognitive.Patterns) {
	if m == nil || m.Tree == nil {
		return
	}
	root := skipRootWrapper(m.Tree)

	var rootCodeFiles []FileMap
	for _, f := range root.Files {
		if !f.IsTest && !f.IsDoc && !f.IsConfig && patterns.IsCodeFile(f.Path) {
			rootCodeFiles = append(rootCodeFiles, f)
		}
	}

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

	if candidateCount >= 3 {
		topo.Strategy = "directory"
		buildDirectoryPartition(m, specs, rootCodeFiles, topo, fileToNodeId)
	} else {
		topo.Strategy = "topological_layer"
		buildTopologicalLayerPartition(m, topo, fileToNodeId)
	}

	aggregateMacroEdges(m, topo, fileToNodeId)
}

func buildDirectoryPartition(
	m *RepoMap,
	specs []SubsystemSpec,
	rootCodeFiles []FileMap,
	topo *MacroTopology,
	fileToNodeId map[string]string,
) {
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

	// Assign files by longest matching subsystem prefix so nested packages never fall into parent buckets.
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

	if len(interfaceFiles) == 0 && len(pipelineFiles) == 0 && len(foundationFiles) > 0 {
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

func buildSubsystemTopology(m *RepoMap, scope string, topo *MacroTopology, patterns cognitive.Patterns) {
	scope = strings.Trim(scope, "/ ")
	targetNode := findSubtreeNode(m.Tree, scope)
	if targetNode == nil {
		buildMacroSystemTopology(m, topo, patterns)
		return
	}

	topo.Strategy = "subsystem_components"
	fileToNodeId := make(map[string]string)

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

func aggregateMacroEdges(m *RepoMap, topo *MacroTopology, fileToNodeId map[string]string) {
	edgeMap := make(map[string]*MacroTopologyEdge)

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

func RenderDeterministicMermaidSkeleton(topo *MacroTopology) string {
	if topo == nil || len(topo.Nodes) == 0 {
		return "```mermaid\nflowchart TD\n  empty[\"Empty Architecture\"]\n```"
	}

	var sb strings.Builder
	sb.WriteString("```mermaid\nflowchart TD\n")

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

// Require segment boundary prefixes so "doc"/"test" never swallow "docker" or "testify-example".
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

// Append FNV-64a hash for non-ASCII names so distinct CJK subsystems never collide into one Mermaid node ID.
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

package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
)

const (
	conceptTaxonomyHeader = "🧠 Knowledge Graph Concepts (Tutorial Concept Map)"
	navTreeMaxItems       = 60
)

func renderListResources(repo RepoRow, docsCount int, targetVersion string) string {
	category := repo.Category
	if category == "" {
		category = "General"
	}
	if targetVersion == "" {
		targetVersion = repo.Branch
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Repository: %s/%s\n", repo.Owner, repo.Repo)
	fmt.Fprintf(&b, "- Category: %s\n", category)
	fmt.Fprintf(&b, "- Total Documents: %d\n", docsCount)
	fmt.Fprintf(&b, "- Target Version: %s\n", targetVersion)
	return b.String()
}

func (s *readService) runListResources(ctx context.Context, resolved *ResolvedRepo) readResult {
	target := deref(resolved.TargetVersionLabel)
	return readResult{Text: renderListResources(resolved.Repository, len(resolved.Documents), target)}
}

type outlineArgs struct {
	Repository *string `json:"repository"`
	Path       *string `json:"path"`
	Depth      *int    `json:"depth"` // Accepted for schema compatibility and ignored.
}

func extractMacroTopologySection(repo RepoRow) string {
	if len(repo.RepoProfile) == 0 {
		return ""
	}
	var profile map[string]json.RawMessage
	if err := json.Unmarshal(repo.RepoProfile, &profile); err != nil {
		return ""
	}

	var mermaidDiagram string
	type subItem struct {
		name      string
		fileCount int
		loc       int
		role      string
	}
	var subsystems []subItem

	if raw, ok := profile["macroTopologyMermaid"]; ok && len(raw) > 0 {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil && strings.TrimSpace(s) != "" {
			mermaidDiagram = strings.TrimSpace(s)
		}
	}

	if mermaidDiagram == "" {
		if raw, ok := profile["macroTopology"]; ok && len(raw) > 0 {
			var topo pipelineb.MacroTopology
			if err := json.Unmarshal(raw, &topo); err == nil {
				if strings.TrimSpace(topo.Mermaid) != "" {
					mermaidDiagram = strings.TrimSpace(topo.Mermaid)
				} else if strings.TrimSpace(topo.RawMermaid) != "" {
					mermaidDiagram = strings.TrimSpace(topo.RawMermaid)
				} else if len(topo.Nodes) > 0 {
					mermaidDiagram = pipelineb.RenderDeterministicMermaidSkeleton(&topo)
				}
				for _, n := range topo.Nodes {
					subsystems = append(subsystems, subItem{
						name:      n.Name,
						fileCount: n.FileCount,
						loc:       n.LOC,
						role:      n.Role,
					})
				}
			}
		}
	}

	if raw, ok := profile["codeClusters"]; ok && len(raw) > 0 {
		var clusters []codeClusterRow
		if err := json.Unmarshal(raw, &clusters); err == nil && len(clusters) > 0 {
			if mermaidDiagram == "" {
				topo := projectMacroTopologyFromClusters(clusters)
				if topo != nil {
					mermaidDiagram = pipelineb.RenderDeterministicMermaidSkeleton(topo)
				}
			}
			if len(subsystems) == 0 {
				for _, c := range clusters {
					if c.Title == "" {
						continue
					}
					role := "core"
					if c.Cognitive != nil && c.Cognitive.Phase != "" {
						role = classifyPhaseToRole(c.Cognitive.Phase)
					} else {
						role = inferRoleFromTitleOrDirs(c.Title, c.Directories)
					}
					subsystems = append(subsystems, subItem{
						name:      c.Title,
						fileCount: len(c.Files),
						role:      role,
					})
				}
			}
		}
	}

	if strings.TrimSpace(mermaidDiagram) == "" {
		return ""
	}

	var b strings.Builder
	b.WriteString("🏛️ Architecture Topology (C4 L1 System Context):\n\n")
	b.WriteString(mermaidDiagram)
	b.WriteString("\n")

	if len(subsystems) > 0 {
		b.WriteString("\n### Subsystems & Modules:\n")
		for _, sub := range subsystems {
			roleLabel := formatRoleLabel(sub.role)
			if sub.loc > 0 {
				fmt.Fprintf(&b, "- **%s** (%d files · %d LOC) [%s]\n", sub.name, sub.fileCount, sub.loc, roleLabel)
			} else {
				fmt.Fprintf(&b, "- **%s** (%d files) [%s]\n", sub.name, sub.fileCount, roleLabel)
			}
		}
	}

	return b.String()
}

func projectMacroTopologyFromClusters(clusters []codeClusterRow) *pipelineb.MacroTopology {
	if len(clusters) == 0 {
		return nil
	}
	topo := &pipelineb.MacroTopology{
		Scope:    "",
		Scale:    1,
		Strategy: "code_clusters",
	}

	lookup := make(map[string]string)
	for _, c := range clusters {
		if c.Title == "" {
			continue
		}
		nodeID := sanitizeMermaidNodeId(fmt.Sprintf("sub_%d_%s", c.TeachingOrder, c.Title))
		role := "core"
		if c.Cognitive != nil && c.Cognitive.Phase != "" {
			role = classifyPhaseToRole(c.Cognitive.Phase)
		} else {
			role = inferRoleFromTitleOrDirs(c.Title, c.Directories)
		}
		var topExports []string
		if c.Cognitive != nil && len(c.Cognitive.GoldenSymbols) > 0 {
			for _, sym := range c.Cognitive.GoldenSymbols {
				if sym.Name != "" {
					topExports = append(topExports, sym.Name)
					if len(topExports) >= 4 {
						break
					}
				}
			}
		}
		topo.Nodes = append(topo.Nodes, pipelineb.MacroTopologyNode{
			ID:         nodeID,
			Path:       fmt.Sprintf("chapters/%02d", c.TeachingOrder),
			Name:       c.Title,
			Role:       role,
			FileCount:  len(c.Files),
			TopExports: topExports,
		})
		lookup[strings.ToLower(c.Title)] = nodeID
		lookup[strings.ToLower(sanitizeMermaidNodeId(c.Title))] = nodeID
		lookup[fmt.Sprintf("ch%d", c.TeachingOrder)] = nodeID
		lookup[fmt.Sprintf("ch%02d", c.TeachingOrder)] = nodeID
		lookup[fmt.Sprintf("chapter %d", c.TeachingOrder)] = nodeID
		for _, dir := range c.Directories {
			cleanDir := strings.ToLower(strings.Trim(dir, "/"))
			lookup[cleanDir] = nodeID
			lookup[strings.ToLower(filepath.Base(cleanDir))] = nodeID
		}
	}

	seenEdges := make(map[string]bool)
	for _, c := range clusters {
		currID := sanitizeMermaidNodeId(fmt.Sprintf("sub_%d_%s", c.TeachingOrder, c.Title))
		if c.Cognitive == nil {
			continue
		}
		for _, up := range c.Cognitive.UpstreamModules {
			cleanUp := strings.ToLower(strings.Trim(strings.TrimSpace(up), "/"))
			fromID, ok := lookup[cleanUp]
			if !ok {
				fromID, ok = lookup[strings.ToLower(filepath.Base(cleanUp))]
			}
			if ok && fromID != currID {
				key := fromID + "->" + currID
				if !seenEdges[key] {
					seenEdges[key] = true
					topo.Edges = append(topo.Edges, pipelineb.MacroTopologyEdge{
						From:   fromID,
						To:     currID,
						Weight: 2,
						Label:  "depends on",
					})
				}
			}
		}
	}

	return topo
}

func sanitizeMermaidNodeId(s string) string {
	var sb strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
			sb.WriteRune(r)
		} else {
			sb.WriteRune('_')
		}
	}
	res := strings.Trim(sb.String(), "_")
	if res == "" || (res[0] >= '0' && res[0] <= '9') {
		res = "n_" + res
	}
	return res
}

func classifyPhaseToRole(phase string) string {
	p := strings.ToLower(strings.TrimSpace(phase))
	switch {
	case strings.Contains(p, "perception") || strings.Contains(p, "foundation") || strings.Contains(p, "infra") || strings.Contains(p, "storage"):
		return "infra"
	case strings.Contains(p, "interface") || strings.Contains(p, "entry") || strings.Contains(p, "pipeline") || strings.Contains(p, "api"):
		return "interface"
	case strings.Contains(p, "extension") || strings.Contains(p, "adapter") || strings.Contains(p, "util"):
		return "utility"
	default:
		return "core"
	}
}

func formatRoleLabel(role string) string {
	switch strings.ToLower(role) {
	case "interface":
		return "Interface & Delivery"
	case "infra":
		return "Infrastructure & Storage"
	case "utility":
		return "Utilities & Adapters"
	default:
		return "Core Logic"
	}
}

func inferRoleFromTitleOrDirs(title string, dirs []string) string {
	combined := strings.ToLower(title)
	for _, d := range dirs {
		combined += " " + strings.ToLower(d)
	}
	switch {
	case strings.Contains(combined, "api") || strings.Contains(combined, "server") || strings.Contains(combined, "cmd") || strings.Contains(combined, "cli"):
		return "interface"
	case strings.Contains(combined, "store") || strings.Contains(combined, "db") || strings.Contains(combined, "model") || strings.Contains(combined, "data"):
		return "infra"
	case strings.Contains(combined, "util") || strings.Contains(combined, "common") || strings.Contains(combined, "helper"):
		return "utility"
	default:
		return "core"
	}
}

func RenderOutlineFromResolved(repo RepoRow, docs []DocMeta, taxonomy []taxonomyItem) string {
	var b strings.Builder
	hasMacroTopo := false
	if topoSection := extractMacroTopologySection(repo); topoSection != "" {
		b.WriteString(topoSection)
		b.WriteString("\n---\n\n")
		hasMacroTopo = true
	}
	fmt.Fprintf(&b, "Available Documentation in %s/%s:\n\n", repo.Owner, repo.Repo)

	navIsArray := len(repo.NavTree) > 0 && strings.HasPrefix(strings.TrimSpace(string(repo.NavTree)), "[")
	if navIsArray {
		navState := formatNavTree(repo.NavTree, "", navTreeMaxItems)
		b.WriteString(navState.text.String())
	} else {
		limit := len(docs)
		if limit > navTreeMaxItems {
			limit = navTreeMaxItems
		}
		for _, doc := range docs[:limit] {
			title := doc.Title
			if title == "" {
				title = doc.Path
			}
			fmt.Fprintf(&b, "- %s (%s)\n", title, doc.Path)
		}
		if len(docs) > navTreeMaxItems {
			fmt.Fprintf(&b, "... [%d more documents; use search to find specific topics]\n", len(docs)-navTreeMaxItems)
		}
	}

	if len(taxonomy) > 0 {
		b.WriteString("\n---\n\n")
		b.WriteString(formatConceptTaxonomyGrouped(taxonomy))
	}
	if hasMacroTopo {
		b.WriteString("\n(Next steps: use explore_concept with action=\"architecture\" to drill down into subsystem architecture diagrams, outline with \"path\" to inspect document headings, search to find keywords, or read with \"target\" to read content.)")
	} else {
		b.WriteString("\n(Next steps: use outline with \"path\" to inspect document headings, search to find keywords, or read with \"target\" to read content.)")
	}
	return b.String()
}

func (s *readService) runOutline(ctx context.Context, resolved *ResolvedRepo, userID, clientName, path string) readResult {
	startTime := time.Now()
	repo := resolved.Repository

	if path != "" {
		return s.runOutlineDocMode(ctx, resolved, userID, clientName, path, startTime)
	}

	if s.store != nil {
		if outlineInfo, _ := s.store.GetActiveOutline(ctx, repo.ID); outlineInfo != nil && len(outlineInfo.NavTree) > 0 {
			repo.NavTree = outlineInfo.NavTree
		}
	}

	taxonomy := s.buildConceptTaxonomy(ctx, repo.ID)
	text := RenderOutlineFromResolved(repo, resolved.Documents, taxonomy)

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "outline", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "documents", Status: telemetryStatus(len(resolved.Documents)),
		ResultCount: len(resolved.Documents), ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: text}
}

func (s *readService) runOutlineDocMode(ctx context.Context, resolved *ResolvedRepo, userID, clientName, path string, startTime time.Time) readResult {
	repo := resolved.Repository
	doc := findDocInContext(resolved.Documents, path)
	if doc == nil {
		return readResult{Text: fmt.Sprintf("Document not found: %q in %s/%s. Call outline without \"path\" to see available documents.", path, repo.Owner, repo.Repo), IsError: true}
	}

	chunks, _ := s.store.ListChunkHeadings(ctx, doc.ID, 100)

	title := doc.Title
	if title == "" {
		title = doc.Path
	}
	var b strings.Builder
	fmt.Fprintf(&b, "📄 %s\nPath: %s\n", title, doc.Path)
	if doc.Summary != nil && *doc.Summary != "" {
		fmt.Fprintf(&b, "Summary: %s\n", *doc.Summary)
	}
	b.WriteString("\n## Internal Headings (TOC)\n")

	if len(chunks) == 0 {
		fmt.Fprintf(&b, "(No internal heading chunks available. Use read with target=%q to read the full page.)\n", doc.Path)
	} else {
		seen := map[string]bool{}
		for _, c := range chunks {
			heading := deref(c.Heading)
			if heading == "" {
				heading = "(Untitled Section)"
			}
			key := heading + "::" + deref(c.HeadingPath)
			if seen[key] {
				continue
			}
			seen[key] = true
			depth := 0
			if hp := deref(c.HeadingPath); hp != "" {
				depth = strings.Count(hp, " > ")
			}
			typeLabel := ""
			if ct := deref(c.ContentType); ct != "" && ct != "prose" {
				typeLabel = " [" + ct + "]"
			}
			address := deref(c.HeadingPath)
			if address == "" {
				address = heading
			}
			fmt.Fprintf(&b, "%s- %s%s [Address: %s#%s]\n", strings.Repeat("  ", depth), heading, typeLabel, doc.Path, address)
		}
	}

	concepts, _ := s.store.ListDocConcepts(ctx, repo.ID, doc.ID, 20)
	if len(concepts) > 0 {
		fmt.Fprintf(&b, "\n## %s\n", conceptTaxonomyHeader)
		for _, c := range concepts {
			line := fmt.Sprintf("- %s (%s)", c.ConceptName, c.Category)
			if c.DocumentPath != nil && *c.DocumentPath != "" {
				line += fmt.Sprintf(" — %s", *c.DocumentPath)
				if c.HeadingPath != nil && *c.HeadingPath != "" {
					line += fmt.Sprintf(" [Address: %s]", buildCleanSectionAddress(*c.DocumentPath, *c.HeadingPath))
				}
			}
			b.WriteString(line + "\n")
		}
	}

	fmt.Fprintf(&b, "\n(Use read with target=%q for the whole document, or target=\"<Address>\" to read a specific section)", doc.Path)

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "outline", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "documents", Status: telemetryStatus(len(chunks)),
		ResultCount: len(chunks), ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: b.String()}
}

func telemetryStatus(resultCount int) string {
	if resultCount == 0 {
		return "BLIND_SPOT"
	}
	return "SUCCESS"
}

func buildSectionAddress(docPath, headingPath string) string {
	return docPath + "#" + strings.TrimSpace(headingPath)
}

func buildCleanSectionAddress(docPath, headingPath string) string {
	key := strings.TrimSpace(headingPath)
	if key == "" {
		return buildSectionAddress(docPath, key)
	}
	prefix := docPath + "#"
	if strings.HasPrefix(key, prefix) {
		key = strings.TrimSpace(key[len(prefix):])
	}
	return buildSectionAddress(docPath, key)
}

type navFormatState struct {
	text  strings.Builder
	count int
	max   int
}

func formatNavTree(navTree []byte, indent string, maxItems int) navFormatState {

	type rawNavNode struct {
		Type     string       `json:"type"`
		Title    string       `json:"title"`
		Path     string       `json:"path"`
		Children []rawNavNode `json:"children"`
	}
	var nodes []rawNavNode
	if err := jsonUnmarshalStrict(navTree, &nodes); err != nil {
		return navFormatState{max: maxItems}
	}
	st := navFormatState{max: maxItems}
	var walk func(nodes []rawNavNode, indent string)
	walk = func(nodes []rawNavNode, indent string) {
		for i := range nodes {
			if st.count >= maxItems {
				return
			}
			node := nodes[i]
			st.count++
			if node.Type == "directory" {
				fmt.Fprintf(&st.text, "%s📁 %s\n", indent, node.Title)
				if len(node.Children) > 0 && st.count < maxItems {
					walk(node.Children, indent+"  ")
				}
			} else {
				fmt.Fprintf(&st.text, "%s📄 %s (%s)\n", indent, node.Title, node.Path)
			}
		}
	}
	walk(nodes, indent)
	if st.count >= maxItems {
		fmt.Fprintf(&st.text, "%s... [More documents available; pass \"path\" to inspect specific document headings or use search]\n", indent)
	}
	return st
}

type taxonomyItem struct {
	conceptName    string
	category       string
	slug           string
	docPath        string
	address        string
	depth          int
	mergedVariants int
}

func (s *readService) buildConceptTaxonomy(ctx context.Context, repositoryID string) []taxonomyItem {
	return buildConceptTaxonomy(ctx, s.store, repositoryID)
}

func buildConceptTaxonomy(ctx context.Context, store ReadStore, repositoryID string) []taxonomyItem {
	if store == nil {
		return nil
	}
	nodes, _ := store.TaxonomyNodes(ctx, repositoryID, 80)
	if len(nodes) == 0 {
		return nil
	}
	edges, _ := store.PrereqEdges(ctx, repositoryID)

	depths := map[string]int{}
	for round := 0; round < 4; round++ {
		changed := false
		for _, e := range edges {
			if depths[e.SourceID] < depths[e.TargetID]+1 {
				depths[e.SourceID] = depths[e.TargetID] + 1
				changed = true
			}
		}
		if !changed {
			break
		}
	}

	type group struct {
		rep   TaxonomyNode
		count int
	}
	groups := map[string]*group{}
	var order []string
	for i := range nodes {
		n := nodes[i]
		key := "raw:" + n.ID
		if n.CanonicalKey != nil && *n.CanonicalKey != "" {
			key = *n.CanonicalKey
		}
		g, ok := groups[key]
		if !ok {
			groups[key] = &group{rep: n, count: 1}
			order = append(order, key)
			continue
		}
		g.count++
		if n.CanonicalName != nil && *n.CanonicalName != "" && n.ConceptName == *n.CanonicalName {
			g.rep = n
		}
	}

	var out []taxonomyItem
	for _, key := range order {
		g := groups[key]
		item := taxonomyItem{
			conceptName:    g.rep.ConceptName,
			category:       g.rep.Category,
			docPath:        deref(g.rep.DocumentPath),
			depth:          depths[g.rep.ID],
			mergedVariants: g.count,
		}
		if hp := deref(g.rep.HeadingPath); item.docPath != "" && hp != "" {
			item.address = buildCleanSectionAddress(item.docPath, hp)
		}
		out = append(out, item)
		if len(out) >= 20 {
			break
		}
	}
	return out
}

func formatConceptTaxonomyGrouped(items []taxonomyItem) string {
	byCategory := map[string][]taxonomyItem{}
	var cats []string
	for _, it := range items {
		if _, ok := byCategory[it.category]; !ok {
			cats = append(cats, it.category)
		}
		byCategory[it.category] = append(byCategory[it.category], it)
	}
	sort.SliceStable(cats, func(i, j int) bool {
		return len(byCategory[cats[i]]) > len(byCategory[cats[j]])
	})

	var b strings.Builder
	fmt.Fprintf(&b, "## %s\n\n", conceptTaxonomyHeader)
	for _, cat := range cats {
		group := byCategory[cat]
		sort.SliceStable(group, func(i, j int) bool {
			if group[i].depth != group[j].depth {
				return group[i].depth > group[j].depth
			}
			return group[i].conceptName < group[j].conceptName
		})
		fmt.Fprintf(&b, "### 🗂️ %s (%d)\n", cat, len(group))
		for _, it := range group {
			indent := ""
			if it.depth > 0 {
				indent = strings.Repeat("  ", minInt(it.depth, 3))
			}
			label := it.conceptName
			if it.depth > 0 {
				label = fmt.Sprintf("%s [前置×%d]", it.conceptName, it.depth)
			}
			if it.mergedVariants > 1 {
				label += fmt.Sprintf(" ×%d 处同义", it.mergedVariants)
			}
			if it.docPath != "" {
				label += " — " + it.docPath
			}
			if it.address != "" {
				label += fmt.Sprintf(" [Address: %s]", it.address)
			}
			b.WriteString(indent + "- " + label + "\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("(Use explore_concept (concept: \"<name>\") to dive into any concept above, or read with its Address for the source section.)")
	return b.String()
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func jsonUnmarshalStrict(data []byte, v any) error {
	return json.Unmarshal(data, v)
}

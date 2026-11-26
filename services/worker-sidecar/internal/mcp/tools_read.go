package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const mcpDocFullMaxChars = 16000

func capFullDocText(text string) string {
	if utf8.RuneCountInString(text) <= mcpDocFullMaxChars {
		return text
	}
	runes := []rune(text)
	return string(runes[:mcpDocFullMaxChars]) + "\n\n---\n\n... [Truncated for context limit. Use outline for the table of contents, or pass target with an Address (path#heading) to read a specific section.]"
}

const readMissingTargetMsg = `Error: "target" is required. Pass a document path (e.g. "README.md") or section address (e.g. "README.md#Usage"). Use outline to see available documents.`

func readDocNotFoundMsg(docPath, owner, repo string) string {
	return fmt.Sprintf("Error: Document %q not found in %s/%s. Call outline to view valid document paths.", docPath, owner, repo)
}

func readNoContentMsg(docPath string) string {
	return fmt.Sprintf("Error: Document %q has no readable content.", docPath)
}

const tokenTruncateSuffix = DefaultTruncateSuffix

func estimateTokens(text string) int {
	return EstimateTokens(text)
}

func truncateToTokenBudget(text string, maxTokens int) string {
	return TruncateWithSuffix(text, maxTokens, tokenTruncateSuffix)
}

const (
	maxNeighborShow  = 12
	maxCoLocatedShow = 4
	coLocatedWeight  = 0.5
)

type neighborItem struct {
	conceptID     string
	conceptName   string
	canonicalKey  *string
	canonicalName string
	category      string
	docPath       string
	address       string
	relationType  string
	direction     string
	weight        float64
	source        string
}

func neighborRelationTag(relationType, direction string) string {
	switch relationType {
	case "prerequisite":
		if direction == "outgoing" {
			return "⇢[后学]"
		}
		return "⇠[前置]"
	case "successor":
		if direction == "outgoing" {
			return "⇢[后继]"
		}
		return "⇠[先学]"
	case "part_of":
		if direction == "outgoing" {
			return "⇢[含部分]"
		}
		return "⇠[组成部分]"
	case "co_located":
		return "⇋[同篇]"
	default:
		return "⇋[相关]"
	}
}

func sourceScore(src string) int {
	switch src {
	case "code_dep":
		return 3
	case "curriculum_order", "manual":
		return 2
	case "cooccurrence":
		return 0
	default:
		return 1
	}
}

func (s *readService) buildGraphPositionText(ctx context.Context, repositoryID, documentID, headingPath string) string {
	concept, err := s.store.FindConceptForDoc(ctx, repositoryID, documentID, &headingPath)
	if err != nil || concept == nil {
		return ""
	}
	neighbors := s.getConceptNeighbors(ctx, repositoryID, concept.ID)
	if len(neighbors) == 0 {
		return ""
	}
	var tagged []string
	for i, n := range neighbors {
		if i >= 4 {
			break
		}
		tagged = append(tagged, neighborRelationTag(n.relationType, n.direction)+n.conceptName)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "🧭 图位置 (Graph Position): 本节属于「%s」(%s)\n", concept.ConceptName, concept.Category)
	b.WriteString("- 直接邻居: ")
	b.WriteString(strings.Join(tagged, "、"))
	b.WriteString(" (⇠=我依赖它 ⇢=它依赖我 ⇋=无向关联)")
	b.WriteString("\n\n")
	return b.String()
}

func (s *readService) getConceptNeighbors(ctx context.Context, repositoryID, conceptID string) []neighborItem {
	memberIDs, _ := s.store.CanonicalMemberIDs(ctx, repositoryID, conceptID)
	memberSet := make(map[string]bool, len(memberIDs))
	for _, id := range memberIDs {
		memberSet[id] = true
	}

	edges, _ := s.store.EdgesTouching(ctx, repositoryID, memberIDs)

	type rel struct {
		direction string
		typ       string
		source    string
		weight    float64
	}
	byID := map[string][]rel{}
	for _, e := range edges {
		sourceIn := memberSet[e.SourceID]
		targetIn := memberSet[e.TargetID]
		switch {
		case sourceIn && targetIn:
			continue
		case targetIn:
			byID[e.SourceID] = append(byID[e.SourceID], rel{"incoming", e.Type, e.Source, e.Weight})
		case sourceIn:
			byID[e.TargetID] = append(byID[e.TargetID], rel{"outgoing", e.Type, e.Source, e.Weight})
		}
	}

	var neighborIDs []string
	for id := range byID {
		neighborIDs = append(neighborIDs, id)
	}
	if len(neighborIDs) == 0 {
		return nil
	}

	nodes, _ := s.store.NodesByIDs(ctx, repositoryID, neighborIDs)
	nodeByID := make(map[string]ConceptNodeLite, len(nodes))
	for _, n := range nodes {
		nodeByID[n.ID] = n
	}

	var edgeNeighbors []neighborItem
	for _, id := range neighborIDs {
		node, ok := nodeByID[id]
		if !ok {
			continue
		}
		rels := byID[id]
		if len(rels) == 0 {
			continue
		}

		best := rels[0]
		for _, r := range rels[1:] {
			if r.weight > best.weight {
				best = r
			}
		}
		item := neighborItem{
			conceptID: id, conceptName: node.ConceptName, canonicalKey: node.CanonicalKey,
			canonicalName: deref(node.CanonicalName),
			category:      node.Category, docPath: deref(node.DocumentPath),
			relationType: best.typ, direction: best.direction, weight: best.weight, source: best.source,
		}
		if item.docPath != "" && deref(node.HeadingPath) != "" {
			item.address = buildCleanSectionAddress(item.docPath, deref(node.HeadingPath))
		}
		edgeNeighbors = append(edgeNeighbors, item)
	}

	// Pre-sort by conceptID before comparator sorting because Go map iteration order is non-deterministic.
	sort.Slice(edgeNeighbors, func(i, j int) bool {
		si, sj := sourceScore(edgeNeighbors[i].source), sourceScore(edgeNeighbors[j].source)
		if si != sj {
			return si > sj
		}
		if edgeNeighbors[i].weight != edgeNeighbors[j].weight {
			return edgeNeighbors[i].weight > edgeNeighbors[j].weight
		}
		return edgeNeighbors[i].conceptID < edgeNeighbors[j].conceptID
	})

	var deduped []neighborItem
	seenKeys := map[string]bool{}
	for _, n := range edgeNeighbors {
		if n.canonicalKey == nil {
			deduped = append(deduped, n)
			continue
		}
		if seenKeys[*n.canonicalKey] {
			continue
		}
		seenKeys[*n.canonicalKey] = true
		deduped = append(deduped, n)
	}
	if len(deduped) > maxNeighborShow {
		deduped = deduped[:maxNeighborShow]
	}

	var coLocated []neighborItem
	if docID, _ := s.store.GetConceptDocumentID(ctx, repositoryID, conceptID); docID != nil {
		var excludeIDs []string
		excludeIDs = append(excludeIDs, memberIDs...)
		for _, n := range deduped {
			excludeIDs = append(excludeIDs, n.conceptID)
		}
		nodes, _ := s.store.CoLocatedNodes(ctx, repositoryID, *docID, excludeIDs, maxCoLocatedShow*3)
		shownKeys := map[string]bool{}
		for _, n := range deduped {
			if n.canonicalKey != nil {
				shownKeys[*n.canonicalKey] = true
			}
		}
		for _, node := range nodes {
			if node.CanonicalKey != nil && shownKeys[*node.CanonicalKey] {
				continue
			}
			clItem := neighborItem{
				conceptID: node.ID, conceptName: node.ConceptName, canonicalKey: node.CanonicalKey,
				canonicalName: deref(node.CanonicalName),
				category:      node.Category, docPath: deref(node.DocumentPath),
				relationType: "co_located", direction: "undirected", weight: coLocatedWeight, source: "cooccurrence",
			}
			if clItem.docPath != "" && deref(node.HeadingPath) != "" {
				clItem.address = buildCleanSectionAddress(clItem.docPath, deref(node.HeadingPath))
			}
			coLocated = append(coLocated, clItem)
			if len(coLocated) >= maxCoLocatedShow {
				break
			}
		}
	}
	return append(deduped, coLocated...)
}

type readService struct {
	store            ReadStore
	policyCache      *ttlCache
	workerSidecarURL string
	internalToken    string
}

func newReadService(store ReadStore) *readService {
	return &readService{store: store, policyCache: newTTLCache(60*time.Second, 16)}
}

func newReadServiceWithConfig(store ReadStore, cfg Config) *readService {
	rs := newReadService(store)
	rs.workerSidecarURL = strings.TrimRight(strings.TrimSpace(cfg.WorkerSidecarURL), "/")
	rs.internalToken = cfg.InternalToken
	return rs
}

func (s *readService) toolEnabled(ctx context.Context, toolName string, quota UserQuota) bool {
	policies := s.policyMap(ctx)
	policy, ok := policies[toolName]
	if !ok {
		return true
	}
	if !policy.IsEnabled {
		return false
	}
	return meetsTierRequirement(quota.Tier, quota.Role, policy.TierRequirement)
}

func (s *readService) readPolicyTokenBudget(ctx context.Context, toolName string) int {
	policies := s.policyMap(ctx)
	if policy, ok := policies[toolName]; ok {
		return policy.TokenBudget
	}
	return 0
}

func (s *readService) policyMap(ctx context.Context) map[string]ToolPolicy {
	v, err := s.policyCache.getOrLoad("global", func() (any, error) {
		return s.store.ToolPolicyMap(ctx)
	})
	if err != nil {
		return nil
	}
	policies, _ := v.(map[string]ToolPolicy)
	return policies
}

func meetsTierRequirement(userTier, userRole, requiredTier string) bool {
	if userRole == "ADMIN" || userRole == "SUPER_ADMIN" {
		return true
	}
	tierRank := map[string]int{"FREE": 0, "PRO": 1, "ENTERPRISE": 2}
	req, ok := tierRank[requiredTier]
	if !ok {
		return true
	}
	user, ok := tierRank[userTier]
	if !ok {
		user = 0
	}
	return user >= req
}

type readResult struct {
	Text    string
	IsError bool
}

func (s *readService) runRead(ctx context.Context, resolved *ResolvedRepo, userID, clientName, target, aspect string, quota UserQuota) readResult {
	startTime := time.Now()
	repo := resolved.Repository

	rawTarget := trimSpace(target)
	if rawTarget == "" {
		return readResult{Text: readMissingTargetMsg, IsError: true}
	}

	docPath, headingPath := parseSectionAddress(rawTarget)
	doc := findDocInContext(resolved.Documents, docPath)
	if doc == nil {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "read", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: "documents", Status: "BLIND_SPOT", ResultCount: 0,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{Text: readDocNotFoundMsg(docPath, repo.Owner, repo.Repo), IsError: true}
	}

	isWeb := isWebDocRepository(repo)
	var profile map[string]any
	if len(repo.RepoProfile) > 0 {
		_ = json.Unmarshal(repo.RepoProfile, &profile)
	}
	originalURL, _ := profile["originalUrl"].(string)
	liveURL := ""
	if isWeb {
		liveURL = resolveDocLiveURL(repo.NavTree, doc.Path, originalURL)
	}
	liveURLLine := ""
	if liveURL != "" {
		liveURLLine = "Live URL: " + liveURL + "\n"
	}

	title := doc.Title
	if title == "" {
		title = doc.Path
	}

	if headingPath != "" {
		chunks, _ := s.store.ListChunksByDoc(ctx, doc.ID)

		var targetChunk *Chunk
		var exactMatches []Chunk
		for _, c := range chunks {
			if deref(c.HeadingPath) == headingPath || deref(c.Heading) == headingPath {
				exactMatches = append(exactMatches, c)
			}
		}
		if len(exactMatches) > 0 {
			targetChunk = &exactMatches[0]
			for i := range exactMatches {
				if exactMatches[i].SemVerLabel != nil && resolved.TargetVersionLabel != nil &&
					*exactMatches[i].SemVerLabel == *resolved.TargetVersionLabel {
					targetChunk = &exactMatches[i]
					break
				}
			}
		} else {
			for i := range chunks {
				if strings.Contains(deref(chunks[i].HeadingPath), headingPath) {
					targetChunk = &chunks[i]
					break
				}
			}
		}

		graphPos := s.buildGraphPositionText(ctx, repo.ID, doc.ID, headingPath)

		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "read", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: "documents", Status: "SUCCESS", ResultCount: 1,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})

		if targetChunk == nil {

			fullContent := deref2(s.store.FindDocContent(ctx, repo.ID, doc.ID, userID))
			filtered := filterDocByAspect(fullContent, aspect)
			return readResult{Text: fmt.Sprintf("%s# %s\nSource Path: %s\n%s%s", graphPos, title, doc.Path, liveURLLine, capFullDocText(filtered))}
		}
		sectionName := deref(targetChunk.Heading)
		if sectionName == "" {
			sectionName = headingPath
		}
		filtered := filterDocByAspect(targetChunk.Content, aspect)
		return readResult{Text: fmt.Sprintf("%s# %s\nSource Path: %s\n%sSection: %s\n\n%s",
			graphPos, title, doc.Path, liveURLLine, sectionName, capFullDocText(filtered))}
	}

	docContent, _ := s.store.FindDocContent(ctx, repo.ID, doc.ID, userID)
	if docContent == nil {
		return readResult{Text: readNoContentMsg(docPath), IsError: true}
	}
	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "read", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "documents", Status: "SUCCESS", ResultCount: 1,
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	filtered := filterDocByAspect(*docContent, aspect)
	return readResult{Text: fmt.Sprintf("# %s\nSource Path: %s\n%s\n%s", title, doc.Path, liveURLLine, capFullDocText(filtered))}
}

func filterDocByAspect(text, aspect string) string {
	switch strings.ToLower(strings.TrimSpace(aspect)) {
	case "architecture":
		lines := strings.Split(text, "\n")
		var out []string
		inCodeBlock := false
		isMermaid := false
		var codeBlockLines []string
		codeBlockLang := ""

		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
				if !inCodeBlock {
					inCodeBlock = true
					codeBlockLang = strings.TrimSpace(strings.TrimLeft(trimmed, "`~"))
					isMermaid = strings.EqualFold(codeBlockLang, "mermaid")
					codeBlockLines = []string{line}
				} else {
					inCodeBlock = false
					codeBlockLines = append(codeBlockLines, line)
					if isMermaid || len(codeBlockLines) <= 6 {
						out = append(out, codeBlockLines...)
					} else {

						out = append(out, "```"+codeBlockLang)
						out = append(out, fmt.Sprintf("// [Code implementation omitted in architecture mode (%d lines). Pass aspect=\"full\" or use read_symbol to view code.]", len(codeBlockLines)-2))
						out = append(out, "```")
					}
					codeBlockLines = nil
					isMermaid = false
					codeBlockLang = ""
				}
				continue
			}

			if inCodeBlock {
				codeBlockLines = append(codeBlockLines, line)
			} else {
				out = append(out, line)
			}
		}
		if inCodeBlock && len(codeBlockLines) > 0 {
			out = append(out, codeBlockLines...)
		}
		return strings.Join(out, "\n")

	case "contract":
		lines := strings.Split(text, "\n")
		var out []string
		inCodeBlock := false
		inTable := false

		for _, line := range lines {
			trimmed := strings.TrimSpace(line)

			if strings.HasPrefix(trimmed, "#") {
				out = append(out, line)
				continue
			}

			if strings.HasPrefix(trimmed, "|") {
				inTable = true
				out = append(out, line)
				continue
			} else if inTable {
				inTable = false
				out = append(out, "")
			}

			if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
				inCodeBlock = !inCodeBlock
				out = append(out, line)
				continue
			}
			if inCodeBlock {
				out = append(out, line)
				continue
			}

			if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
				if strings.Contains(trimmed, "`") || strings.Contains(trimmed, ":") {
					out = append(out, line)
				}
			}
		}
		return strings.Join(out, "\n")

	default:
		return text
	}
}

func (s *readService) applyCognitiveBudget(ctx context.Context, canonical, text string, quota UserQuota, policyBudget int, userBudget *float64, target string) string {
	budget := ResolveCognitiveBudget(quota, policyBudget, userBudget)
	res := ApplyCognitiveBudget(canonical, text, budget, target)
	return res.Text
}

func (s *readService) applyTokenBudget(ctx context.Context, text string, quota UserQuota, policyTokenCap int) string {
	return s.applyCognitiveBudget(ctx, "read", text, quota, policyTokenCap, nil, "")
}

func (s *readService) recordTelemetry(ctx context.Context, e CallLogEntry) {
	if s == nil || s.store == nil {
		return
	}
	_ = s.store.InsertCallLog(ctx, e)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func deref2(s *string, err error) string {
	if s == nil || err != nil {
		return ""
	}
	return *s
}

func parseSectionAddress(address string) (docPath, headingPath string) {
	value := trimSpace(address)
	idx := strings.Index(value, "#")
	if idx < 0 {
		return value, ""
	}
	return trimSpace(value[:idx]), trimSpace(value[idx+1:])
}

func findDocInContext(docs []DocMeta, docPath string) *DocMeta {
	norm := strings.ToLower(trimSpace(docPath))
	for i := range docs {
		p := strings.ToLower(docs[i].Path)
		if p == norm || p == norm+".md" || p == norm+".mdx" {
			return &docs[i]
		}
	}
	return nil
}

func isWebDocRepository(repo RepoRow) bool {
	if strings.ToLower(repo.Owner) == "web-docs" {
		return true
	}
	if repo.Category == "Web Docs" {
		return true
	}
	var profile map[string]any
	if len(repo.RepoProfile) > 0 {
		_ = json.Unmarshal(repo.RepoProfile, &profile)
	}
	sourceType, _ := profile["sourceType"].(string)
	return sourceType == "web"
}

type navTreeNode struct {
	Title     string        `json:"title"`
	Path      string        `json:"path"`
	SourceURL string        `json:"sourceUrl"`
	Children  []navTreeNode `json:"children"`
}

func resolveDocLiveURL(navTree json.RawMessage, docPath, fallbackRootURL string) string {
	if len(navTree) == 0 {
		return fallbackRootURL
	}
	var root navTreeNode
	if err := json.Unmarshal(navTree, &root); err != nil {
		return fallbackRootURL
	}
	target := strings.ToLower(docPath)
	target = strings.TrimSuffix(strings.TrimSuffix(target, ".mdx"), ".md")
	var found string
	var walk func(node navTreeNode)
	walk = func(node navTreeNode) {
		if found != "" {
			return
		}
		nodePath := strings.ToLower(node.Path)
		nodePath = strings.TrimSuffix(strings.TrimSuffix(nodePath, ".mdx"), ".md")
		if nodePath != "" && nodePath == target && node.SourceURL != "" {
			found = node.SourceURL
			return
		}
		for _, child := range node.Children {
			walk(child)
			if found != "" {
				return
			}
		}
	}
	walk(root)
	if found != "" {
		return found
	}
	return fallbackRootURL
}

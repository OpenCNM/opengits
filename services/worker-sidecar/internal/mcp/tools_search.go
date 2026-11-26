package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/filecache"
)

type searchKindConfig struct {
	dimension         string
	contentTypes      []string
	noun              string
	singleScopeHeader string
	fanoutHeader      string
	noResult          func(query, scope, version string) string
}

var searchKinds = map[string]searchKindConfig{
	"docs": {
		dimension:         "all",
		noun:              "documentation chunks",
		singleScopeHeader: "Search Results",
		fanoutHeader:      "Cross-Tutorial Search Results",
		noResult: func(q, scope, v string) string {
			version := ""
			if v != "" {
				version = " (Version: " + v + ")"
			}
			return "No relevant documentation chunks found for query: \"" + q + "\" in " + scope + version + ". Try listing documents or checking the overview."
		},
	},
	"architecture": {
		dimension:         "architecture",
		contentTypes:      []string{"prose", "architecture", "module_overview", "architecture_diagram"},
		noun:              "architecture or system design documentation",
		singleScopeHeader: "Architecture & Design Search Results",
		fanoutHeader:      "Cross-Tutorial Architecture Search Results",
		noResult: func(q, scope, _ string) string {
			return "No architecture or system design documentation found for: \"" + q + "\" in " + scope + "."
		},
	},
	"code": {
		dimension:         "code",
		contentTypes:      []string{"code", "api_reference", "function_impl", "type_definition", "entry_point"},
		noun:              "code examples or API reference documentation",
		singleScopeHeader: "Code Examples & Implementation Results",
		fanoutHeader:      "Cross-Tutorial Code Examples Results",
		noResult: func(q, scope, _ string) string {
			return "No code examples or API reference documentation found for: \"" + q + "\" in " + scope + "."
		},
	},
	"gotchas": {
		dimension:         "documents",
		noun:              "breaking changes or migration gotchas",
		singleScopeHeader: "Breaking Changes & Gotchas Locator",
		fanoutHeader:      "Cross-Tutorial Breaking Changes Results",
		noResult: func(q, scope, _ string) string {
			return "No explicit breaking changes or gotchas found for: \"" + q + "\" in " + scope + "."
		},
	},
}

type searchCallArgs struct {
	Query       *string  `json:"query"`
	Filter      *string  `json:"filter"`
	Mode        *string  `json:"mode"`
	Detail      *string  `json:"detail"`
	TokenBudget *float64 `json:"token_budget"`
	Repository  *string  `json:"repository"`
	Edition     *string  `json:"edition"`
}

func (s *readService) runSearch(ctx context.Context, resolved *ResolvedRepo, userID, clientName string, args searchCallArgs) readResult {
	startTime := time.Now()
	repo := resolved.Repository

	mode := deref(args.Filter)
	if mode == "" {
		mode = deref(args.Mode)
	}
	if mode == "" {
		mode = "all"
	}
	if mode == "concept" {

		mode = "docs"
	}

	query := strings.TrimSpace(deref(args.Query))
	if query == "" {
		return readResult{Text: `Error: "query" is required and must be a non-empty string.`, IsError: true}
	}

	tokenBudget := DefaultSearchTokenBudget
	if args.TokenBudget != nil && *args.TokenBudget > 0 {
		tokenBudget = *args.TokenBudget
	}
	detail := deref(args.Detail)
	if detail == "" {
		detail = "locator"
	}
	kindKey := "docs"
	if mode != "all" {
		kindKey = mode
	}
	cfg, ok := searchKinds[kindKey]
	if !ok {
		cfg = searchKinds["docs"]
		kindKey = "docs"
	}

	if kindKey == "gotchas" {
		return s.runBreakingChanges(ctx, resolved, userID, clientName, breakingArgs{Query: &query, Detail: &detail})
	}

	effectiveVersion := deref(resolved.TargetVersionLabel)
	locatorMode := detail == "locator"
	editionSuffix := ""
	if resolved.Repository.Edition != "" {
		if label := deriveEditionLabelFromProfile(repo.RepoProfile); label != "" {
			editionSuffix = " (讲法: " + label + ")"
		}
	}

	var uidPtr *string
	if userID != "" {
		uidPtr = &userID
	}
	req := SearchChunksRequest{
		RepositoryID: repo.ID,
		Query:        query,
		RawQuery:     query,
		Version:      effectiveVersion,
		ContentTypes: cfg.contentTypes,
		UserID:       uidPtr,
		TokenBudget:  int(tokenBudget),
		Limit:        SearchFetchLimit,
	}

	var locatorHits []LocatorHit
	var results []ChunkSearchResult
	if locatorMode {
		req.IncludeContent = false
		locatorHits = s.locateRepositorySections(ctx, req, 15)
		if kindKey == "code" && len(locatorHits) == 0 {

			fallback := req
			fallback.ContentTypes = nil
			locatorHits = s.locateRepositorySections(ctx, fallback, 15)
		}
	} else {
		req.IncludeContent = true
		results = rerankChunkResults(s.searchRepositoryDocs(ctx, req), query)
		if kindKey == "code" && len(results) > 0 {
			fallback := req
			fallback.ContentTypes = nil
			unfiltered := s.searchRepositoryDocs(ctx, fallback)
			bestFiltered := bestSignal(results)
			bestUnfiltered := bestSignal(unfiltered)
			if len(unfiltered) > 0 && bestUnfiltered > bestFiltered {
				results = rerankChunkResults(unfiltered, query)
			}
		}
	}

	scope := repo.Owner + "/" + repo.Repo

	var archBlock string
	if cfg.dimension == "architecture" {
		archBlock = s.resolveArchitectureTopologyBlock(repo, query)
	}

	if locatorMode && len(locatorHits) == 0 || !locatorMode && len(results) == 0 {
		if archBlock != "" {
			s.recordTelemetry(ctx, CallLogEntry{
				ToolName: "search", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
				Dimension: cfg.dimension, Status: "SUCCESS", ResultCount: 1,
				ResponseTimeMs: time.Since(startTime).Milliseconds(),
			})
			return readResult{Text: archBlock + "\n\n---\n\n" + cfg.noResult(query, scope, effectiveVersion)}
		}
		resultCount := 0
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "search", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: cfg.dimension, Status: telemetryStatus(0), ResultCount: resultCount,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{Text: cfg.noResult(query, scope, effectiveVersion)}
	}

	if locatorMode {
		versionPart := ""
		if effectiveVersion != "" {
			versionPart = " (Version: " + effectiveVersion + ")"
		}
		header := cfg.singleScopeHeader + " for \"" + query + "\" across " + scope + versionPart + editionSuffix + " [Locator Mode]"
		text := formatLocatorOutput(header, locatorHits)
		if archBlock != "" {
			text = archBlock + "\n\n---\n\n" + text
		}
		text = s.injectConceptEnrichments(ctx, repo.ID, query, text)
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "search", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
			Dimension: cfg.dimension, Status: "SUCCESS", ResultCount: len(locatorHits),
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
		return readResult{Text: text}
	}

	rawCharTotal := 0
	summaryTag := ""
	if detail == "summary" {
		summaryTag = " [Summary Mode]"
	}
	versionPart := ""
	if effectiveVersion != "" {
		versionPart = " (Version: " + effectiveVersion + ")"
	}
	var b strings.Builder
	if archBlock != "" {
		b.WriteString(archBlock)
		b.WriteString("\n\n---\n\n")
	}
	b.WriteString(cfg.singleScopeHeader + " for \"" + query + "\" across " + scope + versionPart + editionSuffix + summaryTag + ":\n\n")
	for i, r := range results {
		rawCharTotal += len(r.Content)
		chunkText := r.Content
		if detail == "summary" {
			chunkText = summarizeDocChunk(r.Content)
		}
		slugPath := strings.TrimPrefix(strings.TrimSuffix(strings.TrimSuffix(r.Path, ".md"), ".mdx"), "docs/")
		fmt.Fprintf(&b, "--- Result %d (Score: %s%%) ---\n", i+1, formatScore(r.Similarity))
		fmt.Fprintf(&b, "Document: %s [Path: %s]\n", titleOrPath(r), r.Path)
		if r.Heading != nil && *r.Heading != "" {
			fmt.Fprintf(&b, "Section Heading: %s\n", *r.Heading)
		}
		fmt.Fprintf(&b, "Web Link: /docs/%s/%s/%s\n", repo.Owner, repo.Repo, slugPath)
		fmt.Fprintf(&b, "\n%s\n\n", chunkText)
	}
	outputText := b.String()
	outputText = s.injectConceptEnrichments(ctx, repo.ID, query, outputText)

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "search", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: cfg.dimension, Status: "SUCCESS", ResultCount: len(results),
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})
	return readResult{Text: outputText}
}

type breakingArgs struct {
	Query   *string `json:"query"`
	Limit   *int    `json:"limit"`
	Detail  *string `json:"detail"`
	RepoRef *string `json:"repository"`
}

func (s *readService) runBreakingChanges(ctx context.Context, resolved *ResolvedRepo, userID, clientName string, args breakingArgs) readResult {
	startTime := time.Now()
	repo := resolved.Repository
	query := strings.TrimSpace(deref(args.Query))
	if query == "" {
		return readResult{Text: `Error: "query" is required and must be a non-empty string.`, IsError: true}
	}
	limit := 5
	if args.Limit != nil && *args.Limit > 0 {
		limit = *args.Limit
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 5 {
		limit = 5
	}
	detail := deref(args.Detail)
	if detail == "" {
		detail = "locator"
	}
	locatorMode := detail == "locator"

	searchQuery := query + " breaking change migration"
	var uidPtr *string
	if userID != "" {
		uidPtr = &userID
	}
	req := SearchChunksRequest{
		RepositoryID: repo.ID,
		Query:        searchQuery,
		RawQuery:     query,
		UserID:       uidPtr,
	}

	var docsResults []ChunkSearchResult
	var locatorHits []LocatorHit
	if locatorMode {
		req.IncludeContent = false
		locatorHits = s.locateRepositorySections(ctx, req, maxInt(limit, 5))
	} else {
		req.IncludeContent = true
		req.TokenBudget = 4_000 // Default search token budget to 4000 so unrequested queries do not blow response size limits.
		docsResults = s.searchRepositoryDocs(ctx, req)
	}
	breakingCount := len(docsResults) + len(locatorHits)

	scope := repo.Owner + "/" + repo.Repo
	resultCount := breakingCount
	if locatorMode {
		resultCount = len(locatorHits)
	}
	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "check_breaking_changes", UserID: userID, ClientName: clientName, RepositoryID: repo.ID,
		Dimension: "documents", Status: telemetryStatus(resultCount), ResultCount: resultCount,
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})

	if breakingCount == 0 {
		return readResult{Text: "No explicit breaking changes found for \"" + query + "\" in " + scope + "."}
	}

	if locatorMode {
		header := "Breaking Changes Locator for \"" + query + "\" in " + scope
		return readResult{Text: formatLocatorOutput(header, locatorHits)}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "🚨 Breaking Changes in %s:\n\n", scope)
	for _, item := range docsResults {
		heading := deref(item.Heading)
		if heading == "" {
			heading = titleOrPath(item)
		}
		fmt.Fprintf(&b, "### %s\nPath: %s\n\n%s\n\n---\n\n", heading, item.Path, item.Content)
	}
	return readResult{Text: b.String()}
}

func formatLocatorOutput(header string, hits []LocatorHit) string {
	var b strings.Builder
	b.WriteString(header + "\n\n")
	for i, h := range hits {
		fmt.Fprintf(&b, "--- Result %d (Score: %s%%) ---\n", i+1, formatScore(h.Similarity))
		fmt.Fprintf(&b, "Document: %s [Path: %s]\n", titleOr(h.Title, h.Path), h.Path)
		if h.Heading != nil && *h.Heading != "" {
			fmt.Fprintf(&b, "Section: %s\n", *h.Heading)
		}
		if h.HeadingPath != nil && *h.HeadingPath != "" {
			fmt.Fprintf(&b, "HeadingPath: %s\n", *h.HeadingPath)
		}
		addressHeading := deref(h.HeadingPath)
		if addressHeading == "" {
			addressHeading = deref(h.Heading)
		}
		fmt.Fprintf(&b, "Address: %s\n", buildSectionAddress(h.Path, addressHeading))
		fmt.Fprintf(&b, "Snippet: %s\n\n", h.Snippet)
	}
	b.WriteString(hintReadSectionByTarget)
	return b.String()
}

const (
	hintReadSectionByTarget    = `(Use read with "target" set to an Address above to fetch the complete section, or pass a document path for the whole page.)`
	hintHubReadSectionByTarget = `(Use read with "repository" and "target" set to an Address above to fetch the complete section, or pass a document path for the whole page.)`
	hintConceptRequiredMsg     = `Error: "concept" is required. Pass a concept name or slug (see outline, Knowledge Graph Concepts section).`
	hintConceptReadSection     = "\n(Use read with \"target\" set to the Address above to read the source section in full.)"
)

const conceptMentorCardHeader = "🧠 导师设计思考与原理卡片 (Author Reflections & Principles)"
const conceptDependencyHintHeader = "⚡ 依赖提示 (Prerequisite Hint)"

var edgeSourceLabels = map[string]struct{ label, confidence string }{
	"cooccurrence":     {"共现", "确定"},
	"curriculum_order": {"教学顺序", "确定"},
	"code_dep":         {"代码依赖", "确定"},
	"llm_extracted":    {"LLM推断", "推断"},
}

var cjkOnlyRE = regexp.MustCompile(`[^` + mdpat.CJKScriptClass + `]`)

func (s *readService) matchConceptNode(ctx context.Context, repositoryID, query string) *ConceptRichNode {
	keywords := make([]string, 0, 4)
	for _, t := range locatorTokensOf(query) {
		if len([]rune(t)) >= 2 {
			keywords = append(keywords, t)
		}
	}
	if len(keywords) == 0 {
		return nil
	}
	if n, _ := s.store.MatchConceptAll(ctx, repositoryID, keywords); n != nil {
		return n
	}
	if n, _ := s.store.MatchConceptAny(ctx, repositoryID, keywords); n != nil {
		return n
	}
	if n, _ := s.store.MatchConceptBody(ctx, repositoryID, keywords); n != nil {
		return n
	}

	bigrams := map[string]bool{}
	for _, kw := range keywords {
		cjk := cjkOnlyRE.ReplaceAllString(kw, "")
		runes := []rune(cjk)
		if len(runes) >= 2 {
			for i := 0; i+1 < len(runes); i++ {
				bigrams[string(runes[i:i+2])] = true
			}
		}
	}
	if len(bigrams) > 0 {
		var grams []string
		for g := range bigrams {
			grams = append(grams, g)
			if len(grams) >= 8 {
				break
			}
		}
		if candidates, _ := s.store.ConceptGramCandidates(ctx, repositoryID, grams); len(candidates) > 0 {
			var best *ConceptRichNode
			bestCoverage := 0
			for i := range candidates {
				coverage := 0
				for _, g := range grams {
					if strings.Contains(candidates[i].ConceptName, g) {
						coverage++
					}
				}
				if coverage > bestCoverage {
					best = &candidates[i]
					bestCoverage = coverage
				}
			}
			if best != nil && bestCoverage >= 2 {
				return best
			}
		}
	}
	return nil
}

type rsgArtifact struct {
	Nodes []struct {
		Path       string  `json:"path"`
		Role       string  `json:"role"`
		PageRank   float64 `json:"pageRank"`
		IsBackbone bool    `json:"isBackbone"`
	} `json:"nodes"`
	GoldenSymbols []struct {
		Name  string  `json:"name"`
		Kind  string  `json:"kind"`
		File  string  `json:"file"`
		Score float64 `json:"score"`
	} `json:"goldenSymbols"`
}

var rsgArtifactCache = filecache.New[*rsgArtifact](16)

func loadRSGArtifact(owner, repo, sha string) *rsgArtifact {
	root := envOr("STORAGE_ROOT", "/storage/repos")
	p := filepath.Join(root, owner, repo, sha+".json")
	if cached, ok := rsgArtifactCache.Get(p); ok {
		return cached
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var a rsgArtifact
	if err := json.Unmarshal(data, &a); err != nil {
		return nil
	}
	rsgArtifactCache.Put(p, &a)
	return &a
}

func (s *readService) injectConceptEnrichments(ctx context.Context, repositoryID, query, baseText string) string {
	if repositoryID == "" || strings.TrimSpace(query) == "" {
		return baseText
	}
	concept := s.matchConceptNode(ctx, repositoryID, query)
	if concept == nil {
		return baseText
	}
	text := s.injectMentorCard(ctx, repositoryID, baseText, concept)
	text = s.injectDependencyHint(ctx, repositoryID, text, concept)
	return text
}

func (s *readService) injectMentorCard(ctx context.Context, repositoryID string, baseText string, concept *ConceptRichNode) string {
	var card strings.Builder
	card.WriteString("\n\n" + conceptMentorCardHeader + "\n")
	fmt.Fprintf(&card, "- **核心概念**: %s (%s)\n", concept.ConceptName, concept.Category)
	docPath := deref(concept.DocumentPath)
	if docPath != "" {
		card.WriteString("- **来源**: " + docPath)
		if hp := deref(concept.HeadingPath); hp != "" {
			card.WriteString(" [Address: " + buildCleanSectionAddress(docPath, hp) + "]")
		}
		card.WriteString("\n")
	}
	if ar := deref(concept.AuthorReflections); ar != "" {
		fmt.Fprintf(&card, "- **作者思考与 Trade-off 权衡**:\n  > %s\n", strings.ReplaceAll(ar, "\n", "\n  > "))
	}
	if len(concept.SopSteps) > 0 {
		card.WriteString("- **核心 SOP 开发步骤**:\n")
		for i, step := range concept.SopSteps {
			fmt.Fprintf(&card, "  %d. %s\n", i+1, step)
		}
	}
	if summary := deref(concept.Summary); summary != "" {
		card.WriteString("- **设计摘要**: " + summary + "\n")
	}

	if owner, repo, sha, ok := s.store.GetRepoGitSha(ctx, repositoryID); ok {
		if artifact := loadRSGArtifact(owner, repo, sha); artifact != nil {
			backbone := rsgBackboneFiles(artifact)
			symbols := rsgGoldenSymbols(artifact)
			if len(symbols) > 0 {
				card.WriteString("- **核心代码符号 (AST Golden Symbols)**:\n")
				for _, sym := range symbols[:minInt(4, len(symbols))] {
					fmt.Fprintf(&card, "  - `%s` (%s) in `%s` [PR: %s]\n", sym.Name, sym.Kind, sym.File, formatPR(sym.Score))
				}
			}
			if len(backbone) > 0 {
				card.WriteString("- **主干实现文件**:\n")
				for _, f := range backbone[:minInt(3, len(backbone))] {
					fmt.Fprintf(&card, "  - `%s` (%s)\n", f.Path, f.Role)
				}
			}
		}
	}

	fmt.Fprintf(&card, "\n(Use explore_concept (concept: %q, action: \"details\") for the full concept package, or read with the Address above to read the source section.)", concept.ConceptName)
	return baseText + card.String()
}

func rsgBackboneFiles(a *rsgArtifact) []struct {
	Path string
	Role string
} {
	type bf = struct {
		Path string
		Role string
	}
	var out []bf
	for _, n := range a.Nodes {
		if n.IsBackbone || n.Role == "core_contract" || n.Role == "entry_point" {
			out = append(out, bf{n.Path, n.Role})
		}
	}

	for i := 1; i < len(out); i++ {
		for j := i; j > 0; j-- {
			if a.nodePageRank(out[j].Path) > a.nodePageRank(out[j-1].Path) {
				out[j-1], out[j] = out[j], out[j-1]
			} else {
				break
			}
		}
	}
	if len(out) > 4 {
		out = out[:4]
	}
	return out
}

func (a *rsgArtifact) nodePageRank(path string) float64 {
	for _, n := range a.Nodes {
		if n.Path == path {
			return n.PageRank
		}
	}
	return 0
}

func rsgGoldenSymbols(a *rsgArtifact) []struct {
	Name, Kind, File string
	Score            float64
} {
	backboneSet := map[string]bool{}
	for _, f := range rsgBackboneFiles(a) {
		backboneSet[f.Path] = true
	}
	type sym = struct {
		Name, Kind, File string
		Score            float64
	}
	var out []sym
	seen := map[string]bool{}
	for _, s := range a.GoldenSymbols {
		if backboneSet[s.File] {

		} else {
			continue
		}
		key := s.File + "::" + s.Name
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, sym{s.Name, s.Kind, s.File, s.Score})
		if len(out) >= 6 {
			break
		}
	}
	return out
}

func (s *readService) injectDependencyHint(ctx context.Context, repositoryID string, baseText string, concept *ConceptRichNode) string {
	memberIDs, _ := s.store.CanonicalMemberIDs(ctx, repositoryID, concept.ID)
	edges, _ := s.store.ConceptDependencyEdges(ctx, repositoryID, memberIDs)
	if len(edges) == 0 {
		return baseText
	}

	seenSources := map[string]bool{}
	var deduped []EdgeRef
	for _, e := range edges {
		if seenSources[e.SourceID] {
			continue
		}
		seenSources[e.SourceID] = true
		deduped = append(deduped, e)
		if len(deduped) >= 5 {
			break
		}
	}
	if len(deduped) == 0 {
		return baseText
	}
	var nodes []ConceptNodeLite
	if ids := edgeSourceIDs(deduped); len(ids) > 0 {
		nodes, _ = s.store.NodesByIDs(ctx, repositoryID, ids)
	}
	nodeByID := map[string]ConceptNodeLite{}
	for _, n := range nodes {
		nodeByID[n.ID] = n
	}

	var b strings.Builder
	b.WriteString("\n\n" + conceptDependencyHintHeader + "\n")
	fmt.Fprintf(&b, "- 理解「%s」建议先掌握:\n", concept.ConceptName)
	for _, e := range deduped {
		node, ok := nodeByID[e.SourceID]
		if !ok {
			continue
		}
		fmt.Fprintf(&b, "  • %s (%s)", node.ConceptName, node.Category)
		srcKey := e.Source
		if srcKey == "" {
			srcKey = "cooccurrence"
		}
		meta, ok := edgeSourceLabels[srcKey]
		if !ok {
			meta = struct{ label, confidence string }{srcKey, "推断"}
		}
		fmt.Fprintf(&b, " [来源:%s(%s) · w%s]", meta.label, meta.confidence, formatWeight(e.Weight))
		if p := deref(node.DocumentPath); p != "" {
			b.WriteString(" — " + p)
		}
		b.WriteString("\n")
	}
	b.WriteString("\n(可用 read 精读任一前置概念，或 explore_concept(action=\"path\") 获取完整递进链)")
	b.WriteString("\n(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉)")
	return baseText + b.String()
}

func edgeSourceIDs(edges []EdgeRef) []string {
	ids := make([]string, 0, len(edges))
	for _, e := range edges {
		ids = append(ids, e.SourceID)
	}
	return ids
}

func formatScore(v float64) string {
	return fmt.Sprintf("%.1f", v*100)
}

func formatPR(v float64) string { return fmt.Sprintf("%.2f", v) }

func formatWeight(v float64) string { return fmt.Sprintf("%.2f", v) }

func titleOrPath(r ChunkSearchResult) string { return titleOr(r.Title, r.Path) }

func titleOr(title, path string) string {
	if title != "" {
		return title
	}
	return path
}

func bestSignal(results []ChunkSearchResult) float64 {
	best := 0.0
	for _, r := range results {
		v := r.Similarity
		if r.MatchCount != nil {
			v = *r.MatchCount
		} else if r.FtsRank != nil {
			v = *r.FtsRank
		}
		if v > best {
			best = v
		}
	}
	return best
}

func (s *readService) resolveArchitectureTopologyBlock(repo RepoRow, query string) string {
	q := strings.ToLower(strings.TrimSpace(query))
	isMacro := q == "architecture" || q == "overview" || q == "design" ||
		q == "structure" || q == "system" || q == "arch" ||
		q == "c4" || q == "topology" || q == "macro" ||
		strings.Contains(q, "architecture") || strings.Contains(q, "topology") ||
		strings.Contains(q, "overview") || strings.Contains(q, "system")

	if isMacro {
		return extractMacroTopologySection(repo)
	}

	subsystemText := renderSubsystemArchitecture(repo, query)
	if subsystemText != "" && !strings.HasPrefix(subsystemText, "Subsystem \"") && !strings.Contains(subsystemText, "not found in architecture topology") {
		return subsystemText
	}

	return ""
}

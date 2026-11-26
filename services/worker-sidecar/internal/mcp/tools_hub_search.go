package mcp

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	hubSearchTopHitsLimit       = 10
	hubSearchMaxHitsPerRepo     = 3
	hubAffinityExactRepoBonus   = 0.25
	hubAffinityMetaTokenBonus   = 0.10
	hubAffinityMaxBonus         = 0.30
	hubAffinityRecentReadBonus  = 0.02
	hubAffinityRecentReadWindow = 7 * 24 * time.Hour
)

type FanoutLocatorHit struct {
	LocatorHit
	RepositoryID string
	Owner        string
	Repo         string
}

func formatFanoutLocatorOutput(header string, hits []FanoutLocatorHit) string {
	var b strings.Builder
	b.WriteString(header + "\n\n")
	for i, h := range hits {
		editionPart := ""
		if h.EditionLabel != "" {
			editionPart = " · 讲法: " + h.EditionLabel
		}
		fmt.Fprintf(&b, "--- Result %d (Score: %s%%) [Source: %s/%s%s] ---\n", i+1, formatScore(h.Similarity), h.Owner, h.Repo, editionPart)
		fmt.Fprintf(&b, "Document: %s [Path: %s]\n", titleOr(h.Title, h.Path), h.Path)
		if h.Heading != nil && *h.Heading != "" {
			fmt.Fprintf(&b, "Section: %s\n", *h.Heading)
		}
		if h.HeadingPath != nil && *h.HeadingPath != "" {
			fmt.Fprintf(&b, "HeadingPath: %s\n", *h.HeadingPath)
		}
		addrHeading := deref(h.HeadingPath)
		if addrHeading == "" {
			addrHeading = deref(h.Heading)
		}
		fmt.Fprintf(&b, "Address: %s\n", buildSectionAddress(h.Path, addrHeading))
		fmt.Fprintf(&b, "Snippet: %s\n\n", h.Snippet)
	}
	b.WriteString(hintHubReadSectionByTarget)
	return b.String()
}

func hubScopeRequiredError() readResult {
	return readResult{
		Text:    `Error: "repository" is required on your OpenGits Hub. Specify which tutorial (e.g. "owner/repo", see list_resources).`,
		IsError: true,
	}
}

func hubRefNotFoundError(ref string) readResult {
	return readResult{
		Text:    fmt.Sprintf(`Error: Repository "%s" not found in your OpenGits Hub. Try list_resources to see available tutorials.`, ref),
		IsError: true,
	}
}

func hubEmptyBookshelfError() readResult {
	return readResult{
		Text:    `Your OpenGits Hub has no tutorials yet. Add tutorials to your bookshelf on the web to enable cross-tutorial search.`,
		IsError: true,
	}
}

func extractAffinityTokens(query string) []string {
	raw := locatorKeywords(query)
	out := make([]string, 0, len(raw))
	for _, tok := range raw {
		if len([]rune(tok)) >= 2 {
			out = append(out, strings.ToLower(tok))
		}
	}
	return out
}

// Boost repo-level semantic affinity so generic terms are not diluted on large bookshelves.
func computeRepoAffinityBoost(queryTokens []string, row BookshelfRepoRow) float64 {
	var boost float64
	if len(queryTokens) > 0 {
		repoLow := strings.ToLower(row.Repo)
		ownerLow := strings.ToLower(row.Owner)
		displayLow := strings.ToLower(resolveRepoDisplayName(row.Owner, row.Repo, row.RepoProfile))
		categoryLow := strings.ToLower(row.Category)
		techLow := strings.ToLower(formatTechStack(row.RepoProfile))
		tagsLow := make([]string, 0, len(row.Tags))
		for _, t := range row.Tags {
			if tl := strings.ToLower(strings.TrimSpace(t)); tl != "" {
				tagsLow = append(tagsLow, tl)
			}
		}

		exactMatched := false
		var tokenBonus float64
		for _, qt := range queryTokens {
			if !exactMatched && (repoLow == qt || displayLow == qt) {
				exactMatched = true
				boost += hubAffinityExactRepoBonus
				continue
			}
			matchedMeta := strings.Contains(repoLow, qt) ||
				strings.Contains(ownerLow, qt) ||
				strings.Contains(displayLow, qt) ||
				strings.Contains(categoryLow, qt) ||
				strings.Contains(techLow, qt)
			if !matchedMeta {
				for _, tag := range tagsLow {
					if strings.Contains(tag, qt) {
						matchedMeta = true
						break
					}
				}
			}
			if matchedMeta {
				tokenBonus += hubAffinityMetaTokenBonus
			}
		}
		if boost+tokenBonus > hubAffinityMaxBonus {
			boost = hubAffinityMaxBonus
		} else {
			boost += tokenBonus
		}
	}
	if !row.LastReadAt.IsZero() && time.Since(row.LastReadAt) <= hubAffinityRecentReadWindow {
		boost += hubAffinityRecentReadBonus
	}
	return boost
}

func selectDiverseTopHits(hits []FanoutLocatorHit, maxTotal, maxPerRepo int) []FanoutLocatorHit {
	if len(hits) <= maxTotal || maxPerRepo <= 0 {
		if len(hits) > maxTotal {
			return hits[:maxTotal]
		}
		return hits
	}
	perRepoCount := make(map[string]int)
	selected := make([]FanoutLocatorHit, 0, maxTotal)
	var overflow []FanoutLocatorHit

	for _, h := range hits {
		key := strings.ToLower(h.Owner + "/" + h.Repo)
		if perRepoCount[key] < maxPerRepo {
			perRepoCount[key]++
			selected = append(selected, h)
			if len(selected) >= maxTotal {
				return selected
			}
		} else {
			overflow = append(overflow, h)
		}
	}
	for _, h := range overflow {
		selected = append(selected, h)
		if len(selected) >= maxTotal {
			break
		}
	}
	return selected
}

func (s *readService) executeScopedHubSearch(
	ctx context.Context,
	targets []ScopeGroup,
	userID, searchQuery, rawQuery string,
	contentTypes []string,
) []FanoutLocatorHit {
	repoIDs := make([]string, 0, len(targets))
	groupByRepoID := make(map[string]ScopeGroup, len(targets))
	groupByOwnerRepo := make(map[string]ScopeGroup, len(targets))
	for _, g := range targets {
		repoIDs = append(repoIDs, g.Preferred.ID)
		groupByRepoID[g.Preferred.ID] = g
		ownerRepoKey := strings.ToLower(g.Preferred.Owner + "/" + g.Preferred.Repo)
		if _, exists := groupByOwnerRepo[ownerRepoKey]; !exists {
			groupByOwnerRepo[ownerRepoKey] = g
		}
	}

	tctx, cancel := context.WithTimeout(ctx, hubFanoutTimeoutMs*time.Millisecond)
	defer cancel()

	var uidPtr *string
	if userID != "" {
		uidPtr = &userID
	}
	p := SearchChunksRequest{
		RepositoryIDs:  repoIDs,
		Query:          searchQuery,
		RawQuery:       rawQuery,
		ContentTypes:   contentTypes,
		UserID:         uidPtr,
		IncludeContent: false,
	}
	rawHits := s.locateScopedSections(tctx, p, scopedLocatorCandidateLimit)
	if len(rawHits) == 0 {
		return nil
	}

	queryTokens := extractAffinityTokens(rawQuery)
	allHits := make([]FanoutLocatorHit, 0, len(rawHits))
	for _, h := range rawHits {
		repoID := h.RepositoryID
		owner := h.Owner
		repoName := h.Repo
		var boost float64

		if grp, ok := groupByRepoID[repoID]; ok {
			owner = grp.Preferred.Owner
			repoName = grp.Preferred.Repo
			boost = computeRepoAffinityBoost(queryTokens, grp.Preferred)
		} else if owner != "" && repoName != "" {
			if grp, ok := groupByOwnerRepo[strings.ToLower(owner+"/"+repoName)]; ok {
				repoID = grp.Preferred.ID
				owner = grp.Preferred.Owner
				repoName = grp.Preferred.Repo
				boost = computeRepoAffinityBoost(queryTokens, grp.Preferred)
			}
		}

		h.Similarity = clampF(h.Similarity+boost, 0, 1)
		allHits = append(allHits, FanoutLocatorHit{
			LocatorHit:   h,
			RepositoryID: repoID,
			Owner:        owner,
			Repo:         repoName,
		})
	}

	sort.SliceStable(allHits, func(i, j int) bool {
		if allHits[i].Similarity != allHits[j].Similarity {
			return allHits[i].Similarity > allHits[j].Similarity
		}
		return allHits[i].Path < allHits[j].Path
	})

	return selectDiverseTopHits(allHits, hubSearchTopHitsLimit, hubSearchMaxHitsPerRepo)
}

func (s *readService) runHubSearch(ctx context.Context, userID, clientName string, args searchCallArgs) readResult {
	query := strings.TrimSpace(deref(args.Query))
	if query == "" {
		return readResult{Text: `Error: "query" is required and must be a non-empty string.`, IsError: true}
	}
	filter := deref(args.Filter)
	if filter == "" {
		filter = "all"
	}

	if filter == "gotchas" {
		limit := 5
		return s.runHubBreakingChanges(ctx, userID, clientName, breakingArgs{
			Query: args.Query, Limit: &limit, Detail: args.Detail, RepoRef: args.Repository,
		})
	}

	if filter == "concept" && deref(args.Repository) == "" {
		hits, gcMap, err := s.store.FindConceptAcrossBookshelf(ctx, userID, query, 30)
		if err != nil {
			return readResult{Text: "Error: failed to search concepts across bookshelf", IsError: true}
		}
		text := formatCrossRepoConceptSearch(query, hits, gcMap)
		return readResult{Text: text}
	}

	if deref(args.Repository) != "" {
		resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, deref(args.Repository), deref(args.Edition))
		if err != nil || resolved == nil {
			return hubRefNotFoundError(deref(args.Repository))
		}
		return s.runSearch(ctx, resolved, userID, clientName, args)
	}

	fanoutCfg := searchKinds["docs"]
	if kcfg, ok := searchKinds[filter]; ok {
		fanoutCfg = kcfg
	}
	startTime := time.Now()
	repos, err := s.store.ListUserBookshelfRepos(ctx, userID)
	if err != nil || len(repos) == 0 {
		return hubEmptyBookshelfError()
	}

	targets := foldScopeRows(repos)
	allHits := s.executeScopedHubSearch(ctx, targets, userID, query, query, fanoutCfg.contentTypes)

	cfg := fanoutCfg

	if len(allHits) == 0 {
		text := fmt.Sprintf(`No relevant %s found across your OpenGits Hub for: "%s". Try search with different wording, or pass "repository" to scope into one tutorial.`, cfg.noun, query)
		return readResult{Text: text}
	}

	var hintTexts []string
	seenHintRepos := make(map[string]bool)
	for _, h := range allHits {
		if h.RepositoryID == "" || seenHintRepos[h.RepositoryID] {
			continue
		}
		seenHintRepos[h.RepositoryID] = true
		scope := h.Owner + "/" + h.Repo
		if hint := s.injectConceptDependencyHintHub(ctx, h.RepositoryID, query, scope); hint != "" {
			hintTexts = append(hintTexts, hint)
		}
	}
	fanoutHints := strings.Join(hintTexts, "\n")
	if fanoutHints != "" {
		fanoutHints = "\n" + fanoutHints
	}

	header := fmt.Sprintf(`%s for "%s" across your OpenGits Hub [Locator Mode]`, cfg.fanoutHeader, query)
	fanoutText := formatFanoutLocatorOutput(header, allHits) + fanoutHints

	multiEditionCount := 0
	for _, g := range targets {
		if len(g.Rows) > 1 {
			multiEditionCount++
		}
	}
	editionHint := ""
	if multiEditionCount > 0 {
		editionHint = "\n\n(部分仓库存在多种转录讲法，已按你在读的讲法检索；可用 \"owner/repo@edition\" 形式的 repository 参数指定其他讲法，讲法 key 见 list_resources。)"
	}

	detail := deref(args.Detail)
	detailHint := ""
	if detail != "" && detail != "locator" {
		detailHint = fmt.Sprintf("\n\n(Hub-wide search always returns locator mode; pass \"repository\" to scope into one tutorial for %s content.)", detail)
	}

	outputText := fanoutText + editionHint + detailHint

	telemetryRepoID := targets[0].Preferred.ID
	if allHits[0].RepositoryID != "" {
		telemetryRepoID = allHits[0].RepositoryID
	}
	s.recordTelemetry(ctx, CallLogEntry{
		ToolName: "search", UserID: userID, ClientName: clientName,
		RepositoryID: telemetryRepoID, Dimension: cfg.dimension,
		Status: "SUCCESS", ResultCount: len(allHits),
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})

	return readResult{Text: outputText}
}

func (s *readService) injectConceptDependencyHintHub(ctx context.Context, repositoryID, query, sourceScope string) string {
	concept := s.matchConceptNode(ctx, repositoryID, query)
	if concept == nil {
		return ""
	}
	memberIDs, _ := s.store.CanonicalMemberIDs(ctx, repositoryID, concept.ID)
	edges, _ := s.store.ConceptDependencyEdges(ctx, repositoryID, memberIDs)
	if len(edges) == 0 {
		return ""
	}
	seenSources := map[string]bool{}
	var deduped []EdgeRef
	for _, e := range edges {
		if seenSources[e.SourceID] {
			continue
		}
		seenSources[e.SourceID] = true
		deduped = append(deduped, e)
		if len(deduped) >= 3 {
			break
		}
	}
	if len(deduped) == 0 {
		return ""
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
	fmt.Fprintf(&b, "- 理解「%s」建议先掌握 [Source: %s]:\n", concept.ConceptName, sourceScope)
	for _, e := range deduped {
		node, ok := nodeByID[e.SourceID]
		if !ok {
			continue
		}
		fmt.Fprintf(&b, "  • %s (%s)", node.ConceptName, node.Category)
		if p := deref(node.DocumentPath); p != "" {
			b.WriteString(" — " + p)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (s *readService) runHubBreakingChanges(ctx context.Context, userID, clientName string, args breakingArgs) readResult {
	if deref(args.RepoRef) != "" {
		resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, deref(args.RepoRef), "")
		if err != nil || resolved == nil {
			return hubRefNotFoundError(deref(args.RepoRef))
		}
		return s.runBreakingChanges(ctx, resolved, userID, clientName, args)
	}

	query := strings.TrimSpace(deref(args.Query))
	if query == "" {
		return readResult{Text: `Error: "query" is required and must be a non-empty string.`, IsError: true}
	}

	repos, err := s.store.ListUserBookshelfRepos(ctx, userID)
	if err != nil || len(repos) == 0 {
		return hubEmptyBookshelfError()
	}

	groups := foldScopeRows(repos)
	searchQuery := query + " breaking change migration"
	allHits := s.executeScopedHubSearch(ctx, groups, userID, searchQuery, query, nil)

	if len(allHits) == 0 {
		return readResult{
			Text: fmt.Sprintf(`No explicit breaking changes found for "%s" across your OpenGits Hub.`, query),
		}
	}

	header := fmt.Sprintf(`Breaking Changes Locator for "%s" across your OpenGits Hub [Locator Mode]`, query)
	return readResult{
		Text: formatFanoutLocatorOutput(header, allHits),
	}
}

func formatCrossRepoConceptSearch(query string, hits []CrossRepoConceptHit, gcMap map[string]GlobalConceptMeta) string {
	if len(hits) == 0 {
		return fmt.Sprintf(`🔍 跨仓概念检索 "%s"：书架内无匹配概念。可尝试 list_resources 查看可用教程，或用 search(mode='concept') 做全文检索。`, query)
	}

	grouped := make(map[string][]CrossRepoConceptHit)
	var ungrouped []CrossRepoConceptHit

	for _, h := range hits {
		if h.GlobalConceptID != nil && *h.GlobalConceptID != "" {
			grouped[*h.GlobalConceptID] = append(grouped[*h.GlobalConceptID], h)
		} else {
			ungrouped = append(ungrouped, h)
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "🔍 跨仓概念检索 \"%s\"（%d 命中 / %d 全局概念 / %d 单仓）\n\n", query, len(hits), len(grouped), len(ungrouped))

	if len(grouped) > 0 {
		b.WriteString("🌐 跨仓归并概念（同义，多仓讲解）：\n")
		for gcID, grpHits := range grouped {
			canonical := grpHits[0].ConceptName
			aliasNote := ""
			if gc, ok := gcMap[gcID]; ok {
				if gc.CanonicalName != "" {
					canonical = gc.CanonicalName
				}
				if len(gc.Aliases) > 0 {
					aliasNote = fmt.Sprintf("（别名: %s）", strings.Join(gc.Aliases, "、"))
				}
			}
			fmt.Fprintf(&b, "- **%s**%s — 覆盖 %d 仓:\n", canonical, aliasNote, len(grpHits))
			for _, h := range grpHits {
				fmt.Fprintf(&b, "  • %s/%s: %s", h.RepoOwner, h.RepoName, h.ConceptName)
				if h.Address != "" {
					fmt.Fprintf(&b, " [Address: %s]", h.Address)
				}
				b.WriteString("\n")
			}
		}
		b.WriteString("\n")
	}

	if len(ungrouped) > 0 {
		b.WriteString("📚 单仓概念（未跨仓归并，仅出现在一个仓或尚未对齐）：\n")
		for _, h := range ungrouped {
			fmt.Fprintf(&b, "- %s/%s: %s (%s)", h.RepoOwner, h.RepoName, h.ConceptName, h.Category)
			if h.Address != "" {
				fmt.Fprintf(&b, " [Address: %s]", h.Address)
			}
			b.WriteString("\n")
		}
	}

	b.WriteString("\n(对任一命中调用 explore_concept(action='details', concept=..., repository=...) 深入，read(target=Address, repository=...) 精读原文)")
	return b.String()
}

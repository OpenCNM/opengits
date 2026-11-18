package mcp

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
)

type FanoutLocatorHit struct {
	LocatorHit
	Owner string
	Repo  string
}

// formatFanoutLocatorOutput 对齐 shared.ts formatFanoutLocatorOutput 渲染
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

	// concept 模式无 repository：跨仓全局概念检索
	if filter == "concept" && deref(args.Repository) == "" {
		hits, gcMap, err := s.store.FindConceptAcrossBookshelf(ctx, userID, query, 30)
		if err != nil {
			return readResult{Text: "Error: failed to search concepts across bookshelf", IsError: true}
		}
		text := formatCrossRepoConceptSearch(query, hits, gcMap)
		return readResult{Text: text}
	}

	// 指定 repository：解析单仓精搜
	if deref(args.Repository) != "" {
		resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, deref(args.Repository), deref(args.Edition))
		if err != nil || resolved == nil {
			return hubRefNotFoundError(deref(args.Repository))
		}
		return s.runSearch(ctx, resolved, userID, clientName, args)
	}

	// ── 跨仓 fan-out 路径 ──（维度 contentType 过滤与目标版本随请求下沉，
	// 对齐 Node tools/search.ts:274-278——此前 Hub 扇出全维度不过滤跨版本混串）
	fanoutCfg := searchKinds["docs"]
	if kcfg, ok := searchKinds[filter]; ok {
		fanoutCfg = kcfg
	}
	startTime := time.Now()
	repos, err := s.store.ListUserBookshelfRepos(ctx, userID)
	if err != nil || len(repos) == 0 {
		return hubEmptyBookshelfError()
	}

	// Node 无候选仓截断（只有合并后的 top-10）——书架 >10 仓不再静默漏检
	groups := foldScopeRows(repos)
	targets := groups

	type repoHitResult struct {
		preferred BookshelfRepoRow
		hits      []LocatorHit
	}

	resultsChan := make(chan repoHitResult, len(targets))
	sem := make(chan struct{}, hubFanoutConcurrency)
	var wg sync.WaitGroup

	for _, g := range targets {
		wg.Add(1)
		go func(grp ScopeGroup) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			tctx, cancel := context.WithTimeout(ctx, hubFanoutTimeoutMs*time.Millisecond)
			defer cancel()

			var uidPtr *string
			if userID != "" {
				uidPtr = &userID
			}
			p := SearchChunksRequest{
				RepositoryID:   grp.Preferred.ID,
				Query:          query,
				RawQuery:       query,
				Version:        deref(grp.Preferred.SemVerLabel),
				ContentTypes:   fanoutCfg.contentTypes,
				UserID:         uidPtr,
				IncludeContent: false,
			}
			hits := s.locateRepositorySections(tctx, p, 6)
			resultsChan <- repoHitResult{preferred: grp.Preferred, hits: hits}
		}(g)
	}

	wg.Wait()
	close(resultsChan)

	var perRepoHits []repoHitResult
	var allHits []FanoutLocatorHit
	for res := range resultsChan {
		perRepoHits = append(perRepoHits, res)
		for _, h := range res.hits {
			allHits = append(allHits, FanoutLocatorHit{
				LocatorHit: h,
				Owner:      res.preferred.Owner,
				Repo:       res.preferred.Repo,
			})
		}
	}

	// 排序：相似度降序 → 字典序平局
	sort.SliceStable(allHits, func(i, j int) bool {
		if allHits[i].Similarity != allHits[j].Similarity {
			return allHits[i].Similarity > allHits[j].Similarity
		}
		return allHits[i].Path < allHits[j].Path
	})

	if len(allHits) > 10 {
		allHits = allHits[:10]
	}

	cfg := fanoutCfg

	if len(allHits) == 0 {
		text := fmt.Sprintf(`No relevant %s found across your OpenGits Hub for: "%s". Try search with different wording, or pass "repository" to scope into one tutorial.`, cfg.noun, query)
		return readResult{Text: text}
	}

	// 概念依赖提示注入
	var hintTexts []string
	for _, rh := range perRepoHits {
		if len(rh.hits) > 0 {
			scope := rh.preferred.Owner + "/" + rh.preferred.Repo
			hint := s.injectConceptDependencyHintHub(ctx, rh.preferred.ID, query, scope)
			if hint != "" {
				hintTexts = append(hintTexts, hint)
			}
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

	// 记录首仓或汇总遥测
	if len(perRepoHits) > 0 {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName: "search", UserID: userID, ClientName: clientName,
			RepositoryID: perRepoHits[0].preferred.ID, Dimension: cfg.dimension,
			Status: "SUCCESS", ResultCount: len(allHits),
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})
	}

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

	type groupHitsResult struct {
		owner string
		repo  string
		hits  []LocatorHit
	}

	resultsChan := make(chan groupHitsResult, len(groups))
	sem := make(chan struct{}, hubFanoutConcurrency)
	var wg sync.WaitGroup

	for _, g := range groups {
		wg.Add(1)
		go func(grp ScopeGroup) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			tctx, cancel := context.WithTimeout(ctx, hubFanoutTimeoutMs*time.Millisecond)
			defer cancel()

			var uidPtr *string
			if userID != "" {
				uidPtr = &userID
			}
			p := SearchChunksRequest{
				RepositoryID:   grp.Preferred.ID,
				Query:          searchQuery,
				RawQuery:       query,
				UserID:         uidPtr,
				IncludeContent: false,
			}
			hits := s.locateRepositorySections(tctx, p, 5)
			if errors.Is(tctx.Err(), context.DeadlineExceeded) {
				// In-Band 收支留痕：单仓超时该组命中放弃——不静默缩水结果质量
				log.Printf("[hub-search] breaking-changes fanout dropped group %s/%s (per-repo timeout %dms)",
					grp.Preferred.Owner, grp.Preferred.Repo, hubFanoutTimeoutMs)
			}
			resultsChan <- groupHitsResult{
				owner: grp.Preferred.Owner,
				repo:  grp.Preferred.Repo,
				hits:  hits,
			}
		}(g)
	}

	wg.Wait()
	close(resultsChan)

	var allHits []FanoutLocatorHit
	for r := range resultsChan {
		for _, h := range r.hits {
			allHits = append(allHits, FanoutLocatorHit{
				LocatorHit: h,
				Owner:      r.owner,
				Repo:       r.repo,
			})
		}
	}

	sort.SliceStable(allHits, func(i, j int) bool {
		if allHits[i].Similarity != allHits[j].Similarity {
			return allHits[i].Similarity > allHits[j].Similarity
		}
		return allHits[i].Path < allHits[j].Path
	})

	if len(allHits) > 10 {
		allHits = allHits[:10]
	}

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

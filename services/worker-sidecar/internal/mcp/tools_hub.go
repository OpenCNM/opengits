package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/concept"
)

// ── Hub 多仓书架域常数（对齐 constants.ts） ──
const (
	// 对齐 Node constants.ts：MCP_FANOUT_MAX_CONCURRENCY=3 /
	// MCP_FANOUT_PER_REPO_TIMEOUT_MS=10_000（2.5s 会砍掉三段串行查询的正常仓库）
	hubFanoutConcurrency = 3
	hubFanoutTimeoutMs   = 10_000
	webDocPrefix         = "web-"
)

// ScopeGroup 讲法折叠分组
type ScopeGroup struct {
	Key       string
	Preferred BookshelfRepoRow
	Rows      []BookshelfRepoRow
}

func scopeGroupKey(r BookshelfRepoRow) string {
	return strings.ToLower(r.Owner) + "/" + strings.ToLower(r.Repo) + "@" + r.Branch
}

// foldScopeRows 讲法折叠：同 (owner, repo, branch) 组只保留主讲法行（最近在读 > 基础行 > edition 字典序）
func foldScopeRows(rows []BookshelfRepoRow) []ScopeGroup {
	buckets := make(map[string][]BookshelfRepoRow)
	var order []string
	for _, r := range rows {
		k := scopeGroupKey(r)
		if _, exists := buckets[k]; !exists {
			order = append(order, k)
		}
		buckets[k] = append(buckets[k], r)
	}

	groups := make([]ScopeGroup, 0, len(buckets))
	for _, k := range order {
		b := buckets[k]
		if len(b) == 1 {
			groups = append(groups, ScopeGroup{Key: k, Preferred: b[0], Rows: b})
			continue
		}
		sorted := make([]BookshelfRepoRow, len(b))
		copy(sorted, b)
		sort.SliceStable(sorted, func(i, j int) bool {
			ti, tj := sorted[i].LastReadAt, sorted[j].LastReadAt
			if !ti.Equal(tj) {
				return ti.After(tj)
			}
			ei, ej := sorted[i].Edition, sorted[j].Edition
			if (ei == "") != (ej == "") {
				return ei == ""
			}
			return ei < ej
		})
		groups = append(groups, ScopeGroup{Key: k, Preferred: sorted[0], Rows: sorted})
	}
	return groups
}

// ── Hub 资源概览（hub://overview） ──

type chapterLite struct {
	Title   string
	Summary string
}

// hubOverviewCache / hubManifestsCache：低频发现面/资源读的 60s 投影缓存
// （书架全量查询 + NavTree 章节抽取成本随书架规模线性增长，多客户端同用户共享）。
var (
	hubOverviewCache  = newTTLCache(60*time.Second, 256)
	hubManifestsCache = newTTLCache(60*time.Second, 256)
)

func (s *readService) runHubOverview(ctx context.Context, userID string) string {
	if v, err := hubOverviewCache.getOrLoad("hub-overview:"+userID, func() (any, error) {
		return s.buildHubOverview(ctx, userID), nil
	}); err == nil {
		if text, ok := v.(string); ok {
			return text
		}
	}
	return s.buildHubOverview(ctx, userID)
}

func (s *readService) buildHubOverview(ctx context.Context, userID string) string {
	repos, err := s.store.ListUserBookshelfRepos(ctx, userID)
	if err != nil || len(repos) == 0 {
		return "# OpenGits Hub Capability Manifest Overview\n\nTotal Tutorials on Hub: 0\n\n"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# OpenGits Hub Capability Manifest Overview\n\nTotal Tutorials on Hub: %d\n\n", len(repos))
	for i, r := range repos {
		isWeb := isWebDocRepo(r.Repo, r.RepoProfile)
		icon := "🐙"
		sourceKind := "GitHub"
		if isWeb {
			icon = "🌐"
			sourceKind = "Web Docs"
		}
		displayName := resolveRepoDisplayName(r.Owner, r.Repo, r.RepoProfile)
		ingestMode := getProfileString(r.RepoProfile, "ingestMode", "hybrid")
		category := r.Category
		if category == "" {
			category = "General"
		}
		version := r.Branch
		if r.SemVerLabel != nil && *r.SemVerLabel != "" {
			version = *r.SemVerLabel
		}
		sourceURL := resolveRepoSourceURL(r.Owner, r.Repo, r.RepoProfile, isWeb)
		lastSynced := r.UpdatedAt.Format("2006-01-02")

		fmt.Fprintf(&b, "## %d. %s %s (%s | %s)\n", i+1, icon, displayName, sourceKind, ingestMode)
		fmt.Fprintf(&b, "Category: %s | Version: %s\n", category, version)
		fmt.Fprintf(&b, "Source: %s | Last Synced: %s\n", sourceURL, lastSynced)

		if ts := formatTechStack(r.RepoProfile); ts != "" {
			b.WriteString(ts + "\n")
		}
		b.WriteString("\n**Best Used For:**\n")
		bestUsed := r.BestUsedFor
		if len(bestUsed) == 0 {
			bestUsed = defaultBestUsedFor(displayName, r.Owner, r.Repo, isWeb)
		}
		for _, pt := range bestUsed {
			fmt.Fprintf(&b, "- %s\n", pt)
		}
		chapters := extractTeachingChapters(r.NavTree)
		fmt.Fprintf(&b, "\n**Teaching Chapters (%d chapters):**\n", len(chapters))
		for _, ch := range limitChapters(chapters, 8) {
			fmt.Fprintf(&b, "  - **%s**: %s\n", ch.Title, ch.Summary)
		}
		b.WriteString("\n---\n\n")
	}
	return b.String()
}

func (s *readService) buildHubManifests(ctx context.Context, userID string) []map[string]any {
	if v, err := hubManifestsCache.getOrLoad("hub-manifests:"+userID, func() (any, error) {
		return s.buildHubManifestsUncached(ctx, userID), nil
	}); err == nil {
		if ms, ok := v.([]map[string]any); ok {
			return ms
		}
	}
	return s.buildHubManifestsUncached(ctx, userID)
}

func (s *readService) buildHubManifestsUncached(ctx context.Context, userID string) []map[string]any {
	repos, err := s.store.ListUserBookshelfRepos(ctx, userID)
	if err != nil || len(repos) == 0 {
		return []map[string]any{}
	}
	manifests := make([]map[string]any, 0, len(repos))
	for _, r := range repos {
		isWeb := isWebDocRepo(r.Repo, r.RepoProfile)
		displayName := resolveRepoDisplayName(r.Owner, r.Repo, r.RepoProfile)
		sourceURL := resolveRepoSourceURL(r.Owner, r.Repo, r.RepoProfile, isWeb)
		sourceType := "github"
		if isWeb {
			sourceType = "web"
		}
		version := r.Branch
		if r.SemVerLabel != nil && *r.SemVerLabel != "" {
			version = *r.SemVerLabel
		}
		category := r.Category
		if category == "" {
			category = "General"
		}
		lastSyncedAt := r.UpdatedAt.Format(time.RFC3339)
		bestUsed := r.BestUsedFor
		if len(bestUsed) == 0 {
			bestUsed = defaultBestUsedFor(displayName, r.Owner, r.Repo, isWeb)
		}
		chapters := extractTeachingChapters(r.NavTree)
		manifest := map[string]any{
			"identity": map[string]any{
				"id":           r.ID,
				"owner":        r.Owner,
				"repo":         r.Repo,
				"displayName":  displayName,
				"category":     category,
				"tags":         r.Tags,
				"version":      version,
				"verified":     r.IsVerified,
				"stars":        r.StarCount,
				"sourceType":   sourceType,
				"sourceUrl":    sourceURL,
				"lastSyncedAt": lastSyncedAt,
			},
			"teachingCapabilities": map[string]any{
				"chapters": limitChapters(chapters, 8),
			},
			"bestUsedFor": bestUsed,
			"mcpEndpoint": map[string]any{
				"url":            fmt.Sprintf("/api/mcp/%s/%s", r.Owner, r.Repo),
				"availableTools": NativeAllToolNames,
			},
		}
		manifests = append(manifests, manifest)
	}
	return manifests
}

// ── list_resources 工具 ──

func (s *readService) runHubListResources(ctx context.Context, userID string, category, query *string) readResult {
	repos, err := s.store.ListUserBookshelfRepos(ctx, userID)
	if err != nil {
		return readResult{Text: "Error: failed to fetch bookshelf", IsError: true}
	}

	var filtered []BookshelfRepoRow
	catFilter := strings.ToLower(deref(category))
	qFilter := strings.ToLower(deref(query))

	for _, r := range repos {
		if catFilter != "" {
			if !strings.Contains(strings.ToLower(r.Category), catFilter) {
				continue
			}
		}
		if qFilter != "" {
			displayName := strings.ToLower(resolveRepoDisplayName(r.Owner, r.Repo, r.RepoProfile))
			matchName := strings.Contains(displayName, qFilter) ||
				strings.Contains(strings.ToLower(r.Owner+"/"+r.Repo), qFilter)
			matchDesc := strings.Contains(strings.ToLower(getProfileString(r.RepoProfile, "description", "")), qFilter)
			matchTags := false
			for _, t := range r.Tags {
				if strings.Contains(strings.ToLower(t), qFilter) {
					matchTags = true
					break
				}
			}
			matchBest := false
			bestUsed := r.BestUsedFor
			if len(bestUsed) == 0 {
				bestUsed = defaultBestUsedFor(displayName, r.Owner, r.Repo, isWebDocRepo(r.Repo, r.RepoProfile))
			}
			for _, bu := range bestUsed {
				if strings.Contains(strings.ToLower(bu), qFilter) {
					matchBest = true
					break
				}
			}
			if !matchName && !matchDesc && !matchTags && !matchBest {
				continue
			}
		}
		filtered = append(filtered, r)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "OpenGits Hub Bookshelf (%d tutorials found):\n\n", len(filtered))
	for _, r := range filtered {
		isWeb := isWebDocRepo(r.Repo, r.RepoProfile)
		icon := "🐙"
		sourceKind := "GitHub"
		if isWeb {
			icon = "🌐"
			sourceKind = "Web Docs"
		}
		displayName := resolveRepoDisplayName(r.Owner, r.Repo, r.RepoProfile)
		category := r.Category
		if category == "" {
			category = "General"
		}
		sourceURL := resolveRepoSourceURL(r.Owner, r.Repo, r.RepoProfile, isWeb)
		lastSynced := r.UpdatedAt.Format("2006-01-02")

		fmt.Fprintf(&b, "### %s %s [%s]\n", icon, displayName, sourceKind)
		fmt.Fprintf(&b, "- Repository: `%s` | Category: %s\n", r.ID, category)
		fmt.Fprintf(&b, "- Source: %s | Last Synced: %s\n", sourceURL, lastSynced)
		if ts := formatTechStack(r.RepoProfile); ts != "" {
			b.WriteString("- " + ts + "\n")
		}
		bestUsed := r.BestUsedFor
		if len(bestUsed) == 0 {
			bestUsed = defaultBestUsedFor(displayName, r.Owner, r.Repo, isWeb)
		}
		if len(bestUsed) > 0 {
			b.WriteString("- Best Used For:\n")
			for _, bu := range bestUsed {
				fmt.Fprintf(&b, "  * %s\n", bu)
			}
		}
		b.WriteString("\n")
	}
	return readResult{Text: b.String()}
}

// ── read / outline 工具 Hub 分派 ──

func (s *readService) runHubRead(ctx context.Context, userID, clientName string, repoRef, edition, target, aspect string, quota UserQuota, isReadDocFacade bool) readResult {
	if repoRef == "" {
		return hubScopeRequiredError()
	}
	resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, repoRef, edition)
	if err != nil || resolved == nil {
		return hubRefNotFoundError(repoRef)
	}
	if isReadDocFacade {
		return s.runOutline(ctx, resolved, userID, clientName, "")
	}
	return s.runRead(ctx, resolved, userID, clientName, target, aspect, quota)
}

func (s *readService) runHubOutline(ctx context.Context, userID, clientName string, repoRef, path string) readResult {
	if repoRef == "" {
		return hubScopeRequiredError()
	}
	resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, repoRef, "")
	if err != nil || resolved == nil {
		return hubRefNotFoundError(repoRef)
	}
	return s.runOutline(ctx, resolved, userID, clientName, path)
}


// ── explore_concept 工具 Hub 分派 ──

func (s *readService) runHubExploreConcept(ctx context.Context, userID, clientName string, args exploreConceptArgs, repoRef string) readResult {
	action := deref(args.Action)
	if action == "" {
		action = "details"
	}

	if action == "coverage" {
		concept := deref(args.Concept)
		return s.runHubSkillCoverage(ctx, userID, concept)
	}

	if action == "recommend" {
		desc := deref(args.Concept)
		return s.runHubRecommend(ctx, userID, clientName, desc)
	}

	if strings.TrimSpace(repoRef) == "" && args.Concept != nil {
		scope, cleanConcept := concept.ParseScopedConcept(*args.Concept)
		if scope != "" {
			repoRef = scope
			args.Concept = &cleanConcept
		}
	}

	if repoRef == "" {
		return hubScopeRequiredError()
	}

	resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, repoRef, "")
	if err != nil || resolved == nil {
		return hubRefNotFoundError(repoRef)
	}
	return s.runExploreConcept(ctx, resolved, userID, clientName, args)
}

func (s *readService) runHubSkillCoverage(ctx context.Context, userID, skill string) readResult {
	trimmed := strings.TrimSpace(skill)
	if trimmed == "" {
		return readResult{Text: "📊 技能覆盖：请指定要检索的技能或概念名称（例如 explore_concept(action='coverage', concept='React')）。"}
	}
	repos, err := s.store.ListUserBookshelfRepos(ctx, userID)
	if err != nil || len(repos) == 0 {
		return readResult{Text: fmt.Sprintf("📊 技能覆盖「%s」：书架内无教程覆盖该技能。可尝试 search(mode='concept') 查相关概念，或 list_resources 看可用教程。", trimmed)}
	}

	type covHit struct {
		owner, repo string
		conceptName string
		category    string
		address     string
		prereqCount int
	}

	var hits []covHit
	for _, r := range repos {
		node, err := s.store.ResolveConceptNode(ctx, r.ID, trimmed)
		if err != nil || node == nil {
			continue
		}
		memberIDs, _ := s.store.CanonicalMemberIDs(ctx, r.ID, node.ID)
		edges, _ := s.store.ConceptDependencyEdges(ctx, r.ID, memberIDs)
		addr := ""
		if node.DocumentPath != nil && node.HeadingPath != nil && *node.DocumentPath != "" && *node.HeadingPath != "" {
			addr = buildCleanSectionAddress(*node.DocumentPath, *node.HeadingPath)
		}
		hits = append(hits, covHit{
			owner: r.Owner, repo: r.Repo,
			conceptName: node.ConceptName, category: node.Category,
			address: addr, prereqCount: len(edges),
		})
	}

	if len(hits) == 0 {
		return readResult{Text: fmt.Sprintf("📊 技能覆盖「%s」：书架内无教程覆盖该技能。可尝试 search(mode='concept') 查相关概念，或 list_resources 看可用教程。", trimmed)}
	}

	sort.SliceStable(hits, func(i, j int) bool {
		return hits[i].prereqCount > hits[j].prereqCount
	})

	var b strings.Builder
	fmt.Fprintf(&b, "📊 技能覆盖「%s」（%d 仓覆盖）\n\n", trimmed, len(hits))
	for _, h := range hits {
		depthLabel := "入门级（无前置）"
		if h.prereqCount > 0 {
			depthLabel = fmt.Sprintf("%d 个前置概念", h.prereqCount)
		}
		fmt.Fprintf(&b, "- %s/%s: %s (%s) — 深度: %s", h.owner, h.repo, h.conceptName, h.category, depthLabel)
		if h.address != "" {
			fmt.Fprintf(&b, " [Address: %s]", h.address)
		}
		b.WriteString("\n")
	}
	b.WriteString("\n(对覆盖仓调用 explore_concept(action='path') 看完整前置链，read_document(section=Address) 精读)")
	return readResult{Text: b.String()}
}

func (s *readService) runHubRecommend(ctx context.Context, userID, clientName, description string) readResult {
	desc := strings.TrimSpace(description)
	if desc == "" {
		return readResult{
			Text:    `Error: pass a short project description as "concept" for recommendation (e.g. "Next.js 15 + Drizzle + auth 全栈项目").`,
			IsError: true,
		}
	}

	repos, err := s.store.ListUserBookshelfRepos(ctx, userID)
	if err != nil || len(repos) == 0 {
		return readResult{Text: fmt.Sprintf("🎓 教程推荐：书架内无教程覆盖项目描述「%s」中的概念。可尝试 list_resources 查看可用教程，或用更通用的技术词重试。", desc)}
	}

	keywords := extractKeywords(desc)
	if len(keywords) == 0 {
		return readResult{Text: fmt.Sprintf("🎓 教程推荐：书架内无教程覆盖项目描述「%s」中的概念。可尝试 list_resources 查看可用教程，或用更通用的技术词重试。", desc)}
	}

	type recScore struct {
		owner, repo     string
		score           float64
		totalConcepts   int
		matchedConcepts []struct {
			name, category, address string
		}
	}

	var ranked []recScore
	for _, r := range repos {
		tax, _ := s.store.TaxonomyNodes(ctx, r.ID, 100)
		if len(tax) == 0 {
			continue
		}
		var matched []struct{ name, category, address string }
		seenName := map[string]bool{}
		for _, n := range tax {
			nLower := strings.ToLower(n.ConceptName)
			for _, kw := range keywords {
				if strings.Contains(nLower, kw) && !seenName[nLower] {
					seenName[nLower] = true
					matched = append(matched, struct{ name, category, address string }{
						name: n.ConceptName, category: n.Category,
					})
					break
				}
			}
		}
		if len(matched) == 0 {
			continue
		}
		score := float64(len(matched)) / float64(len(tax))
		ranked = append(ranked, recScore{
			owner: r.Owner, repo: r.Repo,
			score: score, totalConcepts: len(tax),
			matchedConcepts: matched,
		})
	}

	if len(ranked) == 0 {
		return readResult{Text: fmt.Sprintf("🎓 教程推荐：书架内无教程覆盖项目描述「%s」中的概念。可尝试 list_resources 查看可用教程，或用更通用的技术词重试。", desc)}
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return len(ranked[i].matchedConcepts) > len(ranked[j].matchedConcepts)
	})
	if len(ranked) > 3 {
		ranked = ranked[:3]
	}

	var b strings.Builder
	fmt.Fprintf(&b, "🎓 教程推荐（按概念覆盖度排序，项目描述: %q）\n\n", desc)
	for i, r := range ranked {
		fmt.Fprintf(&b, "### %d. %s/%s（覆盖分 %.0f%%，命中 %d/%d 概念）\n", i+1, r.owner, r.repo, r.score*100, len(r.matchedConcepts), r.totalConcepts)
		b.WriteString("覆盖概念:\n")
		for _, m := range r.matchedConcepts[:minInt(12, len(r.matchedConcepts))] {
			fmt.Fprintf(&b, "- %s (%s)\n", m.name, m.category)
		}
		if len(r.matchedConcepts) > 12 {
			fmt.Fprintf(&b, "...（另有 %d 个）\n", len(r.matchedConcepts)-12)
		}
		b.WriteString("\n")
	}
	b.WriteString("(对推荐教程调用 explore_concept(action='course_map') 看结构，read_document(section=Address) 精读覆盖概念)")
	return readResult{Text: b.String()}
}

// ── 辅助格式化函数 ──

func extractKeywords(description string) []string {
	stopWords := map[string]bool{
		"the": true, "a": true, "an": true, "for": true, "and": true, "with": true,
		"using": true, "use": true, "to": true, "of": true, "in": true, "on": true,
		"我": true, "要": true, "想": true, "一个": true, "项目": true, "应用": true,
	}
	var out []string
	seen := map[string]bool{}
	rawTokens := queryTokenRE.FindAllString(strings.ToLower(description), -1)
	for _, tok := range rawTokens {
		t := strings.TrimSpace(tok)
		if len([]rune(t)) < 2 || stopWords[t] || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) >= 8 {
			break
		}
	}
	return out
}

func isWebDocRepo(repo string, repoProfile json.RawMessage) bool {
	if strings.HasPrefix(repo, webDocPrefix) {
		return true
	}
	return getProfileString(repoProfile, "repoType", "") == "web-docs"
}

func resolveRepoDisplayName(owner, repo string, repoProfile json.RawMessage) string {
	if custom := getProfileString(repoProfile, "customDisplayName", ""); custom != "" {
		return custom
	}
	if strings.HasPrefix(repo, webDocPrefix) {
		name := strings.TrimPrefix(repo, webDocPrefix)
		name = strings.ReplaceAll(name, "-", " ")
		if len(name) > 0 {
			runes := []rune(name)
			runes[0] = []rune(strings.ToUpper(string(runes[0])))[0]
			return string(runes)
		}
		return name
	}
	return owner + "/" + repo
}

func resolveRepoSourceURL(owner, repo string, repoProfile json.RawMessage, isWeb bool) string {
	if orig := getProfileString(repoProfile, "originalUrl", ""); orig != "" {
		return orig
	}
	if isWeb {
		clean := strings.TrimPrefix(repo, webDocPrefix)
		return "https://" + clean
	}
	return "https://github.com/" + owner + "/" + repo
}

func formatTechStack(repoProfile json.RawMessage) string {
	if len(repoProfile) == 0 {
		return ""
	}
	var p struct {
		CodebaseProfile struct {
			PrimaryLanguages []string `json:"primaryLanguages"`
			Framework        *string  `json:"framework"`
		} `json:"codebaseProfile"`
	}
	if err := json.Unmarshal(repoProfile, &p); err != nil {
		return ""
	}
	langs := strings.Join(p.CodebaseProfile.PrimaryLanguages, ", ")
	if langs == "" {
		return ""
	}
	fw := "No framework"
	if p.CodebaseProfile.Framework != nil && *p.CodebaseProfile.Framework != "" {
		fw = *p.CodebaseProfile.Framework
	}
	return fmt.Sprintf("Tech Stack: %s (%s)", langs, fw)
}

func defaultBestUsedFor(displayName, owner, repo string, isWeb bool) []string {
	if isWeb {
		return []string{
			fmt.Sprintf("Consult official %s API reference, configuration, and guides", displayName),
			fmt.Sprintf("Verify accurate usage patterns and official best practices for %s", displayName),
			fmt.Sprintf("Search documentation and tutorials for %s", displayName),
		}
	}
	return []string{
		fmt.Sprintf("Learn %s/%s architectural patterns and concepts", owner, repo),
		fmt.Sprintf("Reference code examples and API usage for %s", repo),
		"Understand project structure and key features",
	}
}

func extractTeachingChapters(navTree json.RawMessage) []chapterLite {
	if len(navTree) == 0 {
		return nil
	}
	var nodes []struct {
		Title    string `json:"title"`
		Summary  string `json:"summary"`
		Children []struct {
			Title   string `json:"title"`
			Summary string `json:"summary"`
		} `json:"children"`
	}
	if err := json.Unmarshal(navTree, &nodes); err != nil {
		return nil
	}
	var chapters []chapterLite
	for _, n := range nodes {
		if n.Title != "" {
			chapters = append(chapters, chapterLite{Title: n.Title, Summary: n.Summary})
		}
		for _, c := range n.Children {
			if c.Title != "" {
				chapters = append(chapters, chapterLite{Title: c.Title, Summary: c.Summary})
			}
		}
	}
	return chapters
}

func limitChapters(chs []chapterLite, n int) []chapterLite {
	if len(chs) <= n {
		return chs
	}
	return chs[:n]
}

func getProfileString(profile json.RawMessage, key, fallback string) string {
	if len(profile) == 0 {
		return fallback
	}
	var m map[string]any
	if err := json.Unmarshal(profile, &m); err != nil {
		return fallback
	}
	if v, ok := m[key].(string); ok && v != "" {
		return v
	}
	return fallback
}

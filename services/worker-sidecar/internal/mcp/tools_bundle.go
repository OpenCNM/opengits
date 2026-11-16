package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// ── Bundle 元数据 60s TTL LRU 缓存与 singleflight 并发去重 ──

func (s *server) cachedLookupBundle(ctx context.Context, bundleID string) (*BundleMeta, error) {
	v, err := s.bundleCache.getOrLoadWithCustomTTL(bundleID, func() (any, time.Duration, error) {
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		meta, qerr := s.store.LookupBundle(loadCtx, bundleID)
		if qerr != nil {
			return nil, 0, qerr
		}
		if meta == nil {
			// 10s 负缓存（防无效 bundleID 击穿轰炸 DB）
			return (*BundleMeta)(nil), 10 * time.Second, nil
		}
		return meta, 60 * time.Second, nil
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	meta, ok := v.(*BundleMeta)
	if !ok || meta == nil {
		return nil, nil
	}
	return meta, nil
}

// ── 4 大核心工具实现 ──

func runBundleListResources(bundle *BundleMeta) readResult {
	var b strings.Builder
	slugOrID := bundle.ID
	if bundle.Slug != nil && *bundle.Slug != "" {
		slugOrID = *bundle.Slug
	}
	fmt.Fprintf(&b, "Repositories included in bundle \"%s\" (%s):\n\n", bundle.Title, slugOrID)
	for _, r := range bundle.Repositories {
		cat := "General"
		if r.Category != nil && *r.Category != "" {
			cat = *r.Category
		}
		verified := "No"
		if r.IsVerified {
			verified = "Yes"
		}
		fmt.Fprintf(&b, "- %s/%s [Category: %s, Stars: %d, Verified: %s]\n",
			r.Owner, r.Repo, cat, r.StarCount, verified)
	}
	return readResult{Text: b.String()}
}

func (s *server) runBundleReadDocument(ctx context.Context, bundle *BundleMeta, repoRef, path string, _ UserQuota) readResult {
	if strings.TrimSpace(repoRef) == "" || strings.TrimSpace(path) == "" {
		return readResult{Text: "Error: Repository and path cannot be empty.", IsError: true}
	}
	parts := strings.Split(repoRef, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return readResult{Text: "Error: repository must be in \"owner/repo\" format.", IsError: true}
	}
	owner, repo := parts[0], parts[1]
	var targetRepo *BundleRepoMeta
	for i := range bundle.Repositories {
		if strings.EqualFold(bundle.Repositories[i].Owner, owner) && strings.EqualFold(bundle.Repositories[i].Repo, repo) {
			targetRepo = &bundle.Repositories[i]
			break
		}
	}
	if targetRepo == nil {
		return readResult{Text: fmt.Sprintf("Error: Repository \"%s\" is not included in this bundle.", repoRef), IsError: true}
	}

	rs, ok := s.store.(ReadStore)
	if !ok {
		return readResult{Text: "Internal error: store does not support document reading", IsError: true}
	}

	title, docPath, content, found, err := rs.FindBundleDoc(ctx, targetRepo.ID, path)
	if err != nil || !found || content == "" {
		return readResult{Text: fmt.Sprintf("Error: Document \"%s\" not found in %s.", path, repoRef), IsError: true}
	}

	docTitle := title
	if docTitle == "" {
		docTitle = docPath
	}
	formatted := fmt.Sprintf("# %s\nRepository: %s\nSource Path: %s\n\n%s", docTitle, repoRef, docPath, capFullDocText(content))
	return readResult{Text: formatted}
}

func (s *server) runBundleSearch(ctx context.Context, bundle *BundleMeta, query, dimension string) readResult {
	if strings.TrimSpace(query) == "" {
		return readResult{Text: "Error: Query cannot be empty.", IsError: true}
	}
	if s.reader == nil {
		return readResult{Text: fmt.Sprintf("No relevant knowledge chunks found across the bundle for query: \"%s\". Try list_repositories to see included packages.", query)}
	}

	var contentTypes []string
	switch dimension {
	case "architecture":
		contentTypes = []string{"prose", "architecture", "module_overview", "architecture_diagram"}
	case "code":
		contentTypes = []string{"code", "api_reference", "function_impl", "type_definition", "entry_point"}
	case "gotcha", "gotchas", "warning":
		contentTypes = []string{"warning"}
	default:
		contentTypes = nil
	}

	type rankedHit struct {
		owner      string
		repo       string
		title      string
		path       string
		heading    string
		content    string
		similarity float64
		combined   float64
		repoID     string
	}

	resultsChan := make(chan []rankedHit, len(bundle.Repositories))
	sem := make(chan struct{}, hubFanoutConcurrency)
	var wg sync.WaitGroup

	for _, r := range bundle.Repositories {
		wg.Add(1)
		go func(repoMeta BundleRepoMeta) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			tctx, cancel := context.WithTimeout(ctx, hubFanoutTimeoutMs*time.Millisecond)
			defer cancel()

			p := SearchChunksRequest{
				RepositoryID:   repoMeta.ID,
				Query:          query,
				RawQuery:       query,
				ContentTypes:   contentTypes,
				Limit:          8,
				IncludeContent: false,
			}
			hits := s.reader.locateRepositorySections(tctx, p, 8)
			if errors.Is(tctx.Err(), context.DeadlineExceeded) {
				// In-Band 收支留痕：单仓超时该仓命中放弃——不静默缩水结果质量
				log.Printf("[bundle-search] fanout dropped repo %s/%s (per-repo timeout %dms)",
					repoMeta.Owner, repoMeta.Repo, hubFanoutTimeoutMs)
			}
			var repoHits []rankedHit
			for idx, h := range hits {
				rrf := 1.0 / (60.0 + float64(idx+1))
				heading := ""
				if h.Heading != nil {
					heading = *h.Heading
				}
				repoHits = append(repoHits, rankedHit{
					owner:      repoMeta.Owner,
					repo:       repoMeta.Repo,
					title:      h.Title,
					path:       h.Path,
					heading:    heading,
					content:    h.Snippet,
					similarity: h.Similarity,
					combined:   h.Similarity + rrf,
					repoID:     repoMeta.ID,
				})
			}
			resultsChan <- repoHits
		}(r)
	}

	wg.Wait()
	close(resultsChan)

	var allHits []rankedHit
	for rHits := range resultsChan {
		allHits = append(allHits, rHits...)
	}

	// 按结合分数 (similarity + rrfScore) 全局降序排序
	sort.SliceStable(allHits, func(i, j int) bool {
		return allHits[i].combined > allHits[j].combined
	})

	// 限制：单仓最多 3 命中，总数最多 10
	repoCounts := make(map[string]int)
	var finalHits []rankedHit
	for _, h := range allHits {
		if repoCounts[h.repoID] >= 3 {
			continue
		}
		repoCounts[h.repoID]++
		finalHits = append(finalHits, h)
		if len(finalHits) >= 10 {
			break
		}
	}

	if len(finalHits) == 0 {
		return readResult{
			Text: fmt.Sprintf("No relevant knowledge chunks found across the bundle for query: \"%s\". Try list_repositories to see included packages.", query),
		}
	}

	var b strings.Builder
	dimStr := ""
	if dimension != "" && dimension != "all" {
		dimStr = fmt.Sprintf(" [%s]", dimension)
	}
	fmt.Fprintf(&b, "Bundle Search Results for \"%s\"%s across %s:\n\n", query, dimStr, bundle.Title)
	for i, h := range finalHits {
		fmt.Fprintf(&b, "--- Result %d (%s/%s | Score: %.1f%%) ---\n", i+1, h.owner, h.repo, h.similarity*100)
		docTitle := h.title
		if docTitle == "" {
			docTitle = h.path
		}
		fmt.Fprintf(&b, "Document: %s [Path: %s]\n", docTitle, h.path)
		if h.heading != "" {
			fmt.Fprintf(&b, "Section Heading: %s\n", h.heading)
		}
		fmt.Fprintf(&b, "\n%s\n\n", h.content)
	}

	return readResult{Text: b.String()}
}

func (s *server) runBundleBreakingChanges(ctx context.Context, bundle *BundleMeta, query string) readResult {
	if strings.TrimSpace(query) == "" {
		return readResult{Text: "Error: Query cannot be empty.", IsError: true}
	}
	return s.runBundleSearch(ctx, bundle, query, "gotcha")
}

// ── Bundle 路由控制面方法 ──

func (s *server) tryNativeBundle(w http.ResponseWriter, r *http.Request, body []byte, rpc jsonRpcBody, bundleID, _ string, quota UserQuota, era eraInfo) bool {
	if rpc.Method != "tools/call" {
		return false
	}
	var params toolsCallParams
	if err := json.Unmarshal(rpc.Params, &params); err != nil {
		return false
	}
	canonical, ok := toolCanonicalName[params.Name]
	if !ok {
		canonical = params.Name
	}
	if canonical == "read" {
		canonical = "read_document"
	}
	// 原生 4 大工具维持 Go 快路径；其余 6 个深工具（outline/read/explore_concept/
	// read_symbol/search_symbols/read_source_file）不在白名单内，自然代理到 Node 共享工厂
	if canonical != "list_resources" && canonical != "search" && canonical != "read_document" && canonical != "check_breaking_changes" {
		return false
	}

	ctx := r.Context()
	bundle, err := s.cachedLookupBundle(ctx, bundleID)
	if err != nil || bundle == nil {
		writeJSONRPCError(w, http.StatusNotFound, -32000, "McpBundle not found", rpc.ID)
		return true
	}

	// 异步自增 useCount
	go func(bID string) {
		bctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.store.IncrementBundleUseCount(bctx, bID)
	}(bundle.ID)

	var args struct {
		Repository  *string  `json:"repository"`
		Path        *string  `json:"path"`
		Query       *string  `json:"query"`
		Dimension   *string  `json:"dimension"`
		TokenBudget *float64 `json:"token_budget"`
	}
	if len(params.Arguments) > 0 {
		_ = json.Unmarshal(params.Arguments, &args)
	}

	var result readResult
	switch canonical {
	case "list_resources":
		result = runBundleListResources(bundle)
	case "read_document":
		repoRef := deref(args.Repository)
		path := deref(args.Path)
		result = s.runBundleReadDocument(ctx, bundle, repoRef, path, quota)
	case "search":
		query := strings.TrimSpace(deref(args.Query))
		dim := deref(args.Dimension)
		result = s.runBundleSearch(ctx, bundle, query, dim)
	case "check_breaking_changes":
		query := strings.TrimSpace(deref(args.Query))
		result = s.runBundleBreakingChanges(ctx, bundle, query)
	default:
		return false
	}

	if !result.IsError && s.reader != nil {
		policyBudget := s.reader.readPolicyTokenBudget(ctx, canonical)
		target := deref(args.Path)
		result.Text = s.reader.applyCognitiveBudget(ctx, canonical, result.Text, quota, policyBudget, args.TokenBudget, target)
	}

	writeCallToolResult(w, rpc.ID, result, era)
	return true
}

func (s *server) handleBundleInitialize(w http.ResponseWriter, ctx context.Context, bundleID string, body []byte, id json.RawMessage) {
	bundle, err := s.cachedLookupBundle(ctx, bundleID)
	if err != nil || bundle == nil {
		writeJSONRPCError(w, http.StatusNotFound, -32000, "McpBundle not found", id)
		return
	}
	serverName := fmt.Sprintf("opengits-bundle-%s", bundle.ID)
	if bundle.Slug != nil && *bundle.Slug != "" {
		serverName = fmt.Sprintf("opengits-bundle-%s", *bundle.Slug)
	}
	writeJSONRPCResponse(w, id, InitializeResult{
		ProtocolVersion: negotiateLegacyVersion(body),
		Capabilities:    standardCapabilities(),
		ServerInfo: ServerInfo{
			Name:    serverName,
			Version: "1.0.0",
		},
	})
}

func (s *server) handleBundleToolsList(w http.ResponseWriter, id json.RawMessage, era eraInfo) {
	writePrecomputedList(w, id, era, bundleToolsListCache)
}

func (s *server) handleBundleDiscovery(w http.ResponseWriter, r *http.Request, bundleID string) {
	setMCPCors(w)
	token := extractBearerToken(r)
	if token == "" {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeRawJSON(w, http.StatusUnauthorized, `{"error":"Unauthorized: authentication required"}`)
		return
	}
	rec, err := s.cachedLookupToken(r.Context(), sha256Hex(token))
	if err != nil || rec == nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeRawJSON(w, http.StatusUnauthorized, `{"error":"Unauthorized: invalid or revoked API token"}`)
		return
	}
	s.fireAndForget(rec, r)

	if strings.TrimSpace(bundleID) == "" {
		writeRawJSON(w, http.StatusBadRequest, `{"error":"Invalid bundleId"}`)
		return
	}

	bundle, err := s.cachedLookupBundle(r.Context(), bundleID)
	if err != nil || bundle == nil {
		writeRawJSON(w, http.StatusNotFound, `{"error":"McpBundle not found"}`)
		return
	}

	slugOrID := bundle.ID
	if bundle.Slug != nil && *bundle.Slug != "" {
		slugOrID = *bundle.Slug
	}

	desc := fmt.Sprintf("MCP Bundle containing %d verified repositories", len(bundle.Repositories))
	if bundle.Description != nil && *bundle.Description != "" {
		desc = *bundle.Description
	}

	repos := make([]string, len(bundle.Repositories))
	for i, rp := range bundle.Repositories {
		repos[i] = fmt.Sprintf("%s/%s", rp.Owner, rp.Repo)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	resp := map[string]any{
		"name":              fmt.Sprintf("opengits-bundle-%s", slugOrID),
		"version":           "1.0.0",
		"description":       desc,
		"status":            "READY",
		"repositoriesCount": len(bundle.Repositories),
		"repositories":      repos,
		"endpoints": map[string]string{
			"rpc": fmt.Sprintf("/api/mcp/bundle/%s", slugOrID),
		},
		"capabilities": map[string]any{
			"tools": NativeAllToolNames,
		},
	}
	_ = json.NewEncoder(w).Encode(resp)
}

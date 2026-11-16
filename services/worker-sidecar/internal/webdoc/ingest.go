package webdoc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
)

// ingestProgressReporter 单调递增节流进度上报器（3s 节流，避免写放大）。
type ingestProgressReporter struct {
	store       IngestStore
	jobID       string
	interval    time.Duration
	mu          sync.Mutex
	lastUpdate  time.Time
	maxProgress int
}

func newIngestProgressReporter(store IngestStore, jobID string, interval time.Duration) *ingestProgressReporter {
	if interval <= 0 {
		interval = 3 * time.Second
	}
	return &ingestProgressReporter{
		store:    store,
		jobID:    jobID,
		interval: interval,
	}
}

func (r *ingestProgressReporter) Report(ctx context.Context, step string, progress int, force bool) {
	if r == nil || r.store == nil || r.jobID == "" {
		return
	}
	r.mu.Lock()
	now := time.Now()
	if !force && now.Sub(r.lastUpdate) < r.interval {
		r.mu.Unlock()
		return
	}
	if progress < r.maxProgress {
		progress = r.maxProgress
	} else {
		r.maxProgress = progress
	}
	r.lastUpdate = now
	r.mu.Unlock()

	_ = r.store.UpdateImportJobProgress(ctx, r.jobID, step, progress)
}

// RunIngest Go 原生处理 web-doc 任务（Zero-Node Worker 收官：Firecrawl 直连与 FastPath 优先）。
func RunIngest(
	ctx context.Context,
	deps IngestDeps,
	job IngestJob,
	opts IngestOptions,
) IngestOutcome {
	reporter := newIngestProgressReporter(deps.Store, job.ID, 3*time.Second)
	reporter.Report(ctx, "[1/3] 解析文档站点目标地址...", 15, true)
	targetUrl := opts.URL
	if targetUrl == "" {
		log.Printf("[webdoc-ingest] web doc target url empty for %s, fail-closed", job.ID)
		if deps.Emit != nil {
			deps.Emit("error", map[string]any{"message": "网页文档抓取失败：目标 URL 为空"})
		}
		return IngestFallback
	}

	if deps.Emit != nil {
		deps.Emit("log", map[string]any{"message": fmt.Sprintf("[1/3] 解析文档站点目标地址: %s...", targetUrl)})
	}

	maxPages := opts.MaxPages
	if maxPages <= 0 {
		maxPages = DefaultMaxPages() // 1000（对齐 Node defaultMaxPages），此前硬编码 50
	}

	userId := job.UserID

	// 三级抓取梯（对齐 Node web-doc/index.ts:85-243）：
	// ① fast-path BFS——静态站零 Firecrawl 成本（robots 合规 + 礼貌延迟内置）；
	// ② Firecrawl——快道 0 文档或失败时接管；③ 失败直接 Fail-Closed（Zero-Node Worker 终局）。
	var docs []FirecrawlDoc
	engineUsed := "fast-path"

	synthesizeOpenApiDocs := func(spec *OpenApiSpecInfo) []FirecrawlDoc {
		docTitle := spec.Title
		if docTitle == "" {
			docTitle = "API Reference"
		}
		return []FirecrawlDoc{
			{
				Path:        "index.md",
				Title:       docTitle,
				Markdown:    fmt.Sprintf("# %s\n\nOpenAPI %s 规范驱动的 API 交互文档与 MCP 接口。", docTitle, spec.Version),
				URL:         targetUrl,
				ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(spec.Version+spec.Title))),
			},
		}
	}

	// Frame 0: 落地页 DOM 拓扑嗅探与 LLM 拓扑意图裁决（优先命中确认页联合缓存）
	var topologyDecision *SiteTopologyDecision
	var seedHtml string
	var seedScan *FastPathScanResult
	var landingTopo *LandingTopology

	extractSeedHTML := func(scan *FastPathScanResult) string {
		if scan == nil {
			return ""
		}
		if scan.RawHTML != "" {
			return scan.RawHTML
		}
		if scan.Document != nil {
			if rawHtml, ok := scan.Document.Metadata["html"].(string); ok {
				return rawHtml
			}
			if rawHtml, ok := scan.Document.Metadata["rawHtml"].(string); ok {
				return rawHtml
			}
		}
		return ""
	}

	if cached := seedTopoCache.Get(targetUrl); cached != nil && cached.seedScan != nil && cached.seedScan.Document != nil {
		seedScan = cached.seedScan
		seedHtml = extractSeedHTML(seedScan)
		landingTopo = cached.landingTopo
		topologyDecision = cached.decision
		if deps.Emit != nil {
			deps.Emit("log", map[string]any{
				"message": "⚡ 复用确认页探路结果与拓扑裁决，跳过二次首包下载",
			})
		}
	} else if scan, err := ScanFastPathPage(ctx, targetUrl, 0); err == nil && scan != nil && scan.Document != nil {
		seedScan = scan
		seedHtml = extractSeedHTML(scan)
	}

	// 显式作用域（scopeMode != ''）由确认页 scout 裁决并经信封透传，
	// 此处跳过作用域覆盖决策；仅当未命中缓存且 W3C 无标准侧栏时唤醒轻量裁决提取 sidebarBlockId。
	explicitScope := opts.ScopeMode != ""
	var uidPtr *string
	if userId != "" {
		uidPtr = &userId
	}
	if landingTopo == nil && seedHtml != "" {
		landingTopo = ExtractLandingTopology(seedHtml, targetUrl)
	}
	if landingTopo != nil {
		if !explicitScope {
			if topologyDecision == nil {
				topologyDecision = ResolveSiteTopologyIntent(ctx, deps.LLM, landingTopo, uidPtr)
			}
			if deps.Emit != nil && topologyDecision != nil && (topologyDecision.PrimaryDocPrefix != "/" || len(topologyDecision.ExcludePrefixes) > 0 || len(topologyDecision.ModuleTabs) > 0) {
				deps.Emit("log", map[string]any{
					"message": fmt.Sprintf("🧭 识别站点拓扑: 锁定根作用域 %s (拦截 %d 个无关前缀, 发现 %d 个导航 Tab)",
						topologyDecision.PrimaryDocPrefix, len(topologyDecision.ExcludePrefixes), len(topologyDecision.ModuleTabs)),
				})
			}
		} else {
			if topologyDecision == nil && len(landingTopo.SidebarSections) == 0 {
				topologyDecision = ResolveSiteTopologyIntent(ctx, deps.LLM, landingTopo, uidPtr)
			}
			if deps.Emit != nil {
				deps.Emit("log", map[string]any{
					"message": fmt.Sprintf("🎯 应用确认页显式作用域 (mode=%s, primary=%s, %d 个允许前缀)，跳过作用域覆盖",
						opts.ScopeMode, opts.PrimaryDocPrefix, len(opts.AllowedPrefixes)),
				})
			}
		}
		if topologyDecision != nil && len(topologyDecision.ResolvedSidebarSections) > 0 {
			landingTopo.SidebarSections = topologyDecision.ResolvedSidebarSections
			if seedScan != nil {
				scanCp := *seedScan
				scanCp.SidebarSections = topologyDecision.ResolvedSidebarSections
				seedScan = &scanCp
			}
		}
	}

	// 构造 FastPath 抓取配置（Prefix Containment & Anti-Sinkhole）
	crawlOpts := CrawlOptions{
		MaxPages: maxPages,
		Emit:     deps.Emit,
		SeedScan: seedScan,
	}
	if topologyDecision != nil {
		crawlOpts.PrimaryDocPrefix = topologyDecision.PrimaryDocPrefix
		crawlOpts.ExcludePrefixes = topologyDecision.ExcludePrefixes
		if len(topologyDecision.SidebarAnchorHrefs) > 0 {
			crawlOpts.SidebarHints = &SidebarTrackHints{
				AnchorHrefs: topologyDecision.SidebarAnchorHrefs,
			}
		}
	}
	if opts.PrimaryDocPrefix != "" {
		crawlOpts.PrimaryDocPrefix = opts.PrimaryDocPrefix
	}
	if len(opts.AllowedPrefixes) > 0 {
		crawlOpts.AllowedPrefixes = opts.AllowedPrefixes
	}

	if crawlOpts.PrimaryDocPrefix == "" && len(crawlOpts.AllowedPrefixes) == 0 {
		natural := DeriveNaturalPrefix(targetUrl)
		if natural != "" && natural != "/" {
			crawlOpts.PrimaryDocPrefix = natural
		}
	}

	// 生效允许前缀并集（单一事实来源）：Firecrawl includePaths 与 repoProfile 落盘
	// 共用，保证"爬取受什么约束、落盘就记什么、同步就按什么过滤"三者同构。
	effectiveAllows := EffectiveAllowedPrefixes(crawlOpts.PrimaryDocPrefix, crawlOpts.AllowedPrefixes)

	var crawledNavOrder []string
	var crawlTelemetry ContentLiftTelemetry
	if fastResult := FastPathCrawlWithOptions(ctx, targetUrl, crawlOpts); len(fastResult.Docs) > 0 {
		docs = fastResult.Docs
		crawledNavOrder = fastResult.NavOrderURL
		crawlTelemetry.Merge(fastResult.Telemetry)
		if len(fastResult.SidebarSections) > 0 {
			if landingTopo == nil {
				landingTopo = &LandingTopology{EntryURL: targetUrl, SiteTitle: opts.Name}
			}
			landingTopo.SidebarSections = MergeSidebarSections(landingTopo.SidebarSections, fastResult.SidebarSections)
		}
	} else if deps.Firecrawl != nil {
		engineUsed = "firecrawl"
		if deps.Emit != nil {
			deps.Emit("log", map[string]any{"message": "[2/3] 静态解析未命中，切换 Firecrawl 深度渲染引擎抓取..."})
		}
		var crawlFilters *CrawlFilters
		includePaths := make([]string, 0, len(effectiveAllows))
		for _, allow := range effectiveAllows {
			if allow != "/" {
				includePaths = append(includePaths, allow+".*")
			}
		}

		excludePaths := make([]string, 0, len(crawlOpts.ExcludePrefixes)+2)
		// 防黑洞：Firecrawl 排除分页流
		excludePaths = append(excludePaths, ".*/(?:page|p)/\\d+.*", ".*[?&](?:page|p|pg)=\\d+.*")
		for _, ex := range crawlOpts.ExcludePrefixes {
			if ex != "" && ex != "/" {
				excludePaths = append(excludePaths, ex+".*")
			}
		}

		if len(includePaths) > 0 || len(excludePaths) > 0 {
			crawlFilters = &CrawlFilters{
				IncludePaths: includePaths,
				ExcludePaths: excludePaths,
			}
		}
		var err error
		if maxPages == 1 {
			var single *FirecrawlDoc
			single, err = deps.Firecrawl.ScrapeUrl(ctx, targetUrl)
			if err == nil && single != nil {
				docs = []FirecrawlDoc{*single}
			}
		} else {
			docs, err = deps.Firecrawl.Crawl(ctx, targetUrl, maxPages, crawlFilters)
		}
		if err != nil || len(docs) == 0 {
			if spec := DetectOpenApiSpec(ctx, targetUrl, ""); spec != nil {
				docs = synthesizeOpenApiDocs(spec)
				engineUsed = "openapi-spec"
			} else {
				log.Printf("[webdoc-ingest] fastpath and firecrawl both failed for %s (%s): %v, fail-closed", job.ID, targetUrl, err)
				errMsg := "网页文档抓取失败"
				if err != nil {
					errMsg = fmt.Sprintf("网页文档抓取失败：%v", err)
				} else {
					errMsg = "网页文档抓取失败：未检索到有效文档"
				}
				if deps.Emit != nil {
					deps.Emit("error", map[string]any{"message": errMsg})
				}
				return IngestFallback
			}
		} else {
			for _, d := range docs {
				if d.Telemetry != nil {
					crawlTelemetry.Merge(*d.Telemetry)
				} else {
					crawlTelemetry.PagesScanned++
				}
			}
		}
	} else {
		if spec := DetectOpenApiSpec(ctx, targetUrl, ""); spec != nil {
			docs = synthesizeOpenApiDocs(spec)
			engineUsed = "openapi-spec"
		} else {
			log.Printf("[webdoc-ingest] fastpath returned 0 docs and firecrawl is unconfigured for %s (%s), fail-closed", job.ID, targetUrl)
			if deps.Emit != nil {
				deps.Emit("error", map[string]any{"message": "网页文档抓取失败：FastPath 未发现有效页面且 Firecrawl 抓取服务未配置"})
			}
			return IngestFallback
		}
	}
	reporter.Report(ctx, fmt.Sprintf("[2/3] 抓取网页文档内容完成 (%s, 共 %d 页)...", engineUsed, len(docs)), 50, true)
	if deps.Emit != nil {
		deps.Emit("log", map[string]any{
			"message": fmt.Sprintf("[2/3] 抓取网页文档内容完成 (%s 引擎, 共 %d 页)", engineUsed, len(docs)),
		})
	}

	// Slow-Path LLM 蓝图聚合：仅当全站侧栏合并后仍无多分组（len(SidebarSections) <= 1）且文档足够多时唤醒，
	// 拥有多分组的标准站（如 eve.dev 5 个分组）直接确定性短路（0 Token 开销）。
	if deps.LLM != nil && len(docs) >= 8 {
		if landingTopo == nil {
			landingTopo = &LandingTopology{EntryURL: targetUrl, SiteTitle: opts.Name}
		}
		if len(landingTopo.SidebarSections) == 0 {
			flatItems := make([]WebDocNavItem, 0, len(docs))
			for i, d := range docs {
				href := d.URL
				if u, err := url.Parse(d.URL); err == nil && u.Path != "" {
					href = u.Path
				}
				if href == "" {
					href = "/" + strings.TrimSuffix(strings.TrimPrefix(d.Path, "/"), ".md")
				}
				title := d.Title
				if title == "" {
					title = docFallbackTitle(d.Path)
				}
				flatItems = append(flatItems, WebDocNavItem{
					Title: title,
					Href:  href,
					Order: i + 1,
				})
			}
			landingTopo.SidebarSections = []WebDocSection{{
				Title: landingTopo.SiteTitle,
				Order: 1,
				Items: flatItems,
			}}
		}
		if len(landingTopo.SidebarSections) <= 1 {
			var uidPtr *string
			if userId != "" {
				uidPtr = &userId
			}
			landingTopo.SidebarSections = SynthesizeWebDocBlueprint(ctx, deps.LLM, landingTopo, uidPtr)
		}
	}

	// Phase 4: 非对称站点级容器骨架探测（仅在高频降级且配置 LLM 时单次触发）
	if (crawlTelemetry.CardGateFailures+crawlTelemetry.AnchorDegradations) >= containerProbeMinDegradations && deps.LLM != nil {
		rawHTMLs := collectRawHTMLSamples(docs, 12)
		skeletons := ExtractDegradedContainerSkeletons(rawHTMLs, containerProbeMaxSkeletons)
		if len(skeletons) > 0 {
			var uidPtr *string
			if userId != "" {
				uidPtr = &userId
			}
			degradedTotal := crawlTelemetry.CardGateFailures + crawlTelemetry.AnchorDegradations
			rules := ProbeSiteContainerMappings(ctx, deps.LLM, targetUrl, skeletons, degradedTotal, uidPtr)
			if len(rules) > 0 {
				var applied int
				docs, applied = ApplySiteContainerRulesToDocs(docs, rules)
				crawlTelemetry.ProbedRulesApplied += applied
			}
		}
	}

	// 同源图片本地持久化（对齐 Node persistSameOriginImages：COEP 防裂图、
	// 防盗链站保图；失败静默保留原链接，不阻断导入）
	if deps.Emit != nil {
		deps.Emit("log", map[string]any{
			"message": "[3/3] 正在持久化同源图片资产与样式...",
		})
	}
	docs = PersistSameOriginImages(ctx, strings.ToLower(job.Owner), strings.ToLower(job.Repo), docs, targetUrl)

	// 聚合 contentHash 计算 aggregate sha
	var sb strings.Builder
	for i, d := range docs {
		if i > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(d.Path)
		sb.WriteByte(':')
		sb.WriteString(d.ContentHash)
	}
	h := sha256.Sum256([]byte(sb.String()))
	sha := hex.EncodeToString(h[:])

	branch := opts.Branch
	if branch == "" {
		branch = job.Branch
	}
	edition := opts.Edition
	category := opts.Category
	if category == "" {
		category = "Web Docs"
	}
	tags := opts.Tags
	if tags == nil {
		tags = []string{}
	}

	// 探测并集成 OpenAPI / Swagger 规范 (1:1 API Reference 与 MCP 增强)
	if seedHtml == "" && len(docs) > 0 {
		if rawHtml, ok := docs[0].Metadata["html"].(string); ok {
			seedHtml = rawHtml
		} else if rawHtml, ok := docs[0].Metadata["rawHtml"].(string); ok {
			seedHtml = rawHtml
		}
	}
	if landingTopo == nil && seedHtml != "" {
		landingTopo = ExtractLandingTopology(seedHtml, targetUrl)
		var uidPtr *string
		if userId != "" {
			uidPtr = &userId
		}
		if topologyDecision == nil {
			topologyDecision = ResolveSiteTopologyIntent(ctx, deps.LLM, landingTopo, uidPtr)
		}
		if landingTopo != nil && len(landingTopo.SidebarSections) <= 1 && deps.LLM != nil {
			landingTopo.SidebarSections = SynthesizeWebDocBlueprint(ctx, deps.LLM, landingTopo, uidPtr)
		}
	}
	openApiSpec := DetectOpenApiSpec(ctx, targetUrl, seedHtml)
	if openApiSpec != nil {
		if deps.Emit != nil {
			deps.Emit("log", map[string]any{
				"message": fmt.Sprintf("🎯 成功嗅探到 OpenAPI 规范 (%s: %s)，开启 1:1 API Reference 与 MCP 增强", openApiSpec.Version, openApiSpec.Title),
			})
		}
		// 若抓取到的文档中尚无独立 API Reference 节点，增补一章以便导航树与路由显式定位
		hasApiDoc := false
		for _, d := range docs {
			lp := strings.ToLower(d.Path)
			if strings.Contains(lp, "api-reference") || strings.Contains(lp, "openapi") || lp == "api.md" {
				hasApiDoc = true
				break
			}
		}
		if !hasApiDoc && len(docs) > 1 {
			apiTitle := "API Reference"
			if openApiSpec.Title != "" {
				apiTitle = openApiSpec.Title + " API"
			}
			docs = append(docs, FirecrawlDoc{
				Path:        "api-reference.md",
				Title:       apiTitle,
				Markdown:    fmt.Sprintf("# %s\n\nOpenAPI %s 交互式接口文档与调用视窗。", apiTitle, openApiSpec.Version),
				URL:         openApiSpec.SpecURL,
				ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte("api-reference:"+openApiSpec.Version))),
			})
		}
	}

	// 1. 构建规则导航树与 Profile（navTree 物化封顶 maxPages：写侧护栏，
	//    防止超大爬取把整棵树 jsonb 塞爆 Repository 行）
	if deps.Emit != nil {
		deps.Emit("log", map[string]any{
			"message": "[3/3] 构建文档大纲导航树与知识目录...",
		})
	}
	var navJSON []byte = []byte("[]")
	if deps.BuildNavTree != nil {
		nodes := make([]GitNode, len(docs))
		for i, d := range docs {
			nodes[i] = GitNode{Path: d.Path, Type: "blob"}
		}
		navJSON = deps.BuildNavTree(nodes, job.Owner, job.Repo, maxPages)
		if len(navJSON) == 0 {
			navJSON = []byte("[]")
		}
	}

	siteTitle := strings.TrimSpace(stripInvisibleFormatRunes(opts.Name))
	if siteTitle == "" && seedHtml != "" {
		siteTitle = ExtractWebSiteBrandFromHTML(seedHtml, targetUrl)
	}
	if siteTitle == "" && len(docs) > 0 && docs[0].Metadata != nil {
		if raw, ok := docs[0].Metadata["html"].(string); ok && raw != "" {
			siteTitle = ExtractWebSiteBrandFromHTML(raw, targetUrl)
		} else if raw, ok := docs[0].Metadata["rawHtml"].(string); ok && raw != "" {
			siteTitle = ExtractWebSiteBrandFromHTML(raw, targetUrl)
		}
	}
	if siteTitle == "" && len(docs) > 0 && docs[0].Title != "" {
		if brand := extractBrandFromTitleTag(docs[0].Title); brand != "" {
			siteTitle = brand
		}
	}
	if siteTitle == "" || IsGenericWebDocTitle(siteTitle) || IsPageSlugWebDocTitle(siteTitle, targetUrl) {
		siteTitle = CleanHostFromURL(targetUrl)
	}
	if siteTitle == "" {
		siteTitle = job.Repo
	}

	siteDescription := ""
	if seedHtml != "" {
		siteDescription = ExtractWebSiteDescriptionFromHTML(seedHtml)
	}
	if siteDescription == "" && len(docs) > 0 && docs[0].Metadata != nil {
		if raw, ok := docs[0].Metadata["html"].(string); ok && raw != "" {
			siteDescription = ExtractWebSiteDescriptionFromHTML(raw)
		} else if raw, ok := docs[0].Metadata["rawHtml"].(string); ok && raw != "" {
			siteDescription = ExtractWebSiteDescriptionFromHTML(raw)
		}
	}

	profileMap := map[string]any{
		"sourceType":  "web",
		"originalUrl": targetUrl,
		"siteTitle":   siteTitle,
		"engineUsed":  engineUsed,
		"pageCount":   len(docs),
	}
	if siteDescription != "" {
		profileMap["description"] = siteDescription
	}
	// 作用域单一收敛落盘尾（Single Convergence Tail）：
	// 无论显式作用域还是 auto 裁决，均按最终生效的 crawlOpts 同构落盘，
	// 供 web-sync 增量过滤与复用/去重作用域核验消费（isURLAllowed 同一套语义）。
	if crawlOpts.PrimaryDocPrefix != "" {
		profileMap["primaryDocPrefix"] = crawlOpts.PrimaryDocPrefix
	}
	if len(effectiveAllows) > 0 {
		profileMap["allowedPrefixes"] = effectiveAllows
	}
	if len(crawlOpts.ExcludePrefixes) > 0 {
		profileMap["excludePrefixes"] = crawlOpts.ExcludePrefixes
	}
	if len(opts.ModuleTabs) > 0 {
		profileMap["moduleTabs"] = opts.ModuleTabs
	} else if topologyDecision != nil && len(topologyDecision.ModuleTabs) > 0 {
		profileMap["moduleTabs"] = topologyDecision.ModuleTabs
	}
	if topologyDecision != nil && topologyDecision.ApiReferenceURL != "" {
		profileMap["apiReferenceUrl"] = topologyDecision.ApiReferenceURL
	}
	if openApiSpec != nil {
		profileMap["hasOpenApi"] = true
		profileMap["openApiTitle"] = openApiSpec.Title
		profileMap["openApiUrl"] = openApiSpec.SpecURL
	}
	navOrder := make([]string, 0, len(crawledNavOrder)+len(docs))
	navSeen := make(map[string]bool, len(crawledNavOrder)+len(docs))
	for _, u := range crawledNavOrder {
		if u != "" && !navSeen[u] {
			navSeen[u] = true
			navOrder = append(navOrder, u)
		}
	}
	for _, d := range docs {
		if d.URL != "" && !navSeen[d.URL] {
			navSeen[d.URL] = true
			navOrder = append(navOrder, d.URL)
		}
	}
	profileMap["navOrderUrls"] = navOrder

	// 预先完成并发 Markdown 清洗与 Phase 3 goldmark AST 闸门改写统计，确保遥测计数同步写入 profileJSON
	sanitized := make([]string, len(docs))
	if len(docs) > 0 {
		rewriteCounts := make([]int, len(docs))
		g, _ := errgroup.WithContext(ctx)
		g.SetLimit(4)
		for i := range docs {
			i := i
			g.Go(func() error {
				sanitized[i], rewriteCounts[i] = SanitizeMarkdownWithStats(docs[i].Path, docs[i].Markdown)
				return nil
			})
		}
		_ = g.Wait()
		for _, c := range rewriteCounts {
			crawlTelemetry.GoldmarkLinkRewrites += c
		}
	}
	if crawlTelemetry.PagesScanned > 0 || crawlTelemetry.GoldmarkLinkRewrites > 0 || crawlTelemetry.ProbedRulesApplied > 0 {
		log.Printf("[webdoc-ingest] content lift telemetry for %s/%s: pages=%d cards=%d callouts=%d codeGroups=%d accordions=%d steps=%d gateFailures=%d anchorDegrads=%d goldmarkRewrites=%d svgsStripped=%d svgsAssetized=%d probedRules=%d",
			job.Owner, job.Repo,
			crawlTelemetry.PagesScanned, crawlTelemetry.CardsLifted, crawlTelemetry.CalloutsLifted,
			crawlTelemetry.CodeGroupsLifted, crawlTelemetry.AccordionsLifted, crawlTelemetry.StepsLifted,
			crawlTelemetry.CardGateFailures, crawlTelemetry.AnchorDegradations, crawlTelemetry.GoldmarkLinkRewrites,
			crawlTelemetry.SvgsStripped, crawlTelemetry.SvgsAssetized, crawlTelemetry.ProbedRulesApplied)
	}

	profileJSON, err := json.Marshal(profileMap)
	if err != nil {
		profileJSON = []byte("{}")
	}

	// 2. UpsertRepositoryRow
	shaPtr := &sha
	repoId, err := deps.Store.UpsertRepositoryRow(ctx, IngestRepoParams{
		Owner:       strings.ToLower(job.Owner),
		Repo:        strings.ToLower(job.Repo),
		Branch:      branch,
		Edition:     edition,
		IsPublic:    opts.IsPublic,
		Category:    category,
		Tags:        tags,
		GitSha:      shaPtr,
		NavTreeJSON: navJSON,
		ProfileJSON: profileJSON,
	})
	if err != nil {
		log.Printf("[webdoc-ingest] upsert repository row failed for %s: %v", job.ID, err)
		return IngestFallback
	}

	// 3. UpsertOwnedDocument（经清洗漏斗：Firecrawl markdown 不裸存 PROCESSED）
	reporter.Report(ctx, "[3/3] 正在持久化文档与大纲...", 80, true)
	if deps.Emit != nil {
		deps.Emit("log", map[string]any{
			"message": fmt.Sprintf("[3/3] 正在清洗正文并持久化到课程树 (共 %d 篇)...", len(docs)),
		})
	}
	docOwnerId := DocOwnerIdFor(opts.IsPublic, userId)
	for i, d := range docs {
		_, err := deps.Store.UpsertOwnedDocument(ctx, IngestDocParams{
			RepositoryId: repoId,
			Path:         d.Path,
			OwnerUserId:  docOwnerId,
			Title:        d.Title,
			Content:      sanitized[i],
			Lang:         opts.TargetLanguage,
			Status:       "PROCESSED", // 严格对齐 DocumentStatus ENUM
		})
		if err != nil {
			log.Printf("[webdoc-ingest] upsert document failed for %s: %v", d.Path, err)
			return IngestFallback
		}
		if deps.Emit != nil && (i == 0 || (i+1)%5 == 0 || i+1 == len(docs)) {
			title := d.Title
			if title == "" {
				title = d.Path
			}
			deps.Emit("log", map[string]any{
				"message": fmt.Sprintf("[3/3] 文档已入库 (%d/%d): %s", i+1, len(docs), title),
			})
		}
	}

	// 3. RegisterImportSnapshot
	_, err = deps.Store.RegisterImportSnapshot(ctx, IngestSnapshotParams{
		UserId:       userId,
		RepositoryId: repoId,
		Owner:        strings.ToLower(job.Owner),
		Repo:         strings.ToLower(job.Repo),
		Branch:       branch,
		Sha:          sha,
		DocOwnerId:   docOwnerId,
	})
	if err != nil {
		log.Printf("[webdoc-ingest] register snapshot failed for %s: %v", job.ID, err)
		return IngestFallback
	}

	// 4. 持久化正典激活大纲 (TutorialOutline)，单一持久化尾原子落盘，彻底根除读侧伪自愈与字典序倒置
	draft := HydrateWebDocOutline(landingTopo, docs, targetUrl)
	if len(draft.Chapters) > 0 {
		outlineId, err := deps.Store.StoreOutlineDraft(ctx, repoId, draft, true)
		if err != nil {
			log.Printf("[webdoc-ingest] store outline draft failed for %s: %v", repoId, err)
		} else {
			log.Printf("[webdoc-ingest] active outline stored %s (parts=%d, chapters=%d)",
				outlineId, len(draft.Parts), len(draft.Chapters))
		}
	}

	// 5. 结算
	if deps.Settle != nil {
		if err := deps.Settle(ctx, job.ID, SettleResult{
			RepositoryID:         repoId,
			QueuedDocumentsCount: len(docs),
			GitSha:               sha,
		}); err != nil {
			log.Printf("[webdoc-ingest] settle failed for %s: %v", job.ID, err)
			return IngestFallback
		}
	}

	if deps.Emit != nil {
		deps.Emit("log", map[string]any{
			"message": fmt.Sprintf("✓ 文档站点全部解析入库完成 (共 %d 篇文档已就绪)", len(docs)),
		})
	}
	reporter.Report(ctx, "文档站点导入完成", 100, true)
	log.Printf("[webdoc-ingest] web-doc job %s done: %s/%s docs=%d (go native firecrawl)", job.ID, job.Owner, job.Repo, len(docs))
	return IngestDone
}

func docFallbackTitle(path string) string {
	parts := strings.Split(path, "/")
	name := parts[len(parts)-1]
	if name == "" {
		return path
	}
	name = strings.TrimSuffix(name, ".md")
	name = strings.TrimSuffix(name, ".mdx")
	return name
}

// HydrateWebDocOutline 将抓取到的文档集合回填至侧栏蓝图模板，生成正典 TutorialOutline 草稿。
// 遵循确定性收敛漏斗与单一持久化尾契约：
// 1. 蓝图中的每一个 Item 优先通过 URL / CanonicalDocPath 绑定已抓取的 Document；
// 2. 爬取到的孤儿文档（正文爬到但未出现在侧栏模板中的文档）自动收集并追加至末尾独立 Part（📎 附录与延伸文档）；
// 3. 全局 teachingOrder 严格按作者主线物理顺序自增，绝不降级到字典序。
func HydrateWebDocOutline(landingTopo *LandingTopology, docs []FirecrawlDoc, targetURL string) OutlineDraft {
	draft := OutlineDraft{
		Parts:    []OutlinePart{},
		Chapters: []StoredOutlineChapter{},
	}
	if len(docs) == 0 {
		return draft
	}

	docByPath := make(map[string]FirecrawlDoc, len(docs))
	docByHref := make(map[string]string)
	visitedDocs := make(map[string]bool, len(docs))
	visitedHashes := make(map[string]bool, len(docs))

	for _, d := range docs {
		docByPath[d.Path] = d
		docByHref[d.URL] = d.Path
		docByHref[d.Path] = d.Path

		if u, err := url.Parse(d.URL); err == nil && u.Path != "" {
			docByHref[u.Path] = d.Path
			if len(u.Path) > 1 {
				docByHref[strings.TrimSuffix(u.Path, "/")] = d.Path
			}
		}

		canon := CanonicalDocPathFromUrl(d.URL)
		if canon != "" {
			docByHref[canon] = d.Path
		}

		cleanPath := strings.TrimSuffix(strings.TrimPrefix(d.Path, "/"), ".md")
		cleanPath = strings.TrimSuffix(cleanPath, ".mdx")
		docByHref["/"+cleanPath] = d.Path
		docByHref[cleanPath] = d.Path
	}

	findDocPath := func(href string) (string, bool) {
		href = strings.TrimSpace(href)
		if href == "" {
			return "", false
		}
		if p, ok := docByHref[href]; ok {
			return p, true
		}
		trimmed := strings.TrimSuffix(href, "/")
		if p, ok := docByHref[trimmed]; ok {
			return p, true
		}
		if u, err := url.Parse(href); err == nil && u.Path != "" {
			cleanHref := u.Path
			if p, ok := docByHref[cleanHref]; ok {
				return p, true
			}
			if p, ok := docByHref[strings.TrimSuffix(cleanHref, "/")]; ok {
				return p, true
			}
		}
		canon := CanonicalDocPathFromUrl(href)
		if _, ok := docByPath[canon]; ok {
			return canon, true
		}
		if p, ok := docByHref[canon]; ok {
			return p, true
		}
		noSlash := strings.TrimPrefix(trimmed, "/")
		if _, ok := docByPath[noSlash+".md"]; ok {
			return noSlash + ".md", true
		}
		if _, ok := docByPath[noSlash+".mdx"]; ok {
			return noSlash + ".mdx", true
		}
		return "", false
	}

	chapterOrder := 0

	var sections []WebDocSection
	if landingTopo != nil && len(landingTopo.SidebarSections) > 0 {
		sections = landingTopo.SidebarSections
	}

	var appendItemNodes func(it WebDocNavItem, nodes *[]OutlineNode)
	appendItemNodes = func(it WebDocNavItem, nodes *[]OutlineNode) {
		if p, ok := findDocPath(it.Href); ok && !visitedDocs[p] {
			title := it.Title
			if title == "" {
				if d, exists := docByPath[p]; exists && d.Title != "" {
					title = d.Title
				} else {
					title = docFallbackTitle(p)
				}
			}
			*nodes = append(*nodes, OutlineNode{
				Title:      title,
				NodeType:   "doc",
				SourcePath: p,
			})
			visitedDocs[p] = true
			if d, exists := docByPath[p]; exists && d.ContentHash != "" {
				visitedHashes[d.ContentHash] = true
			}
		}
		for _, ch := range it.Children {
			appendItemNodes(ch, nodes)
		}
	}

	for _, sec := range sections {
		secChaptersAdded := 0
		for _, item := range sec.Items {
			var nodes []OutlineNode
			appendItemNodes(item, &nodes)

			if len(nodes) > 0 {
				chapterOrder++
				secChaptersAdded++
				chTitle := item.Title
				if chTitle == "" {
					chTitle = nodes[0].Title
				}
				if chTitle == "" {
					chTitle = docFallbackTitle(nodes[0].SourcePath)
				}
				draft.Chapters = append(draft.Chapters, StoredOutlineChapter{
					Title:         chTitle,
					ChapterType:   "doc",
					TeachingOrder: chapterOrder,
					Nodes:         nodes,
					PartTitle:     sec.Title,
				})
			}
		}
		if secChaptersAdded > 0 {
			draft.Parts = append(draft.Parts, OutlinePart{
				Title:         sec.Title,
				TeachingOrder: len(draft.Parts) + 1,
			})
		}
	}

	// 孤儿文档自动收编追加至独立 Part（📎 附录与延伸文档）；跳过跳转别名页（相同 ContentHash 已收录）
	var orphanDocs []FirecrawlDoc
	for _, d := range docs {
		if !visitedDocs[d.Path] {
			if d.ContentHash != "" && visitedHashes[d.ContentHash] {
				continue
			}
			if d.ContentHash != "" {
				visitedHashes[d.ContentHash] = true
			}
			orphanDocs = append(orphanDocs, d)
		}
	}

	if len(orphanDocs) > 0 {
		if len(draft.Parts) > 0 {
			appendixPartTitle := "📎 附录与延伸文档"
			draft.Parts = append(draft.Parts, OutlinePart{
				Title:         appendixPartTitle,
				TeachingOrder: len(draft.Parts) + 1,
			})
			for _, od := range orphanDocs {
				chapterOrder++
				title := od.Title
				if title == "" {
					title = docFallbackTitle(od.Path)
				}
				draft.Chapters = append(draft.Chapters, StoredOutlineChapter{
					Title:         title,
					ChapterType:   "doc",
					TeachingOrder: chapterOrder,
					Nodes: []OutlineNode{{
						Title:      title,
						NodeType:   "doc",
						SourcePath: od.Path,
					}},
					PartTitle: appendixPartTitle,
				})
			}
		} else {
			// 全站无 Part 蓝图时，直接按爬取物理出现顺序平铺
			for _, od := range orphanDocs {
				chapterOrder++
				title := od.Title
				if title == "" {
					title = docFallbackTitle(od.Path)
				}
				draft.Chapters = append(draft.Chapters, StoredOutlineChapter{
					Title:         title,
					ChapterType:   "doc",
					TeachingOrder: chapterOrder,
					Nodes: []OutlineNode{{
						Title:      title,
						NodeType:   "doc",
						SourcePath: od.Path,
					}},
				})
			}
		}
	}

	// 剪裁没有任何章节的空 Part
	usedParts := make(map[string]bool)
	for _, ch := range draft.Chapters {
		if ch.PartTitle != "" {
			usedParts[ch.PartTitle] = true
		}
	}
	var filteredParts []OutlinePart
	for _, p := range draft.Parts {
		if usedParts[p.Title] {
			p.TeachingOrder = len(filteredParts) + 1
			filteredParts = append(filteredParts, p)
		}
	}
	draft.Parts = filteredParts

	return draft
}

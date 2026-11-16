package webdoc

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// fast-path BFS 抓取梯子（移植 apps/client/src/engine/web-doc/index.ts:97-155）：
// 批并发 4（maxConcurrent）、批间礼貌延迟（首批不延迟）、seen 归一化去重、
// 队列增长因子 2（深链队列不超 maxPages*2）、navOrderUrls 参与导航排序。
// 静态站零 Firecrawl 成本直出；入口非静态返回 0 文档交由上层降级梯。
//
// 346 架构演进与硬防线：
// 1. Prefix Containment（路径前缀收敛）：限制爬虫 BFS 仅在入口所属业务文档前缀内，
//    杜绝逃逸到 /changelog, /benchmarks, /pricing 等全域非核心页面；
// 2. Anti-Sinkhole Guard（分页黑洞拦截）：截断 /page/\d+, ?page= 等单向无限列表；
// 3. 严格失效封闭（Fail-Closed）：无 LLM 或解析异常时确定性收敛至自然父级路径。
// ─────────────────────────────────────────────────────────────

const (
	fastPathMaxConcurrent = 4
	fastPathQueueGrowth   = 2
)

// Common doc directory names indicating documentation scope
var docScopeIndicators = map[string]bool{
	"docs":          true,
	"doc":           true,
	"guide":         true,
	"guides":        true,
	"tutorial":      true,
	"tutorials":     true,
	"manual":        true,
	"reference":     true,
	"api":           true,
	"learn":         true,
	"documentation": true,
	"wiki":          true,
}

// DeriveNaturalPrefix 从入口 URL 推导自然业务作用域前缀。
// 规则：
// 1. 若 URL 无 path 或仅为 "/"，返回 "/"；
// 2. 若第一段是语言代码（如 en, zh, zh-cn）且存在第二段，组合前缀（如 /en/docs）；
// 3. 若第一段是常见文档目录（如 docs, guide, manual 等）或总段数 > 1，提取首段目录作为前缀（如 /docs）；
// 4. 若为单段普通页面（如 /getting-started），返回 "/" 保障同级页面可达。
func DeriveNaturalPrefix(entryURL string) string {
	u, err := url.Parse(strings.TrimSpace(entryURL))
	if err != nil || u.Path == "" || u.Path == "/" {
		return "/"
	}
	clean := strings.Trim(u.Path, "/")
	if clean == "" {
		return "/"
	}
	parts := strings.Split(clean, "/")
	if len(parts) == 0 {
		return "/"
	}

	firstLower := strings.ToLower(parts[0])
	if isLocalePrefix(firstLower) && len(parts) > 1 {
		secondLower := strings.ToLower(parts[1])
		if docScopeIndicators[secondLower] || len(parts) > 2 {
			return "/" + parts[0] + "/" + parts[1]
		}
		return "/" + parts[0]
	}

	if docScopeIndicators[firstLower] || len(parts) > 1 {
		return "/" + parts[0]
	}
	return "/"
}

func isLocalePrefix(s string) bool {
	if len(s) == 2 {
		return true // en, zh, ja, de, fr, es, etc.
	}
	if len(s) == 5 && (s[2] == '-' || s[2] == '_') {
		return true // zh-cn, pt-br, en-us, etc.
	}
	return false
}

// HasPathPrefix 路径段边界安全前缀匹配（避免 /docs 误伤 /documentation 或 /docs-other）。
func HasPathPrefix(path, prefix string) bool {
	path = strings.TrimSpace(path)
	prefix = strings.TrimSpace(prefix)
	if prefix == "" || prefix == "/" {
		return true
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	prefix = strings.TrimSuffix(prefix, "/")
	if path == prefix {
		return true
	}
	return strings.HasPrefix(path, prefix+"/")
}

// IsPaginationURL 判定是否为分页流归档链接（阻断 /page/2...44 等分页黑洞）。
func IsPaginationURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	if mdpat.PaginationPatternRe.MatchString(u.Path) {
		return true
	}
	if u.RawQuery != "" && mdpat.PaginationQueryRe.MatchString(u.RawQuery) {
		return true
	}
	return false
}

func isURLAllowed(raw string, allowedPrefixes, excludePrefixes []string) bool {
	if IsPaginationURL(raw) {
		return false
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}

	// 排除前缀硬拦截（如 /changelog, /benchmarks, /pricing, /blog）
	for _, ex := range excludePrefixes {
		if ex != "" && HasPathPrefix(u.Path, ex) {
			return false
		}
	}

	// 允许前缀校验（若指定了允许前缀集，则必须落在其中之一）
	if len(allowedPrefixes) > 0 {
		matched := false
		for _, allow := range allowedPrefixes {
			if allow != "" && HasPathPrefix(u.Path, allow) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

// FastPathCrawlResult fast-path 批量抓取产物。
type FastPathCrawlResult struct {
	Docs            []FirecrawlDoc
	NavOrderURL     []string
	SidebarSections []WebDocSection
	Telemetry       ContentLiftTelemetry
}

// FastPathEnabled WEB_CRAWLER_FAST_PATH !== 'false'（默认 true，对齐 Node
// 历史默认值——TS 侧 webCrawler 配置键已退役，env 为 SSOT）。
func FastPathEnabled() bool {
	return os.Getenv("WEB_CRAWLER_FAST_PATH") != "false"
}

// EffectiveAllowedPrefixes 计算实际生效的允许前缀并集（单一事实来源）：
// [PrimaryDocPrefix] ∪ AllowedPrefixes，保序去重、剔除空串。
// 爬取过滤（isURLAllowed）、Firecrawl includePaths 与 repoProfile 作用域落盘
// 三方共用该并集，杜绝"爬取受限而落盘为空/同步漏风"的分叉漂移。
func EffectiveAllowedPrefixes(primary string, allows []string) []string {
	out := make([]string, 0, len(allows)+1)
	if primary != "" {
		out = append(out, primary)
	}
	for _, p := range allows {
		if p != "" && p != primary {
			out = append(out, p)
		}
	}
	return out
}

// FastPathCrawlWithOptions 带拓扑作用域与黑洞守卫的高级快道抓取。
func FastPathCrawlWithOptions(ctx context.Context, entryURL string, opts CrawlOptions) *FastPathCrawlResult {
	if !FastPathEnabled() {
		return &FastPathCrawlResult{}
	}
	maxPages := opts.MaxPages
	if maxPages <= 0 {
		maxPages = 1
	}
	emit := opts.Emit

	var seed *FastPathScanResult
	if opts.SeedScan != nil && opts.SeedScan.IsStatic && opts.SeedScan.Document != nil {
		seed = opts.SeedScan
	} else {
		var err error
		seed, err = ScanFastPathPage(ctx, entryURL, 0)
		if err != nil || seed == nil || !seed.IsStatic || seed.Document == nil {
			return &FastPathCrawlResult{}
		}
	}

	// 计算有效允许前缀与排除前缀（Prefix Containment）
	allowedPrefixes := EffectiveAllowedPrefixes(opts.PrimaryDocPrefix, opts.AllowedPrefixes)
	if len(allowedPrefixes) == 0 {
		natural := DeriveNaturalPrefix(entryURL)
		if natural != "" && natural != "/" {
			allowedPrefixes = append(allowedPrefixes, natural)
		}
	}
	excludePrefixes := opts.ExcludePrefixes

	type pageResult struct {
		doc      *FastPathDocument
		nextURLs []string
	}

	seen := map[string]bool{normalizeCrawlURL(entryURL): true}
	queue := []string{}
	docs := make([]FirecrawlDoc, 0, 8)
	navOrder := map[string]int{} // URL → 首现顺序
	for i, u := range seed.NavOrderURLs {
		if _, ok := navOrder[u]; !ok {
			navOrder[u] = i
		}
	}
	mergedSections := MergeSidebarSections(seed.SidebarSections, nil)
	var aggTel ContentLiftTelemetry

	pushDoc := func(d *FastPathDocument) {
		docs = append(docs, FirecrawlDoc{
			Path:        d.Path,
			Title:       d.Title,
			Markdown:    d.Markdown,
			URL:         d.URL,
			ContentHash: d.ContentHash,
			Headings:    fastHeadingsToFirecrawl(d.Headings),
			Metadata:    d.Metadata,
		})
	}
	pushDoc(seed.Document)
	aggTel.Merge(seed.Telemetry)

	if emit != nil {
		title := seed.Document.Title
		if title == "" {
			title = entryURL
		}
		emit("log", map[string]any{
			"message": fmt.Sprintf("[1/3] 识别静态入口: 《%s》，发现 %d 个文档链接", title, len(seed.DiscoveredURLs)),
		})
	}

	enqueue := func(urls []string) {
		for _, raw := range urls {
			if len(docs)+len(queue) >= maxPages*fastPathQueueGrowth {
				return
			}
			norm := normalizeCrawlURL(raw)
			if norm == "" || seen[norm] {
				continue
			}
			if !isURLAllowed(raw, allowedPrefixes, excludePrefixes) {
				continue
			}
			if !IsUrlAllowedByRobots(ctx, raw) {
				continue
			}
			seen[norm] = true
			queue = append(queue, raw)
		}
	}
	enqueue(seed.DiscoveredURLs)


	batchIndex := 0
	for len(queue) > 0 && len(docs) < maxPages {
		if ctx.Err() != nil {
			break
		}
		// 批间礼貌延迟（首批不延迟；≤0 禁用）
		if batchIndex > 0 {
			if d := PolitenessDelayMs(); d > 0 {
				select {
				case <-ctx.Done():
					return &FastPathCrawlResult{
						Docs:            docs,
						NavOrderURL:     orderedNavURLs(navOrder),
						SidebarSections: mergedSections,
						Telemetry:       aggTel,
					}
				case <-time.After(time.Duration(d) * time.Millisecond):
				}
			}
		}
		batchIndex++

		batch := queue
		if len(batch) > fastPathMaxConcurrent {
			batch = batch[:fastPathMaxConcurrent]
		}
		queue = queue[len(batch):]

		results := make([]*FastPathScanResult, len(batch))
		var wg sync.WaitGroup
		for i, u := range batch {
			wg.Add(1)
			go func(idx int, target string) {
				defer wg.Done()
				res, err := ScanFastPathPageWithHints(ctx, target, 0, opts.SidebarHints)
				if err == nil {
					results[idx] = res
				}
			}(i, u)
		}
		wg.Wait()

		for _, res := range results {
			if res == nil || !res.IsStatic || res.Document == nil {
				continue
			}
			if len(docs) >= maxPages {
				break
			}
			pushDoc(res.Document)
			aggTel.Merge(res.Telemetry)
			for j, u := range res.NavOrderURLs {
				if _, ok := navOrder[u]; !ok {
					navOrder[u] = len(seed.NavOrderURLs) + j
				}
			}
			if len(res.SidebarSections) > 0 {
				mergedSections = MergeSidebarSections(mergedSections, res.SidebarSections)
			}
			enqueue(res.DiscoveredURLs)
		}

		if emit != nil {
			lastTitle := ""
			for k := len(results) - 1; k >= 0; k-- {
				if results[k] != nil && results[k].Document != nil && results[k].Document.Title != "" {
					lastTitle = results[k].Document.Title
					break
				}
			}
			// 诚实分母：已完成 + 待抓（已发现未抓）页数，以 maxPages 封顶。
			// 按预算上限（如 200）展示会让小站进度永远停在 17% 上下，
			// 用户误判为卡死；发现数会随 BFS 前沿扩张小幅上修，远比恒定 cap 真实。
			discoveredTotal := len(docs) + len(queue)
			if discoveredTotal > maxPages {
				discoveredTotal = maxPages
			}
			msg := fmt.Sprintf("[2/3] 正在抓取文档页面 (%d/%d)...", len(docs), discoveredTotal)
			if lastTitle != "" {
				msg = fmt.Sprintf("[2/3] 正在抓取: %s (%d/%d)...", lastTitle, len(docs), discoveredTotal)
			}
			emit("log", map[string]any{
				"message": msg,
			})
		}
	}
	return &FastPathCrawlResult{
		Docs:            docs,
		NavOrderURL:     orderedNavURLs(navOrder),
		SidebarSections: mergedSections,
		Telemetry:       aggTel,
	}
}

// orderedNavURLs 按首现顺序输出导航链接。
func orderedNavURLs(order map[string]int) []string {
	if len(order) == 0 {
		return nil
	}
	type kv struct {
		u string
		i int
	}
	pairs := make([]kv, 0, len(order))
	for u, i := range order {
		pairs = append(pairs, kv{u, i})
	}
	// 稳定序：首现位置，平局按字典序（确定性；原插入排序 O(n²)，
	// nav 链接多时退化）
	sort.SliceStable(pairs, func(a, b int) bool {
		if pairs[a].i != pairs[b].i {
			return pairs[a].i < pairs[b].i
		}
		return pairs[a].u < pairs[b].u
	})
	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = p.u
	}
	return out
}

// normalizeCrawlURL 抓取去重键（对齐 Node normalizeCrawlUrl：剥 hash、
// path 长度 >1 时剥单个尾斜杠、保留 query）。
func normalizeCrawlURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.Fragment = ""
	u.RawFragment = ""
	if len(u.EscapedPath()) > 1 {
		u.Path = strings.TrimSuffix(u.Path, "/")
	}
	return u.String()
}

// fastHeadingsToFirecrawl fast-path 大纲 → Firecrawl 兼容形态。
func fastHeadingsToFirecrawl(in []FastPathHeading) []FirecrawlHeading {
	if len(in) == 0 {
		return nil
	}
	out := make([]FirecrawlHeading, len(in))
	for i, h := range in {
		out[i] = FirecrawlHeading{Level: h.Level, Text: h.Text, ID: h.ID}
	}
	return out
}

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

const (
	fastPathMaxConcurrent = 4
	fastPathQueueGrowth   = 2
)

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
		return true
	}
	if len(s) == 5 && (s[2] == '-' || s[2] == '_') {
		return true
	}
	return false
}

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

	for _, ex := range excludePrefixes {
		if ex != "" && HasPathPrefix(u.Path, ex) {
			return false
		}
	}

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

type FastPathCrawlResult struct {
	Docs            []FirecrawlDoc
	NavOrderURL     []string
	SidebarSections []WebDocSection
	Telemetry       ContentLiftTelemetry
}

func FastPathEnabled() bool {
	return os.Getenv("WEB_CRAWLER_FAST_PATH") != "false"
}

// Single source of truth for [PrimaryDocPrefix] U AllowedPrefixes shared across crawl, Firecrawl, and profile persistence.
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
	navOrder := map[string]int{}
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
			// Report progress over discoveredTotal (docs+queue, capped at maxPages) so small sites do not stall near 17%.
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

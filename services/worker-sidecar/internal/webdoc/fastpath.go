package webdoc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/base"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/commonmark"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/strikethrough"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/table"
	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
	"golang.org/x/net/html/charset"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const (
	mainContentMinChars  = 200
	bodyFallbackMinChars = 250
	htmlMinChars         = 100
	markdownMinChars     = 150
)

var (
	reBrandSeparator = regexp.MustCompile(`^(.*?)\s+(?:[|·—–])\s+.*$`)
	reHyphenSplit    = regexp.MustCompile(`\s+-\s+`)
	reNumericPrefix  = regexp.MustCompile(`^\d+(?:\.\d+)*$`)
	reOrdinalPrefix  = regexp.MustCompile(`(?i)^(?:\d+|[〇零一二两三四五六七八九十百]+|第\s*(?:\d+|[〇零一二两三四五六七八九十百]+)\s*[章节模块单元部分课讲篇]{0,2}|(?:module|chapter|lesson|part|section|step)\s*\d+)[\s.·:：、-]*`)
	reMultiSpaces    = regexp.MustCompile(`\s+`)

	nonBrandHostTokens = map[string]bool{
		"www": true, "com": true, "org": true, "net": true, "io": true,
		"dev": true, "ai": true, "app": true, "docs": true, "doc": true,
	}
)

func stripInvisibleFormatRunes(raw string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '\u200B', '\u200C', '\u200D', '\uFEFF', '\u00AD':
			return -1
		default:
			return r
		}
	}, raw)
}

func StripSiteTitleSuffix(rawTitle string) string {
	if rawTitle == "" {
		return ""
	}
	trimmed := strings.TrimSpace(rawTitle)

	if m := reBrandSeparator.FindStringSubmatch(trimmed); len(m) == 2 && strings.TrimSpace(m[1]) != "" {
		return strings.TrimSpace(m[1])
	}

	hyphenParts := reHyphenSplit.Split(trimmed, -1)
	if len(hyphenParts) > 2 {
		return strings.TrimSpace(strings.Join(hyphenParts[:len(hyphenParts)-1], " - "))
	}
	if len(hyphenParts) == 2 {
		first := strings.TrimSpace(hyphenParts[0])
		isFirstPartPrefix := reNumericPrefix.MatchString(first) || reOrdinalPrefix.MatchString(first)
		if isFirstPartPrefix {
			return trimmed
		}
		return first
	}

	return trimmed
}

var genericWebDocTitles = map[string]bool{
	"introduction": true, "intro": true, "getting started": true, "get started": true,
	"quick start": true, "quickstart": true, "overview": true, "welcome": true,
	"home": true, "index": true, "docs": true, "documentation": true,
	"guide": true, "guides": true, "manual": true, "reference": true,
	"api reference": true, "readme": true, "about": true, "changelog": true,
	"untitled": true,
	"简介":       true, "介绍": true, "快速开始": true, "快速上手": true,
	"入门": true, "开始使用": true, "起步": true, "概览": true,
	"概述": true, "总览": true, "首页": true, "文档": true,
	"使用文档": true, "说明": true, "指南": true, "目录": true, "未命名": true,
}

func normalizeWebDocTitleToken(raw string) string {
	cleaned := stripInvisibleFormatRunes(raw)
	trimmed := strings.TrimSpace(cleaned)
	if trimmed == "" {
		return ""
	}
	trimmed = reMultiSpaces.ReplaceAllString(strings.ToLower(trimmed), " ")
	return strings.TrimSpace(strings.TrimRight(trimmed, ":：.!！。"))
}

func IsGenericWebDocTitle(raw string) bool {
	trimmed := normalizeWebDocTitleToken(raw)
	return trimmed == "" || genericWebDocTitles[trimmed]
}

func IsPageSlugWebDocTitle(rawTitle string, pageURL string) bool {
	normTitle := normalizeWebDocTitleToken(rawTitle)
	if normTitle == "" || strings.TrimSpace(pageURL) == "" {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(pageURL))
	if err != nil {
		return false
	}
	var segments []string
	for _, seg := range strings.Split(parsed.Path, "/") {
		if seg != "" {
			segments = append(segments, seg)
		}
	}
	if len(segments) == 0 {
		return false
	}
	rawLeaf := segments[len(segments)-1]
	if unescaped, err := url.PathUnescape(rawLeaf); err == nil {
		rawLeaf = unescaped
	}
	for _, ext := range []string{".html", ".htm", ".mdx", ".md"} {
		if strings.HasSuffix(strings.ToLower(rawLeaf), ext) {
			rawLeaf = rawLeaf[:len(rawLeaf)-len(ext)]
			break
		}
	}
	leafToken := strings.NewReplacer("-", " ", "_", " ").Replace(strings.ToLower(rawLeaf))
	leafToken = strings.TrimSpace(reMultiSpaces.ReplaceAllString(leafToken, " "))
	if leafToken == "" || leafToken != normTitle {
		return false
	}

	host := CleanHostFromURL(pageURL)
	if host == normTitle {
		return false
	}
	for _, part := range strings.Split(host, ".") {
		if len(part) > 1 && !nonBrandHostTokens[part] && part == normTitle {
			return false
		}
	}
	return true
}

func CleanHostFromURL(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(parsed.Hostname()), "www.")
}

func extractBrandFromTitleTag(rawTitle string) string {
	trimmed := reMultiSpaces.ReplaceAllString(strings.TrimSpace(stripInvisibleFormatRunes(rawTitle)), " ")
	if trimmed == "" {
		return ""
	}
	for _, sep := range []string{" | ", " · ", " — ", " – ", " - "} {
		if !strings.Contains(trimmed, sep) {
			continue
		}
		parts := strings.Split(trimmed, sep)
		if len(parts) < 2 {
			continue
		}
		first := strings.TrimSpace(parts[0])
		last := strings.TrimSpace(parts[len(parts)-1])
		firstGeneric := IsGenericWebDocTitle(first)
		lastGeneric := IsGenericWebDocTitle(last)

		if firstGeneric && !lastGeneric {
			return last
		}
		if !firstGeneric && lastGeneric {
			return first
		}
		if !firstGeneric && !lastGeneric {
			if len([]rune(last)) > len([]rune(first))*2 {
				return first
			}
			return last
		}
		return ""
	}
	if !IsGenericWebDocTitle(trimmed) {
		return trimmed
	}
	return ""
}

func ExtractWebSiteName(doc *html.Node, pageURL string) string {
	hostFallback := CleanHostFromURL(pageURL)
	if doc == nil {
		return hostFallback
	}

	var ogSiteName, appName, docTitle string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.DataAtom == atom.Meta {
				var metaKey, content string
				for _, a := range n.Attr {
					if strings.EqualFold(a.Key, "property") || strings.EqualFold(a.Key, "name") {
						metaKey = strings.ToLower(strings.TrimSpace(a.Val))
					} else if strings.EqualFold(a.Key, "content") {
						content = strings.TrimSpace(stripInvisibleFormatRunes(a.Val))
					}
				}
				content = reMultiSpaces.ReplaceAllString(content, " ")
				if content != "" {
					if metaKey == "og:site_name" && ogSiteName == "" {
						ogSiteName = content
					} else if metaKey == "application-name" && appName == "" {
						appName = content
					}
				}
			} else if n.DataAtom == atom.Title && docTitle == "" {
				docTitle = reMultiSpaces.ReplaceAllString(strings.TrimSpace(extractNodeText(n)), " ")
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	isCleanBrand := func(candidate string) bool {
		return candidate != "" && !IsGenericWebDocTitle(candidate) && !IsPageSlugWebDocTitle(candidate, pageURL)
	}
	if isCleanBrand(ogSiteName) {
		return ogSiteName
	}
	if isCleanBrand(appName) {
		return appName
	}
	if brand := extractBrandFromTitleTag(docTitle); isCleanBrand(brand) {
		return brand
	}
	return hostFallback
}

func ExtractWebSiteBrandFromHTML(rawHTML string, pageURL string) string {
	hostFallback := CleanHostFromURL(pageURL)
	if strings.TrimSpace(rawHTML) == "" {
		return hostFallback
	}
	doc, err := html.Parse(strings.NewReader(rawHTML))
	if err != nil {
		return hostFallback
	}
	return ExtractWebSiteName(doc, pageURL)
}

func truncateUTF8Runes(s string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return strings.TrimSpace(string(runes[:maxRunes])) + "…"
}

func ExtractWebSiteDescription(doc *html.Node) string {
	if doc == nil {
		return ""
	}
	var metaDesc, ogDesc, twDesc string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.DataAtom == atom.Meta {
			var metaKey, content string
			for _, a := range n.Attr {
				if strings.EqualFold(a.Key, "name") || strings.EqualFold(a.Key, "property") {
					metaKey = strings.ToLower(strings.TrimSpace(a.Val))
				} else if strings.EqualFold(a.Key, "content") {
					content = strings.TrimSpace(stripInvisibleFormatRunes(a.Val))
				}
			}
			content = reMultiSpaces.ReplaceAllString(content, " ")
			if content != "" {
				switch metaKey {
				case "description":
					if metaDesc == "" {
						metaDesc = content
					}
				case "og:description":
					if ogDesc == "" {
						ogDesc = content
					}
				case "twitter:description":
					if twDesc == "" {
						twDesc = content
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	for _, candidate := range []string{metaDesc, ogDesc, twDesc} {
		if candidate != "" {
			return truncateUTF8Runes(candidate, 240)
		}
	}
	return ""
}

func ExtractWebSiteDescriptionFromHTML(rawHTML string) string {
	if strings.TrimSpace(rawHTML) == "" {
		return ""
	}
	doc, err := html.Parse(strings.NewReader(rawHTML))
	if err != nil {
		return ""
	}
	return ExtractWebSiteDescription(doc)
}

func ExtractWebPageTitle(doc *html.Node, contentNode ...*html.Node) string {
	var firstH1 string
	var ogTitle string
	var docTitle string

	if len(contentNode) > 0 && contentNode[0] != nil {
		var walkContent func(*html.Node)
		walkContent = func(n *html.Node) {
			if n.Type == html.ElementNode && n.DataAtom == atom.H1 && firstH1 == "" {
				t := strings.TrimSpace(extractNodeText(n))
				if t != "" {
					firstH1 = reMultiSpaces.ReplaceAllString(t, " ")
				}
			}
			for c := n.FirstChild; c != nil && firstH1 == ""; c = c.NextSibling {
				walkContent(c)
			}
		}
		walkContent(contentNode[0])
		if firstH1 != "" {
			return firstH1
		}
	}

	var walk func(*html.Node, bool)
	walk = func(n *html.Node, inNoise bool) {
		isNoiseNow := inNoise
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "nav" || tag == "aside" || tag == "header" || tag == "footer" {
				isNoiseNow = true
			}
			for _, a := range n.Attr {
				if strings.EqualFold(a.Key, "class") || strings.EqualFold(a.Key, "id") {
					val := strings.ToLower(a.Val)
					if strings.Contains(val, "menu-title") || strings.Contains(val, "site-title") ||
						strings.Contains(val, "logo") || strings.Contains(val, "brand") ||
						strings.Contains(val, "sidebar") {
						isNoiseNow = true
					}
				}
			}

			if n.DataAtom == atom.H1 && firstH1 == "" && !isNoiseNow {
				t := strings.TrimSpace(extractNodeText(n))
				if t != "" {
					firstH1 = reMultiSpaces.ReplaceAllString(t, " ")
				}
			} else if n.DataAtom == atom.Meta {
				isOg := false
				content := ""
				for _, a := range n.Attr {
					if (strings.EqualFold(a.Key, "property") || strings.EqualFold(a.Key, "name")) && strings.EqualFold(a.Val, "og:title") {
						isOg = true
					}
					if strings.EqualFold(a.Key, "content") {
						content = a.Val
					}
				}
				if isOg && content != "" && ogTitle == "" {
					ogTitle = content
				}
			} else if n.DataAtom == atom.Title && docTitle == "" {
				t := strings.TrimSpace(extractNodeText(n))
				if t != "" {
					docTitle = t
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, isNoiseNow)
		}
	}
	walk(doc, false)

	if firstH1 != "" {
		return firstH1
	}
	if ogTitle != "" {
		s := StripSiteTitleSuffix(ogTitle)
		return reMultiSpaces.ReplaceAllString(strings.TrimSpace(s), " ")
	}
	if docTitle != "" {
		s := StripSiteTitleSuffix(docTitle)
		return reMultiSpaces.ReplaceAllString(strings.TrimSpace(s), " ")
	}
	return "Untitled"
}

func ScanFastPathPage(ctx context.Context, targetURL string, timeout time.Duration) (*FastPathScanResult, error) {
	return ScanFastPathPageWithHints(ctx, targetURL, timeout, nil)
}

func ScanFastPathPageWithHints(ctx context.Context, targetURL string, timeout time.Duration, hints *SidebarTrackHints) (*FastPathScanResult, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if !IsPublicEndpoint(targetURL) {
		return &FastPathScanResult{IsStatic: false}, nil
	}
	if !IsUrlAllowedByRobots(ctx, targetURL) {
		log.Printf("[fastpath] blocked by robots.txt: %s", targetURL)
		return &FastPathScanResult{IsStatic: false}, nil
	}

	parsedBase, err := url.Parse(targetURL)
	if err != nil {
		return &FastPathScanResult{IsStatic: false}, nil
	}
	baseOrigin := fmt.Sprintf("%s://%s", parsedBase.Scheme, parsedBase.Host)

	currentURL := targetURL
	redirectCount := 0
	const maxRedirects = 3
	var resp *http.Response

	client := NewSafeHTTPClient(timeout, -1)
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}

	for {
		if !IsPublicEndpoint(currentURL) {
			return &FastPathScanResult{IsStatic: false}, nil
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, currentURL, nil)
		if err != nil {
			return &FastPathScanResult{IsStatic: false}, nil
		}
		userAgent := os.Getenv("WEB_CRAWLER_USER_AGENT")
		if userAgent == "" {
			userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

		resp, err = client.Do(req)
		if err != nil {
			log.Printf("[fastpath] client.Do error for %s: %v", currentURL, err)
			return &FastPathScanResult{IsStatic: false}, nil
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			resp.Body.Close()
			redirectCount++
			if redirectCount > maxRedirects {
				log.Printf("[fastpath] too many redirects for %s: %d", currentURL, redirectCount)
				return &FastPathScanResult{IsStatic: false}, nil
			}
			loc := resp.Header.Get("Location")
			if loc == "" {
				log.Printf("[fastpath] redirect with empty location for %s", currentURL)
				return &FastPathScanResult{IsStatic: false}, nil
			}
			refURL, err := url.Parse(loc)
			if err != nil {
				log.Printf("[fastpath] invalid redirect url %s: %v", loc, err)
				return &FastPathScanResult{IsStatic: false}, nil
			}
			resolved := parsedBase.ResolveReference(refURL)
			parsedBase = resolved
			currentURL = resolved.String()
			// Re-check robots.txt on every redirect target so 301s cannot redirect crawlers into disallowed paths or origins.
			if !IsUrlAllowedByRobots(ctx, currentURL) {
				log.Printf("[fastpath] redirect target blocked by robots.txt: %s", currentURL)
				return &FastPathScanResult{IsStatic: false}, nil
			}
			continue
		}
		break
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("[fastpath] non-200 status code for %s: %d", currentURL, resp.StatusCode)
		return &FastPathScanResult{IsStatic: false}, nil
	}

	if currentParsed, err := url.Parse(currentURL); err == nil {
		parsedBase = currentParsed
		baseOrigin = fmt.Sprintf("%s://%s", parsedBase.Scheme, parsedBase.Host)
	}

	contentType := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Type")))
	if !strings.Contains(contentType, "text/html") && !strings.Contains(contentType, "application/xhtml") {
		log.Printf("[fastpath] non-HTML content-type for %s: %s", currentURL, contentType)
		return &FastPathScanResult{IsStatic: false}, nil
	}

	rawBytes, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		log.Printf("[fastpath] read body error for %s: %v", currentURL, err)
		return &FastPathScanResult{IsStatic: false}, nil
	}
	rawHtml := string(rawBytes)

	var bodyReader io.Reader = bytes.NewReader(rawBytes)
	if decodedReader, err := charset.NewReader(bytes.NewReader(rawBytes), contentType); err == nil {
		bodyReader = decodedReader
	}
	doc, err := html.Parse(bodyReader)
	if err != nil {
		return &FastPathScanResult{IsStatic: false}, nil
	}

	linkAssetRe := currentPatterns().LinkAsset
	var navOrderURLs []string
	navVisited := make(map[string]bool)
	var collectNavLinks func(*html.Node, bool)
	collectNavLinks = func(n *html.Node, inNav bool) {
		isNavNow := inNav
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "nav" || tag == "aside" {
				isNavNow = true
			} else if isNavNow && tag == "a" {
				for _, a := range n.Attr {
					if !strings.EqualFold(a.Key, "href") || a.Val == "" {
						continue
					}
					u, err := url.Parse(a.Val)
					if err != nil {
						continue
					}
					resolved := parsedBase.ResolveReference(u)
					rOrigin := fmt.Sprintf("%s://%s", resolved.Scheme, resolved.Host)
					if rOrigin != baseOrigin || isLinkAssetPath(linkAssetRe, resolved.Path) {
						continue
					}
					s := resolved.String()
					if !navVisited[s] {
						navVisited[s] = true
						navOrderURLs = append(navOrderURLs, s)
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collectNavLinks(c, isNavNow)
		}
	}
	collectNavLinks(doc, false)

	var discoveredURLs []string
	discVisited := make(map[string]bool)
	var collectDiscoveredLinks func(*html.Node)
	collectDiscoveredLinks = func(n *html.Node) {
		if n.Type == html.ElementNode && strings.EqualFold(n.Data, "a") {
			for _, a := range n.Attr {
				if !strings.EqualFold(a.Key, "href") || a.Val == "" {
					continue
				}
				u, err := url.Parse(a.Val)
				if err != nil {
					continue
				}
				resolved := parsedBase.ResolveReference(u)
				rOrigin := fmt.Sprintf("%s://%s", resolved.Scheme, resolved.Host)
				if rOrigin != baseOrigin || isLinkAssetPath(linkAssetRe, resolved.Path) {
					continue
				}
				cleanURL := *resolved
				cleanURL.Fragment = ""
				cleanURL.RawFragment = ""
				cleanStr := cleanURL.String()
				if cleanStr == currentURL || cleanStr == currentURL+"/" || currentURL == cleanStr+"/" {
					continue
				}
				if !discVisited[cleanStr] {
					discVisited[cleanStr] = true
					discoveredURLs = append(discoveredURLs, cleanStr)
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collectDiscoveredLinks(c)
		}
	}
	collectDiscoveredLinks(doc)

	contentNode := findMainContentNode(doc)
	if contentNode == nil {
		body := findFirstElementByTag(doc, "body")
		if body == nil {
			log.Printf("[fastpath] body is nil for %s", targetURL)
			return &FastPathScanResult{IsStatic: false}, nil
		}
		bodyText := strings.TrimSpace(extractNodeText(body))
		if len(bodyText) < bodyFallbackMinChars {
			log.Printf("[fastpath] bodyText too short (%d < %d) for %s", len(bodyText), bodyFallbackMinChars, targetURL)
			return &FastPathScanResult{IsStatic: false}, nil
		}
		contentNode = body
	}

	preTitle := ExtractWebPageTitle(doc, contentNode)
	sidebarSections := ExtractSidebarSectionsFromDocWithHints(doc, targetURL, preTitle, hints)

	var liftTel ContentLiftTelemetry
	liftTel.PagesScanned = 1
	cleanContentNodeWithContext(contentNode, targetURL, &liftTel)
	injectScriptAwareSpacing(contentNode)

	title := ExtractWebPageTitle(doc, contentNode)
	headings := extractHeadingsFromNode(contentNode)
	if (title == "" || title == "Untitled") && len(headings) > 0 && headings[0].Text != "" {
		title = headings[0].Text
	}

	renderedHTML := renderNodeHTML(contentNode)
	if len(strings.TrimSpace(renderedHTML)) < htmlMinChars {
		log.Printf("[fastpath] renderedHTML too short (%d < %d) for %s", len(strings.TrimSpace(renderedHTML)), htmlMinChars, targetURL)
		return &FastPathScanResult{IsStatic: false}, nil
	}

	markdown := convertContentNodeWithLift(contentNode, targetURL, &liftTel)
	if len(strings.TrimSpace(markdown)) < markdownMinChars {
		log.Printf("[fastpath] markdown too short (%d < %d) for %s", len(strings.TrimSpace(markdown)), markdownMinChars, targetURL)
		return &FastPathScanResult{IsStatic: false}, nil
	}

	docPath := CanonicalDocPathFromUrl(targetURL)
	h := sha256.Sum256([]byte(markdown))
	contentHash := hex.EncodeToString(h[:])

	return &FastPathScanResult{
		IsStatic: true,
		RawHTML:  rawHtml,
		Document: &FastPathDocument{
			Path:        docPath,
			Title:       title,
			Markdown:    markdown,
			URL:         targetURL,
			ContentHash: contentHash,
			Headings:    headings,
			Metadata: map[string]any{
				"engine":  "fast-path",
				"rawHtml": rawHtml,
				"html":    rawHtml,
			},
		},
		DiscoveredURLs:  discoveredURLs,
		NavOrderURLs:    navOrderURLs,
		SidebarSections: sidebarSections,
		Telemetry:       liftTel,
	}, nil
}

var nonContentTextTags = map[string]bool{
	"svg": true, "script": true, "style": true, "noscript": true,
}

func extractNodeText(n *html.Node) string {
	var sb strings.Builder
	var walk func(*html.Node)
	walk = func(curr *html.Node) {
		if curr.Type == html.ElementNode && nonContentTextTags[strings.ToLower(curr.Data)] {
			return
		}
		if curr.Type == html.TextNode {
			sb.WriteString(curr.Data)
		}
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return stripInvisibleFormatRunes(sb.String())
}

func findFirstElementByTag(n *html.Node, tag string) *html.Node {
	if n.Type == html.ElementNode && strings.EqualFold(n.Data, tag) {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if res := findFirstElementByTag(c, tag); res != nil {
			return res
		}
	}
	return nil
}

func findMainContentNode(doc *html.Node) *html.Node {
	for _, sel := range currentPatterns().MainContentSelectors {
		selector := compileSelector(sel)
		for _, node := range cascadia.QueryAll(doc, selector) {
			txt := strings.TrimSpace(extractNodeText(node))
			if len(txt) >= mainContentMinChars {
				return node
			}
		}
	}
	return nil
}

func extractHeadingsFromNode(root *html.Node) []FastPathHeading {
	var headings []FastPathHeading
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if len(tag) == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6' {
				level := int(tag[1] - '0')
				text := strings.TrimSpace(extractNodeText(n))
				if text != "" {
					idVal := extractNodeID(n, text, len(headings)+1)
					headings = append(headings, FastPathHeading{
						Level: level,
						Text:  text,
						ID:    idVal,
					})
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return headings
}

func extractNodeID(n *html.Node, text string, seq int) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, "id") && a.Val != "" {
			return a.Val
		}
	}
	if slug := mdpat.Slugify(text); slug != "" {
		return slug
	}
	return fmt.Sprintf("heading-%d", seq)
}

var noiseHygieneTags = map[string]bool{
	"script": true, "style": true, "noscript": true,
	"iframe": true, "button": true,
}

func isNoiseElement(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	tag := strings.ToLower(n.Data)
	if noiseHygieneTags[tag] {
		return true
	}
	for _, sel := range currentPatterns().NoiseSelectors {
		if compileSelector(sel).Match(n) {
			return true
		}
	}
	return false
}

func isNoiseElementInRoot(root, n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	tag := strings.ToLower(n.Data)
	// Defer stripping <aside> and protected controls until content lifting consumes Callouts and CodeGroups.
	if tag == "aside" && root != nil && n != root {
		if _, isCallout := classifyCalloutNode(n, root); isCallout {
			return false
		}
	}
	if tag == "button" && root != nil && isProtectedSemanticControl(root, n) {
		return false
	}
	return isNoiseElement(n)
}

func isProtectedSemanticControl(root, btn *html.Node) bool {
	if strings.EqualFold(strings.TrimSpace(getNodeAttr(btn, "role")), "tab") || hasAncestorRole(btn, "tablist", root) {
		return true
	}
	if hasAttr(btn, "aria-expanded") {
		ctrlID := strings.TrimSpace(getNodeAttr(btn, "aria-controls"))
		if ctrlID != "" && findUniqueElementByID(root, ctrlID) != nil {
			return true
		}
	}
	return false
}

func hasAncestorRole(n *html.Node, role string, root *html.Node) bool {
	for p := n.Parent; p != nil && p != root; p = p.Parent {
		if p.Type == html.ElementNode && strings.EqualFold(strings.TrimSpace(getNodeAttr(p, "role")), role) {
			return true
		}
	}
	return false
}

func cleanContentNodeWithRoot(root, curRoot *html.Node) {
	if curRoot == nil {
		return
	}
	var next *html.Node
	for c := curRoot.FirstChild; c != nil; c = next {
		next = c.NextSibling
		if isNoiseElementInRoot(root, c) {
			curRoot.RemoveChild(c)
		} else {
			cleanContentNodeWithRoot(root, c)
		}
	}
}

func cleanContentNodeWithContext(contentNode *html.Node, pageURL string, tel *ContentLiftTelemetry) {
	if contentNode == nil {
		return
	}
	cleanContentNodeWithRoot(contentNode, contentNode)
	processContentSVGs(contentNode, tel)
	pruneAnchorChrome(contentNode, pageURL)
}

func renderNodeHTML(n *html.Node) string {
	var buf bytes.Buffer
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		_ = html.Render(&buf, c)
	}
	return buf.String()
}

var (
	mdConverterOnce sync.Once
	mdConverter     *converter.Converter
	mdConverterMu   sync.Mutex // Serialize html-to-markdown/v2 Converter calls because its instance is not thread-safe.
)

func getMDConverter() *converter.Converter {
	mdConverterOnce.Do(func() {
		mdConverter = converter.NewConverter(converter.WithPlugins(
			base.NewBasePlugin(),
			commonmark.NewCommonmarkPlugin(
				commonmark.WithStrongDelimiter("**"),
				commonmark.WithEmDelimiter("*"),
				commonmark.WithHorizontalRule("---"),
				commonmark.WithBulletListMarker("-"),
			),
			strikethrough.NewStrikethroughPlugin(),
			table.NewTablePlugin(),
			RegisterWebDocLiftPlugin(),
		))
	})
	return mdConverter
}

func htmlToMarkdownFromInner(inner string, root *html.Node) string {
	mdConverterMu.Lock()
	out, err := getMDConverter().ConvertString(inner)
	mdConverterMu.Unlock()
	if err != nil {
		log.Printf("[fastpath] html-to-markdown convert failed, fallback to plain text: %v", err)
		return strings.TrimSpace(extractNodeText(root))
	}
	return strings.TrimSpace(out)
}

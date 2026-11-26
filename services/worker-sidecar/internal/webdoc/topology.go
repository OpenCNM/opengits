package webdoc

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
)

const (
	sidebarTrackMinOverlap     = 2
	sidebarTrackMaxOverlap     = 4
	sidebarTrackOverlapPercent = 30

	navBlockMinLinks        = 4
	navBlockMaxBlocks       = 6
	navBlockMaxSampleLinks  = 15
	navBlockMaxAvgTextChars = 48
)

func ExtractLandingTopology(rawHtml string, entryURL string) *LandingTopology {
	doc, err := html.Parse(strings.NewReader(rawHtml))
	if err != nil {
		return &LandingTopology{
			EntryURL:          entryURL,
			SiteTitle:         "Documentation",
			HeaderLinks:       []HeaderLink{},
			CandidatePrefixes: []string{},
		}
	}
	return extractTopologyFromDoc(doc, entryURL, "", false)
}

func ExtractSidebarSectionsFromDocWithHints(doc *html.Node, pageURL string, siteTitle string, hints *SidebarTrackHints) []WebDocSection {
	if doc == nil {
		return nil
	}
	topo := extractTopologyFromDoc(doc, pageURL, siteTitle, true)
	if topo == nil {
		return nil
	}

	if hints != nil && len(hints.AnchorHrefs) >= sidebarTrackMinOverlap {
		parsedBase, err := url.Parse(strings.TrimSpace(pageURL))
		if err == nil && parsedBase.Scheme != "" && parsedBase.Host != "" {
			baseOrigin := fmt.Sprintf("%s://%s", parsedBase.Scheme, parsedBase.Host)
			linkAssetRe := currentPatterns().LinkAsset

			anchorSet := make(map[string]bool, len(hints.AnchorHrefs))
			for _, h := range hints.AnchorHrefs {
				if nh := normNavHref(h); nh != "" {
					anchorSet[nh] = true
				}
			}
			requiredOverlap := (len(anchorSet) * sidebarTrackOverlapPercent) / 100
			if requiredOverlap < sidebarTrackMinOverlap {
				requiredOverlap = sidebarTrackMinOverlap
			}
			if requiredOverlap > sidebarTrackMaxOverlap {
				requiredOverlap = sidebarTrackMaxOverlap
			}
			if requiredOverlap > len(anchorSet) {
				requiredOverlap = len(anchorSet)
			}

			var bestNode *html.Node
			bestOverlap := 0
			for _, blk := range topo.NavBlocks {
				if blk.RegionHint == "header" || blk.node == nil {
					continue
				}
				hrefs := collectBlockDocHrefs(blk.node, parsedBase, baseOrigin, linkAssetRe)
				overlap := 0
				for _, href := range hrefs {
					if anchorSet[normNavHref(href)] {
						overlap++
					}
				}
				if overlap > bestOverlap {
					bestOverlap = overlap
					bestNode = blk.node
				}
			}
			if bestNode != nil && bestOverlap >= requiredOverlap {
				sections := extractSidebarSectionsFromNodes([]*html.Node{bestNode}, parsedBase, baseOrigin, linkAssetRe, topo.SiteTitle, nil)
				if len(sections) > 0 {
					return sections
				}
			}
		}
	}

	return topo.SidebarSections
}

func extractTopologyFromDoc(doc *html.Node, entryURL string, siteTitleOverride string, sidebarOnly bool) *LandingTopology {
	parsedBase, err := url.Parse(strings.TrimSpace(entryURL))
	if err != nil || parsedBase.Scheme == "" || parsedBase.Host == "" {
		return &LandingTopology{
			EntryURL:          entryURL,
			SiteTitle:         "Documentation",
			HeaderLinks:       []HeaderLink{},
			CandidatePrefixes: []string{},
		}
	}
	baseOrigin := fmt.Sprintf("%s://%s", parsedBase.Scheme, parsedBase.Host)

	siteTitle := siteTitleOverride
	if siteTitle == "" {
		siteTitle = ExtractWebPageTitle(doc)
	}
	if siteTitle == "" || siteTitle == "Untitled" {
		siteTitle = parsedBase.Host
	}

	linkAssetRe := currentPatterns().LinkAsset

	// Classify DOM links into top-nav vs sidebar buckets so sidebar entries never leak into top moduleTabs.
	type topoRegion int
	const (
		regionContent topoRegion = iota
		regionTop
		regionSidebar
	)

	// Prefer explicit aria/class/role hints over DOM position because frameworks put both navbar and sidebar in <nav>.
	navHintRegion := func(n *html.Node) (topoRegion, bool) {
		hint := ""
		for _, a := range n.Attr {
			key := strings.ToLower(a.Key)
			if key == "class" || key == "aria-label" || key == "role" {
				hint += " " + strings.ToLower(a.Val)
			}
		}
		switch {
		case strings.Contains(hint, "sidebar"),
			strings.Contains(hint, "table-of-contents"),
			strings.Contains(hint, "toc"):
			return regionSidebar, true
		case strings.Contains(hint, "pagination"),
			strings.Contains(hint, "breadcrumb"),
			strings.Contains(hint, "footer"):
			return regionContent, true
		}
		return regionContent, false
	}

	var headerLinks []HeaderLink
	headerVisited := make(map[string]bool)

	var sidebarLinks []HeaderLink
	sidebarVisited := make(map[string]bool)

	var headerRawPaths []string
	var sidebarRoots []*html.Node
	var blockedNodes []*html.Node

	// Treat only the first pre-main <nav> as top bar so subsequent pre-main navs (e.g. Docusaurus sidebar) stay sidebar.
	seenMain := false
	firstTopNavSeen := false

	var walk func(*html.Node, topoRegion, bool)
	walk = func(n *html.Node, region topoRegion, inMainOrArticle bool) {
		childRegion := region
		childInMain := inMainOrArticle

		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			switch tag {
			case "header":
				childRegion = regionTop
				blockedNodes = append(blockedNodes, n)
			case "aside":
				childRegion = regionSidebar
				blockedNodes = append(blockedNodes, n)
			case "footer":
				childRegion = regionContent
				blockedNodes = append(blockedNodes, n)
			case "main", "article":
				seenMain = true
				childRegion = regionContent
				childInMain = true
				blockedNodes = append(blockedNodes, n)
			case "nav":
				if r, hinted := navHintRegion(n); hinted {
					childRegion = r
				} else if region == regionTop {
					childRegion = regionTop
				} else if region == regionSidebar {
					childRegion = regionSidebar
				} else if !seenMain && !firstTopNavSeen {
					firstTopNavSeen = true
					childRegion = regionTop
				} else if inMainOrArticle {
					childRegion = regionSidebar
				} else if seenMain {
					childRegion = regionContent
				} else {
					childRegion = regionSidebar
				}
				blockedNodes = append(blockedNodes, n)
			}

			if childRegion == regionSidebar && region != regionSidebar {
				sidebarRoots = append(sidebarRoots, n)
			}

			if tag == "a" {
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

					if region == regionTop {
						headerRawPaths = append(headerRawPaths, resolved.Path)
					}

					text := strings.TrimSpace(extractNodeText(n))
					if text != "" && len(text) <= 50 {
						linkPath := resolved.Path
						if linkPath == "" {
							linkPath = "/"
						}
						if region == regionTop {
							if !headerVisited[linkPath] {
								headerVisited[linkPath] = true
								headerLinks = append(headerLinks, HeaderLink{
									Text: text,
									Href: linkPath,
								})
							}
						} else if region == regionSidebar {
							if !sidebarVisited[linkPath] {
								sidebarVisited[linkPath] = true
								sidebarLinks = append(sidebarLinks, HeaderLink{
									Text: text,
									Href: linkPath,
								})
							}
						}
					}
				}
			}
		}

		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, childRegion, childInMain)
		}
	}

	walk(doc, regionContent, false)

	if len(headerLinks) > 12 {
		headerLinks = headerLinks[:12]
	}

	candidatePrefixes := deriveCandidatePrefixesFromPaths(headerRawPaths)
	if len(candidatePrefixes) > 10 {
		candidatePrefixes = candidatePrefixes[:10]
	}

	if mainContent := findMainContentNode(doc); mainContent != nil &&
		!strings.EqualFold(mainContent.Data, "body") &&
		!strings.EqualFold(mainContent.Data, "html") {
		blockedNodes = append(blockedNodes, mainContent)
	}

	sidebarHeadings := make([]string, 0, len(sidebarLinks))
	headingVisited := make(map[string]bool, len(sidebarLinks))
	for _, sl := range sidebarLinks {
		h := sl.Text
		if len(h) > 120 {
			h = h[:120]
		}
		if h != "" && !headingVisited[h] {
			headingVisited[h] = true
			sidebarHeadings = append(sidebarHeadings, h)
		}
		if len(sidebarHeadings) >= 10 {
			break
		}
	}

	sidebarSections := extractSidebarSectionsFromNodes(sidebarRoots, parsedBase, baseOrigin, linkAssetRe, siteTitle, sidebarLinks)
	navBlocks := extractCandidateNavBlocks(doc, parsedBase, baseOrigin, linkAssetRe, headerLinks, sidebarRoots, blockedNodes)

	return &LandingTopology{
		EntryURL:          entryURL,
		SiteTitle:         siteTitle,
		HeaderLinks:       headerLinks,
		CandidatePrefixes: candidatePrefixes,
		NavBlocks:         navBlocks,
		SidebarHeadings:   sidebarHeadings,
		SidebarSections:   sidebarSections,
	}
}

func deriveCandidatePrefixesFromPaths(rawPaths []string) []string {
	if len(rawPaths) == 0 {
		return []string{}
	}

	distinctSet := make(map[string]bool, len(rawPaths))
	var parsedParts [][]string
	for _, rp := range rawPaths {
		clean := strings.Trim(strings.TrimSpace(rp), "/")
		if clean == "" {
			continue
		}
		parts := strings.Split(clean, "/")
		if len(parts) == 0 || parts[0] == "" || strings.Contains(parts[0], ".") {
			continue
		}
		norm := "/" + clean
		parsedParts = append(parsedParts, parts)
		distinctSet[norm] = true
	}

	shareCommonMountRoot := false
	if len(distinctSet) >= 2 && len(parsedParts) >= 2 {
		commonFirst := strings.ToLower(parsedParts[0][0])
		allMatch := commonFirst != ""
		hasNested := false
		for _, parts := range parsedParts {
			if strings.ToLower(parts[0]) != commonFirst {
				allMatch = false
				break
			}
			if len(parts) > 1 && parts[1] != "" {
				hasNested = true
			}
		}
		shareCommonMountRoot = allMatch && hasNested
	}

	var candidates []string
	visited := make(map[string]bool, len(parsedParts))
	for _, parts := range parsedParts {
		candidate := "/" + parts[0]
		firstLower := strings.ToLower(parts[0])
		if (shareCommonMountRoot || isLocalePrefix(firstLower)) && len(parts) > 1 && parts[1] != "" {
			candidate = "/" + parts[0] + "/" + parts[1]
		}
		if !strings.Contains(candidate, ".") && !visited[candidate] {
			visited[candidate] = true
			candidates = append(candidates, candidate)
		}
	}
	if candidates == nil {
		return []string{}
	}
	return candidates
}

func collectBlockDocHrefs(root *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp) []string {
	links := collectBlockSampleLinks(root, parsedBase, baseOrigin, linkAssetRe, 0)
	out := make([]string, 0, len(links))
	for _, l := range links {
		out = append(out, l.Href)
	}
	return out
}

func collectBlockSampleLinks(root *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp, limit int) []HeaderLink {
	if root == nil {
		return nil
	}
	seen := make(map[string]bool)
	var out []HeaderLink
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "script" || tag == "style" || tag == "noscript" || tag == "svg" {
				return
			}
			if tag == "a" {
				if title, href, ok := extractLinkItem(n, parsedBase, baseOrigin, linkAssetRe); ok {
					if !seen[href] {
						seen[href] = true
						out = append(out, HeaderLink{Text: title, Href: href})
					}
				}
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	if limit > 0 && len(out) > limit {
		return out[:limit]
	}
	return out
}

func measureBlockLinkMetrics(root *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp) (linkCount int, linkRunes int, totalRunes int, allLinks []HeaderLink) {
	if root == nil {
		return 0, 0, 0, nil
	}
	seen := make(map[string]bool)
	var walk func(*html.Node, bool)
	walk = func(n *html.Node, insideAnchor bool) {
		if n.Type == html.TextNode {
			trimmed := strings.TrimSpace(n.Data)
			if trimmed != "" {
				rCount := utf8.RuneCountInString(trimmed)
				totalRunes += rCount
				if insideAnchor {
					linkRunes += rCount
				}
			}
			return
		}
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "script" || tag == "style" || tag == "noscript" || tag == "svg" {
				return
			}
			nextInsideAnchor := insideAnchor
			if tag == "a" {
				nextInsideAnchor = true
				if title, href, ok := extractLinkItem(n, parsedBase, baseOrigin, linkAssetRe); ok {
					if !seen[href] {
						seen[href] = true
						allLinks = append(allLinks, HeaderLink{Text: title, Href: href})
					}
				}
			}
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c, nextInsideAnchor)
			}
		}
	}
	walk(root, false)
	return len(allLinks), linkRunes, totalRunes, allLinks
}

func extractCandidateNavBlocks(
	doc *html.Node,
	parsedBase *url.URL,
	baseOrigin string,
	linkAssetRe *regexp.Regexp,
	headerLinks []HeaderLink,
	sidebarRoots []*html.Node,
	blockedNodes []*html.Node,
) []CandidateNavBlock {
	var blocks []CandidateNavBlock
	nextBlockID := func() string {
		return fmt.Sprintf("b%d", len(blocks)+1)
	}

	if len(headerLinks) > 0 {
		samples := headerLinks
		if len(samples) > navBlockMaxSampleLinks {
			samples = samples[:navBlockMaxSampleLinks]
		}
		blocks = append(blocks, CandidateNavBlock{
			ID:          nextBlockID(),
			RegionHint:  "header",
			LinkCount:   len(headerLinks),
			SampleLinks: append([]HeaderLink(nil), samples...),
		})
	}

	for _, sr := range sidebarRoots {
		if len(blocks) >= navBlockMaxBlocks {
			break
		}
		links := collectBlockSampleLinks(sr, parsedBase, baseOrigin, linkAssetRe, 0)
		if len(links) == 0 {
			continue
		}
		samples := links
		if len(samples) > navBlockMaxSampleLinks {
			samples = samples[:navBlockMaxSampleLinks]
		}
		blocks = append(blocks, CandidateNavBlock{
			ID:          nextBlockID(),
			RegionHint:  "sidebar_std",
			LinkCount:   len(links),
			SampleLinks: samples,
			node:        sr,
		})
	}

	isBlocked := make(map[*html.Node]bool, len(blockedNodes))
	containsBlocked := make(map[*html.Node]bool, len(blockedNodes)*4)
	for _, bn := range blockedNodes {
		if bn == nil {
			continue
		}
		isBlocked[bn] = true
		for p := bn; p != nil; p = p.Parent {
			containsBlocked[p] = true
		}
	}

	var scanOutsideMain func(*html.Node)
	scanOutsideMain = func(n *html.Node) {
		if n == nil || len(blocks) >= navBlockMaxBlocks {
			return
		}
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if isBlocked[n] || tag == "script" || tag == "style" || tag == "noscript" || tag == "svg" {
				return
			}
			if !containsBlocked[n] && tag != "html" && tag != "body" && tag != "head" {
				linkCount, linkRunes, totalRunes, allLinks := measureBlockLinkMetrics(n, parsedBase, baseOrigin, linkAssetRe)
				if linkCount < navBlockMinLinks {
					return
				}
				avgLen := linkRunes / linkCount
				nonLinkRunes := totalRunes - linkRunes
				if avgLen <= navBlockMaxAvgTextChars && (nonLinkRunes <= linkCount*32 || linkRunes*2 >= totalRunes) {
					samples := allLinks
					if len(samples) > navBlockMaxSampleLinks {
						samples = samples[:navBlockMaxSampleLinks]
					}
					blocks = append(blocks, CandidateNavBlock{
						ID:          nextBlockID(),
						RegionHint:  "outside_main",
						LinkCount:   linkCount,
						SampleLinks: samples,
						node:        n,
					})
					return
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			scanOutsideMain(c)
		}
	}
	scanOutsideMain(doc)

	return blocks
}

func getNodeAttr(n *html.Node, key string) string {
	if n == nil {
		return ""
	}
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

func isAllDigitsOrPunctuation(s string) bool {
	hasLetter := false
	for _, r := range s {
		if unicode.IsLetter(r) {
			hasLetter = true
			break
		}
	}
	return !hasLetter
}

func hasDocLinkDescendants(n *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp) bool {
	var check func(*html.Node) bool
	check = func(curr *html.Node) bool {
		if curr.Type == html.ElementNode && strings.ToLower(curr.Data) == "a" {
			for _, a := range curr.Attr {
				if strings.EqualFold(a.Key, "href") && a.Val != "" {
					val := strings.TrimSpace(a.Val)
					if !strings.HasPrefix(val, "#") && !strings.HasPrefix(val, "javascript:") && !strings.HasPrefix(val, "mailto:") {
						u, err := url.Parse(val)
						if err == nil {
							resolved := parsedBase.ResolveReference(u)
							rOrigin := fmt.Sprintf("%s://%s", resolved.Scheme, resolved.Host)
							if rOrigin == baseOrigin && !isLinkAssetPath(linkAssetRe, resolved.Path) {
								return true
							}
						}
					}
				}
			}
		}
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			if check(c) {
				return true
			}
		}
		return false
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if check(c) {
			return true
		}
	}
	return false
}

func hasCollapsibleControl(n *html.Node) bool {
	var check func(*html.Node) bool
	check = func(curr *html.Node) bool {
		if curr.Type == html.ElementNode {
			if strings.EqualFold(curr.Data, "button") {
				return true
			}
			if getNodeAttr(curr, "aria-expanded") != "" || getNodeAttr(curr, "aria-controls") != "" {
				return true
			}
		}
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			if check(c) {
				return true
			}
		}
		return false
	}
	return check(n)
}

func hasSubListDescendant(n *html.Node) bool {
	var check func(*html.Node) bool
	check = func(curr *html.Node) bool {
		if curr.Type == html.ElementNode {
			tag := strings.ToLower(curr.Data)
			if tag == "ul" || tag == "ol" {
				return true
			}
		}
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			if check(c) {
				return true
			}
		}
		return false
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if check(c) {
			return true
		}
	}
	return false
}

func isStructuralSectionHeaderLi(li *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp) bool {
	if li == nil || li.Type != html.ElementNode || !strings.EqualFold(li.Data, "li") {
		return false
	}
	if li.Parent == nil || li.Parent.Type != html.ElementNode {
		return false
	}
	pTag := strings.ToLower(li.Parent.Data)
	if pTag != "ul" && pTag != "ol" {
		return false
	}
	if hasDocLinkDescendants(li, parsedBase, baseOrigin, linkAssetRe) || hasCollapsibleControl(li) || hasSubListDescendant(li) {
		return false
	}
	text := strings.TrimSpace(extractNodeText(li))
	if len(text) < 1 || len(text) > 80 || isAllDigitsOrPunctuation(text) {
		return false
	}
	for sib := li.Parent.FirstChild; sib != nil; sib = sib.NextSibling {
		if sib != li && sib.Type == html.ElementNode && strings.EqualFold(sib.Data, "li") {
			if hasDocLinkDescendants(sib, parsedBase, baseOrigin, linkAssetRe) {
				return true
			}
		}
	}
	return false
}

func isSectionHeaderNode(n *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp) bool {
	if n.Type != html.ElementNode {
		return false
	}
	tag := strings.ToLower(n.Data)
	switch tag {
	case "a", "script", "style", "svg", "path", "img", "input", "select", "option", "code":
		return false
	}

	if hasDocLinkDescendants(n, parsedBase, baseOrigin, linkAssetRe) {
		return false
	}

	text := strings.TrimSpace(extractNodeText(n))
	if len(text) < 1 || len(text) > 80 || isAllDigitsOrPunctuation(text) {
		return false
	}

	switch tag {
	case "h1", "h2", "h3", "h4", "h5", "h6", "summary":
		return true
	}

	class := strings.ToLower(getNodeAttr(n, "class"))
	role := strings.ToLower(getNodeAttr(n, "role"))
	id := strings.ToLower(getNodeAttr(n, "id"))
	ariaLabel := strings.ToLower(getNodeAttr(n, "aria-label"))
	attrText := class + " " + role + " " + id + " " + ariaLabel

	if role == "heading" || role == "separator" {
		return true
	}

	headerKeywords := []string{
		"menu__list-item--header",
		"sidebar-group-header",
		"sidebar__heading",
		"sidebar-heading",
		"sidebar-header",
		"group-header",
		"category-header",
		"section-header",
		"section-title",
		"sidebar-label",
		"sidebar-title",
		"menu-label",
		"group-label",
		"group-title",
		"caption",
		"separator",
		"sidebar-separator",
		"category-title",
		"category-label",
		"sidebar-category",
	}
	for _, kw := range headerKeywords {
		if strings.Contains(attrText, kw) {
			return true
		}
	}

	if (strings.Contains(class, "uppercase") || strings.Contains(class, "tracking-wider") || strings.Contains(class, "tracking-widest")) &&
		(strings.Contains(class, "font-semibold") || strings.Contains(class, "font-bold") || strings.Contains(class, "font-medium") || strings.Contains(class, "text-xs") || strings.Contains(class, "text-sm")) {
		return true
	}

	if tag == "button" &&
		getNodeAttr(n, "aria-expanded") == "" &&
		getNodeAttr(n, "aria-controls") == "" &&
		(strings.Contains(attrText, "collapse") || strings.Contains(attrText, "group") || strings.Contains(attrText, "category")) {
		return true
	}

	return false
}

func extractLinkItem(aNode *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp) (string, string, bool) {
	if aNode.Type != html.ElementNode || strings.ToLower(aNode.Data) != "a" {
		return "", "", false
	}
	for _, a := range aNode.Attr {
		if strings.EqualFold(a.Key, "href") && a.Val != "" {
			val := strings.TrimSpace(a.Val)
			if strings.HasPrefix(val, "#") || strings.HasPrefix(val, "javascript:") || strings.HasPrefix(val, "mailto:") {
				return "", "", false
			}
			u, err := url.Parse(val)
			if err != nil {
				return "", "", false
			}
			resolved := parsedBase.ResolveReference(u)
			rOrigin := fmt.Sprintf("%s://%s", resolved.Scheme, resolved.Host)
			if rOrigin != baseOrigin || isLinkAssetPath(linkAssetRe, resolved.Path) {
				return "", "", false
			}
			title := strings.TrimSpace(extractNodeText(aNode))
			cleanPath := resolved.Path
			if cleanPath == "" {
				cleanPath = "/"
			}
			if len(cleanPath) > 1 && strings.HasSuffix(cleanPath, "/") {
				cleanPath = strings.TrimSuffix(cleanPath, "/")
			}
			if title == "" {
				parts := strings.Split(strings.Trim(cleanPath, "/"), "/")
				if len(parts) > 0 {
					title = parts[len(parts)-1]
				}
			}
			return title, cleanPath, true
		}
	}
	return "", "", false
}

func findPrimaryLinkAndChildList(liNode *html.Node) (*html.Node, *html.Node) {
	var primaryLink *html.Node
	var childList *html.Node

	var walk func(*html.Node)
	walk = func(curr *html.Node) {
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode {
				continue
			}
			tag := strings.ToLower(c.Data)
			if tag == "ul" || tag == "ol" {
				if childList == nil {
					childList = c
				}
				continue
			}
			if tag == "a" {
				if primaryLink == nil {
					primaryLink = c
				}
				continue
			}
			walk(c)
		}
	}
	walk(liNode)
	return primaryLink, childList
}

func extractListChildren(listNode *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp) []WebDocNavItem {
	var children []WebDocNavItem
	childOrder := 0

	var walkList func(*html.Node)
	walkList = func(curr *html.Node) {
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode {
				continue
			}
			tag := strings.ToLower(c.Data)
			if tag == "li" {
				if nested, _, ok := extractNestedListItem(c, parsedBase, baseOrigin, linkAssetRe); ok {
					childOrder++
					nested.Order = childOrder
					children = append(children, *nested)
					continue
				}
				if pLink, _ := findPrimaryLinkAndChildList(c); pLink != nil {
					if cTitle, cHref, ok := extractLinkItem(pLink, parsedBase, baseOrigin, linkAssetRe); ok {
						childOrder++
						children = append(children, WebDocNavItem{
							Title: cTitle,
							Href:  cHref,
							Order: childOrder,
						})
					}
				} else if !hasDocLinkDescendants(c, parsedBase, baseOrigin, linkAssetRe) && hasCollapsibleControl(c) {
					btnTitle := strings.TrimSpace(extractNodeText(c))
					if btnTitle != "" && len(btnTitle) <= 80 && !isAllDigitsOrPunctuation(btnTitle) {
						childOrder++
						children = append(children, WebDocNavItem{
							Title: btnTitle,
							Href:  "",
							Order: childOrder,
						})
					}
				}
				continue
			}
			if tag == "a" {
				if cTitle, cHref, ok := extractLinkItem(c, parsedBase, baseOrigin, linkAssetRe); ok {
					childOrder++
					children = append(children, WebDocNavItem{
						Title: cTitle,
						Href:  cHref,
						Order: childOrder,
					})
				}
				continue
			}
			walkList(c)
		}
	}
	walkList(listNode)
	return children
}

func extractNestedListItem(liNode *html.Node, parsedBase *url.URL, baseOrigin string, linkAssetRe *regexp.Regexp) (*WebDocNavItem, *html.Node, bool) {
	if liNode.Type != html.ElementNode {
		return nil, nil, false
	}
	primaryLink, childList := findPrimaryLinkAndChildList(liNode)
	if childList == nil {
		return nil, nil, false
	}

	var title, href string
	if primaryLink != nil {
		t, h, ok := extractLinkItem(primaryLink, parsedBase, baseOrigin, linkAssetRe)
		if ok {
			title = t
			href = h
		}
	}
	if title == "" {
		for c := liNode.FirstChild; c != nil && c != childList; c = c.NextSibling {
			if c.Type == html.ElementNode && strings.ToLower(c.Data) != "ul" && strings.ToLower(c.Data) != "ol" {
				txt := strings.TrimSpace(extractNodeText(c))
				if txt != "" && len(txt) <= 80 {
					title = txt
					break
				}
			}
		}
	}
	if title == "" {
		return nil, nil, false
	}

	children := extractListChildren(childList, parsedBase, baseOrigin, linkAssetRe)
	if len(children) == 0 && href == "" {
		return nil, nil, false
	}

	item := &WebDocNavItem{
		Title:    title,
		Href:     href,
		Children: children,
	}
	return item, childList, true
}

func filterVisitedNavItems(items []WebDocNavItem, visitedHrefs map[string]bool) []WebDocNavItem {
	var clean []WebDocNavItem
	for _, it := range items {
		if it.Href != "" {
			if visitedHrefs[it.Href] {
				if len(it.Children) == 0 {
					continue
				}
			} else {
				visitedHrefs[it.Href] = true
			}
		}
		if len(it.Children) > 0 {
			it.Children = filterVisitedNavItems(it.Children, visitedHrefs)
		}
		if it.Href != "" || len(it.Children) > 0 {
			it.Order = len(clean) + 1
			clean = append(clean, it)
		}
	}
	return clean
}

func extractSidebarSectionsFromNodes(
	roots []*html.Node,
	parsedBase *url.URL,
	baseOrigin string,
	linkAssetRe *regexp.Regexp,
	siteTitle string,
	sidebarLinks []HeaderLink,
) []WebDocSection {
	if len(roots) == 0 {
		if len(sidebarLinks) == 0 {
			return nil
		}
		items := make([]WebDocNavItem, len(sidebarLinks))
		for i, sl := range sidebarLinks {
			items[i] = WebDocNavItem{
				Title: sl.Text,
				Href:  sl.Href,
				Order: i + 1,
			}
		}
		t := siteTitle
		if t == "" {
			t = "Documentation"
		}
		return []WebDocSection{{
			Title: t,
			Order: 1,
			Items: items,
		}}
	}

	type rawSec struct {
		title string
		items []WebDocNavItem
	}
	var rawSections []*rawSec
	current := &rawSec{title: ""}
	visitedHrefs := make(map[string]bool)
	visitedPlaceholders := make(map[string]bool)

	ensureCurrent := func(title string) {
		if current.title == "" && len(current.items) == 0 {
			current.title = title
			rawSections = append(rawSections, current)
		} else if current.title != title {
			if len(current.items) > 0 {
				current = &rawSec{title: title}
				rawSections = append(rawSections, current)
			} else {
				current.title = title
			}
		}
	}

	ensureInitSection := func() {
		if current.title == "" {
			initTitle := siteTitle
			if initTitle == "" {
				initTitle = "Introduction"
			}
			ensureCurrent(initTitle)
		}
	}

	for _, root := range roots {
		hint := getNodeAttr(root, "class") + " " + getNodeAttr(root, "aria-label")
		hintLower := strings.ToLower(hint)
		if (strings.Contains(hintLower, "table-of-contents") || strings.Contains(hintLower, "toc")) && len(roots) > 1 {
			continue
		}

		skipSubtree := make(map[*html.Node]bool)

		var walkNode func(*html.Node)
		walkNode = func(n *html.Node) {
			if skipSubtree[n] {
				return
			}

			if n.Type == html.ElementNode {
				tag := strings.ToLower(n.Data)

				if isSectionHeaderNode(n, parsedBase, baseOrigin, linkAssetRe) ||
					isStructuralSectionHeaderLi(n, parsedBase, baseOrigin, linkAssetRe) {
					secTitle := strings.TrimSpace(extractNodeText(n))
					if secTitle != "" {
						ensureCurrent(secTitle)
						return
					}
				}

				if tag == "li" {
					if nestedItem, childList, ok := extractNestedListItem(n, parsedBase, baseOrigin, linkAssetRe); ok {
						if childList != nil {
							skipSubtree[childList] = true
						}
						ensureInitSection()
						if nestedItem.Href != "" && visitedHrefs[nestedItem.Href] && len(nestedItem.Children) == 0 {
							return
						}
						if nestedItem.Href != "" {
							visitedHrefs[nestedItem.Href] = true
						}
						nestedItem.Children = filterVisitedNavItems(nestedItem.Children, visitedHrefs)
						if nestedItem.Href != "" || len(nestedItem.Children) > 0 {
							nestedItem.Order = len(current.items) + 1
							current.items = append(current.items, *nestedItem)
						}
						return
					}

					// Preserve empty expandable <button aria-expanded> items as folder placeholders for site-wide sidebar merge.
					if !hasDocLinkDescendants(n, parsedBase, baseOrigin, linkAssetRe) &&
						!hasSubListDescendant(n) &&
						hasCollapsibleControl(n) {
						btnTitle := strings.TrimSpace(extractNodeText(n))
						if btnTitle != "" && len(btnTitle) <= 80 && !isAllDigitsOrPunctuation(btnTitle) {
							ensureInitSection()
							phKey := strings.ToLower(current.title) + "\x00" + strings.ToLower(btnTitle)
							if !visitedPlaceholders[phKey] {
								visitedPlaceholders[phKey] = true
								current.items = append(current.items, WebDocNavItem{
									Title: btnTitle,
									Href:  "",
									Order: len(current.items) + 1,
								})
							}
							return
						}
					}
				}

				if tag == "a" {
					title, href, ok := extractLinkItem(n, parsedBase, baseOrigin, linkAssetRe)
					if ok {
						if !visitedHrefs[href] {
							visitedHrefs[href] = true
							ensureInitSection()
							item := WebDocNavItem{
								Title: title,
								Href:  href,
								Order: len(current.items) + 1,
							}
							current.items = append(current.items, item)
						}
						return
					}
				}
			}

			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walkNode(c)
			}
		}

		walkNode(root)
	}

	var finalSections []WebDocSection
	for _, rs := range rawSections {
		if len(rs.items) > 0 {
			t := rs.title
			if t == "" {
				t = siteTitle
			}
			if t == "" {
				t = "Documentation"
			}
			finalSections = append(finalSections, WebDocSection{
				Title: t,
				Order: len(finalSections) + 1,
				Items: rs.items,
			})
		}
	}

	if len(finalSections) == 0 && len(sidebarLinks) > 0 {
		fallbackItems := make([]WebDocNavItem, 0, len(sidebarLinks))
		for i, sl := range sidebarLinks {
			fallbackItems = append(fallbackItems, WebDocNavItem{
				Title: sl.Text,
				Href:  sl.Href,
				Order: i + 1,
			})
		}
		t := siteTitle
		if t == "" {
			t = "Documentation"
		}
		finalSections = []WebDocSection{{
			Title: t,
			Order: 1,
			Items: fallbackItems,
		}}
	}

	return finalSections
}

func normNavHref(href string) string {
	trimmed := strings.TrimSpace(href)
	if trimmed == "" || trimmed == "/" {
		return trimmed
	}
	return strings.TrimSuffix(trimmed, "/")
}

func cloneNavItem(it WebDocNavItem) WebDocNavItem {
	cp := WebDocNavItem{
		Title: it.Title,
		Href:  it.Href,
		Order: it.Order,
	}
	if len(it.Children) > 0 {
		cp.Children = make([]WebDocNavItem, len(it.Children))
		for i, ch := range it.Children {
			cp.Children[i] = cloneNavItem(ch)
		}
	}
	return cp
}

func collectKnownNavHrefs(items []WebDocNavItem, out map[string]bool) {
	for _, it := range items {
		if nh := normNavHref(it.Href); nh != "" {
			out[nh] = true
		}
		if len(it.Children) > 0 {
			collectKnownNavHrefs(it.Children, out)
		}
	}
}

func cloneUnseenNavItem(it WebDocNavItem, knownHrefs map[string]bool) (WebDocNavItem, bool) {
	nh := normNavHref(it.Href)
	keepSelfHref := ""
	if nh != "" && !knownHrefs[nh] {
		knownHrefs[nh] = true
		keepSelfHref = it.Href
	}
	var keptChildren []WebDocNavItem
	for _, ch := range it.Children {
		if kept, ok := cloneUnseenNavItem(ch, knownHrefs); ok {
			keptChildren = append(keptChildren, kept)
		}
	}
	if keepSelfHref == "" && len(keptChildren) == 0 {
		if it.Href == "" && strings.TrimSpace(it.Title) != "" {
			return WebDocNavItem{Title: it.Title, Href: "", Order: it.Order}, true
		}
		return WebDocNavItem{}, false
	}
	return WebDocNavItem{
		Title:    it.Title,
		Href:     keepSelfHref,
		Order:    it.Order,
		Children: keptChildren,
	}, true
}

func mergeNavItems(dst []WebDocNavItem, src []WebDocNavItem, knownHrefs map[string]bool) []WebDocNavItem {
	for _, s := range src {
		sHref := normNavHref(s.Href)
		sTitle := strings.ToLower(strings.TrimSpace(s.Title))
		matchIdx := -1
		for i := range dst {
			if sHref != "" && normNavHref(dst[i].Href) == sHref {
				matchIdx = i
				break
			}
			if sHref == "" && strings.ToLower(strings.TrimSpace(dst[i].Title)) == sTitle {
				matchIdx = i
				break
			}
		}
		if matchIdx >= 0 {
			if dst[matchIdx].Href == "" && sHref != "" && !knownHrefs[sHref] {
				dst[matchIdx].Href = s.Href
				knownHrefs[sHref] = true
			}
			if strings.TrimSpace(dst[matchIdx].Title) == "" && strings.TrimSpace(s.Title) != "" {
				dst[matchIdx].Title = s.Title
			}
			if len(s.Children) > 0 {
				dst[matchIdx].Children = mergeNavItems(dst[matchIdx].Children, s.Children, knownHrefs)
			}
			continue
		}

		if sHref != "" && sTitle != "" {
			for i := range dst {
				if dst[i].Href == "" && strings.ToLower(strings.TrimSpace(dst[i].Title)) == sTitle {
					matchIdx = i
					break
				}
			}
			if matchIdx >= 0 {
				if !knownHrefs[sHref] {
					dst[matchIdx].Href = s.Href
					knownHrefs[sHref] = true
				}
				if len(s.Children) > 0 {
					dst[matchIdx].Children = mergeNavItems(dst[matchIdx].Children, s.Children, knownHrefs)
				}
				continue
			}
		}

		if cloned, ok := cloneUnseenNavItem(s, knownHrefs); ok {
			cloned.Order = len(dst) + 1
			dst = append(dst, cloned)
		}
	}
	for i := range dst {
		dst[i].Order = i + 1
	}
	return dst
}

func MergeSidebarSections(base []WebDocSection, incoming []WebDocSection) []WebDocSection {
	if len(incoming) == 0 {
		if len(base) == 0 {
			return nil
		}
		out := make([]WebDocSection, len(base))
		for i, sec := range base {
			items := make([]WebDocNavItem, len(sec.Items))
			for j, it := range sec.Items {
				items[j] = cloneNavItem(it)
			}
			out[i] = WebDocSection{Title: sec.Title, Order: i + 1, Items: items}
		}
		return out
	}
	if len(base) == 0 {
		return MergeSidebarSections(incoming, nil)
	}

	merged := MergeSidebarSections(base, nil)
	knownHrefs := make(map[string]bool)
	for _, sec := range merged {
		collectKnownNavHrefs(sec.Items, knownHrefs)
	}

	for _, inSec := range incoming {
		inTitle := strings.ToLower(strings.TrimSpace(inSec.Title))
		secIdx := -1
		for i := range merged {
			if strings.ToLower(strings.TrimSpace(merged[i].Title)) == inTitle {
				secIdx = i
				break
			}
		}
		if secIdx >= 0 {
			merged[secIdx].Items = mergeNavItems(merged[secIdx].Items, inSec.Items, knownHrefs)
		} else {
			var newItems []WebDocNavItem
			for _, it := range inSec.Items {
				if cloned, ok := cloneUnseenNavItem(it, knownHrefs); ok {
					cloned.Order = len(newItems) + 1
					newItems = append(newItems, cloned)
				}
			}
			if len(newItems) > 0 {
				merged = append(merged, WebDocSection{
					Title: inSec.Title,
					Order: len(merged) + 1,
					Items: newItems,
				})
			}
		}
	}

	for i := range merged {
		merged[i].Order = i + 1
	}
	return merged
}

func SynthesizeWebDocBlueprint(
	ctx context.Context,
	llm LLMGenerator,
	topology *LandingTopology,
	userId *string,
) []WebDocSection {
	if topology == nil || len(topology.SidebarSections) > 1 || llm == nil {
		if topology != nil {
			return topology.SidebarSections
		}
		return nil
	}

	totalItems := 0
	for _, sec := range topology.SidebarSections {
		totalItems += len(sec.Items)
	}
	if totalItems < 8 {
		return topology.SidebarSections
	}

	whitelist := make(map[string]WebDocNavItem)
	var linksTextBuilder strings.Builder
	for _, sec := range topology.SidebarSections {
		for _, it := range sec.Items {
			if it.Href != "" {
				whitelist[it.Href] = it
				linksTextBuilder.WriteString(fmt.Sprintf("- [%s](%s)\n", it.Title, it.Href))
			}
			for _, ch := range it.Children {
				if ch.Href != "" {
					whitelist[ch.Href] = ch
					linksTextBuilder.WriteString(fmt.Sprintf("  - [%s](%s)\n", ch.Title, ch.Href))
				}
			}
		}
	}
	if len(whitelist) < 8 {
		return topology.SidebarSections
	}

	llmCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	variables := map[string]any{
		"entryUrl":         topology.EntryURL,
		"siteTitle":        topology.SiteTitle,
		"sidebarLinksText": linksTextBuilder.String(),
	}

	type llmSectionItem struct {
		Title string `json:"title"`
		Href  string `json:"href"`
	}
	type llmSection struct {
		Title string           `json:"title"`
		Items []llmSectionItem `json:"items"`
	}
	type llmResponse struct {
		Sections []llmSection `json:"sections"`
	}

	var resp llmResponse
	err := llm.Generate(llmCtx, "webdoc_outline_synthesizer", variables, userId, &resp)
	if err != nil || len(resp.Sections) == 0 {
		log.Printf("[webdoc-topology] LLM outline synthesizer fallback (fail-closed to flat sections): %v", err)
		return topology.SidebarSections
	}

	placedHrefs := make(map[string]bool)
	var outSections []WebDocSection

	for _, sec := range resp.Sections {
		secTitle := strings.TrimSpace(sec.Title)
		if secTitle == "" {
			continue
		}
		var validItems []WebDocNavItem
		for _, it := range sec.Items {
			href := strings.TrimSpace(it.Href)
			if origItem, ok := whitelist[href]; ok && !placedHrefs[href] {
				placedHrefs[href] = true
				itemTitle := strings.TrimSpace(it.Title)
				if itemTitle == "" {
					itemTitle = origItem.Title
				}
				validItems = append(validItems, WebDocNavItem{
					Title:    itemTitle,
					Href:     origItem.Href,
					Order:    len(validItems) + 1,
					Children: origItem.Children,
				})
			}
		}
		if len(validItems) > 0 {
			outSections = append(outSections, WebDocSection{
				Title: secTitle,
				Order: len(outSections) + 1,
				Items: validItems,
			})
		}
	}

	var unplacedItems []WebDocNavItem
	for _, sec := range topology.SidebarSections {
		for _, it := range sec.Items {
			if it.Href != "" && !placedHrefs[it.Href] {
				placedHrefs[it.Href] = true
				for _, ch := range it.Children {
					if ch.Href != "" {
						placedHrefs[ch.Href] = true
					}
				}
				unplacedItems = append(unplacedItems, it)
			} else {
				for _, ch := range it.Children {
					if ch.Href != "" && !placedHrefs[ch.Href] {
						placedHrefs[ch.Href] = true
						unplacedItems = append(unplacedItems, ch)
					}
				}
			}
		}
	}

	if len(unplacedItems) > 0 {
		if len(outSections) > 0 {
			last := &outSections[len(outSections)-1]
			for _, it := range unplacedItems {
				it.Order = len(last.Items) + 1
				last.Items = append(last.Items, it)
			}
		} else {
			return topology.SidebarSections
		}
	}

	if len(outSections) > 0 {
		return outSections
	}
	return topology.SidebarSections
}

func ResolveSiteTopologyIntent(
	ctx context.Context,
	llm LLMGenerator,
	topology *LandingTopology,
	userId *string,
) *SiteTopologyDecision {
	natural := "/"
	if topology != nil && topology.EntryURL != "" {
		natural = DeriveNaturalPrefix(topology.EntryURL)
	}

	if topology == nil {
		return &SiteTopologyDecision{
			PrimaryDocPrefix: natural,
			ExcludePrefixes:  []string{},
			ModuleTabs:       []ModuleTab{},
		}
	}

	fallbackPrimary := deriveFallbackPrimaryPrefix(topology, natural)
	fallbackTabs := fallbackModuleTabsFromHeaders(topology)
	fallbackDecision := &SiteTopologyDecision{
		PrimaryDocPrefix: fallbackPrimary,
		ExcludePrefixes:  []string{},
		ModuleTabs:       fallbackTabs,
	}

	hasOutsideMainBlocks := false
	for _, blk := range topology.NavBlocks {
		if blk.RegionHint == "outside_main" {
			hasOutsideMainBlocks = true
			break
		}
	}
	canShortCircuitLLM := len(topology.CandidatePrefixes) <= 1 && (len(topology.SidebarSections) > 0 || !hasOutsideMainBlocks)
	if canShortCircuitLLM || llm == nil {
		materializeFrame0Sidebar(topology, fallbackDecision)
		return fallbackDecision
	}

	llmCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	headerLinksPayload := make([]map[string]string, len(topology.HeaderLinks))
	for i, h := range topology.HeaderLinks {
		headerLinksPayload[i] = map[string]string{
			"text": h.Text,
			"href": h.Href,
		}
	}

	navBlocksPayload := make([]map[string]any, 0, len(topology.NavBlocks))
	for _, blk := range topology.NavBlocks {
		samples := make([]map[string]string, 0, len(blk.SampleLinks))
		for _, sl := range blk.SampleLinks {
			samples = append(samples, map[string]string{"text": sl.Text, "href": sl.Href})
		}
		navBlocksPayload = append(navBlocksPayload, map[string]any{
			"id":          blk.ID,
			"regionHint":  blk.RegionHint,
			"linkCount":   blk.LinkCount,
			"sampleLinks": samples,
		})
	}

	variables := map[string]any{
		"entryUrl":          topology.EntryURL,
		"siteTitle":         topology.SiteTitle,
		"headerLinks":       headerLinksPayload,
		"candidatePrefixes": topology.CandidatePrefixes,
		"navBlocks":         navBlocksPayload,
	}

	var decision SiteTopologyDecision
	err := llm.Generate(llmCtx, "webdoc_topology_scout", variables, userId, &decision)
	if err != nil {
		log.Printf("[webdoc-topology] LLM topology scout fallback (to %s, %d header tabs): %v", fallbackPrimary, len(fallbackTabs), err)
		materializeFrame0Sidebar(topology, fallbackDecision)
		return fallbackDecision
	}

	if decision.PrimaryDocPrefix == "" {
		decision.PrimaryDocPrefix = fallbackPrimary
	}
	if !strings.HasPrefix(decision.PrimaryDocPrefix, "/") {
		decision.PrimaryDocPrefix = "/" + decision.PrimaryDocPrefix
	}
	if len(decision.PrimaryDocPrefix) > 1 {
		decision.PrimaryDocPrefix = strings.TrimSuffix(decision.PrimaryDocPrefix, "/")
	}

	cleanExcludes := make([]string, 0, len(decision.ExcludePrefixes))
	for _, ex := range decision.ExcludePrefixes {
		trimmed := strings.TrimSpace(ex)
		if trimmed == "" || trimmed == "/" {
			continue
		}
		if !strings.HasPrefix(trimmed, "/") {
			trimmed = "/" + trimmed
		}
		cleanExcludes = append(cleanExcludes, strings.TrimSuffix(trimmed, "/"))
	}
	decision.ExcludePrefixes = cleanExcludes

	decision.ModuleTabs = sanitizeModuleTabs(decision.ModuleTabs)
	if len(decision.ModuleTabs) == 0 && len(fallbackTabs) > 0 {
		decision.ModuleTabs = fallbackTabs
	}
	decision.SidebarBlockID = strings.TrimSpace(decision.SidebarBlockID)

	materializeFrame0Sidebar(topology, &decision)
	return &decision
}

func deriveFallbackPrimaryPrefix(topology *LandingTopology, natural string) string {
	if topology == nil || topology.EntryURL == "" {
		return natural
	}
	u, err := url.Parse(strings.TrimSpace(topology.EntryURL))
	if err != nil {
		return natural
	}
	entryPath := u.Path
	if entryPath == "" {
		entryPath = "/"
	}
	best := natural
	for _, cand := range topology.CandidatePrefixes {
		if cand == "" || cand == "/" {
			continue
		}
		if HasPathPrefix(entryPath, cand) && (best == "/" || len(cand) > len(best)) {
			best = cand
		}
	}
	return best
}

func sanitizeModuleTabID(rawID, label, kind string) string {
	src := strings.ToLower(strings.TrimSpace(rawID))
	if src == "" {
		src = strings.ToLower(strings.TrimSpace(label))
	}
	var b strings.Builder
	prevDash := false
	for _, r := range src {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash && b.Len() > 0 {
			b.WriteByte('-')
			prevDash = true
		}
		if b.Len() >= 64 {
			break
		}
	}
	id := strings.Trim(b.String(), "-")
	if id == "" {
		id = kind
	}
	if len(id) > 64 {
		id = id[:64]
	}
	return id
}

func sanitizeModuleTabPath(rawPath, kind string) (string, bool) {
	p := strings.TrimSpace(rawPath)
	if kind == "external" {
		if p == "" {
			return "", false
		}
		if len(p) > 200 {
			p = p[:200]
		}
		return p, true
	}
	if idx := strings.IndexAny(p, "?#"); idx >= 0 {
		p = p[:idx]
	}
	if p == "" {
		p = "/"
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	if len(p) > 200 {
		return "", false
	}
	for _, r := range p {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '/' || r == '_' || r == '.' || r == '-') {
			return "", false
		}
	}
	return p, true
}

func sanitizeModuleTabs(raw []ModuleTab) []ModuleTab {
	const maxModuleTabs = 12
	cleanTabs := make([]ModuleTab, 0, len(raw))
	seenPaths := make(map[string]bool, len(raw))

	for _, t := range raw {
		if len(cleanTabs) >= maxModuleTabs {
			break
		}
		label := truncateRunes(strings.Join(strings.Fields(strings.TrimSpace(t.Label)), " "), 60)
		if label == "" {
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(t.Kind))
		if kind != "doc" && kind != "api" && kind != "changelog" && kind != "external" {
			kind = "doc"
		}
		path, ok := sanitizeModuleTabPath(t.Path, kind)
		if !ok {
			continue
		}
		if kind != "external" {
			if seenPaths[path] {
				continue
			}
			seenPaths[path] = true
		}
		id := sanitizeModuleTabID(t.ID, label, kind)
		cleanTabs = append(cleanTabs, ModuleTab{
			ID:    id,
			Label: label,
			Path:  path,
			Kind:  kind,
		})
	}
	return cleanTabs
}

func fallbackModuleTabsFromHeaders(topology *LandingTopology) []ModuleTab {
	if topology == nil || len(topology.HeaderLinks) == 0 {
		return []ModuleTab{}
	}

	type normalizedHeader struct {
		label string
		path  string
	}
	items := make([]normalizedHeader, 0, len(topology.HeaderLinks))
	for _, hl := range topology.HeaderLinks {
		p := strings.TrimSpace(hl.Href)
		if p == "" {
			p = "/"
		}
		if len(p) > 1 {
			p = strings.TrimRight(p, "/")
		}
		items = append(items, normalizedHeader{label: hl.Text, path: p})
	}

	var tabs []ModuleTab
	for i, item := range items {
		if item.path == "/" {
			if len(items) > 1 {
				continue
			}
		} else {
			isMountBrandAncestor := false
			for j, other := range items {
				if i != j && len(other.path) > len(item.path) && strings.HasPrefix(other.path, item.path+"/") {
					isMountBrandAncestor = true
					break
				}
			}
			if isMountBrandAncestor {
				continue
			}
		}

		tabPath := item.path
		for _, cand := range topology.CandidatePrefixes {
			if cand != "" && cand != "/" && HasPathPrefix(item.path, cand) && (tabPath == item.path || len(cand) > len(tabPath)) {
				tabPath = cand
			}
		}

		lowerLabel := strings.ToLower(item.label)
		lowerPath := strings.ToLower(tabPath)
		kind := "doc"
		if strings.Contains(lowerPath, "changelog") || strings.Contains(lowerLabel, "changelog") || strings.Contains(lowerLabel, "release") {
			kind = "changelog"
		} else if lowerPath == "/api" || lowerPath == "/api-reference" || strings.HasSuffix(lowerPath, "/api") || strings.Contains(lowerPath, "api-reference") || strings.Contains(lowerLabel, "api") {
			kind = "api"
		}

		tabs = append(tabs, ModuleTab{
			Label: item.label,
			Path:  tabPath,
			Kind:  kind,
		})
	}
	return sanitizeModuleTabs(tabs)
}

func collectSectionAnchorHrefs(sections []WebDocSection) []string {
	seen := make(map[string]bool)
	var out []string
	var walkItems func([]WebDocNavItem)
	walkItems = func(items []WebDocNavItem) {
		for _, it := range items {
			if it.Href != "" {
				if nh := normNavHref(it.Href); nh != "" && !seen[nh] {
					seen[nh] = true
					out = append(out, nh)
				}
			}
			if len(it.Children) > 0 {
				walkItems(it.Children)
			}
		}
	}
	for _, sec := range sections {
		walkItems(sec.Items)
	}
	return out
}

func materializeFrame0Sidebar(topology *LandingTopology, decision *SiteTopologyDecision) {
	if topology == nil || decision == nil {
		return
	}
	parsedBase, err := url.Parse(strings.TrimSpace(topology.EntryURL))
	if err != nil || parsedBase.Scheme == "" || parsedBase.Host == "" {
		if len(topology.SidebarSections) > 0 {
			decision.ResolvedSidebarSections = topology.SidebarSections
			decision.SidebarAnchorHrefs = collectSectionAnchorHrefs(topology.SidebarSections)
		}
		return
	}
	baseOrigin := fmt.Sprintf("%s://%s", parsedBase.Scheme, parsedBase.Host)
	linkAssetRe := currentPatterns().LinkAsset

	if decision.SidebarBlockID != "" {
		for _, blk := range topology.NavBlocks {
			if blk.ID == decision.SidebarBlockID && blk.RegionHint != "header" && blk.node != nil {
				sections := extractSidebarSectionsFromNodes([]*html.Node{blk.node}, parsedBase, baseOrigin, linkAssetRe, topology.SiteTitle, nil)
				if len(sections) > 0 {
					decision.ResolvedSidebarSections = sections
					decision.SidebarAnchorHrefs = collectSectionAnchorHrefs(sections)
					return
				}
			}
		}
	}

	if len(topology.SidebarSections) > 0 {
		decision.ResolvedSidebarSections = topology.SidebarSections
		decision.SidebarAnchorHrefs = collectSectionAnchorHrefs(topology.SidebarSections)
		return
	}

	var outsideBlocks []CandidateNavBlock
	for _, blk := range topology.NavBlocks {
		if blk.RegionHint == "outside_main" && blk.node != nil {
			outsideBlocks = append(outsideBlocks, blk)
		}
	}
	if len(outsideBlocks) == 1 {
		sections := extractSidebarSectionsFromNodes([]*html.Node{outsideBlocks[0].node}, parsedBase, baseOrigin, linkAssetRe, topology.SiteTitle, nil)
		if len(sections) > 0 {
			decision.ResolvedSidebarSections = sections
			decision.SidebarAnchorHrefs = collectSectionAnchorHrefs(sections)
		}
	}
}

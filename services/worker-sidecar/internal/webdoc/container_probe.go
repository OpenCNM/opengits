package webdoc

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"
)

// ─────────────────────────────────────────────────────────────
// Phase 4: 非对称站点级容器骨架探测与确定性规则重放
//
// 仅在“单站点触发卡片验证门失败/锚点降级次数 >= 3”且注入了 LLM 时启用；
// LLM 仅读取脱敏后的最小 DOM 骨架并输出 CSS 选择器与组件角色分类，
// 绝对禁止改写正文内容，且所有抽取均需二次经过 Phase 1 文本守恒校验门。
// ─────────────────────────────────────────────────────────────

const (
	containerProbeMinDegradations = 3
	containerProbeMaxSkeletons    = 6
	containerProbeMaxRules        = 4
	containerProbeTimeout         = 10 * time.Second
)

func collectRawHTMLSamples(docs []FirecrawlDoc, limit int) []string {
	out := make([]string, 0, limit)
	for _, d := range docs {
		if len(out) >= limit {
			break
		}
		if d.Metadata == nil {
			continue
		}
		if raw, ok := d.Metadata["rawHtml"].(string); ok && strings.TrimSpace(raw) != "" {
			out = append(out, raw)
			continue
		}
		if raw, ok := d.Metadata["html"].(string); ok && strings.TrimSpace(raw) != "" {
			out = append(out, raw)
		}
	}
	return out
}

// ExtractDegradedContainerSkeletons 从站内样本 HTML 中提取重复出现的可疑自定义卡片/提示框 DOM 骨架。
// 所有文本节点均脱敏截断为短结构占位，避免泄漏整段正文或膨胀 Token 预算。
func ExtractDegradedContainerSkeletons(rawHTMLs []string, maxSkeletons int) []ContainerSkeleton {
	if len(rawHTMLs) == 0 {
		return nil
	}
	if maxSkeletons <= 0 {
		maxSkeletons = containerProbeMaxSkeletons
	}

	type agg struct {
		sig     string
		count   int
		minimal string
	}
	counts := make(map[string]*agg)
	seenNodes := make(map[*html.Node]bool)

	for _, raw := range rawHTMLs {
		doc, err := html.Parse(strings.NewReader(raw))
		if err != nil {
			continue
		}
		contentNode := findMainContentNode(doc)
		if contentNode == nil {
			contentNode = findFirstElementByTag(doc, "body")
		}
		if contentNode == nil {
			continue
		}
		cleanContentNodeWithRoot(contentNode, contentNode)

		var walk func(*html.Node)
		walk = func(n *html.Node) {
			if n.Type != html.ElementNode {
				return
			}
			// 检测父容器下重复类名/标签的块级子卡片群（或独立自定义带属性容器）
			if isGridLikeSkeletonParent(n) {
				children := meaningfulElementChildren(n)
				bySig := make(map[string][]*html.Node)
				for _, ch := range children {
					if sig := elementStructureSignature(ch); sig != "" {
						bySig[sig] = append(bySig[sig], ch)
					}
				}
				for sig, grp := range bySig {
					if len(grp) < 2 {
						continue
					}
					if _, exists := counts[sig]; !exists {
						counts[sig] = &agg{
							sig:     sig,
							minimal: renderMinimalSkeletonHTML(grp[0], 0),
						}
					}
					for _, g := range grp {
						if !seenNodes[g] {
							seenNodes[g] = true
							counts[sig].count++
						}
					}
				}
			}

			// 独立带自定义 class/data 属性的提示块/Bento 卡片候选
			if !seenNodes[n] && isCustomSkeletonCandidate(n) {
				sig := elementStructureSignature(n)
				if sig != "" {
					if _, exists := counts[sig]; !exists {
						counts[sig] = &agg{
							sig:     sig,
							minimal: renderMinimalSkeletonHTML(n, 0),
						}
					}
					seenNodes[n] = true
					counts[sig].count++
				}
			}

			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c)
			}
		}
		walk(contentNode)
	}

	list := make([]ContainerSkeleton, 0, len(counts))
	for _, a := range counts {
		if a.count < 2 || strings.TrimSpace(a.minimal) == "" {
			continue
		}
		list = append(list, ContainerSkeleton{
			Signature:   a.sig,
			Count:       a.count,
			MinimalHTML: a.minimal,
		})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Count != list[j].Count {
			return list[i].Count > list[j].Count
		}
		return list[i].Signature < list[j].Signature
	})
	if len(list) > maxSkeletons {
		list = list[:maxSkeletons]
	}
	return list
}

func isGridLikeSkeletonParent(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	tag := strings.ToLower(n.Data)
	if tag == "div" || tag == "section" || tag == "ul" {
		return len(meaningfulElementChildren(n)) >= 2
	}
	return false
}

func isCustomSkeletonCandidate(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	tag := strings.ToLower(n.Data)
	if tag != "div" && tag != "section" && tag != "article" {
		return false
	}
	cls := strings.TrimSpace(getNodeAttr(n, "class"))
	if cls == "" && !hasCustomDataAttr(n) {
		return false
	}
	txtLen := countNonSpaceRunes(extractNodeText(n))
	if txtLen < 12 || txtLen > 500 {
		return false
	}
	children := meaningfulElementChildren(n)
	return len(children) >= 2 && len(children) <= 8
}

func hasCustomDataAttr(n *html.Node) bool {
	for _, a := range n.Attr {
		k := strings.ToLower(a.Key)
		if strings.HasPrefix(k, "data-") && k != "data-lift-id" {
			return true
		}
	}
	return false
}

func meaningfulElementChildren(n *html.Node) []*html.Node {
	var out []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode {
			out = append(out, c)
		}
	}
	return out
}

func elementStructureSignature(n *html.Node) string {
	if n == nil || n.Type != html.ElementNode {
		return ""
	}
	tag := strings.ToLower(n.Data)
	if tag == "p" || tag == "h1" || tag == "h2" || tag == "h3" || tag == "h4" || tag == "pre" || tag == "code" || tag == "table" || tag == "tr" {
		return ""
	}
	cls := strings.Fields(getNodeAttr(n, "class"))
	if len(cls) == 0 && !hasCustomDataAttr(n) {
		return ""
	}
	kept := make([]string, 0, 3)
	for _, c := range cls {
		if len(kept) >= 3 {
			break
		}
		if len(c) <= 40 {
			kept = append(kept, c)
		}
	}
	sort.Strings(kept)
	if len(kept) > 0 {
		return tag + "." + strings.Join(kept, ".")
	}
	for _, a := range n.Attr {
		k := strings.ToLower(a.Key)
		if strings.HasPrefix(k, "data-") {
			return tag + "[" + k + "]"
		}
	}
	return ""
}

func renderMinimalSkeletonHTML(n *html.Node, depth int) string {
	if n == nil || depth > 3 {
		return ""
	}
	if n.Type == html.TextNode {
		t := strings.TrimSpace(reMultiSpaces.ReplaceAllString(n.Data, " "))
		if t == "" {
			return ""
		}
		return truncateRunes(t, 28)
	}
	if n.Type != html.ElementNode {
		return ""
	}
	tag := strings.ToLower(n.Data)
	if tag == "svg" || tag == "script" || tag == "style" || tag == "noscript" {
		return ""
	}

	var sb strings.Builder
	sb.WriteByte('<')
	sb.WriteString(tag)
	cls := strings.Fields(getNodeAttr(n, "class"))
	if len(cls) > 0 {
		limit := len(cls)
		if limit > 3 {
			limit = 3
		}
		sb.WriteString(` class="`)
		sb.WriteString(html.EscapeString(strings.Join(cls[:limit], " ")))
		sb.WriteByte('"')
	}
	for _, a := range n.Attr {
		k := strings.ToLower(a.Key)
		if strings.HasPrefix(k, "data-") || k == "role" || k == "href" {
			val := a.Val
			if k == "href" && utf8.RuneCountInString(val) > 48 {
				val = "/..."
			}
			sb.WriteByte(' ')
			sb.WriteString(k)
			sb.WriteString(`="`)
			sb.WriteString(html.EscapeString(val))
			sb.WriteByte('"')
		}
	}
	sb.WriteByte('>')
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if sb.Len() > 320 {
			sb.WriteString("...")
			break
		}
		sb.WriteString(renderMinimalSkeletonHTML(c, depth+1))
	}
	sb.WriteString("</")
	sb.WriteString(tag)
	sb.WriteByte('>')
	return sb.String()
}

// ProbeSiteContainerMappings 对重复未知容器骨架执行单次轻量 LLM 角色映射探测（Fail-Closed）。
func ProbeSiteContainerMappings(
	ctx context.Context,
	llm LLMGenerator,
	entryURL string,
	skeletons []ContainerSkeleton,
	degradedCount int,
	userId *string,
) []ContainerMappingRule {
	if llm == nil || len(skeletons) == 0 {
		return nil
	}

	var sb strings.Builder
	for i, sk := range skeletons {
		sb.WriteString(fmt.Sprintf("%d. signature=%q count=%d\n   html: %s\n", i+1, sk.Signature, sk.Count, sk.MinimalHTML))
	}

	llmCtx, cancel := context.WithTimeout(ctx, containerProbeTimeout)
	defer cancel()

	variables := map[string]any{
		"entryUrl":      entryURL,
		"degradedCount": degradedCount,
		"skeletonsText": sb.String(),
	}

	var resp struct {
		Rules []ContainerMappingRule `json:"rules"`
	}
	if err := llm.Generate(llmCtx, "webdoc_container_probe", variables, userId, &resp); err != nil {
		log.Printf("[webdoc-probe] LLM container probe skipped (fail-closed): %v", err)
		return nil
	}
	return validateContainerMappingRules(resp.Rules)
}

func isQualifiedContainerSelector(sel string) bool {
	if sel == "" {
		return false
	}
	for _, part := range strings.Split(sel, ",") {
		p := strings.TrimSpace(part)
		if p == "" || (!strings.Contains(p, ".") && !strings.Contains(p, "[")) {
			return false
		}
	}
	return true
}

func validateContainerMappingRules(raw []ContainerMappingRule) []ContainerMappingRule {
	if len(raw) == 0 {
		return nil
	}
	out := make([]ContainerMappingRule, 0, containerProbeMaxRules)
	seen := make(map[string]bool)
	for _, r := range raw {
		if len(out) >= containerProbeMaxRules {
			break
		}
		sel := strings.TrimSpace(r.ContainerSelector)
		if !isQualifiedContainerSelector(sel) {
			continue
		}
		if _, err := cascadia.Compile(sel); err != nil {
			continue
		}
		if seen[sel] {
			continue
		}
		role := strings.ToLower(strings.TrimSpace(r.Role))
		if role != "card" && role != "callout" && role != "ignore" {
			continue
		}

		cleanRule := ContainerMappingRule{
			ContainerSelector: sel,
			Role:              role,
			CalloutType:       normalizeProbeCalloutType(r.CalloutType),
			TitleSelector:     compileOrClearSelector(r.TitleSelector),
			EyebrowSelector:   compileOrClearSelector(r.EyebrowSelector),
			BodySelector:      compileOrClearSelector(r.BodySelector),
			LinkSelector:      compileOrClearSelector(r.LinkSelector),
		}
		seen[sel] = true
		out = append(out, cleanRule)
	}
	return out
}

func compileOrClearSelector(sel string) string {
	s := strings.TrimSpace(sel)
	if s == "" {
		return ""
	}
	if _, err := cascadia.Compile(s); err != nil {
		return ""
	}
	return s
}

func normalizeProbeCalloutType(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "note", "tip", "check", "important", "warning", "danger", "info":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return "info"
	}
}

// ApplySiteContainerRulesToDocs 按已校验的规则对含 rawHtml 的文档执行确定性 DOM 重抽取（复用 Phase 1 逐卡守恒校验门）。
func ApplySiteContainerRulesToDocs(docs []FirecrawlDoc, rules []ContainerMappingRule) ([]FirecrawlDoc, int) {
	if len(docs) == 0 || len(rules) == 0 {
		return docs, 0
	}

	out := make([]FirecrawlDoc, len(docs))
	copy(out, docs)
	totalApplied := 0

	for i, d := range docs {
		rawHTML := ""
		if d.Metadata != nil {
			if s, ok := d.Metadata["rawHtml"].(string); ok {
				rawHTML = s
			} else if s, ok := d.Metadata["html"].(string); ok {
				rawHTML = s
			}
		}
		if strings.TrimSpace(rawHTML) == "" {
			continue
		}

		parsedDoc, err := html.Parse(strings.NewReader(rawHTML))
		if err != nil {
			continue
		}
		contentNode := findMainContentNode(parsedDoc)
		if contentNode == nil {
			contentNode = findFirstElementByTag(parsedDoc, "body")
		}
		if contentNode == nil {
			continue
		}

		var tel ContentLiftTelemetry
		cleanContentNodeWithContext(contentNode, d.URL, &tel)
		injectScriptAwareSpacing(contentNode)

		store := &liftStore{}
		appliedInDoc := applyValidatedRulesToContentNode(contentNode, d.URL, rules, store, &tel)
		if appliedInDoc == 0 {
			continue
		}
		applyDOMContentLifting(contentNode, d.URL, store, &tel)
		newMD := strings.TrimSpace(renderNodeWithLiftStore(contentNode, store))
		if len(newMD) < markdownMinChars {
			continue
		}

		out[i].Markdown = newMD
		out[i].ContentHash = hashContent(newMD)
		totalApplied += appliedInDoc
	}
	return out, totalApplied
}

func applyValidatedRulesToContentNode(root *html.Node, pageURL string, rules []ContainerMappingRule, store *liftStore, tel *ContentLiftTelemetry) int {
	applied := 0

	for _, rule := range rules {
		sel, err := cascadia.Compile(rule.ContainerSelector)
		if err != nil {
			continue
		}
		matches := cascadia.QueryAll(root, sel)
		if len(matches) == 0 {
			continue
		}

		switch rule.Role {
		case "ignore":
			for _, m := range matches {
				if m == root || m.Parent == nil || !isAncestor(root, m) {
					continue
				}
				m.Parent.RemoveChild(m)
				applied++
			}
		case "callout":
			for _, m := range matches {
				if m == root || m.Parent == nil || !isAncestor(root, m) {
					continue
				}
				if hasLiftAncestor(m) {
					continue
				}
				if liftCustomCalloutByRule(m, rule, store) {
					applied++
					if tel != nil {
						tel.CalloutsLifted++
					}
				}
			}
		case "card":
			applied += liftCustomCardsByRule(matches, root, pageURL, rule, store, tel)
		}
	}
	return applied
}

func hasLiftAncestor(n *html.Node) bool {
	for p := n.Parent; p != nil; p = p.Parent {
		if p.Type == html.ElementNode && strings.EqualFold(p.Data, "opengits-lift") {
			return true
		}
	}
	return false
}

func liftCustomCalloutByRule(node *html.Node, rule ContainerMappingRule, store *liftStore) bool {
	work := cloneHTMLNode(node)
	title := ""
	if rule.TitleSelector != "" {
		if sel, err := cascadia.Compile(rule.TitleSelector); err == nil {
			if tNode := cascadia.Query(work, sel); tNode != nil {
				title = strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(tNode), " "))
				if tNode.Parent != nil {
					tNode.Parent.RemoveChild(tNode)
				}
			}
		}
	}

	var bodyMD string
	if rule.BodySelector != "" {
		if sel, err := cascadia.Compile(rule.BodySelector); err == nil {
			if bNode := cascadia.Query(work, sel); bNode != nil {
				bodyMD = strings.TrimSpace(renderNodeWithLiftStore(bNode, store))
			}
		}
	}
	if bodyMD == "" {
		bodyMD = renderChildListToMarkdown(allChildNodes(work), store)
	}
	if bodyMD == "" {
		return false
	}

	origText := extractNodeText(node)
	if !passesNormalizedTextConservation(origText, title+" "+bodyMD) {
		return false
	}

	cType := normalizeProbeCalloutType(rule.CalloutType)
	var mdx string
	if title != "" {
		mdx = fmt.Sprintf("<Callout type=\"%s\" title=\"%s\">\n\n%s\n\n</Callout>", formatJSXAttr(cType), formatJSXAttr(title), bodyMD)
	} else {
		mdx = fmt.Sprintf("<Callout type=\"%s\">\n\n%s\n\n</Callout>", formatJSXAttr(cType), bodyMD)
	}
	replaceNodeWithLift(node, mdx, store)
	return true
}

func liftCustomCardsByRule(matches []*html.Node, root *html.Node, pageURL string, rule ContainerMappingRule, store *liftStore, tel *ContentLiftTelemetry) int {
	// 按父节点分组连续/同级匹配的自定义卡片容器
	type parentGroup struct {
		parent *html.Node
		items  []*html.Node
	}
	var groups []*parentGroup
	byParent := make(map[*html.Node]*parentGroup)
	for _, m := range matches {
		if m == root || m.Parent == nil || !isAncestor(root, m) || hasLiftAncestor(m) {
			continue
		}
		g, exists := byParent[m.Parent]
		if !exists {
			g = &parentGroup{parent: m.Parent}
			byParent[m.Parent] = g
			groups = append(groups, g)
		}
		g.items = append(g.items, m)
	}

	applied := 0
	for _, grp := range groups {
		cards := make([]cardCandidate, 0, len(grp.items))
		gateFailed := false
		for _, item := range grp.items {
			c, ok := extractCustomCardCandidate(item, pageURL, rule, store)
			if !ok {
				gateFailed = true
				break
			}
			cards = append(cards, c)
		}
		if gateFailed || len(cards) == 0 {
			if tel != nil && len(grp.items) > 0 {
				tel.CardGateFailures++
			}
			continue
		}

		// 若父容器仅含这些卡片（如 grid 容器），整个父容器替换为 <CardGroup>；否则各自原地替换单个 <Card>
		if len(grp.items) >= 2 && parentContainsOnlyNodes(grp.parent, grp.items) {
			cols := mapCardGridCols(len(cards))
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("<CardGroup cols=\"%s\">\n", cols))
			for _, c := range cards {
				sb.WriteString(renderCardJSX(c))
				sb.WriteByte('\n')
			}
			sb.WriteString("</CardGroup>")
			replaceNodeWithLift(grp.parent, sb.String(), store)
			applied += len(cards)
			if tel != nil {
				tel.CardGroupsLifted++
				tel.CardsLifted += len(cards)
			}
		} else if len(grp.items) >= 2 {
			// 多卡位于同一父节点但前后还有其他段落：将卡片包进 <CardGroup> 放在首卡位置，并移除其余卡片节点
			cols := mapCardGridCols(len(cards))
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("<CardGroup cols=\"%s\">\n", cols))
			for _, c := range cards {
				sb.WriteString(renderCardJSX(c))
				sb.WriteByte('\n')
			}
			sb.WriteString("</CardGroup>")
			replaceNodeWithLift(grp.items[0], sb.String(), store)
			for _, rest := range grp.items[1:] {
				if rest.Parent != nil {
					rest.Parent.RemoveChild(rest)
				}
			}
			applied += len(cards)
			if tel != nil {
				tel.CardGroupsLifted++
				tel.CardsLifted += len(cards)
			}
		} else {
			replaceNodeWithLift(grp.items[0], renderCardJSX(cards[0]), store)
			applied++
			if tel != nil {
				tel.CardsLifted++
			}
		}
	}
	return applied
}

func parentContainsOnlyNodes(parent *html.Node, items []*html.Node) bool {
	set := make(map[*html.Node]bool, len(items))
	for _, it := range items {
		set[it] = true
	}
	for _, ch := range meaningfulChildNodes(parent) {
		if !set[ch] {
			return false
		}
	}
	return true
}

func extractCustomCardCandidate(item *html.Node, _ string, rule ContainerMappingRule, store *liftStore) (cardCandidate, bool) {
	origText := extractNodeText(item)
	work := cloneHTMLNode(item)

	var href string
	var linkCTAText string
	if strings.EqualFold(work.Data, "a") {
		href = strings.TrimSpace(getNodeAttr(work, "href"))
	} else if rule.LinkSelector != "" {
		if sel, err := cascadia.Compile(rule.LinkSelector); err == nil {
			if linkNode := cascadia.Query(work, sel); linkNode != nil {
				href = strings.TrimSpace(getNodeAttr(linkNode, "href"))
				linkCTAText = strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(linkNode), " "))
			}
		}
	}
	if href == "" {
		if firstA := findFirstElementByTag(work, "a"); firstA != nil {
			href = strings.TrimSpace(getNodeAttr(firstA, "href"))
			if linkCTAText == "" {
				linkCTAText = strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(firstA), " "))
			}
		}
	}

	var eyebrow string
	if rule.EyebrowSelector != "" {
		if sel, err := cascadia.Compile(rule.EyebrowSelector); err == nil {
			if ebNode := cascadia.Query(work, sel); ebNode != nil {
				eyebrow = strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(ebNode), " "))
				if ebNode.Parent != nil {
					ebNode.Parent.RemoveChild(ebNode)
				}
			}
		}
	}

	var title string
	if rule.TitleSelector != "" {
		if sel, err := cascadia.Compile(rule.TitleSelector); err == nil {
			if tNode := cascadia.Query(work, sel); tNode != nil {
				title = strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(tNode), " "))
				if tNode.Parent != nil {
					tNode.Parent.RemoveChild(tNode)
				}
			}
		}
	}
	if title == "" {
		for _, hTag := range []string{"h2", "h3", "h4", "h5", "h6", "strong"} {
			if hNode := findFirstElementByTag(work, hTag); hNode != nil {
				t := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(hNode), " "))
				if t != "" {
					title = t
					if hNode.Parent != nil {
						hNode.Parent.RemoveChild(hNode)
					}
					break
				}
			}
		}
	}
	if title == "" {
		return cardCandidate{}, false
	}

	var bodyMD string
	if rule.BodySelector != "" {
		if sel, err := cascadia.Compile(rule.BodySelector); err == nil {
			if bNode := cascadia.Query(work, sel); bNode != nil {
				if href != "" {
					unwrapDescendantAnchors(bNode)
				}
				liftCompactPillLists(bNode, store, true)
				bodyMD = renderChildListToMarkdown(allChildNodes(bNode), store)
				if linkCTAText != "" && !strings.Contains(bodyMD, linkCTAText) && !strings.EqualFold(linkCTAText, title) {
					if bodyMD != "" {
						bodyMD += "\n\n" + linkCTAText
					} else {
						bodyMD = linkCTAText
					}
				}
			}
		}
	}
	if bodyMD == "" {
		if href != "" {
			unwrapDescendantAnchors(work)
		}
		liftCompactPillLists(work, store, true)
		bodyMD = renderChildListToMarkdown(allChildNodes(work), store)
	}

	// Phase 1 逐卡归一化文本守恒校验门：确保无文本丢帧
	if !passesNormalizedTextConservation(origText, title+" "+eyebrow+" "+bodyMD) {
		return cardCandidate{}, false
	}

	return cardCandidate{
		title:      title,
		eyebrow:    eyebrow,
		href:       href,
		body:       bodyMD,
		passesGate: true,
	}, true
}

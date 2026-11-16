package webdoc

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// ─────────────────────────────────────────────────────────────
// WebDoc 正文 DOM 结构升维与卫生守门（Phase 1 + Phase 2）
//
// 1. 强信号优先 SVG 分级清洗与资产化（N-1 终态二选一：剥除或转 data:image/svg+xml 交资产持久化，零裸 <svg> 透传）；
// 2. N-2 Fail-Closed 锚型 UI Chrome 剪枝（仅裁剪明确外站编辑/反馈工具条，同源链接网格一律保留）；
// 3. Unicode 脚本感知的相邻间距注入（严禁向 Han/Hiragana/Katakana/Bopomofo 及 Digit↔Letter 注入空格）；
// 4. 紧凑 Pill 列表归一化（`Slack` · `Microsoft Teams` · `GitHub`）；
// 5. Phase 2 通用语义组件升维：<CodeGroup>、<Accordion>/<AccordionGroup>、<Callout>、<Steps>/<Step>；
// 6. Phase 1 Block-in-Anchor 卡片升维：<CardGroup>/<Card> + 逐卡归一化守恒验证门 + 熔断引用卡兜底。
// ─────────────────────────────────────────────────────────────

type liftContextKey struct{}

type liftStore struct {
	blocks []string
}

func (s *liftStore) add(mdx string) int {
	id := len(s.blocks)
	s.blocks = append(s.blocks, mdx)
	return id
}

func withLiftStore(ctx context.Context, s *liftStore) context.Context {
	return context.WithValue(ctx, liftContextKey{}, s)
}

func getLiftStore(ctx context.Context) *liftStore {
	if s, ok := ctx.Value(liftContextKey{}).(*liftStore); ok {
		return s
	}
	return nil
}

// RegisterWebDocLiftPlugin 注册 html-to-markdown/v2 的结构升维占位块渲染器。
func RegisterWebDocLiftPlugin() converter.Plugin {
	return &webDocLiftPlugin{}
}

type webDocLiftPlugin struct{}

func (p *webDocLiftPlugin) Name() string {
	return "opengits-webdoc-lift"
}

func (p *webDocLiftPlugin) Init(conv *converter.Converter) error {
	conv.Register.RendererFor("opengits-lift", converter.TagTypeBlock, func(ctx converter.Context, w converter.Writer, n *html.Node) converter.RenderStatus {
		store := getLiftStore(ctx)
		if store == nil {
			return converter.RenderTryNext
		}
		idStr := getNodeAttr(n, "data-lift-id")
		id, err := strconv.Atoi(strings.TrimSpace(idStr))
		if err != nil || id < 0 || id >= len(store.blocks) {
			return converter.RenderSuccess
		}
		_, _ = w.WriteString("\n\n")
		_, _ = w.WriteString(store.blocks[id])
		_, _ = w.WriteString("\n\n")
		return converter.RenderSuccess
	}, converter.PriorityEarly)
	return nil
}

var (
	reCardConservationTokens = regexp.MustCompile("(?m)(?:^[ \\t]*>[ \\t]?|`+|\\s*·\\s*|\\*\\*|\\[|\\]|\\\\)")
	reSpaceUnit              = regexp.MustCompile(`\s+`)
)

// ConvertHTMLToMarkdown 对原始 HTML 字符串执行与 FastPath 完全一致的正文定位、清洗与结构升维。
// 供 Firecrawl HTML 格式接入及 Phase 4 站点级规则重放共用（单一收敛管道）。
func ConvertHTMLToMarkdown(rawHTML string, pageURL string) (markdown string, title string, headings []FastPathHeading, tel ContentLiftTelemetry, ok bool) {
	if strings.TrimSpace(rawHTML) == "" {
		return "", "", nil, tel, false
	}
	doc, err := html.Parse(strings.NewReader(rawHTML))
	if err != nil {
		return "", "", nil, tel, false
	}
	return ConvertParsedDocToMarkdown(doc, pageURL)
}

// ConvertParsedDocToMarkdown 对已解析的 HTML 文档执行清洗、结构升维与 Markdown 转录。
func ConvertParsedDocToMarkdown(doc *html.Node, pageURL string) (markdown string, title string, headings []FastPathHeading, tel ContentLiftTelemetry, ok bool) {
	if doc == nil {
		return "", "", nil, tel, false
	}
	contentNode := findMainContentNode(doc)
	if contentNode == nil {
		body := findFirstElementByTag(doc, "body")
		if body == nil {
			return "", "", nil, tel, false
		}
		bodyText := strings.TrimSpace(extractNodeText(body))
		if len(bodyText) < bodyFallbackMinChars {
			return "", "", nil, tel, false
		}
		contentNode = body
	}

	tel.PagesScanned = 1
	cleanContentNodeWithContext(contentNode, pageURL, &tel)
	injectScriptAwareSpacing(contentNode)

	title = ExtractWebPageTitle(doc, contentNode)
	headings = extractHeadingsFromNode(contentNode)
	if (title == "" || title == "Untitled") && len(headings) > 0 && headings[0].Text != "" {
		title = headings[0].Text
	}

	renderedHTML := renderNodeHTML(contentNode)
	if len(strings.TrimSpace(renderedHTML)) < htmlMinChars {
		return "", title, headings, tel, false
	}

	markdown = convertContentNodeWithLift(contentNode, pageURL, &tel)
	if len(strings.TrimSpace(markdown)) < markdownMinChars {
		return "", title, headings, tel, false
	}
	return markdown, title, headings, tel, true
}

func convertContentNodeWithLift(contentNode *html.Node, pageURL string, tel *ContentLiftTelemetry) string {
	store := &liftStore{}
	applyDOMContentLifting(contentNode, pageURL, store, tel)
	return strings.TrimSpace(renderNodeWithLiftStore(contentNode, store))
}

func renderNodeWithLiftStore(n *html.Node, store *liftStore) string {
	if n == nil {
		return ""
	}
	ctx := withLiftStore(context.Background(), store)
	mdConverterMu.Lock()
	out, err := getMDConverter().ConvertNode(n, converter.WithContext(ctx))
	mdConverterMu.Unlock()
	if err != nil {
		return strings.TrimSpace(extractNodeText(n))
	}
	return strings.TrimSpace(string(out))
}

func renderChildListToMarkdown(nodes []*html.Node, store *liftStore) string {
	if len(nodes) == 0 {
		return ""
	}
	wrapper := &html.Node{
		Type:     html.ElementNode,
		Data:     "div",
		DataAtom: atom.Div,
	}
	// 复制节点引用进临时容器渲染（不破坏原父链，通过 Clone）
	for _, n := range nodes {
		if n != nil {
			wrapper.AppendChild(cloneHTMLNode(n))
		}
	}
	return strings.TrimSpace(renderNodeWithLiftStore(wrapper, store))
}

func cloneHTMLNode(n *html.Node) *html.Node {
	if n == nil {
		return nil
	}
	cp := &html.Node{
		Type:      n.Type,
		DataAtom:  n.DataAtom,
		Data:      n.Data,
		Namespace: n.Namespace,
		Attr:      append([]html.Attribute(nil), n.Attr...),
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		cp.AppendChild(cloneHTMLNode(c))
	}
	return cp
}

func replaceNodeWithLift(target *html.Node, mdx string, store *liftStore) {
	if target == nil || target.Parent == nil {
		return
	}
	id := store.add(mdx)
	placeholder := &html.Node{
		Type: html.ElementNode,
		Data: "opengits-lift",
		Attr: []html.Attribute{{Key: "data-lift-id", Val: strconv.Itoa(id)}},
	}
	target.Parent.InsertBefore(placeholder, target)
	target.Parent.RemoveChild(target)
}

// ─────────────────────────────────────────────────────────────
// 1. SVG 分级判定、剥除与资产化前置（N-1 终态二选一）
// ─────────────────────────────────────────────────────────────

func processContentSVGs(root *html.Node, tel *ContentLiftTelemetry) {
	if root == nil {
		return
	}
	var svgs []*html.Node
	var collect func(*html.Node)
	collect = func(n *html.Node) {
		if n.Type == html.ElementNode && strings.EqualFold(n.Data, "svg") {
			svgs = append(svgs, n)
			return // 不递归嵌套 svg
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collect(c)
		}
	}
	collect(root)

	for _, svg := range svgs {
		if svg.Parent == nil {
			continue
		}
		if shouldAssetizeSVG(svg, root) {
			alt := extractSVGAltText(svg, root)
			sanitizeSVGNode(svg)
			var buf bytes.Buffer
			if err := html.Render(&buf, svg); err == nil && buf.Len() > 0 {
				b64 := base64.StdEncoding.EncodeToString(buf.Bytes())
				imgNode := &html.Node{
					Type:     html.ElementNode,
					Data:     "img",
					DataAtom: atom.Img,
					Attr: []html.Attribute{
						{Key: "src", Val: "data:image/svg+xml;base64," + b64},
						{Key: "alt", Val: alt},
					},
				}
				svg.Parent.InsertBefore(imgNode, svg)
				svg.Parent.RemoveChild(svg)
				if tel != nil {
					tel.SvgsAssetized++
				}
				continue
			}
		}
		// 默认及剥除路径：彻底移除 SVG，严禁裸透传
		svg.Parent.RemoveChild(svg)
		if tel != nil {
			tel.SvgsStripped++
		}
	}
}

func shouldAssetizeSVG(svg *html.Node, root *html.Node) bool {
	// 优先级 1：强装饰声明 aria-hidden="true" 无条件剥除
	if strings.EqualFold(strings.TrimSpace(getNodeAttr(svg, "aria-hidden")), "true") {
		return false
	}

	large := hasExplicitLargeSVGSize(svg)
	inFigure := isInsideFigure(svg, root)

	// 优先级 2：图标上下文容器（a / button / li / h1..h6 / pill 标签）默认剥除，
	// 仅显式 width>=100 || height>=100 且位于 <figure> 的核心图示可豁免（严禁 viewBox 放行图标库）
	if isInIconContext(svg, root) {
		return large && inFigure
	}

	// 优先级 3：中性容器 + 显式大图特征或 <figure> 内主图示
	return large || inFigure
}

func hasExplicitLargeSVGSize(svg *html.Node) bool {
	w := parseSVGDimension(getNodeAttr(svg, "width"))
	h := parseSVGDimension(getNodeAttr(svg, "height"))
	return w >= 100 || h >= 100
}

func parseSVGDimension(raw string) float64 {
	s := strings.TrimSpace(strings.ToLower(raw))
	if s == "" || s == "auto" || strings.HasSuffix(s, "%") {
		return 0
	}
	s = strings.TrimSuffix(s, "px")
	s = strings.TrimSpace(s)
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

func isInsideFigure(n *html.Node, root *html.Node) bool {
	for p := n.Parent; p != nil; p = p.Parent {
		if p.Type == html.ElementNode && strings.EqualFold(p.Data, "figure") {
			return true
		}
		if p == root {
			break
		}
	}
	return false
}

func isInIconContext(n *html.Node, root *html.Node) bool {
	for p := n.Parent; p != nil; p = p.Parent {
		if p.Type == html.ElementNode {
			tag := strings.ToLower(p.Data)
			switch tag {
			case "a", "button", "li", "h1", "h2", "h3", "h4", "h5", "h6", "summary", "label":
				return true
			}
			role := strings.ToLower(strings.TrimSpace(getNodeAttr(p, "role")))
			if role == "button" || role == "tab" {
				return true
			}
			if hasClassToken(p, "icon", "icons", "pill", "badge", "chip", "avatar", "btn") {
				return true
			}
		}
		if p == root {
			break
		}
	}
	return false
}

func hasClassToken(n *html.Node, targets ...string) bool {
	cls := strings.ToLower(getNodeAttr(n, "class"))
	if cls == "" {
		return false
	}
	fields := strings.Fields(cls)
	for _, f := range fields {
		for _, t := range targets {
			if f == t {
				return true
			}
		}
	}
	return false
}

func hasClassSubstring(n *html.Node, subs ...string) bool {
	cls := strings.ToLower(getNodeAttr(n, "class"))
	if cls == "" {
		return false
	}
	for _, s := range subs {
		if strings.Contains(cls, s) {
			return true
		}
	}
	return false
}

func extractSVGAltText(svg *html.Node, root *html.Node) string {
	if aria := strings.TrimSpace(getNodeAttr(svg, "aria-label")); aria != "" {
		return reMultiSpaces.ReplaceAllString(aria, " ")
	}
	var titleText string
	var walk func(*html.Node)
	walk = func(curr *html.Node) {
		if titleText != "" {
			return
		}
		if curr.Type == html.ElementNode && strings.EqualFold(curr.Data, "title") {
			t := strings.TrimSpace(extractRawNodeText(curr))
			if t != "" {
				titleText = reMultiSpaces.ReplaceAllString(t, " ")
				return
			}
		}
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(svg)
	if titleText != "" {
		return titleText
	}
	return "diagram"
}

func extractRawNodeText(n *html.Node) string {
	var sb strings.Builder
	var walk func(*html.Node)
	walk = func(curr *html.Node) {
		if curr.Type == html.TextNode {
			sb.WriteString(curr.Data)
			return
		}
		if curr.Type == html.ElementNode {
			tag := strings.ToLower(curr.Data)
			if tag == "br" {
				sb.WriteByte('\n')
				return
			}
			isLineBlock := tag == "div" || tag == "p" || tag == "li" || tag == "tr"
			if isLineBlock && sb.Len() > 0 {
				cur := sb.String()
				if cur[len(cur)-1] != '\n' {
					sb.WriteByte('\n')
				}
			}
			for c := curr.FirstChild; c != nil; c = c.NextSibling {
				walk(c)
			}
			if isLineBlock && sb.Len() > 0 {
				cur := sb.String()
				if cur[len(cur)-1] != '\n' {
					sb.WriteByte('\n')
				}
			}
			return
		}
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return sb.String()
}

// sanitizeSVGNode 剥离 SVG 内的危险元素/事件属性与 <title>/<desc>（避免文本重影与 XSS），确保 xmlns 完备。
func sanitizeSVGNode(svg *html.Node) {
	if svg == nil {
		return
	}
	hasXmlns := false
	for _, a := range svg.Attr {
		if strings.EqualFold(a.Key, "xmlns") {
			hasXmlns = true
			break
		}
	}
	if !hasXmlns {
		svg.Attr = append(svg.Attr, html.Attribute{Key: "xmlns", Val: "http://www.w3.org/2000/svg"})
	}

	var clean func(*html.Node)
	clean = func(n *html.Node) {
		if n.Type == html.ElementNode {
			cleanAttrs := make([]html.Attribute, 0, len(n.Attr))
			for _, a := range n.Attr {
				kl := strings.ToLower(strings.TrimSpace(a.Key))
				if strings.HasPrefix(kl, "on") && len(kl) > 2 {
					continue
				}
				if kl == "href" || kl == "xlink:href" || kl == "src" {
					vl := strings.Map(func(r rune) rune {
						if unicode.IsSpace(r) || unicode.IsControl(r) {
							return -1
						}
						return unicode.ToLower(r)
					}, a.Val)
					if strings.HasPrefix(vl, "javascript:") || strings.HasPrefix(vl, "vbscript:") || strings.HasPrefix(vl, "data:text/html") {
						continue
					}
				}
				cleanAttrs = append(cleanAttrs, a)
			}
			n.Attr = cleanAttrs
		}
		var next *html.Node
		for c := n.FirstChild; c != nil; c = next {
			next = c.NextSibling
			if c.Type == html.ElementNode {
				tag := strings.ToLower(c.Data)
				if tag == "script" || tag == "foreignobject" || tag == "iframe" ||
					tag == "object" || tag == "embed" || tag == "title" || tag == "desc" {
					n.RemoveChild(c)
					continue
				}
			}
			clean(c)
		}
	}
	clean(svg)
}

// sanitizeSVGBytes 对外部下载或解码的 .svg 字节流执行同一 DOM 级清洗（N-1 安全兜底）。
func sanitizeSVGBytes(raw []byte) ([]byte, bool) {
	doc, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return nil, false
	}
	svg := findFirstElementByTag(doc, "svg")
	if svg == nil {
		return nil, false
	}
	sanitizeSVGNode(svg)
	var buf bytes.Buffer
	if err := html.Render(&buf, svg); err != nil || buf.Len() == 0 {
		return nil, false
	}
	return buf.Bytes(), true
}

// ─────────────────────────────────────────────────────────────
// 2. N-2 Fail-Closed 锚型 UI Chrome 剪枝（同源文档链接一律保留）
// ─────────────────────────────────────────────────────────────

func pruneAnchorChrome(root *html.Node, pageURL string) {
	if root == nil {
		return
	}
	var baseOrigin string
	if pageURL != "" {
		if u, err := urlParseSafe(pageURL); err == nil && u != nil && u.Scheme != "" && u.Host != "" {
			baseOrigin = u.Scheme + "://" + u.Host
		}
	}

	var candidates []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && strings.EqualFold(n.Data, "a") {
			if isVerifiedChromeAnchor(n, pageURL, baseOrigin) {
				candidates = append(candidates, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)

	for _, a := range candidates {
		parent := a.Parent
		if parent == nil {
			continue
		}
		parent.RemoveChild(a)
		pruneEmptyChromeWrapper(parent, root)
	}
}

func isVerifiedChromeAnchor(a *html.Node, pageURL, baseOrigin string) bool {
	href := strings.TrimSpace(getNodeAttr(a, "href"))
	if href == "" || strings.HasPrefix(href, "#") {
		return false
	}

	// 同源文档链接一律严禁删除（N-2 核心不变量：宁漏剪，绝不误删相关推荐/Next Guides 卡片）
	if baseOrigin != "" {
		if baseU, err := urlParseSafe(pageURL); err == nil && baseU != nil {
			if refU, err := urlParseSafe(href); err == nil && refU != nil {
				resolved := baseU.ResolveReference(refU)
				if resolved.Scheme+"://"+resolved.Host == baseOrigin {
					return false
				}
			}
		}
	} else if strings.HasPrefix(href, "/") || strings.HasPrefix(href, ".") {
		return false
	}

	// 块级多行卡片与长文本链接绝不是 UI chrome
	if hasBlockDescendant(a) {
		return false
	}

	text := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(a), " "))
	if utf8.RuneCountInString(text) > 48 {
		return false
	}
	lowerText := strings.ToLower(text)
	lowerHref := strings.ToLower(href)

	// 若位于正文长段落内（同级文本超 40 runes），禁止误杀
	if a.Parent != nil && strings.EqualFold(a.Parent.Data, "p") {
		totalParent := utf8.RuneCountInString(strings.TrimSpace(extractNodeText(a.Parent)))
		if totalParent-utf8.RuneCountInString(text) > 40 {
			return false
		}
	}

	isEditHref := (strings.Contains(lowerHref, "github.com/") && strings.Contains(lowerHref, "/edit/")) ||
		(strings.Contains(lowerHref, "gitlab") && strings.Contains(lowerHref, "/-/edit/")) ||
		(strings.Contains(lowerHref, "bitbucket.org/") && strings.Contains(lowerHref, "mode=edit"))
	isEditText := lowerText == "edit this page" ||
		lowerText == "edit this page on github" ||
		lowerText == "edit this page on gitlab" ||
		lowerText == "edit on github" ||
		lowerText == "edit on gitlab" ||
		lowerText == "suggest an edit" ||
		lowerText == "improve this page" ||
		lowerText == "编辑此页" ||
		lowerText == "在 github 上编辑"
	if isEditHref && (isEditText || strings.Contains(lowerText, "edit")) {
		return true
	}

	isFeedbackHref := (strings.Contains(lowerHref, "github.com/") && strings.Contains(lowerHref, "/issues/new")) ||
		strings.Contains(lowerHref, "forms.gle/") ||
		strings.Contains(lowerHref, "typeform.com/") ||
		strings.Contains(lowerHref, "tally.so/") ||
		strings.Contains(lowerHref, "canny.io/")
	isFeedbackText := lowerText == "give feedback" ||
		lowerText == "leave feedback" ||
		lowerText == "send feedback" ||
		lowerText == "feedback" ||
		lowerText == "report an issue" ||
		lowerText == "report a bug"
	if isFeedbackHref && isFeedbackText {
		return true
	}

	// 显式实用工具属性（不含任何同源链接前提下已在上方守住）
	attrHint := strings.ToLower(getNodeAttr(a, "class") + " " + getNodeAttr(a, "data-testid") + " " + getNodeAttr(a, "aria-label"))
	if strings.Contains(attrHint, "edit-this-page") || strings.Contains(attrHint, "theme-edit-this-page") ||
		strings.Contains(attrHint, "page-feedback") || strings.Contains(attrHint, "doc-feedback") {
		return isEditText || isFeedbackText || strings.Contains(lowerText, "edit") || strings.Contains(lowerText, "feedback")
	}
	return false
}

func pruneEmptyChromeWrapper(node *html.Node, root *html.Node) {
	if node == nil || node == root || node.Parent == nil {
		return
	}
	tag := strings.ToLower(node.Data)
	if tag == "main" || tag == "article" || tag == "body" {
		return
	}
	// 若容器内已无元素子节点，且剩余文本仅为空白或分隔符（· / | / -）
	for c := node.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode {
			return
		}
		if c.Type == html.TextNode {
			t := strings.TrimSpace(c.Data)
			if t != "" && t != "·" && t != "|" && t != "/" && t != "•" {
				return
			}
		}
	}
	parent := node.Parent
	parent.RemoveChild(node)
	pruneEmptyChromeWrapper(parent, root)
}

// ─────────────────────────────────────────────────────────────
// 3. Unicode 脚本感知的相邻间距注入（CJK 防篡改 + R-1）
// ─────────────────────────────────────────────────────────────

func isSpacelessScriptRune(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r) ||
		unicode.Is(unicode.Bopomofo, r) ||
		unicode.Is(unicode.Thai, r) ||
		unicode.Is(unicode.Lao, r) ||
		unicode.Is(unicode.Khmer, r) ||
		unicode.Is(unicode.Myanmar, r) ||
		unicode.Is(unicode.Tibetan, r)
}

func injectScriptAwareSpacing(root *html.Node) {
	if root == nil {
		return
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "pre" || tag == "code" || tag == "script" || tag == "style" || tag == "svg" {
				return
			}
		}

		// 先递归子级
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}

		if n.Type != html.ElementNode {
			return
		}

		// 在同一父节点下扫描紧邻的非空兄弟节点
		var cur *html.Node = n.FirstChild
		for cur != nil {
			next := nextVisibleSibling(cur)
			if next == nil {
				break
			}
			// 若两者之间已存在任何文本节点（如空白/换行），无需注入
			if hasInterveningTextNode(cur, next) {
				cur = next
				continue
			}
			if shouldInjectSpaceBetween(n, cur, next) {
				space := &html.Node{Type: html.TextNode, Data: " "}
				n.InsertBefore(space, next)
			}
			cur = next
		}
	}
	walk(root)
}

func nextVisibleSibling(n *html.Node) *html.Node {
	for s := n.NextSibling; s != nil; s = s.NextSibling {
		if s.Type == html.CommentNode {
			continue
		}
		if s.Type == html.TextNode && s.Data == "" {
			continue
		}
		if s.Type == html.ElementNode && strings.TrimSpace(extractNodeText(s)) == "" && !hasVisualMediaChild(s) {
			continue
		}
		return s
	}
	return nil
}

func hasVisualMediaChild(n *html.Node) bool {
	if n.Type == html.ElementNode && strings.EqualFold(n.Data, "img") {
		return true
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if hasVisualMediaChild(c) {
			return true
		}
	}
	return false
}

func hasInterveningTextNode(left, right *html.Node) bool {
	for s := left.NextSibling; s != nil && s != right; s = s.NextSibling {
		if s.Type == html.TextNode && s.Data != "" {
			return true
		}
	}
	return false
}

func shouldInjectSpaceBetween(parent, left, right *html.Node) bool {
	// 至少一侧为元素节点；或双方都非空文本/元素
	if left.Type != html.ElementNode && right.Type != html.ElementNode {
		return false
	}

	rawL := extractNodeText(left)
	rawR := extractNodeText(right)
	if rawL == "" || rawR == "" {
		return false
	}
	// 若节点自身边界已含空白（如 <span>foo </span><span>bar</span>），不重复插入
	lastRawL, _ := utf8.DecodeLastRuneInString(rawL)
	firstRawR, _ := utf8.DecodeRuneInString(rawR)
	if unicode.IsSpace(lastRawL) || unicode.IsSpace(firstRawR) {
		return false
	}

	trimL := strings.TrimSpace(rawL)
	trimR := strings.TrimSpace(rawR)
	if trimL == "" || trimR == "" {
		return false
	}

	cL, _ := utf8.DecodeLastRuneInString(trimL)
	cR, _ := utf8.DecodeRuneInString(trimR)
	if cL == utf8.RuneError || cR == utf8.RuneError {
		return false
	}

	// 1. 无空格书写系统（Han / Hiragana / Katakana / Bopomofo 等）绝对禁止注入空格
	if isSpacelessScriptRune(cL) || isSpacelessScriptRune(cR) {
		return false
	}

	// 2. Digit ↔ Letter 混合边界（防 <span>3</span><span>D</span> 变成 3 D）绝对禁止注入空格
	if (unicode.IsDigit(cL) && unicode.IsLetter(cR)) || (unicode.IsLetter(cL) && unicode.IsDigit(cR)) {
		return false
	}

	// 3. 标点/符号边界禁止注入空格
	if unicode.IsPunct(cL) || unicode.IsSymbol(cL) || unicode.IsPunct(cR) || unicode.IsSymbol(cR) {
		return false
	}

	hasBlockBoundary := isBlockElementNode(left) || isBlockElementNode(right)
	if !hasBlockBoundary {
		// 行内片段（<span>Web</span><span>Doc</span> 等）：
		// ① 单字碎片跳过；② 必须存在父容器布局间距信号（flex/grid/gap/space-x/margin）
		if utf8.RuneCountInString(trimL) < 2 || utf8.RuneCountInString(trimR) < 2 {
			return false
		}
		if !hasLayoutSpacingSignal(parent, left, right) {
			return false
		}
	}
	return true
}

func hasLayoutSpacingSignal(parent, left, right *html.Node) bool {
	if hasFlexGridGapHint(parent) {
		return true
	}
	if hasMarginSpacingHint(left) || hasMarginSpacingHint(right) {
		return true
	}
	if hasBlockDisplayHint(left) || hasBlockDisplayHint(right) {
		return true
	}
	tag := strings.ToLower(parent.Data)
	// 紧凑行内扁平化父容器内的块级相邻（如 <a> 内）在 bothBlock 已放行，
	// 其余 <ul>/<ol>/<li> 内紧邻兄弟若为块或胶囊也视为带布局间隔
	return tag == "ul" || tag == "ol"
}

func hasBlockDisplayHint(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	cls := strings.ToLower(getNodeAttr(n, "class"))
	for _, f := range strings.Fields(cls) {
		base := f
		if idx := strings.LastIndex(f, ":"); idx >= 0 {
			base = f[idx+1:]
		}
		switch base {
		case "block", "flex", "inline-flex", "grid", "inline-grid", "table":
			return true
		}
	}
	style := strings.ToLower(strings.ReplaceAll(getNodeAttr(n, "style"), " ", ""))
	return strings.Contains(style, "display:block") ||
		strings.Contains(style, "display:flex") ||
		strings.Contains(style, "display:grid")
}

func hasFlexGridGapHint(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	cls := strings.ToLower(getNodeAttr(n, "class"))
	for _, f := range strings.Fields(cls) {
		base := f
		if idx := strings.LastIndex(f, ":"); idx >= 0 {
			base = f[idx+1:]
		}
		if base == "flex" || base == "inline-flex" || base == "grid" || base == "inline-grid" ||
			strings.HasPrefix(base, "gap-") || strings.HasPrefix(base, "space-x-") ||
			strings.HasPrefix(base, "space-y-") || strings.HasPrefix(base, "divide-x-") ||
			base == "justify-between" || base == "justify-around" || base == "justify-evenly" {
			return true
		}
	}
	style := strings.ToLower(strings.ReplaceAll(getNodeAttr(n, "style"), " ", ""))
	return strings.Contains(style, "display:flex") || strings.Contains(style, "display:grid") || strings.Contains(style, "gap:")
}

// isVerticalStackContainer 判断节点是否为显式纵向堆叠列表/容器（flex-col / space-y / border-y / divide-y 且无横向网格覆盖），
// 防止纵向列表被误判为横向 Pill 胶囊条或卡片网格。
func isVerticalStackContainer(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	cls := strings.ToLower(getNodeAttr(n, "class"))
	if cls == "" {
		return false
	}
	hasFlexCol := false
	hasVerticalSpacing := false
	hasHorizontalOverride := false
	for _, f := range strings.Fields(cls) {
		base := f
		if idx := strings.LastIndex(f, ":"); idx >= 0 {
			base = f[idx+1:]
		}
		if base == "flex-col" || base == "flex-col-reverse" {
			hasFlexCol = true
		}
		if strings.HasPrefix(base, "space-y-") || strings.HasPrefix(base, "divide-y") || base == "border-y" {
			hasVerticalSpacing = true
		}
		if base == "grid" || base == "inline-grid" || base == "flex-row" || base == "inline-flex" ||
			base == "flex-wrap" || strings.HasPrefix(base, "grid-cols-") || strings.HasPrefix(base, "space-x-") ||
			strings.HasPrefix(base, "divide-x") {
			hasHorizontalOverride = true
		}
	}
	if hasVerticalSpacing && !hasHorizontalOverride {
		return true
	}
	return hasFlexCol && !hasHorizontalOverride
}

// hasHorizontalFlexOrGridHint 仅当容器呈现横向排列或网格布局（非纵向堆叠）时返回 true。
func hasHorizontalFlexOrGridHint(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	if isVerticalStackContainer(n) {
		return false
	}
	cls := strings.ToLower(getNodeAttr(n, "class"))
	for _, f := range strings.Fields(cls) {
		base := f
		if idx := strings.LastIndex(f, ":"); idx >= 0 {
			base = f[idx+1:]
		}
		if base == "flex" || base == "inline-flex" || base == "grid" || base == "inline-grid" ||
			base == "flex-row" || base == "flex-wrap" || strings.HasPrefix(base, "grid-cols-") ||
			strings.HasPrefix(base, "space-x-") || strings.HasPrefix(base, "divide-x-") ||
			base == "justify-between" || base == "justify-around" || base == "justify-evenly" {
			return true
		}
	}
	style := strings.ToLower(strings.ReplaceAll(getNodeAttr(n, "style"), " ", ""))
	if strings.Contains(style, "flex-direction:column") {
		return false
	}
	return strings.Contains(style, "display:flex") || strings.Contains(style, "display:inline-flex") || strings.Contains(style, "display:grid")
}

func hasMarginSpacingHint(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	cls := strings.ToLower(getNodeAttr(n, "class"))
	for _, f := range strings.Fields(cls) {
		base := f
		if idx := strings.LastIndex(f, ":"); idx >= 0 {
			base = f[idx+1:]
		}
		if strings.HasPrefix(base, "mr-") || strings.HasPrefix(base, "ml-") ||
			strings.HasPrefix(base, "mx-") || strings.HasPrefix(base, "me-") ||
			strings.HasPrefix(base, "ms-") {
			return true
		}
	}
	return false
}

// ─────────────────────────────────────────────────────────────
// 4. DOM 结构升维主协调器（Pill / CodeGroup / Accordion / Callout / Steps / Cards）
// ─────────────────────────────────────────────────────────────

func applyDOMContentLifting(root *html.Node, pageURL string, store *liftStore, tel *ContentLiftTelemetry) {
	if root == nil {
		return
	}
	// 1. 优先升维多语言代码选项卡（避免 tablist 按钮/列表被误当普通按钮或 pill 清理）
	liftCodeGroups(root, pageURL, store, tel)
	// 2. 紧凑 Pill 列表归一化（可在卡片、Callout、Accordion 内部与独立段落运行）
	liftCompactPillLists(root, store, false)
	// 3. 卡片网格与 Block-in-Anchor 卡片升维 + 逐卡守恒门 + 熔断引用卡兜底
	//    （前置升维使 Callout / Step / Accordion 内的 CardGroup 也能被完整保留）
	liftCardGridsAndBlockAnchors(root, pageURL, store, tel)
	// 4. 提示框（role=alert/note、data-callout、admonition、正文语义 aside）
	liftCallouts(root, store, tel)
	// 5. 有序步骤条（显式 steps 容器，不确定回退有序列表）
	liftSteps(root, store, tel)
	// 6. 折叠面板（<details> 与带硬证据 aria-controls 的触发器，Fail-Closed）
	liftAccordions(root, store, tel)
	// 7. 清理未被 CodeGroup/Accordion 消费的孤立 tablist 按钮 chrome
	cleanupUnconsumedTabControls(root)
}

func liftCompactPillLists(root *html.Node, store *liftStore, insideCard bool) {
	if root == nil {
		return
	}
	var lists []*html.Node
	var collect func(*html.Node)
	collect = func(n *html.Node) {
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "opengits-lift" || tag == "pre" || tag == "code" {
				return
			}
			if tag == "ul" || tag == "ol" {
				if isCompactPillList(n, insideCard) {
					lists = append(lists, n)
					return
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collect(c)
		}
	}
	collect(root)

	for _, list := range lists {
		if list.Parent == nil {
			continue
		}
		pills := renderCompactPillList(list)
		if pills != "" {
			replaceNodeWithLift(list, pills, store)
		}
	}
}

func isCompactPillList(listNode *html.Node, insideCard bool) bool {
	if listNode == nil || listNode.Type != html.ElementNode {
		return false
	}
	if strings.EqualFold(getNodeAttr(listNode, "role"), "tablist") || isExplicitStepsContainer(listNode) {
		return false
	}
	tag := strings.ToLower(listNode.Data)
	if !insideCard {
		if hasClassSubstring(listNode, "border-y", "divide-y") {
			return false
		}
		isExplicitPill := hasClassSubstring(listNode, "pill", "chip", "tag", "badge", "inline")
		if !isExplicitPill {
			if isVerticalStackContainer(listNode) {
				return false
			}
			if tag == "ol" && !hasClassSubstring(listNode, "list-none") {
				return false
			}
			if !hasHorizontalFlexOrGridHint(listNode) {
				return false
			}
		}
	}

	var items []*html.Node
	for c := listNode.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode && strings.TrimSpace(c.Data) == "" {
			continue
		}
		if c.Type == html.CommentNode {
			continue
		}
		if c.Type != html.ElementNode || !strings.EqualFold(c.Data, "li") {
			return false
		}
		if strings.EqualFold(getNodeAttr(c, "role"), "tab") {
			return false
		}
		items = append(items, c)
	}
	if len(items) < 2 || len(items) > 24 {
		return false
	}

	for _, li := range items {
		if hasBlockDescendant(li) || hasTagDescendant(li, "a") || hasTagDescendant(li, "img") {
			return false
		}
		txt := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(li), " "))
		runes := utf8.RuneCountInString(txt)
		if runes < 1 || runes > 32 || strings.Contains(txt, "\n") {
			return false
		}
		lastR, _ := utf8.DecodeLastRuneInString(txt)
		switch lastR {
		case '.', '!', '?', '。', '！', '？', ':', '：', ';', '；', ',', '，':
			return false
		}
	}
	return true
}

func renderCompactPillList(listNode *html.Node) string {
	var parts []string
	for c := listNode.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && strings.EqualFold(c.Data, "li") {
			txt := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(c), " "))
			if txt != "" {
				parts = append(parts, formatInlineCodePill(txt))
			}
		}
	}
	return strings.Join(parts, " · ")
}

func formatInlineCodePill(s string) string {
	if !strings.Contains(s, "`") {
		return "`" + s + "`"
	}
	return "`` " + s + " ``"
}

// ─────────────────────────────────────────────────────────────
// 5. Phase 2 语义组件升维（CodeGroup / Accordion / Callout / Steps）
// ─────────────────────────────────────────────────────────────

func liftCodeGroups(root *html.Node, pageURL string, store *liftStore, tel *ContentLiftTelemetry) {
	var tablists []*html.Node
	var collect func(*html.Node)
	collect = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if strings.EqualFold(n.Data, "opengits-lift") {
				return
			}
			if strings.EqualFold(getNodeAttr(n, "role"), "tablist") {
				tablists = append(tablists, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collect(c)
		}
	}
	collect(root)

	for _, tablist := range tablists {
		if tablist.Parent == nil {
			continue
		}
		tabs := findDescendantsByAttr(tablist, "role", "tab")
		if len(tabs) == 0 {
			continue
		}

		// 查找配对容器（最多向上 2 层）
		container := tablist.Parent
		var panels []*html.Node
		for depth := 0; depth < 2 && container != nil; depth++ {
			panels = matchTabPanels(container, root, tabs)
			if len(panels) == len(tabs) {
				break
			}
			if container == root {
				break
			}
			container = container.Parent
		}
		if len(panels) != len(tabs) || container == nil {
			continue
		}

		// 确认 container 内除 tablist 和 panels 外无大段正文才整体替换容器，否则仅替换 tablist 与各 panel
		type tabEntry struct {
			title   string
			lang    string
			code    string
			isCode  bool
			bodyMD  string
		}
		entries := make([]tabEntry, 0, len(tabs))
		allCode := true
		for i, tab := range tabs {
			tabTitle := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(tab), " "))
			if tabTitle == "" {
				tabTitle = fmt.Sprintf("Tab %d", i+1)
			}
			panel := panels[i]
			clearHiddenAttrs(panel)
			lang, code, okCode := extractPureCodePanel(panel)
			if okCode {
				entries = append(entries, tabEntry{title: tabTitle, lang: lang, code: code, isCode: true})
			} else {
				allCode = false
				// 对混合图文 Tab 面板先运行子树结构升维（Card/Callout/Steps/Accordion/Pill），再渲染为 Markdown
				liftCompactPillLists(panel, store, false)
				liftCardGridsAndBlockAnchors(panel, pageURL, store, tel)
				liftCallouts(panel, store, tel)
				liftSteps(panel, store, tel)
				liftAccordions(panel, store, tel)
				bodyMD := renderChildListToMarkdown(allChildNodes(panel), store)
				entries = append(entries, tabEntry{title: tabTitle, bodyMD: bodyMD})
			}
		}

		var mdxBuf strings.Builder
		if allCode {
			mdxBuf.WriteString("<CodeGroup>\n")
			for _, e := range entries {
				fence := fenceForCode(e.code)
				mdxBuf.WriteString(fmt.Sprintf(`<CodeGroupItem title="%s">`, formatJSXAttr(e.title)))
				mdxBuf.WriteString("\n\n")
				mdxBuf.WriteString(fence)
				if e.lang != "" {
					mdxBuf.WriteString(e.lang)
				}
				mdxBuf.WriteString("\n")
				mdxBuf.WriteString(e.code)
				if !strings.HasSuffix(e.code, "\n") {
					mdxBuf.WriteString("\n")
				}
				mdxBuf.WriteString(fence)
				mdxBuf.WriteString("\n\n</CodeGroupItem>\n")
			}
			mdxBuf.WriteString("</CodeGroup>")
			if tel != nil {
				tel.CodeGroupsLifted++
			}
		} else {
			// 混合图文 Tab：全部展开为带小标题的有序小节，不丢隐藏 panel 内容
			for idx, e := range entries {
				if idx > 0 {
					mdxBuf.WriteString("\n\n")
				}
				mdxBuf.WriteString("#### " + e.title + "\n\n")
				if e.isCode {
					fence := fenceForCode(e.code)
					mdxBuf.WriteString(fence)
					if e.lang != "" {
						mdxBuf.WriteString(e.lang)
					}
					mdxBuf.WriteString("\n" + e.code)
					if !strings.HasSuffix(e.code, "\n") {
						mdxBuf.WriteString("\n")
					}
					mdxBuf.WriteString(fence)
				} else if e.bodyMD != "" {
					mdxBuf.WriteString(e.bodyMD)
				}
			}
		}

		if canReplaceWholeTabContainer(container, root, tablist, panels) {
			replaceNodeWithLift(container, strings.TrimSpace(mdxBuf.String()), store)
		} else {
			replaceNodeWithLift(tablist, strings.TrimSpace(mdxBuf.String()), store)
			for _, p := range panels {
				if p.Parent != nil {
					p.Parent.RemoveChild(p)
				}
			}
		}
	}
}

func matchTabPanels(scope, root *html.Node, tabs []*html.Node) []*html.Node {
	var matched []*html.Node
	used := make(map[*html.Node]bool)
	for _, tab := range tabs {
		ctrl := strings.TrimSpace(getNodeAttr(tab, "aria-controls"))
		if ctrl != "" {
			if p := findUniqueElementByID(root, ctrl); p != nil && !used[p] {
				used[p] = true
				matched = append(matched, p)
				continue
			}
		}
	}
	if len(matched) == len(tabs) {
		return matched
	}
	// 按同容器内 [role="tabpanel"] 顺序配对
	panels := findDescendantsByAttr(scope, "role", "tabpanel")
	if len(panels) == len(tabs) {
		return panels
	}
	return nil
}

func canReplaceWholeTabContainer(container, root, tablist *html.Node, panels []*html.Node) bool {
	if container == nil || container == root || container.Parent == nil {
		return false
	}
	panelSet := make(map[*html.Node]bool, len(panels))
	for _, p := range panels {
		panelSet[p] = true
	}
	// 检查容器内除 tablist 和 panels 之外是否还有其他有意义正文
	var hasExtraText func(*html.Node) bool
	hasExtraText = func(n *html.Node) bool {
		if n == tablist || panelSet[n] {
			return false
		}
		if n.Type == html.TextNode {
			return strings.TrimSpace(n.Data) != ""
		}
		if n.Type == html.ElementNode {
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if hasExtraText(c) {
					return true
				}
			}
		}
		return false
	}
	for c := container.FirstChild; c != nil; c = c.NextSibling {
		if hasExtraText(c) {
			return false
		}
	}
	return true
}

func extractPureCodePanel(panel *html.Node) (lang string, code string, ok bool) {
	var pres []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && strings.EqualFold(n.Data, "pre") {
			pres = append(pres, n)
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(panel)
	if len(pres) != 1 {
		return "", "", false
	}
	pre := pres[0]
	// 确认 panel 中没有除 pre 之外的实质性正文（如 <p>, <h1..h6>, <ul>, <table>, <img> 等）
	var nonPreText strings.Builder
	var checkOutside func(*html.Node) bool
	checkOutside = func(n *html.Node) bool {
		if n == pre {
			return true
		}
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			switch tag {
			case "img", "table", "ul", "ol", "blockquote",
				"p", "h1", "h2", "h3", "h4", "h5", "h6",
				"aside", "details", "figure", "figcaption", "dl", "a":
				return false
			}
		}
		if n.Type == html.TextNode {
			nonPreText.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if !checkOutside(c) {
				return false
			}
		}
		return true
	}
	if !checkOutside(panel) {
		return "", "", false
	}
	extra := strings.TrimSpace(reMultiSpaces.ReplaceAllString(nonPreText.String(), " "))
	if extra != "" {
		// 仅允许极短代码头部标签/文件名（如 "index.ts"、"bash"），多词说明文本或句末标点视为混合图文面板（防静默丢文）
		if utf8.RuneCountInString(extra) > 24 || len(strings.Fields(extra)) > 2 || endsWithSentencePunct(extra) || strings.HasSuffix(extra, ":") {
			return "", "", false
		}
	}

	codeNode := findFirstElementByTag(pre, "code")
	if codeNode == nil {
		codeNode = pre
	}
	lang = detectCodeLanguage(pre, codeNode)
	code = strings.TrimRight(extractRawNodeText(codeNode), "\r\n")
	if strings.TrimSpace(code) == "" {
		return "", "", false
	}
	return lang, code, true
}

func detectCodeLanguage(pre, codeNode *html.Node) string {
	for _, n := range []*html.Node{codeNode, pre} {
		if n == nil {
			continue
		}
		if lang := strings.TrimSpace(getNodeAttr(n, "data-language")); lang != "" {
			return lang
		}
		cls := getNodeAttr(n, "class")
		for _, f := range strings.Fields(cls) {
			if strings.HasPrefix(f, "language-") {
				return strings.TrimPrefix(f, "language-")
			}
			if strings.HasPrefix(f, "lang-") {
				return strings.TrimPrefix(f, "lang-")
			}
		}
	}
	return ""
}

func fenceForCode(code string) string {
	maxRun := 2
	cur := 0
	for _, r := range code {
		if r == '`' {
			cur++
			if cur > maxRun {
				maxRun = cur
			}
		} else {
			cur = 0
		}
	}
	return strings.Repeat("`", maxRun+1)
}

func clearHiddenAttrs(root *html.Node) {
	if root == nil {
		return
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			filtered := make([]html.Attribute, 0, len(n.Attr))
			for _, a := range n.Attr {
				kl := strings.ToLower(a.Key)
				if kl == "hidden" || kl == "inert" || (kl == "aria-hidden" && strings.EqualFold(a.Val, "true")) {
					continue
				}
				filtered = append(filtered, a)
			}
			n.Attr = filtered
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
}

func liftAccordions(root *html.Node, store *liftStore, tel *ContentLiftTelemetry) {
	// 1. 原生 HTML5 <details><summary>...</summary>...</details>
	var detailsList []*html.Node
	var collectDetails func(*html.Node)
	collectDetails = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if strings.EqualFold(n.Data, "opengits-lift") {
				return
			}
			if strings.EqualFold(n.Data, "details") {
				detailsList = append(detailsList, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collectDetails(c)
		}
	}
	collectDetails(root)

	type accItem struct {
		node  *html.Node
		title string
		body  string
	}
	var liftedNodes []*html.Node

	for _, det := range detailsList {
		if det.Parent == nil {
			continue
		}
		var sumNode *html.Node
		var bodyNodes []*html.Node
		for c := det.FirstChild; c != nil; c = c.NextSibling {
			if sumNode == nil && c.Type == html.ElementNode && strings.EqualFold(c.Data, "summary") {
				sumNode = c
				continue
			}
			bodyNodes = append(bodyNodes, c)
		}
		if sumNode == nil {
			continue
		}
		title := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(sumNode), " "))
		body := renderChildListToMarkdown(bodyNodes, store)
		if title == "" || body == "" {
			continue
		}
		mdx := fmt.Sprintf("<Accordion title=\"%s\">\n\n%s\n\n</Accordion>", formatJSXAttr(title), body)
		replaceNodeWithLift(det, mdx, store)
		liftedNodes = append(liftedNodes, det)
		if tel != nil {
			tel.AccordionsLifted++
		}
	}
	_ = liftedNodes

	// 2. 硬证据 [aria-expanded][aria-controls="<panel-id>"]（禁止无 aria-controls 猜测兄弟配对）
	var triggers []*html.Node
	var collectTriggers func(*html.Node)
	collectTriggers = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if strings.EqualFold(n.Data, "opengits-lift") {
				return
			}
			if !strings.EqualFold(getNodeAttr(n, "role"), "tab") &&
				hasAttr(n, "aria-expanded") &&
				strings.TrimSpace(getNodeAttr(n, "aria-controls")) != "" {
				triggers = append(triggers, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collectTriggers(c)
		}
	}
	collectTriggers(root)

	ctrlRefCount := make(map[string]int, len(triggers))
	for _, trig := range triggers {
		if ctrlID := strings.TrimSpace(getNodeAttr(trig, "aria-controls")); ctrlID != "" {
			ctrlRefCount[ctrlID]++
		}
	}

	consumedTargets := make(map[*html.Node]bool)
	demoteAccordionButton := func(trig *html.Node) {
		if strings.EqualFold(trig.Data, "button") && trig.Parent != nil {
			txt := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(trig), " "))
			if txt != "" {
				trig.Parent.InsertBefore(&html.Node{Type: html.TextNode, Data: txt}, trig)
			}
			trig.Parent.RemoveChild(trig)
		}
	}
	for _, trig := range triggers {
		if trig.Parent == nil {
			continue
		}
		ctrlID := strings.TrimSpace(getNodeAttr(trig, "aria-controls"))
		if ctrlRefCount[ctrlID] != 1 {
			demoteAccordionButton(trig)
			continue
		}
		target := findUniqueElementByID(root, ctrlID)
		if target == nil || consumedTargets[target] || isAncestor(target, trig) || isAncestor(trig, target) {
			// Fail-closed：无法确定性解析唯一 panel，将 button 还原为纯文本节点（不破坏 <h3> 等外层结构）
			demoteAccordionButton(trig)
			continue
		}
		title := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(trig), " "))
		clearHiddenAttrs(target)
		body := renderChildListToMarkdown(allChildNodes(target), store)
		if title == "" || body == "" {
			demoteAccordionButton(trig)
			continue
		}
		consumedTargets[target] = true
		mdx := fmt.Sprintf("<Accordion title=\"%s\">\n\n%s\n\n</Accordion>", formatJSXAttr(title), body)
		// 若触发器被包在 <h3><button ...></h3> 这类单标题外壳内，提升替换触发器外壳
		replaceTarget := trig
		if trig.Parent != nil && trig.Parent != root && isHeadingTag(trig.Parent) && singleMeaningfulChild(trig.Parent, trig) {
			replaceTarget = trig.Parent
		}
		replaceNodeWithLift(replaceTarget, mdx, store)
		if target.Parent != nil {
			target.Parent.RemoveChild(target)
		}
		if tel != nil {
			tel.AccordionsLifted++
		}
	}

	// 将相邻的 >= 2 个 <Accordion> 占位块收敛包裹为 <AccordionGroup>
	groupConsecutiveLifts(root, store, "<Accordion ", "<AccordionGroup>\n", "\n</AccordionGroup>")
}

func groupConsecutiveLifts(root *html.Node, store *liftStore, prefix, openTag, closeTag string) {
	if root == nil {
		return
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type != html.ElementNode {
			return
		}
		var run []*html.Node
		flush := func() {
			if len(run) < 2 {
				run = nil
				return
			}
			var parts []string
			for _, node := range run {
				id, err := strconv.Atoi(getNodeAttr(node, "data-lift-id"))
				if err == nil && id >= 0 && id < len(store.blocks) {
					parts = append(parts, store.blocks[id])
				}
			}
			if len(parts) >= 2 {
				merged := openTag + strings.Join(parts, "\n") + closeTag
				newID := store.add(merged)
				first := run[0]
				setNodeAttr(first, "data-lift-id", strconv.Itoa(newID))
				for _, extra := range run[1:] {
					if extra.Parent != nil {
						extra.Parent.RemoveChild(extra)
					}
				}
			}
			run = nil
		}

		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.TextNode && strings.TrimSpace(c.Data) == "" {
				continue
			}
			if c.Type == html.ElementNode && strings.EqualFold(c.Data, "opengits-lift") {
				id, err := strconv.Atoi(getNodeAttr(c, "data-lift-id"))
				if err == nil && id >= 0 && id < len(store.blocks) && strings.HasPrefix(store.blocks[id], prefix) {
					run = append(run, c)
					continue
				}
			}
			flush()
		}
		flush()
	}
	walk(root)
}

func liftCallouts(root *html.Node, store *liftStore, tel *ContentLiftTelemetry) {
	var callouts []*html.Node
	var collect func(*html.Node)
	collect = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if strings.EqualFold(n.Data, "opengits-lift") {
				return
			}
			if _, ok := classifyCalloutNode(n, root); ok {
				callouts = append(callouts, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collect(c)
		}
	}
	collect(root)

	for _, co := range callouts {
		if co.Parent == nil {
			continue
		}
		cType, ok := classifyCalloutNode(co, root)
		if !ok {
			continue
		}
		title, bodyNodes := extractCalloutTitleAndBody(co)
		body := renderChildListToMarkdown(bodyNodes, store)
		if body == "" && title != "" {
			body = title
			title = ""
		}
		if body == "" {
			continue
		}
		// 守恒校验：确保无文本大面积丢失
		origText := extractNodeText(co)
		if !passesNormalizedTextConservation(origText, title+" "+body) {
			continue
		}

		var mdx string
		if title != "" {
			mdx = fmt.Sprintf("<Callout type=\"%s\" title=\"%s\">\n\n%s\n\n</Callout>",
				formatJSXAttr(cType), formatJSXAttr(title), body)
		} else {
			mdx = fmt.Sprintf("<Callout type=\"%s\">\n\n%s\n\n</Callout>",
				formatJSXAttr(cType), body)
		}
		replaceNodeWithLift(co, mdx, store)
		if tel != nil {
			tel.CalloutsLifted++
		}
	}
}

func classifyCalloutNode(n *html.Node, root *html.Node) (string, bool) {
	if n == nil || n.Type != html.ElementNode || n == root {
		return "", false
	}
	tag := strings.ToLower(n.Data)
	role := strings.ToLower(strings.TrimSpace(getNodeAttr(n, "role")))
	dataCallout := strings.ToLower(strings.TrimSpace(getNodeAttr(n, "data-callout")))
	dataCalloutType := strings.ToLower(strings.TrimSpace(getNodeAttr(n, "data-callout-type")))
	dataAdmonition := strings.ToLower(strings.TrimSpace(getNodeAttr(n, "data-admonition")))
	cls := strings.ToLower(getNodeAttr(n, "class"))

	hasExplicitSignal := role == "alert" || role == "note" ||
		hasAttr(n, "data-callout") || dataCalloutType != "" || dataAdmonition != "" ||
		strings.Contains(cls, "admonition") ||
		strings.Contains(cls, "callout") ||
		strings.Contains(cls, "custom-block") ||
		strings.Contains(cls, "starlight-aside") ||
		strings.Contains(cls, "markdown-alert")

	if !hasExplicitSignal && tag != "aside" {
		return "", false
	}
	// VitePress .custom-block.details 交给 <details> 或不按 callout 处理
	if strings.Contains(cls, "custom-block") && strings.Contains(cls, "details") {
		return "", false
	}
	// 若为 <aside>，排除侧栏/TOC 噪声；无显式 callout 信号的裸 <aside> 在 body 兜底容器下或含密集导航链接时不误升维
	if tag == "aside" {
		if hasClassSubstring(n, "sidebar", "toc", "table-of-contents") || hasTagDescendant(n, "nav") {
			return "", false
		}
		if !hasExplicitSignal {
			if root != nil && strings.EqualFold(root.Data, "body") {
				return "", false
			}
			if len(findDescendantsByTag(n, "a")) >= 3 {
				return "", false
			}
		}
	}
	// 排除导航翻页条或纯按钮工具栏
	if role == "navigation" || hasClassSubstring(n, "pagination", "breadcrumb", "toc") {
		return "", false
	}

	rawKind := strings.Join([]string{dataCalloutType, dataCallout, dataAdmonition, cls, role, getNodeAttr(n, "aria-label")}, " ")
	return mapCalloutType(rawKind), true
}

func mapCalloutType(signal string) string {
	s := strings.ToLower(signal)
	switch {
	case strings.Contains(s, "danger"), strings.Contains(s, "caution"), strings.Contains(s, "error"),
		strings.Contains(s, "destructive"), strings.Contains(s, "critical"):
		return "danger"
	case strings.Contains(s, "warning"), strings.Contains(s, "warn"), strings.Contains(s, "attention"):
		return "warning"
	case strings.Contains(s, "important"):
		return "important"
	case strings.Contains(s, "check"), strings.Contains(s, "success"), strings.Contains(s, "done"):
		return "check"
	case strings.Contains(s, "tip"), strings.Contains(s, "hint"):
		return "tip"
	case strings.Contains(s, "note"):
		return "note"
	default:
		return "info"
	}
}

func extractCalloutTitleAndBody(co *html.Node) (string, []*html.Node) {
	children := meaningfulChildNodes(co)
	if len(children) == 0 {
		return "", nil
	}
	if explicit := strings.TrimSpace(getNodeAttr(co, "data-title")); explicit != "" {
		return reMultiSpaces.ReplaceAllString(explicit, " "), children
	}

	first := children[0]
	if first.Type == html.ElementNode {
		cls := strings.ToLower(getNodeAttr(first, "class"))
		if strings.Contains(cls, "admonition-heading") || strings.Contains(cls, "admonition-title") ||
			strings.Contains(cls, "custom-block-title") || strings.Contains(cls, "callout-title") ||
			strings.Contains(cls, "markdown-alert-title") || strings.Contains(cls, "aside-title") ||
			hasAttr(first, "data-callout-title") || isHeadingTag(first) {
			t := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(first), " "))
			if t != "" && utf8.RuneCountInString(t) <= 80 && len(children) > 1 {
				return t, children[1:]
			}
		}
		// 首段仅为短粗体标题行（如 <p><strong>Note</strong></p>）且后面有正文段落
		if strings.EqualFold(first.Data, "p") && len(children) > 1 {
			sub := meaningfulChildNodes(first)
			if len(sub) == 1 && sub[0].Type == html.ElementNode && (strings.EqualFold(sub[0].Data, "strong") || strings.EqualFold(sub[0].Data, "b")) {
				t := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(sub[0]), " "))
				if t != "" && utf8.RuneCountInString(t) <= 60 {
					return t, children[1:]
				}
			}
		}
	}
	return "", children
}

func liftSteps(root *html.Node, store *liftStore, tel *ContentLiftTelemetry) {
	var containers []*html.Node
	var collect func(*html.Node)
	collect = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if strings.EqualFold(n.Data, "opengits-lift") {
				return
			}
			if isExplicitStepsContainer(n) {
				containers = append(containers, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collect(c)
		}
	}
	collect(root)

	for _, cont := range containers {
		if cont.Parent == nil {
			continue
		}
		items := meaningfulChildNodes(cont)
		if len(items) < 2 {
			continue
		}
		type stepSpec struct {
			title string
			body  string
		}
		var steps []stepSpec
		valid := true
		for i, item := range items {
			if item.Type != html.ElementNode {
				valid = false
				break
			}
			t, bodyNodes := extractStepTitleAndBody(item, i+1)
			body := renderChildListToMarkdown(bodyNodes, store)
			if body == "" || (t == "" && len(bodyNodes) == 0) {
				valid = false
				break
			}
			if !passesNormalizedTextConservation(extractNodeText(item), t+" "+body) {
				// 若因剥除纯数字序标导致极微小差异，放行仅等于步骤序号的徽章剥离
				if !passesNormalizedTextConservation(stripLeadingStepIndex(extractNodeText(item), i+1), t+" "+body) {
					valid = false
					break
				}
			}
			steps = append(steps, stepSpec{title: t, body: body})
		}
		if !valid || len(steps) < 2 {
			continue
		}

		var mdx strings.Builder
		mdx.WriteString("<Steps>\n")
		for _, s := range steps {
			if s.title != "" {
				mdx.WriteString(fmt.Sprintf("<Step title=\"%s\">\n\n%s\n\n</Step>\n", formatJSXAttr(s.title), s.body))
			} else {
				mdx.WriteString(fmt.Sprintf("<Step>\n\n%s\n\n</Step>\n", s.body))
			}
		}
		mdx.WriteString("</Steps>")
		replaceNodeWithLift(cont, mdx.String(), store)
		if tel != nil {
			tel.StepsLifted++
		}
	}
}

func isExplicitStepsContainer(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	if hasAttr(n, "data-steps") {
		return true
	}
	return hasClassToken(n, "steps", "fd-steps", "nextra-steps", "sl-steps", "step-list")
}

func extractStepTitleAndBody(item *html.Node, index int) (string, []*html.Node) {
	children := meaningfulChildNodes(item)
	// 剥除显式数字序号装饰徽章（如 <span class="step-number">1</span> 或 aria-hidden 数字角标）
	if len(children) > 1 && children[0].Type == html.ElementNode {
		badgeTxt := strings.TrimSpace(extractNodeText(children[0]))
		if badgeTxt == strconv.Itoa(index) &&
			(strings.EqualFold(getNodeAttr(children[0], "aria-hidden"), "true") ||
				hasClassSubstring(children[0], "step-number", "step-index", "step-badge")) {
			children = children[1:]
		}
	}
	if len(children) == 0 {
		return "", nil
	}
	first := children[0]
	if first.Type == html.ElementNode {
		if isHeadingTag(first) || hasClassSubstring(first, "step-title") {
			t := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(first), " "))
			if t != "" && len(children) > 1 {
				return t, children[1:]
			}
		}
		if strings.EqualFold(first.Data, "p") && len(children) > 1 {
			sub := meaningfulChildNodes(first)
			if len(sub) == 1 && sub[0].Type == html.ElementNode && (strings.EqualFold(sub[0].Data, "strong") || strings.EqualFold(sub[0].Data, "b")) {
				t := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(sub[0]), " "))
				if t != "" && utf8.RuneCountInString(t) <= 80 {
					return t, children[1:]
				}
			}
		}
	}
	return "", children
}

func stripLeadingStepIndex(s string, idx int) string {
	trimmed := strings.TrimSpace(s)
	num := strconv.Itoa(idx)
	if strings.HasPrefix(trimmed, num) {
		return strings.TrimSpace(strings.TrimPrefix(trimmed, num))
	}
	return trimmed
}

// ─────────────────────────────────────────────────────────────
// 6. Phase 1 Block-in-Anchor 卡片升维 + 逐卡确定性验证门 + 熔断降级兜底
// ─────────────────────────────────────────────────────────────

type cardCandidate struct {
	rootNode    *html.Node // 待替换 DOM 节点（可能是 <a> 或包裹单主链接的卡片外壳）
	anchorNode  *html.Node // Block-in-Anchor <a>（若存在）
	href        string
	eyebrow     string
	title       string
	body        string
	origText    string
	isComplex   bool
	passesGate  bool
}

func liftCardGridsAndBlockAnchors(root *html.Node, pageURL string, store *liftStore, tel *ContentLiftTelemetry) {
	if root == nil {
		return
	}

	// 1. 识别含 >= 2 张同构卡片的容器（网格/flex/列表卡片组）
	var containers []*html.Node
	var collectContainers func(*html.Node)
	collectContainers = func(n *html.Node) {
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "opengits-lift" || tag == "pre" || tag == "code" || tag == "table" {
				return
			}
			if looksLikeCardGridContainer(n) {
				containers = append(containers, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collectContainers(c)
		}
	}
	collectContainers(root)

	for _, cont := range containers {
		if cont.Parent == nil {
			continue
		}
		children := meaningfulChildNodes(cont)
		if len(children) < 2 {
			continue
		}

		// 若容器内还有部分文本或标题（如 <section><h2>Related</h2><div class="grid">...</div></section>），
		// only treat direct children if ALL meaningful children are card candidates!
		cards := make([]cardCandidate, 0, len(children))
		allAreCards := true
		for _, ch := range children {
			cand, ok := extractCardCandidate(ch, pageURL, store)
			if !ok {
				allAreCards = false
				break
			}
			cards = append(cards, cand)
		}
		if !allAreCards || len(cards) < 2 {
			continue
		}

		// 逐卡验证门（R-2）：整组任意一卡未通过即整组 fail-closed
		groupValid := true
		for _, c := range cards {
			if c.isComplex || !c.passesGate {
				groupValid = false
				break
			}
		}

		if groupValid {
			cols := mapCardGridCols(len(cards))
			var mdx strings.Builder
			mdx.WriteString(fmt.Sprintf("<CardGroup cols=\"%s\">\n", cols))
			for _, c := range cards {
				mdx.WriteString(renderCardJSX(c))
				mdx.WriteString("\n")
			}
			mdx.WriteString("</CardGroup>")
			replaceNodeWithLift(cont, mdx.String(), store)
			if tel != nil {
				tel.CardGroupsLifted++
				tel.CardsLifted += len(cards)
			}
		} else {
			if tel != nil {
				tel.CardGateFailures++
			}
			// Fail-closed：整组回落为兜底引用卡形态（绝不压平为多行下划线链接）
			for _, c := range cards {
				if c.anchorNode != nil && c.anchorNode.Parent != nil {
					md := degradeBlockAnchorToQuoteCard(c.anchorNode, store)
					replaceNodeWithLift(c.anchorNode, md, store)
					if tel != nil {
						tel.AnchorDegradations++
					}
				}
			}
		}
	}

	// 2. 扫描孤立的块级 <a>（n == 1 单卡或未知复杂块级 <a>）
	var anchors []*html.Node
	var collectAnchors func(*html.Node)
	collectAnchors = func(n *html.Node) {
		if n.Type == html.ElementNode {
			tag := strings.ToLower(n.Data)
			if tag == "opengits-lift" || tag == "pre" || tag == "code" {
				return
			}
			if tag == "a" && isBlockAnchor(n) {
				anchors = append(anchors, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collectAnchors(c)
		}
	}
	collectAnchors(root)

	for _, a := range anchors {
		if a.Parent == nil {
			continue
		}
		cand, ok := extractCardCandidate(a, pageURL, store)
		if ok && !cand.isComplex && cand.passesGate {
			// n == 1 -> 单独 <Card>（不套 CardGroup）
			replaceNodeWithLift(a, renderCardJSX(cand), store)
			if tel != nil {
				tel.CardsLifted++
			}
		} else {
			// 触发熔断降级：改写为可读引用卡片块（首行 > **[标题 →](href)**）
			md := degradeBlockAnchorToQuoteCard(a, store)
			replaceNodeWithLift(a, md, store)
			if tel != nil {
				if ok && !cand.passesGate {
					tel.CardGateFailures++
				}
				tel.AnchorDegradations++
			}
		}
	}
}

func looksLikeCardGridContainer(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	if strings.EqualFold(n.Data, "details") || isExplicitStepsContainer(n) {
		return false
	}
	if _, isCallout := classifyCalloutNode(n, nil); isCallout {
		return false
	}
	children := meaningfulChildNodes(n)
	if len(children) < 2 {
		return false
	}
	blockAnchorCount := 0
	cardShellCount := 0
	for _, ch := range children {
		if ch.Type != html.ElementNode {
			return false
		}
		if strings.EqualFold(ch.Data, "a") && isBlockAnchor(ch) {
			blockAnchorCount++
			continue
		}
		if findWrappedBlockAnchor(ch) != nil {
			blockAnchorCount++
			continue
		}
		if isCardShellCandidate(ch) {
			cardShellCount++
		}
	}
	if blockAnchorCount == len(children) {
		return true
	}
	if cardShellCount == len(children) && (hasHorizontalFlexOrGridHint(n) || hasClassSubstring(n, "grid", "cards", "card-group", "bento")) {
		return true
	}
	return false
}

func isBlockAnchor(a *html.Node) bool {
	if a == nil || a.Type != html.ElementNode || !strings.EqualFold(a.Data, "a") {
		return false
	}
	return hasBlockDescendant(a)
}

func findWrappedBlockAnchor(n *html.Node) *html.Node {
	if n == nil || n.Type != html.ElementNode {
		return nil
	}
	sub := meaningfulChildNodes(n)
	if len(sub) == 1 && sub[0].Type == html.ElementNode && strings.EqualFold(sub[0].Data, "a") && isBlockAnchor(sub[0]) {
		return sub[0]
	}
	return nil
}

func isCardShellCandidate(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	if isExplicitStepsContainer(n) {
		return false
	}
	if _, isCallout := classifyCalloutNode(n, nil); isCallout {
		return false
	}
	tag := strings.ToLower(n.Data)
	if tag != "div" && tag != "li" && tag != "article" && tag != "section" {
		return false
	}
	links := findDescendantsByTag(n, "a")
	if len(links) != 1 {
		return false
	}
	if tag == "li" {
		if n.Parent != nil && (hasClassSubstring(n.Parent, "border-y", "divide-y") || isVerticalStackContainer(n.Parent)) && !hasClassSubstring(n, "card", "tile", "bento") {
			return false
		}
		if isInlineSentenceLinkInBlock(links[0]) && !hasClassSubstring(n, "card", "tile", "bento") {
			return false
		}
	}
	return hasBlockDescendant(n)
}

func isInlineSentenceLinkInBlock(a *html.Node) bool {
	if a == nil || a.Parent == nil {
		return false
	}
	pTag := strings.ToLower(a.Parent.Data)
	if pTag != "p" && !(pTag == "span" && !hasBlockDescendant(a.Parent)) {
		return false
	}
	totalRunes := countNonSpaceRunes(extractNodeText(a.Parent))
	linkRunes := countNonSpaceRunes(extractNodeText(a))
	return totalRunes-linkRunes > 16
}

func extractCardCandidate(node *html.Node, _ string, store *liftStore) (cardCandidate, bool) {
	if node == nil || node.Type != html.ElementNode {
		return cardCandidate{}, false
	}

	var cand cardCandidate
	cand.rootNode = node

	var targetContentNode *html.Node
	if strings.EqualFold(node.Data, "a") && isBlockAnchor(node) {
		cand.anchorNode = node
		cand.href = strings.TrimSpace(getNodeAttr(node, "href"))
		targetContentNode = node
	} else if wrapped := findWrappedBlockAnchor(node); wrapped != nil {
		cand.anchorNode = wrapped
		cand.href = strings.TrimSpace(getNodeAttr(wrapped, "href"))
		targetContentNode = wrapped
	} else if isCardShellCandidate(node) {
		links := findDescendantsByTag(node, "a")
		if len(links) == 1 {
			cand.href = strings.TrimSpace(getNodeAttr(links[0], "href"))
		}
		targetContentNode = node
	} else {
		return cardCandidate{}, false
	}

	cand.origText = extractNodeText(targetContentNode)

	// 复杂度边界拦截：包含表格/代码围栏/表单/按钮/引用/嵌套多链接等复杂块级结构的 <a> 禁止升维为 <Card>
	if hasComplexCardBlock(targetContentNode, cand.anchorNode != nil) {
		cand.isComplex = true
		return cand, true
	}

	// 克隆子树以安全把内嵌 <ul>/<ol> 胶囊先归一化为 `Pill1` · `Pill2`
	work := cloneHTMLNode(targetContentNode)
	liftCompactPillLists(work, store, true)
	// 若外壳卡片将子 <a> 提升为 <Card href="...">，则剥除卡片体内的 <a> 包装仅留文本，防止 HTML <a> 嵌套引发 React 水合报错
	if cand.anchorNode == nil && cand.href != "" {
		unwrapDescendantAnchors(work)
	}

	// 扁平化有序区块（将纯布局包装 div 解包到线性段列表，提取 eyebrow / title / body）
	eyebrow, title, bodyNodes := extractCardSlots(work)
	cand.eyebrow = eyebrow
	cand.title = title
	cand.body = renderChildListToMarkdown(bodyNodes, store)

	// 逐卡确定性守恒验证门（R-2）：
	// ① title 非空；② 有有效描述/徽章或子内容；③ 归一化文本零缩水校验
	if strings.TrimSpace(cand.title) != "" &&
		strings.TrimSpace(cand.body) != "" &&
		passesNormalizedTextConservation(cand.origText, cand.eyebrow+" "+cand.title+" "+cand.body) {
		cand.passesGate = true
	}
	return cand, true
}

func hasComplexCardBlock(n *html.Node, isAnchorCard bool) bool {
	nestedLinks := 0
	complex := false
	var walk func(*html.Node, bool)
	walk = func(curr *html.Node, isRoot bool) {
		if complex {
			return
		}
		if curr.Type == html.ElementNode && !isRoot {
			tag := strings.ToLower(curr.Data)
			switch tag {
			case "table", "pre", "form", "input", "select", "textarea", "iframe", "blockquote", "dl":
				complex = true
				return
			case "a":
				nestedLinks++
				if isAnchorCard || nestedLinks > 1 {
					complex = true
					return
				}
			}
			if strings.EqualFold(getNodeAttr(curr, "role"), "button") {
				complex = true
				return
			}
		}
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			walk(c, false)
		}
	}
	walk(n, true)
	return complex
}

func extractCardSlots(work *html.Node) (eyebrow string, title string, bodyNodes []*html.Node) {
	// 递归收集逻辑视觉行块：展开纯容器 <div>/<header>/<section>（仅当它包含多个块子元素时），保留叶子块节点
	blocks := flattenCardVisualBlocks(work)
	if len(blocks) == 0 {
		return "", "", nil
	}

	// 1. 优先找显式 heading（h1..h6），其次显式标题语义类名（text-heading / card-title / title / heading，排除 eyebrow/label），最后粗体块
	titleIdx := -1
	for i, b := range blocks {
		if isHeadingTag(b) {
			titleIdx = i
			break
		}
	}
	if titleIdx == -1 {
		for i, b := range blocks {
			if i <= 1 && isExplicitTitleClassBlock(b) {
				titleIdx = i
				break
			}
		}
	}
	if titleIdx == -1 {
		for i, b := range blocks {
			if i <= 1 && isBoldTitleBlock(b) {
				if i == 0 && len(blocks) >= 3 && looksLikeEyebrowBlock(b) && (isExplicitTitleClassBlock(blocks[1]) || isBoldTitleBlock(blocks[1])) {
					continue
				}
				titleIdx = i
				break
			}
		}
	}

	if titleIdx == 0 {
		title = cleanCardSlotText(blocks[0])
		bodyNodes = blocks[1:]
		return "", title, bodyNodes
	}

	if titleIdx == 1 && len(blocks) >= 3 {
		// blocks[0] 位于标题之前且后面仍有 body：作为 eyebrow 眉标
		candEye := cleanCardSlotText(blocks[0])
		if candEye != "" && utf8.RuneCountInString(candEye) <= 40 && !endsWithSentencePunct(candEye) {
			eyebrow = candEye
			title = cleanCardSlotText(blocks[1])
			bodyNodes = blocks[2:]
			return eyebrow, title, bodyNodes
		}
	}

	if titleIdx > 0 {
		// 标题前有非眉标段落（如长文本），不丢弃它们——若直接把第 0 块并入 body 也能守恒
		title = cleanCardSlotText(blocks[titleIdx])
		for i, b := range blocks {
			if i != titleIdx {
				bodyNodes = append(bodyNodes, b)
			}
		}
		return "", title, bodyNodes
	}

	// 2. 无显式 heading：若 >= 3 块且第 0 块明显是短眉标（非句末标点 <= 28 runes，如 "For your team"）
	// 且第 1 块较短可作标题，则第 0 块作 eyebrow，第 1 块作 title，其余作 body
	if len(blocks) >= 3 {
		t0 := cleanCardSlotText(blocks[0])
		t1 := cleanCardSlotText(blocks[1])
		if t0 != "" && t1 != "" &&
			utf8.RuneCountInString(t0) <= 28 && !endsWithSentencePunct(t0) &&
			utf8.RuneCountInString(t1) <= 80 &&
			(looksLikeEyebrowBlock(blocks[0]) ||
				utf8.RuneCountInString(t0) < utf8.RuneCountInString(t1)) {
			return t0, t1, blocks[2:]
		}
	}

	// 3. 默认：首块为 title，其余全部保留为 body
	title = cleanCardSlotText(blocks[0])
	if len(blocks) > 1 {
		bodyNodes = blocks[1:]
	}
	return "", title, bodyNodes
}

func flattenCardVisualBlocks(root *html.Node) []*html.Node {
	var out []*html.Node
	var walk func(*html.Node)
	walk = func(curr *html.Node) {
		children := meaningfulChildNodes(curr)
		for _, c := range children {
			if c.Type == html.TextNode {
				t := strings.TrimSpace(c.Data)
				if t != "" {
					p := &html.Node{Type: html.ElementNode, Data: "p", DataAtom: atom.P}
					p.AppendChild(&html.Node{Type: html.TextNode, Data: t})
					out = append(out, p)
				}
				continue
			}
			if c.Type != html.ElementNode {
				continue
			}
			tag := strings.ToLower(c.Data)
			if tag == "opengits-lift" || tag == "ul" || tag == "ol" || tag == "p" || isHeadingTag(c) || tag == "img" {
				out = append(out, c)
				continue
			}
			// div / section / header / footer / span 等若内部含块级子元素则展开，否则作为一个整体块
			if hasBlockDescendant(c) || hasElementChild(c, "opengits-lift") {
				walk(c)
			} else if strings.TrimSpace(extractNodeText(c)) != "" {
				out = append(out, c)
			}
		}
	}
	walk(root)
	return out
}

func isExplicitTitleClassBlock(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	// 仅显式眉标/副标题语义类可排除，绝不能让 text-gray-1000 等前景色工具类误杀 text-heading-20/16
	if hasClassSubstring(n, "eyebrow", "kicker", "label", "badge", "subtitle", "sub-title", "caption") {
		return false
	}
	if hasClassSubstring(n, "text-heading", "card-title", "title", "heading") {
		txt := cleanCardSlotText(n)
		return txt != "" && utf8.RuneCountInString(txt) <= 90
	}
	return false
}

func looksLikeEyebrowBlock(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	if hasClassSubstring(n, "text-heading", "card-title", "title", "heading") {
		return false
	}
	if hasClassSubstring(n, "eyebrow", "kicker", "label", "muted", "text-xs", "text-sm", "text-copy-12", "text-copy-13", "uppercase") {
		return true
	}
	return hasClassToken(n, "text-gray-400", "text-gray-500", "text-gray-600", "text-gray-700", "text-gray-800", "text-gray-900")
}

func isBoldTitleBlock(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	if hasClassSubstring(n, "font-semibold", "font-bold", "font-medium", "card-title", "title", "heading") {
		txt := cleanCardSlotText(n)
		return txt != "" && utf8.RuneCountInString(txt) <= 90
	}
	sub := meaningfulChildNodes(n)
	if len(sub) == 1 && sub[0].Type == html.ElementNode {
		tag := strings.ToLower(sub[0].Data)
		if tag == "strong" || tag == "b" {
			txt := cleanCardSlotText(n)
			return txt != "" && utf8.RuneCountInString(txt) <= 90
		}
	}
	return false
}

func cleanCardSlotText(n *html.Node) string {
	return strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(n), " "))
}

func endsWithSentencePunct(s string) bool {
	r, _ := utf8.DecodeLastRuneInString(strings.TrimSpace(s))
	switch r {
	case '.', '!', '?', '。', '！', '？', ';', '；':
		return true
	}
	return false
}

func mapCardGridCols(n int) string {
	switch {
	case n == 2 || n == 4:
		return "2"
	case n%3 == 0:
		return "3"
	default:
		return "2"
	}
}

func renderCardJSX(c cardCandidate) string {
	var attrs strings.Builder
	attrs.WriteString(fmt.Sprintf(` title="%s"`, formatJSXAttr(c.title)))
	if c.eyebrow != "" {
		attrs.WriteString(fmt.Sprintf(` eyebrow="%s"`, formatJSXAttr(c.eyebrow)))
	}
	if c.href != "" {
		attrs.WriteString(fmt.Sprintf(` href="%s"`, formatJSXAttr(c.href)))
	}
	return fmt.Sprintf("<Card%s>\n\n%s\n\n</Card>", attrs.String(), strings.TrimSpace(c.body))
}

// degradeBlockAnchorToQuoteCard 熔断降级兜底：将复杂或未通过校验的块级 <a> 转为可读引用卡，绝不输出跨行带下划线链接。
func degradeBlockAnchorToQuoteCard(a *html.Node, store *liftStore) string {
	href := strings.TrimSpace(getNodeAttr(a, "href"))
	work := cloneHTMLNode(a)
	liftCompactPillLists(work, store, true)

	// 提取首个独立标题（优先全局寻找 h1..h6，其次首个非 table 非 list 的简短文本行）
	title := ""
	var consumed *html.Node
	var findHeading func(*html.Node)
	findHeading = func(curr *html.Node) {
		if title != "" {
			return
		}
		for c := curr.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode {
				tag := strings.ToLower(c.Data)
				if tag == "table" || tag == "pre" || tag == "ul" || tag == "ol" || tag == "opengits-lift" {
					continue
				}
				if isHeadingTag(c) {
					t := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(c), " "))
					if t != "" && utf8.RuneCountInString(t) <= 100 {
						title = t
						consumed = c
						return
					}
				}
				findHeading(c)
				if title != "" {
					return
				}
			}
		}
	}
	findHeading(work)

	if title == "" {
		var findFallbackTitle func(*html.Node)
		findFallbackTitle = func(curr *html.Node) {
			if title != "" {
				return
			}
			for c := curr.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.ElementNode {
					tag := strings.ToLower(c.Data)
					if tag == "table" || tag == "pre" || tag == "ul" || tag == "ol" || tag == "opengits-lift" {
						continue
					}
					if (tag == "p" || tag == "div" || tag == "span") && !hasBlockDescendant(c) &&
						!hasClassSubstring(c, "eyebrow", "kicker", "label", "badge") {
						t := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(c), " "))
						if t != "" && utf8.RuneCountInString(t) <= 100 {
							title = t
							consumed = c
							return
						}
					}
					findFallbackTitle(c)
					if title != "" {
						return
					}
				}
			}
		}
		findFallbackTitle(work)
	}

	if consumed != nil && consumed.Parent != nil {
		consumed.Parent.RemoveChild(consumed)
	}
	if title == "" {
		raw := strings.TrimSpace(reMultiSpaces.ReplaceAllString(extractNodeText(work), " "))
		title = truncateRunes(raw, 60)
		if title == "" {
			title = "Details"
		}
	}

	bodyMD := renderChildListToMarkdown(allChildNodes(work), store)
	return FormatDegradedQuoteCard(title, href, bodyMD)
}

// FormatDegradedQuoteCard 统一构造可读的引用卡片块（供 DOM 降级与 Phase 3 goldmark AST 闸门共用）。
func FormatDegradedQuoteCard(title, href, bodyMD string) string {
	cleanTitle := strings.TrimSpace(reMultiSpaces.ReplaceAllString(title, " "))
	if cleanTitle == "" {
		cleanTitle = "Details"
	}
	// 转义方括号避免破坏 Markdown 链接语法
	escapedLabel := strings.NewReplacer("[", `\[`, "]", `\]`).Replace(cleanTitle)
	var header string
	if href != "" {
		header = fmt.Sprintf("> **[%s →](%s)**", escapedLabel, strings.TrimSpace(href))
	} else {
		header = fmt.Sprintf("> **%s**", escapedLabel)
	}

	trimmedBody := strings.TrimSpace(bodyMD)
	if trimmedBody == "" {
		return header
	}
	lines := strings.Split(trimmedBody, "\n")
	var buf strings.Builder
	buf.WriteString(header)
	buf.WriteString("\n>")
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			buf.WriteString("\n>")
		} else {
			buf.WriteString("\n> ")
			buf.WriteString(line)
		}
	}
	return buf.String()
}

// ─────────────────────────────────────────────────────────────
// 7. 归一化文本守恒口径与通用辅助函数
// ─────────────────────────────────────────────────────────────

// passesNormalizedTextConservation 计算剥除注入的 Markdown 语法 token 后的可见 rune 零缩水校验（R-2）。
func passesNormalizedTextConservation(origRaw, liftedRaw string) bool {
	origNorm := normalizeTextForConservation(origRaw)
	liftedNorm := normalizeTextForConservation(liftedRaw)

	origCount := countNonSpaceRunes(origNorm)
	if origCount == 0 {
		return false
	}
	liftedCount := countNonSpaceRunes(liftedNorm)
	if liftedCount == 0 {
		return false
	}
	// 允许最多 2 个标点差异或 >= 98% 可见 rune 保全
	if liftedCount >= origCount {
		return true
	}
	return liftedCount*100 >= origCount*98 && (origCount-liftedCount) <= 2
}

func normalizeTextForConservation(s string) string {
	stripped := reCardConservationTokens.ReplaceAllString(s, " ")
	return strings.TrimSpace(reSpaceUnit.ReplaceAllString(stripped, " "))
}

func countNonSpaceRunes(s string) int {
	n := 0
	for _, r := range s {
		if !unicode.IsSpace(r) {
			n++
		}
	}
	return n
}

func formatJSXAttr(raw string) string {
	collapsed := strings.TrimSpace(reMultiSpaces.ReplaceAllString(raw, " "))
	return strings.NewReplacer(
		"&", "&amp;",
		`"`, "&quot;",
		"<", "&lt;",
		">", "&gt;",
	).Replace(collapsed)
}

func cleanupUnconsumedTabControls(root *html.Node) {
	if root == nil {
		return
	}
	var toRemove []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if strings.EqualFold(getNodeAttr(n, "role"), "tablist") {
				toRemove = append(toRemove, n)
				return
			}
			if strings.EqualFold(n.Data, "button") {
				toRemove = append(toRemove, n)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	for _, n := range toRemove {
		if n.Parent != nil {
			n.Parent.RemoveChild(n)
		}
	}
}

func isBlockElementNode(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	switch strings.ToLower(n.Data) {
	case "div", "p", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
		"section", "article", "header", "footer", "aside", "blockquote", "pre",
		"table", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "opengits-lift":
		return true
	}
	return false
}

func hasBlockDescendant(n *html.Node) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode {
			if isBlockElementNode(c) || hasBlockDescendant(c) {
				return true
			}
		}
	}
	return false
}

func hasTagDescendant(n *html.Node, tag string) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode {
			if strings.EqualFold(c.Data, tag) || hasTagDescendant(c, tag) {
				return true
			}
		}
	}
	return false
}

func hasElementChild(n *html.Node, tag string) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && strings.EqualFold(c.Data, tag) {
			return true
		}
	}
	return false
}

func isHeadingTag(n *html.Node) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	t := strings.ToLower(n.Data)
	return len(t) == 2 && t[0] == 'h' && t[1] >= '1' && t[1] <= '6'
}

func meaningfulChildNodes(n *html.Node) []*html.Node {
	var out []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.CommentNode {
			continue
		}
		if c.Type == html.TextNode && strings.TrimSpace(c.Data) == "" {
			continue
		}
		out = append(out, c)
	}
	return out
}

func allChildNodes(n *html.Node) []*html.Node {
	var out []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		out = append(out, c)
	}
	return out
}

func singleMeaningfulChild(parent, child *html.Node) bool {
	mc := meaningfulChildNodes(parent)
	return len(mc) == 1 && mc[0] == child
}

func findUniqueElementByID(root *html.Node, id string) *html.Node {
	if root == nil || id == "" {
		return nil
	}
	var matches []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if len(matches) > 1 {
			return
		}
		if n.Type == html.ElementNode && getNodeAttr(n, "id") == id {
			matches = append(matches, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	if len(matches) == 1 {
		return matches[0]
	}
	return nil
}

func findDescendantsByAttr(root *html.Node, key, val string) []*html.Node {
	var out []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && strings.EqualFold(strings.TrimSpace(getNodeAttr(n, key)), val) {
			out = append(out, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return out
}

func findDescendantsByTag(root *html.Node, tag string) []*html.Node {
	var out []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && strings.EqualFold(n.Data, tag) {
			out = append(out, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return out
}

func unwrapDescendantAnchors(root *html.Node) {
	if root == nil {
		return
	}
	anchors := findDescendantsByTag(root, "a")
	for _, a := range anchors {
		if a == root || a.Parent == nil {
			continue
		}
		parent := a.Parent
		for c := a.FirstChild; c != nil; {
			next := c.NextSibling
			a.RemoveChild(c)
			parent.InsertBefore(c, a)
			c = next
		}
		parent.RemoveChild(a)
	}
}

func hasAttr(n *html.Node, key string) bool {
	if n == nil {
		return false
	}
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return true
		}
	}
	return false
}

func setNodeAttr(n *html.Node, key, val string) {
	if n == nil {
		return
	}
	for i, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			n.Attr[i].Val = val
			return
		}
	}
	n.Attr = append(n.Attr, html.Attribute{Key: key, Val: val})
}

func isAncestor(maybeAncestor, node *html.Node) bool {
	for p := node; p != nil; p = p.Parent {
		if p == maybeAncestor {
			return true
		}
	}
	return false
}

func truncateRunes(s string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= maxRunes {
		return s
	}
	return strings.TrimSpace(string(r[:maxRunes])) + "…"
}

func urlParseSafe(raw string) (*url.URL, error) {
	return url.Parse(strings.TrimSpace(raw))
}

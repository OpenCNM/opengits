package transform

import (
	"regexp"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// Transformer 正则趟（4 趟）：原移植自 apps/client/src/engine/
// transformer.ts Transformer.process 的正则段（该 TS 实现已于 2026-11
// 死代码清算退役，本包为唯一实现）。输入应为已 mask 的
// 文本（代码块已被 token 替换，正则永不触碰代码内容——mask 存在的意义）。
//
// 注册表来源（改动须与 TS 侧镜像同步）：
//   - HTML_INTRINSIC_TAGS / KNOWN_MDX_COMPONENT_NAMES
//                             lib/mdx/known-mdx-components.ts（活镜像）
//   - SAFE_HTML_TAGS / LANG_ALIAS_MAP：TS 原体已退役，本包为 SSOT
// ─────────────────────────────────────────────────────────────

// safeHTMLTags（TS 原体 lib/config.ts SAFE_HTML_TAGS 已随 transformer.ts 退役，本包为 SSOT）
var safeHTMLTags = map[string]struct{}{
	"br": {}, "hr": {}, "img": {},
	"table": {}, "thead": {}, "tbody": {}, "tr": {}, "th": {}, "td": {},
	"sub": {}, "sup": {}, "kbd": {}, "details": {}, "summary": {},
	"iframe": {},
	"code":   {}, "pre": {},
}

// htmlIntrinsicTags 镜像 lib/mdx/known-mdx-components.ts HTML_INTRINSIC_TAGS
var htmlIntrinsicTags = buildIntrinsicTagSet()

func buildIntrinsicTagSet() map[string]struct{} {
	tags := []string{
		"a", "abbr", "acronym", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo",
		"blockquote", "body", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup",
		"data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt", "em",
		"fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset", "h1", "h2", "h3",
		"h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "img", "input", "ins",
		"kbd", "label", "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter", "nav",
		"noframes", "noscript", "ol", "optgroup", "option", "output", "p", "param", "picture",
		"pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "search", "section", "select",
		"slot", "small", "source", "span", "strong", "sub", "summary", "sup", "svg", "table",
		"tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track",
		"u", "ul", "var", "video", "wbr",
		// 常见 SVG 子元素
		"circle", "clipPath", "defs", "ellipse", "g", "line", "linearGradient", "mask", "path", "pattern",
		"polygon", "polyline", "radialGradient", "rect", "stop", "text", "tspan", "use",
	}
	m := make(map[string]struct{}, len(tags))
	for _, t := range tags {
		m[t] = struct{}{}
	}
	return m
}

// knownMdxComponentNames 镜像 lib/mdx/known-mdx-components.ts KNOWN_MDX_COMPONENT_NAMES
var knownMdxComponentNames = buildKnownMdxSet()

func buildKnownMdxSet() map[string]struct{} {
	names := []string{
		"UnknownMdxComponent",
		"YouTube", "DynamicVar", "Jargon", "WhiteboardImage", "MicroQuiz",
		"Callout", "callout", "Summary", "summary",
		"CodeGroup", "CodeGroupItem", "CodeBlock", "codeblock", "code-block",
		"codeblockitem", "code-block-item",
		"Steps", "steps", "Step", "step",
		"CardGroup", "cardgroup", "Card", "card",
		"AccordionGroup", "accordiongroup", "Accordion", "accordion",
		"Expandable", "expandable", "InterleafAnswer", "SmartTable", "smarttable", "smart-table", "table",
		"CodeAnchor", "codeanchor", "code-anchor",
		"codegroup", "card-group", "accordion-group",
	}
	m := make(map[string]struct{}, len(names))
	for _, n := range names {
		m[n] = struct{}{}
	}
	return m
}

// langAliasMap 镜像 lib/config.ts LANG_ALIAS_MAP
var langAliasMap = map[string]string{
	"dos": "bat",
	"env": "bash",
	"c#":  "csharp",
	"c++": "cpp",
}

var (
	// YouTube 卡片：[![alt](img)](youtube-url) → <YouTube id="..." />
	// 逐字移植（无反向引用，RE2 兼容）
	youtubeCardRe = regexp.MustCompile(
		`\[!\[.*?\]\(.*?\)\]\((https?://(?:(?:www\.|m\.)?youtube\.com/(?:watch\?(?:[^)]*&)?v=|embed/|v/)|youtu\.be/)([\w-]+)[^)]*)\)`)
	// autolink：<url> / <email>
	autolinkRe      = regexp.MustCompile(`<([^>\s]+)>`)
	autolinkEmailRe = regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)
	// 裸标签开括号转义：<(\/?)(tagName)
	bareTagRe = regexp.MustCompile(`<(/?)([a-zA-Z][a-zA-Z0-9-]*)`)
	// 孤立 `<` 转义（applyIsolatedLessThanEscape 第 4 趟用）
	isolatedLessThanRe = regexp.MustCompile(`<([\d\s])`)
)

// applyYouTubeCards 第 1 趟：YouTube 视频卡片转组件。
func applyYouTubeCards(masked string) string {
	return youtubeCardRe.ReplaceAllString(masked, `<YouTube id="$2" />`)
}

// applyAutolinks 第 2 趟：尖括号 autolink 转 markdown 链接。
func applyAutolinks(masked string) string {
	return autolinkRe.ReplaceAllStringFunc(masked, func(match string) string {
		inner := match[1 : len(match)-1]
		if strings.HasPrefix(inner, "http://") || strings.HasPrefix(inner, "https://") {
			return "[" + inner + "](" + inner + ")"
		}
		if autolinkEmailRe.MatchString(inner) {
			return "[" + inner + "](mailto:" + inner + ")"
		}
		return match
	})
}

// applyBareTagEscape 第 3 趟：非白名单裸标签开括号转义（保注册组件与内在元素）。
func applyBareTagEscape(masked string) string {
	return bareTagRe.ReplaceAllStringFunc(masked, func(match string) string {
		sub := bareTagRe.FindStringSubmatch(match)
		slash, tagName := sub[1], sub[2]
		lower := strings.ToLower(tagName)
		_, isHtml := safeHTMLTags[lower]
		if !isHtml {
			_, isHtml = htmlIntrinsicTags[lower]
		}
		_, isCustom := knownMdxComponentNames[tagName]
		if !isCustom {
			_, isCustom = safeHTMLTags[lower]
		}
		if isHtml || isCustom {
			return match
		}
		return "&lt;" + slash + tagName
	})
}

// applyIsolatedLessThanEscape 第 4 趟（post 段）：孤立 `<`（后随数字/空白）转义。
// JS 原式 /<(?=[\d\s])/g 是零宽前瞻——RE2 不支持，用捕获组等价实现。
func applyIsolatedLessThanEscape(masked string) string {
	return isolatedLessThanRe.ReplaceAllString(masked, "&lt;$1")
}

// normalizeFenceLang 代码块语言归一（Node AST code 节点趟的等价实现）：
// 剥 `|` 后缀 + LANG_ALIAS_MAP 别名。作用于围栏块首行（fence info 串）。
// 无别名命中且无 | 后缀时原样返回（保持原文字节，roundtrip 零改动）。
func normalizeFenceLang(fenceLine string) string {
	m := fenceOpenRe.FindStringSubmatch(fenceLine)
	if m == nil {
		return fenceLine
	}
	info := m[2]
	trimmed := strings.TrimSpace(info)
	if trimmed == "" {
		return fenceLine
	}
	// remark node.lang = info 首词；剥 | 后缀后查别名表
	firstWord := strings.Fields(trimmed)[0]
	lang := strings.SplitN(firstWord, "|", 2)[0]
	mapped, aliased := langAliasMap[strings.ToLower(lang)]
	if !aliased && !strings.Contains(firstWord, "|") {
		return fenceLine // 已规范：零改动
	}
	if aliased {
		lang = mapped
	}
	indent := m[0][:len(m[0])-len(m[1])-len(m[2])] // 行首缩进
	// 保留首词后的附加内容（如 title=... / 元信息段）
	if i := strings.Index(info, firstWord); i >= 0 {
		if suffix := strings.TrimSpace(info[i+len(firstWord):]); suffix != "" {
			return indent + m[1] + lang + " " + suffix
		}
	}
	return indent + m[1] + lang
}

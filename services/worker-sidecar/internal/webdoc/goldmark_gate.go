package webdoc

import (
	"bytes"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/sanitize"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
)

const (
	goldmarkMaxInlineLinkRunes = 140
	goldmarkTitleMaxRunes      = 72
)

var webDocGateParser = goldmark.New(goldmark.WithExtensions(extension.GFM))

type goldmarkLinkReplacement struct {
	start int
	end   int
	body  string
}

// DegradeFlattenedLinksWithGoldmark Phase 3 确定性 AST 兜底闸门：
// 1. 先通过 sanitize.MaskCodeBlocks 锁定围栏/行内代码块；
// 2. 通过 internal/mdpat 剥除代码块外的已知页眉/页尾交互 chrome 行；
// 3. 使用 yuin/goldmark GFM 解析 AST，遍历 *ast.Link（零正则识别多行结构）；
// 4. 跳过表格单元格与纯 badge 图片链接，将多行链接或超长扁平化卡片锚点降级为引用卡片块。
func DegradeFlattenedLinksWithGoldmark(raw string) (string, int) {
	if strings.TrimSpace(raw) == "" {
		return raw, 0
	}

	masked, codeBlocks := sanitize.MaskCodeBlocks(raw)
	stripped, chromeRemoved := stripWebDocChromeLines(masked)

	srcBytes := []byte(stripped)
	doc := webDocGateParser.Parser().Parse(text.NewReader(srcBytes))

	var replacements []goldmarkLinkReplacement
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		link, ok := node.(*ast.Link)
		if !ok {
			return ast.WalkContinue, nil
		}
		// 表格内部链接（如对比表中的链接列）绝不降级为块引用，以免打断 GFM 表格语法
		if isInsideTableNode(link) {
			return ast.WalkSkipChildren, nil
		}
		// 纯图片徽章链接（如 [![badge](img)](url)）原样保留
		if isImageOnlyGoldmarkLink(link, srcBytes) {
			return ast.WalkSkipChildren, nil
		}
		// 已由 FormatDegradedQuoteCard 产出的引用卡头部（> **[... →](url)**）保持幂等，禁止二次套娃改写
		if isAlreadyDegradedQuoteCardLink(link, srcBytes, codeBlocks) {
			return ast.WalkSkipChildren, nil
		}

		start, closeBracket, end, valid := locateGoldmarkLinkSpan(link, srcBytes)
		if !valid {
			return ast.WalkSkipChildren, nil
		}

		if !shouldDegradeGoldmarkLink(link, srcBytes, start, closeBracket, codeBlocks) {
			return ast.WalkSkipChildren, nil
		}

		labelRaw := string(srcBytes[start+1 : closeBracket])
		inBlockquote := isInsideBlockquoteNode(link)
		title, bodyMD := splitDegradedLinkLabel(labelRaw, link, srcBytes, codeBlocks, inBlockquote)
		cardBlock := FormatDegradedQuoteCard(title, string(link.Destination), bodyMD)

		replacement := formatBlockReplacementContext(srcBytes, start, end, cardBlock, inBlockquote)
		replacements = append(replacements, goldmarkLinkReplacement{
			start: start,
			end:   end,
			body:  replacement,
		})
		return ast.WalkSkipChildren, nil
	})

	rewritten := applyGoldmarkReplacements(srcBytes, replacements)
	unmasked := sanitize.UnmaskCodeBlocksRaw(rewritten, codeBlocks)
	return unmasked, len(replacements) + chromeRemoved
}

func stripWebDocChromeLines(masked string) (string, int) {
	lines := strings.Split(masked, "\n")
	out := make([]string, 0, len(lines))
	removed := 0
	for _, line := range lines {
		if mdpat.IsWebDocChromeLine(line) {
			removed++
			continue
		}
		out = append(out, line)
	}
	if removed == 0 {
		return masked, 0
	}
	return strings.Join(out, "\n"), removed
}

func isInsideTableNode(n ast.Node) bool {
	for p := n.Parent(); p != nil; p = p.Parent() {
		if _, ok := p.(*extast.Table); ok {
			return true
		}
	}
	return false
}

func isInsideBlockquoteNode(n ast.Node) bool {
	for p := n.Parent(); p != nil; p = p.Parent() {
		if _, ok := p.(*ast.Blockquote); ok {
			return true
		}
	}
	return false
}

func isAlreadyDegradedQuoteCardLink(link *ast.Link, srcBytes []byte, codeBlocks []sanitize.CodeBlock) bool {
	if !isInsideBlockquoteNode(link) {
		return false
	}
	emph, ok := link.Parent().(*ast.Emphasis)
	if !ok || emph.Level != 2 {
		return false
	}
	plain := strings.TrimSpace(collectGoldmarkPlainText(link, srcBytes, codeBlocks))
	return strings.HasSuffix(plain, "→")
}

func isImageOnlyGoldmarkLink(link *ast.Link, srcBytes []byte) bool {
	hasImage := false
	hasNonImageContent := false

	var inspect func(ast.Node)
	inspect = func(curr ast.Node) {
		for c := curr.FirstChild(); c != nil; c = c.NextSibling() {
			if _, ok := c.(*ast.Image); ok {
				hasImage = true
				continue
			}
			if t, ok := c.(*ast.Text); ok {
				if len(bytes.TrimSpace(t.Segment.Value(srcBytes))) > 0 {
					hasNonImageContent = true
				}
				continue
			}
			hasNonImageContent = true
		}
	}
	inspect(link)
	return hasImage && !hasNonImageContent
}

func shouldDegradeGoldmarkLink(link *ast.Link, srcBytes []byte, start, closeBracket int, codeBlocks []sanitize.CodeBlock) bool {
	if hasGoldmarkLinkBreak(link, srcBytes) {
		return true
	}
	if start+1 <= closeBracket && bytes.IndexByte(srcBytes[start+1:closeBracket], '\n') >= 0 {
		return true
	}
	plain := collectGoldmarkPlainText(link, srcBytes, codeBlocks)
	visible := countNonSpaceRunes(plain)
	return visible > goldmarkMaxInlineLinkRunes
}

func hasGoldmarkLinkBreak(link *ast.Link, srcBytes []byte) bool {
	hasBreak := false
	_ = ast.Walk(link, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering || hasBreak {
			return ast.WalkSkipChildren, nil
		}
		if t, ok := n.(*ast.Text); ok {
			if t.SoftLineBreak() || t.HardLineBreak() {
				hasBreak = true
				return ast.WalkStop, nil
			}
			segBytes := t.Segment.Value(srcBytes)
			if bytes.IndexByte(segBytes, '\n') >= 0 {
				hasBreak = true
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	return hasBreak
}

func unmaskMaskTokensForMeasure(s string, codeBlocks []sanitize.CodeBlock) string {
	if len(codeBlocks) == 0 || !strings.Contains(s, sanitize.MaskTokenPrefix) {
		return s
	}
	var sb strings.Builder
	rest := s
	for {
		idx := strings.Index(rest, sanitize.MaskTokenPrefix)
		if idx < 0 {
			sb.WriteString(rest)
			break
		}
		sb.WriteString(rest[:idx])
		after := rest[idx+len(sanitize.MaskTokenPrefix):]
		end := strings.Index(after, sanitize.MaskTokenSuffix)
		if end < 0 {
			sb.WriteString(rest[idx:])
			break
		}
		idStr := after[:end]
		if id, err := strconv.Atoi(idStr); err == nil && id >= 0 && id < len(codeBlocks) {
			sb.WriteString(codeBlocks[id].Text)
		}
		rest = after[end+len(sanitize.MaskTokenSuffix):]
	}
	return sb.String()
}

func collectGoldmarkPlainText(link *ast.Link, srcBytes []byte, codeBlocks []sanitize.CodeBlock) string {
	var sb strings.Builder
	_ = ast.Walk(link, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if n == link {
			return ast.WalkContinue, nil
		}
		switch node := n.(type) {
		case *ast.Image:
			// 徽章图片 alt 不计入文本长度，以免图片 alt 过长误触发链接降级
			return ast.WalkSkipChildren, nil
		case *ast.Text:
			sb.Write(node.Segment.Value(srcBytes))
			if node.SoftLineBreak() || node.HardLineBreak() {
				sb.WriteByte(' ')
			}
		case *ast.String:
			sb.Write(node.Value)
		}
		return ast.WalkContinue, nil
	})
	return strings.TrimSpace(unmaskMaskTokensForMeasure(sb.String(), codeBlocks))
}

func locateGoldmarkLinkSpan(link *ast.Link, src []byte) (start, closeBracket, end int, ok bool) {
	start = link.Pos()
	if start < 0 || start >= len(src) || src[start] != '[' {
		return 0, 0, 0, false
	}

	depth := 1
	closeBracket = -1
	for i := start + 1; i < len(src); i++ {
		b := src[i]
		if b == '\\' && i+1 < len(src) {
			i++
			continue
		}
		if b == '[' {
			depth++
			continue
		}
		if b == ']' {
			depth--
			if depth == 0 {
				closeBracket = i
				break
			}
		}
	}
	if closeBracket < 0 {
		return 0, 0, 0, false
	}

	if link.Reference != nil {
		if link.Reference.Type == ast.ReferenceLinkShortcut {
			return start, closeBracket, closeBracket + 1, true
		}
		if closeBracket+1 >= len(src) || src[closeBracket+1] != '[' {
			return 0, 0, 0, false
		}
		refEnd := -1
		for i := closeBracket + 2; i < len(src); i++ {
			if src[i] == '\\' && i+1 < len(src) {
				i++
				continue
			}
			if src[i] == ']' {
				refEnd = i + 1
				break
			}
		}
		if refEnd < 0 {
			return 0, 0, 0, false
		}
		return start, closeBracket, refEnd, true
	}

	// 内联链接 [label](url "title")
	if closeBracket+1 >= len(src) || src[closeBracket+1] != '(' {
		return 0, 0, 0, false
	}
	parenDepth := 1
	inAngle := false
	var quote byte
	for i := closeBracket + 2; i < len(src); i++ {
		b := src[i]
		if b == '\\' && i+1 < len(src) {
			i++
			continue
		}
		if quote != 0 {
			if b == quote {
				quote = 0
			}
			continue
		}
		if inAngle {
			if b == '>' {
				inAngle = false
			}
			continue
		}
		switch b {
		case '<':
			inAngle = true
		case '"', '\'':
			quote = b
		case '(':
			parenDepth++
		case ')':
			parenDepth--
			if parenDepth == 0 {
				return start, closeBracket, i + 1, true
			}
		}
	}
	return 0, 0, 0, false
}

func splitDegradedLinkLabel(labelRaw string, link *ast.Link, srcBytes []byte, codeBlocks []sanitize.CodeBlock, inBlockquote bool) (title string, bodyMD string) {
	rawLines := strings.Split(labelRaw, "\n")
	nonEmpty := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		cleaned := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line), `\`))
		if inBlockquote && strings.HasPrefix(cleaned, ">") {
			cleaned = strings.TrimSpace(strings.TrimPrefix(cleaned, ">"))
		}
		if cleaned != "" {
			nonEmpty = append(nonEmpty, cleaned)
		}
	}

	if len(nonEmpty) > 1 {
		firstLinePlain := stripSimpleMarkdownDecorators(nonEmpty[0])
		if firstLinePlain == "" {
			firstLinePlain = truncateSafeRunes(collectGoldmarkPlainText(link, srcBytes, codeBlocks), goldmarkTitleMaxRunes)
		}
		title = truncateSafeRunes(firstLinePlain, goldmarkTitleMaxRunes)
		bodyMD = strings.Join(nonEmpty[1:], "\n\n")
		return title, bodyMD
	}

	plain := collectGoldmarkPlainText(link, srcBytes, codeBlocks)
	title = truncateSafeRunes(plain, goldmarkTitleMaxRunes)
	if len(nonEmpty) == 1 {
		bodyMD = nonEmpty[0]
	}
	return title, bodyMD
}

func stripSimpleMarkdownDecorators(line string) string {
	s := strings.TrimSpace(line)
	s = strings.TrimLeft(s, "#*-> ")
	s = strings.TrimSuffix(s, "**")
	s = strings.TrimPrefix(s, "**")
	return strings.TrimSpace(s)
}

func truncateSafeRunes(s string, maxRunes int) string {
	collapsed := strings.TrimSpace(reSpaceUnit.ReplaceAllString(s, " "))
	runes := []rune(collapsed)
	if len(runes) <= maxRunes || maxRunes <= 0 {
		return collapsed
	}
	// 严禁在 mask PUA token (\uE800...\uE001) 中间截断
	cut := maxRunes
	for cut > 0 && cut < len(runes) {
		inMask := false
		for i := 0; i < cut; i++ {
			if runes[i] == '\uE800' {
				inMask = true
			} else if runes[i] == '\uE001' {
				inMask = false
			}
		}
		if inMask {
			// 向后找当前 PUA token 结束符
			for cut < len(runes) && runes[cut-1] != '\uE001' {
				cut++
			}
			break
		}
		if unicode.IsSpace(runes[cut]) {
			break
		}
		cut--
	}
	if cut <= 0 || cut > maxRunes+24 {
		cut = maxRunes
	}
	return strings.TrimSpace(string(runes[:cut])) + "…"
}

func isListItemMarkerPrefix(s string) bool {
	if s == "-" || s == "*" || s == "+" {
		return true
	}
	if len(s) >= 2 && (s[len(s)-1] == '.' || s[len(s)-1] == ')') {
		for i := 0; i < len(s)-1; i++ {
			if s[i] < '0' || s[i] > '9' {
				return false
			}
		}
		return true
	}
	return false
}

func formatBlockReplacementContext(src []byte, start, end int, cardBlock string, inBlockquote bool) string {
	prefix := ""
	suffix := ""

	// 向前查找当前行在 start 之前的内容
	lineStart := bytes.LastIndexByte(src[:start], '\n') + 1
	rawBefore := string(src[lineStart:start])
	beforeOnLine := strings.TrimSpace(rawBefore)

	formattedCard := cardBlock
	if inBlockquote && beforeOnLine == ">" {
		// 当前行已经以 "> " 开头，首行剥除重复 "> " 避免生成 "> >" 嵌套引用
		formattedCard = strings.TrimPrefix(formattedCard, "> ")
	} else if isListItemMarkerPrefix(beforeOnLine) {
		// 列表项内的块链接：保留列表标号并以 2 空格缩进续行，避免留下空列表点
		indent := strings.Repeat(" ", len(rawBefore)-len(strings.TrimLeft(rawBefore, " "))+2)
		formattedCard = strings.ReplaceAll(formattedCard, "\n", "\n"+indent)
	} else if beforeOnLine != "" && beforeOnLine != ">" {
		prefix = "\n\n"
	}

	// 向后查找当前行在 end 之后的内容
	nextNL := bytes.IndexByte(src[end:], '\n')
	var afterOnLine string
	if nextNL >= 0 {
		afterOnLine = strings.TrimSpace(string(src[end : end+nextNL]))
	} else {
		afterOnLine = strings.TrimSpace(string(src[end:]))
	}
	if afterOnLine != "" {
		suffix = "\n\n"
	}
	return prefix + formattedCard + suffix
}

func applyGoldmarkReplacements(src []byte, replacements []goldmarkLinkReplacement) string {
	if len(replacements) == 0 {
		return string(src)
	}
	sort.Slice(replacements, func(i, j int) bool {
		return replacements[i].start > replacements[j].start
	})
	out := make([]byte, len(src))
	copy(out, src)
	prevStart := len(out) + 1
	for _, r := range replacements {
		if r.start < 0 || r.end > prevStart || r.end < r.start {
			continue
		}
		buf := make([]byte, 0, len(out)-(r.end-r.start)+len(r.body))
		buf = append(buf, out[:r.start]...)
		buf = append(buf, r.body...)
		buf = append(buf, out[r.end:]...)
		out = buf
		prevStart = r.start
	}
	return string(out)
}

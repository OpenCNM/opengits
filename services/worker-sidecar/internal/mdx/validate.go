package mdx

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/sanitize"

	"github.com/dop251/goja/parser"
)

const MaxSourceBytes = 2_000_000
const mdxSourceMaxBytes = MaxSourceBytes

var htmlVoidElements = map[string]struct{}{
	"area": {}, "base": {}, "br": {}, "col": {}, "embed": {}, "hr": {},
	"img": {}, "input": {}, "link": {}, "meta": {}, "param": {},
	"source": {}, "track": {}, "wbr": {},
}

type mdxScanFlags struct {
	unclosedFrontmatter bool
	unclosedFence       bool
	hasGenerics         bool
	hasComplexBraces    bool
	unclosedBrace       bool
	hasComplexEsm       bool
	unclosedTag         string
	jsxElementsDetected bool
	detailsLayoutErr    string
}

func scanMdxLinear(u8 []byte) mdxScanFlags {
	var f mdxScanFlags
	len_ := len(u8)
	pos := 0

	if len_ >= 3 && u8[0] == 0x2d && u8[1] == 0x2d && u8[2] == 0x2d {
		fmClosed := false
		i := 3
		for i < len_ && u8[i] != 0x0a {
			i++
		}
		if i < len_ && u8[i] == 0x0a {
			i++
		}
		for i < len_ {
			isLine := i == 0 || u8[i-1] == 0x0a
			if !isLine || i+2 >= len_ || u8[i] != 0x2d || u8[i+1] != 0x2d || u8[i+2] != 0x2d {
				i++
				continue
			}
			nextChar := byte(0x0a)
			if i+3 < len_ {
				nextChar = u8[i+3]
			}
			if nextChar == 0x0a || nextChar == 0x0d || nextChar == 0x20 || i+3 == len_ {
				fmClosed = true
				for i < len_ && u8[i] != 0x0a {
					i++
				}
				if i < len_ && u8[i] == 0x0a {
					i++
				}
				pos = i
				break
			}
			i++
		}
		if !fmClosed {
			f.unclosedFrontmatter = true
			pos = 3
		}
	}

	inFence := false
	var fenceChar byte
	fenceLen := 0
	inInlineCode := false
	braceDepth := 0
	braceStartLine := 0
	currentLine := 1
	var tagStack []string

	isTagnameByte := func(b byte) bool {
		return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ||
			(b >= 0x30 && b <= 0x39) || b == 0x2d || b == 0x2e
	}

	for pos < len_ {
		b := u8[pos]

		if b == 0x0a {
			currentLine++
			pos++
			continue
		}

		isLineStart := pos == 0 || u8[pos-1] == 0x0a
		if isLineStart && (b == 0x60 || b == 0x7e) {
			count := 0
			p := pos
			for p < len_ && u8[p] == b {
				count++
				p++
			}
			if count >= 3 && !inFence {
				inFence = true
				fenceChar = b
				fenceLen = count
				pos = p
				for pos < len_ && u8[pos] != 0x0a {
					pos++
				}
				continue
			}
			if count >= 3 && inFence && b == fenceChar && count >= fenceLen {
				if afterFence, ok := isFenceClosing(u8, len_, p); ok {
					inFence = false
					fenceChar = 0
					fenceLen = 0
					pos = afterFence
					continue
				}
			}
		}

		if inFence {
			pos++
			continue
		}

		if b == 0x60 {
			inInlineCode = !inInlineCode
			pos++
			continue
		}
		if inInlineCode {
			pos++
			continue
		}

		if isLineStart && b == 0x69 && pos+7 < len_ &&
			u8[pos+1] == 0x6d && u8[pos+2] == 0x70 && u8[pos+3] == 0x6f &&
			u8[pos+4] == 0x72 && u8[pos+5] == 0x74 && u8[pos+6] == 0x20 {
			f.hasComplexEsm = true
		}

		if b == 0x7b {
			if braceDepth == 0 {
				braceStartLine = currentLine
			}
			braceDepth++
			f.hasComplexBraces = true
		} else if b == 0x7d {
			braceDepth--
			if braceDepth < 0 {
				f.unclosedBrace = true
				f.hasComplexBraces = true
				braceDepth = 0
			}
			if braceDepth == 0 && currentLine > braceStartLine {
				f.hasComplexBraces = true
			}
		}

		if b == 0x3c {
			if pos+3 < len_ && u8[pos+1] == 0x21 && u8[pos+2] == 0x2d && u8[pos+3] == 0x2d {
				pos += 4
				for pos+2 < len_ && !(u8[pos] == 0x2d && u8[pos+1] == 0x2d && u8[pos+2] == 0x3e) {
					if u8[pos] == 0x0a {
						currentLine++
					}
					pos++
				}
				pos += 3
				continue
			}

			if pos+1 < len_ && u8[pos+1] == 0x2f {
				f.jsxElementsDetected = true
				p := pos + 2
				for p < len_ && isTagnameByte(u8[p]) {
					p++
				}
				tagName := string(u8[pos+2 : p])
				for p < len_ && u8[p] != 0x3e && u8[p] != 0x0a {
					p++
				}
				if p < len_ && u8[p] == 0x3e {
					p++
				}
				var unclosed string
				tagStack, unclosed = popTag(tagStack, tagName)
				if unclosed != "" {
					f.unclosedTag = unclosed
				}
				pos = p
				continue
			}

			p := pos + 1
			for p < len_ && isTagnameByte(u8[p]) {
				p++
			}
			token := string(u8[pos+1 : p])
			if len(token) == 0 {
				pos++
				continue
			}

			isSingleTypeParam := len(token) == 1 && token[0] >= 'A' && token[0] <= 'Z'
			if isSingleTypeParam && p < len_ && (u8[p] == 0x3e || u8[p] == 0x2c) {
				f.hasGenerics = true
			}

			tagEnd, isSelfClosing := scanTagEnd(u8, len_, p, &currentLine)

			_, isKnownVoid := htmlVoidElements[strings.ToLower(token)]
			isComponentTag := token[0] >= 'A' && token[0] <= 'Z' && !isSingleTypeParam
			isAllLetters := token != "" && isAsciiLetters(token)

			if isComponentTag || (!isKnownVoid && !isSelfClosing && len(token) > 1 && isAllLetters) {
				f.jsxElementsDetected = true
				if !isSelfClosing && !isKnownVoid {
					tagStack = append(tagStack, token)
				}
			}

			pos = tagEnd
			continue
		}

		pos++
	}

	if inFence {
		f.unclosedFence = true
	}
	if braceDepth != 0 {
		f.unclosedBrace = true
		f.hasComplexBraces = true
	}
	if len(tagStack) > 0 && f.unclosedTag == "" {
		f.unclosedTag = tagStack[len(tagStack)-1]
	}
	return f
}

func isAsciiLetters(s string) bool {
	for i := 0; i < len(s); i++ {
		b := s[i]
		if !((b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')) {
			return false
		}
	}
	return len(s) > 0
}

func extractJsxSegments(content string) []string {
	var segments []string
	inFence := false
	var nonFenceLines []string
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		nonFenceLines = append(nonFenceLines, line)
	}
	clean := strings.Join(nonFenceLines, "\n")
	i := 0
	for i < len(clean) {
		if clean[i] != '<' || i+1 >= len(clean) {
			i++
			continue
		}
		next := clean[i+1]
		isTagStart := (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a)
		if !isTagStart {
			i++
			continue
		}
		start := i
		p := i + 1
		var quote byte
		braceDepth := 0
		for p < len(clean) {
			ch := clean[p]
			if quote != 0 {
				if ch == quote && (p == 0 || clean[p-1] != 0x5c) {
					quote = 0
				}
				p++
				continue
			}
			matchedClose := false
			switch ch {
			case 0x22, 0x27, 0x60:
				quote = ch
			case 0x7b:
				braceDepth++
			case 0x7d:
				if braceDepth > 0 {
					braceDepth--
				}
			case 0x3e:
				if braceDepth == 0 {
					p++
					matchedClose = true
				}
			}
			if matchedClose {
				break
			}
			p++
		}
		segments = append(segments, clean[start:p])
		i = p
	}
	return segments
}

func extractJsxAttributeExpressions(segment string) []string {
	var expressions []string
	i := 0
	for i < len(segment) {
		if segment[i] != '=' || i+1 >= len(segment) {
			i++
			continue
		}
		p := i + 1
		for p < len(segment) && (segment[p] == ' ' || segment[p] == '\t' || segment[p] == '\n' || segment[p] == '\r') {
			p++
		}
		if p >= len(segment) || segment[p] != '{' {
			i++
			continue
		}
		start := p + 1
		depth := 1
		var quote byte
		end := start
		for end < len(segment) && depth > 0 {
			ch := segment[end]
			if quote != 0 {
				if ch == quote && (end == 0 || segment[end-1] != 0x5c) {
					quote = 0
				}
				end++
				continue
			}
			switch ch {
			case 0x22, 0x27, 0x60:
				quote = ch
			case 0x7b:
				depth++
			case 0x7d:
				depth--
			}
			if depth == 0 {
				break
			}
			end++
		}
		if depth == 0 {
			expressions = append(expressions, segment[start:end])
			i = end + 1
			continue
		}
		expressions = append(expressions, segment[start:])
		break
	}
	return expressions
}

// Uses [ \t] instead of \s so cross-line assertions do not greedily merge.
var tsTypeAssertionRe = regexp.MustCompile(`[ \t]+as[ \t]+[A-Za-z0-9_<>[\]|&, \t]+`)

type mdxValidationRule interface {
	Validate(rawContent string, scan mdxScanFlags) (valid bool, errMsg string)
}

type genericsCollisionRule struct{}

func (genericsCollisionRule) Validate(_ string, scan mdxScanFlags) (bool, string) {
	if scan.hasGenerics {
		return false, "Contains generic type parameter collision outside code block (e.g. <T>)"
	}
	return true, ""
}

type unclosedTagRule struct{}

func (unclosedTagRule) Validate(_ string, scan mdxScanFlags) (bool, string) {
	if scan.unclosedTag != "" {
		return false, "Expected a closing tag for `<" + scan.unclosedTag + ">` in MDX"
	}
	return true, ""
}

type jsxAttributeExpressionRule struct{}

func (jsxAttributeExpressionRule) Validate(rawContent string, scan mdxScanFlags) (bool, string) {
	if !scan.jsxElementsDetected {
		return true, ""
	}
	for _, seg := range extractJsxSegments(rawContent) {
		for _, expr := range extractJsxAttributeExpressions(seg) {
			if !isValidJsExpression(expr) {
				return false, "Unexpected character in JSX attribute expression: {" + truncate(expr, 60) + "}"
			}
		}
	}
	return true, ""
}

type detailsLayoutRule struct{}

func (detailsLayoutRule) Validate(_ string, scan mdxScanFlags) (bool, string) {
	if scan.detailsLayoutErr != "" {
		return false, scan.detailsLayoutErr
	}
	return true, ""
}

var defaultMdxValidationRules = []mdxValidationRule{
	genericsCollisionRule{},
	unclosedTagRule{},
	jsxAttributeExpressionRule{},
	detailsLayoutRule{},
}

func ValidateDetailed(content string) (bool, string) {
	if len(content) > MaxSourceBytes {
		return false, "mdx source exceeds 2,000,000 byte limit"
	}
	if strings.TrimSpace(content) == "" {
		return true, ""
	}
	src := sanitize.PrepareMdxSource(content)
	scan := scanMdxLinear([]byte(src))
	if scan.unclosedTag == "" {
		scan.detailsLayoutErr = validateDetailsLayout(src)
	}

	for _, rule := range defaultMdxValidationRules {
		if valid, errMsg := rule.Validate(content, scan); !valid {
			return false, errMsg
		}
	}

	// Tolerates unclosed frontmatter/fences and brace errors because compilers and heal recover them.
	return true, ""
}

// Enforces standalone <details>/<summary> lines with blank separation so MDX does not wrap <summary> in <p>.
func validateDetailsLayout(src string) string {
	if !strings.Contains(src, "<details") && !strings.Contains(src, "</details") &&
		!strings.Contains(src, "<summary") && !strings.Contains(src, "</summary") {
		return ""
	}

	fenceRanges := armor.FindCodeFenceIndices(src)
	n := len(src)
	fenceIdx := 0

	for i := 0; i < n; {
		if fenceIdx < len(fenceRanges) && i == fenceRanges[fenceIdx][0] {
			i = fenceRanges[fenceIdx][1]
			fenceIdx++
			continue
		}

		limit := n
		if fenceIdx < len(fenceRanges) {
			limit = fenceRanges[fenceIdx][0]
		}

		if src[i] == '`' {
			if isEscapedBacktick(src, i) {
				i++
				continue
			}
			end, _ := armor.ScanInlineCodeSpanEnd(src, i, limit)
			i = end
			continue
		}
		if src[i] != '<' {
			i++
			continue
		}
		if end, handled := armor.ScanHTMLCommentEnd(src, i, limit); handled {
			i = end
			continue
		}

		tag, ok := armor.ScanProseTag(src, i, limit)
		if !ok {
			i++
			continue
		}
		if tag.RawName != "details" && tag.RawName != "summary" {
			i = tag.End
			continue
		}

		switch {
		case tag.RawName == "details" && !tag.Closing && !tag.SelfClose:
			if hasNonSpaceBeforeOnLine(src, i) || hasNonSpaceAfterOnLine(src, tag.End, n) {
				return "Unnormalized <details> tag must sit on its own line before <summary> or body content in MDX"
			}

		case tag.RawName == "summary" && tag.Closing:
			if errMsg := checkAfterSummaryClose(src, tag.End); errMsg != "" {
				return errMsg
			}

		case tag.RawName == "details" && tag.Closing:
			if hasNonSpaceBeforeOnLine(src, i) || hasNonSpaceAfterOnLine(src, tag.End, n) {
				return "Unnormalized </details> tag must sit on its own line in MDX"
			}
		}
		i = tag.End
	}
	return ""
}

func isEscapedBacktick(s string, i int) bool {
	bs := 0
	for k := i - 1; k >= 0 && s[k] == '\\'; k-- {
		bs++
	}
	return bs%2 == 1
}

func hasNonSpaceBeforeOnLine(s string, idx int) bool {
	for k := idx - 1; k >= 0 && s[k] != '\n'; k-- {
		if s[k] != ' ' && s[k] != '\t' && s[k] != '\r' {
			return true
		}
	}
	return false
}

func hasNonSpaceAfterOnLine(s string, idx, limit int) bool {
	for k := idx; k < limit && s[k] != '\n' && s[k] != '\r'; k++ {
		if s[k] != ' ' && s[k] != '\t' {
			return true
		}
	}
	return false
}

func checkAfterSummaryClose(src string, tagEnd int) string {
	n := len(src)
	if hasNonSpaceAfterOnLine(src, tagEnd, n) {
		return "Unnormalized </summary> tag must sit on its own line followed by a blank line in MDX"
	}

	j := tagEnd
	for j < n && (src[j] == ' ' || src[j] == '\t') {
		j++
	}
	if j >= n {
		return ""
	}
	if src[j] == '\r' {
		j++
	}
	if j < n && src[j] == '\n' {
		j++
	} else {
		return ""
	}

	lineEnd := strings.IndexByte(src[j:], '\n')
	var nextLine string
	if lineEnd < 0 {
		nextLine = src[j:]
	} else {
		nextLine = src[j : j+lineEnd]
	}
	trimmed := strings.Trim(nextLine, " \t\r")
	if trimmed == "" || isBlockInterruptingLine(trimmed) {
		return ""
	}
	return "Unnormalized </summary> must be followed by a blank line before prose in MDX (causes <p><summary>)"
}

func isBlockInterruptingLine(trimmed string) bool {
	if strings.HasPrefix(trimmed, "</details") ||
		strings.HasPrefix(trimmed, "```") ||
		strings.HasPrefix(trimmed, "~~~") ||
		strings.HasPrefix(trimmed, ">") {
		return true
	}
	if isATXHeadingStart(trimmed) || isMarkdownListStart(trimmed) {
		return true
	}
	if tag, ok := armor.ScanProseTag(trimmed, 0, len(trimmed)); ok && tag.End == len(trimmed) {
		return true
	}
	return false
}

func isATXHeadingStart(trimmed string) bool {
	hashes := 0
	for hashes < len(trimmed) && hashes < 6 && trimmed[hashes] == '#' {
		hashes++
	}
	if hashes == 0 {
		return false
	}
	return hashes == len(trimmed) || trimmed[hashes] == ' ' || trimmed[hashes] == '\t'
}

func isMarkdownListStart(trimmed string) bool {
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "+ ") {
		return true
	}
	i := 0
	for i < len(trimmed) && i < 9 && trimmed[i] >= '0' && trimmed[i] <= '9' {
		i++
	}
	if i > 0 && i+1 < len(trimmed) && (trimmed[i] == '.' || trimmed[i] == ')') && (trimmed[i+1] == ' ' || trimmed[i+1] == '\t') {
		return true
	}
	return false
}

func isValidJsExpression(expr string) bool {
	trimmed := strings.TrimSpace(expr)
	if trimmed == "" {
		return false
	}
	if jsExprSyntacticallyValid(trimmed) {
		return true
	}
	sanitized := tsTypeAssertionRe.ReplaceAllString(trimmed, "")
	if sanitized != trimmed {
		return jsExprSyntacticallyValid(sanitized)
	}
	return false
}

func goIsValidJsExpression(expr string) bool {
	return isValidJsExpression(expr)
}

// Pure goja parser (no eval) covers arrow/ternary/destructuring JS syntax and recovers from parser panics.
func jsExprSyntacticallyValid(s string) (valid bool) {
	defer func() {
		if recover() != nil {
			valid = false
		}
	}()
	_, err := parser.ParseFile(nil, "", "("+s+")", 0)
	return err == nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func isFenceClosing(u8 []byte, len_, p int) (int, bool) {
	afterFence := p
	for afterFence < len_ && (u8[afterFence] == 0x20 || u8[afterFence] == 0x09) {
		afterFence++
	}
	if afterFence >= len_ || u8[afterFence] == 0x0a || u8[afterFence] == 0x0d {
		return afterFence, true
	}
	return p, false
}

func popTag(tagStack []string, tagName string) ([]string, string) {
	if len(tagStack) == 0 {
		return tagStack, tagName
	}
	top := tagStack[len(tagStack)-1]
	if strings.EqualFold(top, tagName) {
		return tagStack[:len(tagStack)-1], ""
	}
	return tagStack, top
}

func scanTagEnd(u8 []byte, len_, p int, currentLine *int) (int, bool) {
	tagEnd := p
	isSelfClosing := false
	var quoteChar byte
	tagBraceDepth := 0
	for tagEnd < len_ {
		ch := u8[tagEnd]
		if ch == 0x0a {
			*currentLine++
		}
		if quoteChar != 0 {
			if ch == quoteChar && (tagEnd == 0 || u8[tagEnd-1] != 0x5c) {
				quoteChar = 0
			}
			tagEnd++
			continue
		}
		done := false
		switch ch {
		case 0x22, 0x27, 0x60:
			quoteChar = ch
		case 0x7b:
			tagBraceDepth++
		case 0x7d:
			if tagBraceDepth > 0 {
				tagBraceDepth--
			}
		case 0x2f:
			if tagBraceDepth == 0 && tagEnd+1 < len_ && u8[tagEnd+1] == 0x3e {
				isSelfClosing = true
				tagEnd += 2
				done = true
			}
		case 0x3e:
			if tagBraceDepth == 0 {
				tagEnd++
				done = true
			}
		}
		if done {
			break
		}
		tagEnd++
	}
	return tagEnd, isSelfClosing
}

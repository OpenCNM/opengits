package armor

import (
	"bytes"
	"strings"
)

// Unclosed <details> extends to EOF to mirror MDX compiler swallowing behavior rather than faking closure.

type LayerRegion struct {
	IsFence    bool
	IsDiagram  bool
	IsDeepDive bool
	HasSlot    bool
	Text       string
}

type LayerMetrics struct {
	MainBlocks   int
	MainAnchored int
	DeepBlocks   int
	DeepAnchored int
	DeepDives    int
	DenseParas   int
}

const denseParagraphInlineCodeFloor = 4

const DeepDiveLayer = "deep"

func SplitLayerRegions(content string) []LayerRegion {
	regions, _ := splitLayerRegions(content)
	return regions
}

func MeasureLayers(content string) LayerMetrics {
	regions, deepDives := splitLayerRegions(content)
	var m LayerMetrics
	m.DeepDives = deepDives
	for _, reg := range regions {
		if reg.IsFence {
			switch {
			case reg.IsDiagram:
			case reg.IsDeepDive:
				m.DeepBlocks++
				if reg.HasSlot {
					m.DeepAnchored++
				}
			default:
				m.MainBlocks++
				if reg.HasSlot {
					m.MainAnchored++
				}
			}
			continue
		}
		if !reg.IsDeepDive {
			m.DenseParas += countDenseParagraphs(reg.Text)
		}
	}
	return m
}

func splitLayerRegions(content string) ([]LayerRegion, int) {
	parts := armorSplitByFence(content)
	regions := make([]LayerRegion, 0, len(parts)*2)
	deepStack := make([]bool, 0, 4)
	deepDives := 0
	for i, part := range parts {
		if part == "" {
			continue
		}
		if i%2 == 1 {
			first := part
			if nl := strings.IndexByte(part, '\n'); nl >= 0 {
				first = part[:nl]
			} else {
				continue
			}
			isDiagram := isMermaidFenceLine(first)
			regions = append(regions, LayerRegion{
				IsFence:    true,
				IsDiagram:  isDiagram,
				IsDeepDive: inDeepDive(deepStack),
				HasSlot:    !isDiagram && IsResolvedFenceHeader(first),
				Text:       part,
			})
			continue
		}
		regions, deepDives = appendProseLayerRegions(regions, part, &deepStack, deepDives)
	}
	return regions, deepDives
}

func inDeepDive(deepStack []bool) bool {
	for _, deep := range deepStack {
		if deep {
			return true
		}
	}
	return false
}

// Skips inline code spans and HTML comments so literal "<details data-layer=...>" mentions do not shift depth.
func appendProseLayerRegions(regions []LayerRegion, prose string, deepStack *[]bool, deepDives int) ([]LayerRegion, int) {
	last := 0
	flush := func(end int, deep bool) {
		if end > last {
			regions = append(regions, LayerRegion{IsDeepDive: deep, Text: prose[last:end]})
		}
	}
	n := len(prose)
	for i := 0; i < n; {
		if prose[i] == '`' {
			if isEscapedAt(prose, i) {
				i++
				continue
			}
			end, _ := ScanInlineCodeSpanEnd(prose, i, n)
			i = end
			continue
		}
		if prose[i] != '<' {
			i++
			continue
		}
		if end, handled := ScanHTMLCommentEnd(prose, i, n); handled {
			i = end
			continue
		}
		tag, ok := ScanProseTag(prose, i, n)
		if !ok {
			i++
			continue
		}
		if tag.RawName != "details" || tag.SelfClose {
			i = tag.End
			continue
		}
		wasDeep := inDeepDive(*deepStack)
		if tag.Closing {
			if stackLen := len(*deepStack); stackLen > 0 {
				*deepStack = (*deepStack)[:stackLen-1]
			}
		} else {
			deep := false
			if v, has := layerTagAttr(prose, tag, "data-layer"); has {
				deep = isDeepDiveLayerValue(v)
			}
			if deep {
				deepDives++
			}
			*deepStack = append(*deepStack, deep)
		}
		if inDeepDive(*deepStack) == wasDeep {
			i = tag.End
			continue
		}
		flush(i, wasDeep)
		last = i
		i = tag.End
	}
	flush(len(prose), inDeepDive(*deepStack))
	return regions, deepDives
}

type ProseTag struct {
	End       int
	RawName   string
	Name      string
	Closing   bool
	SelfClose bool
	attrStart int
	attrEnd   int
}

func isEscapedAt(s string, i int) bool {
	bs := 0
	for k := i - 1; k >= 0 && s[k] == '\\'; k-- {
		bs++
	}
	return bs%2 == 1
}

func isParagraphBreakAt(s string, i, limit int) bool {
	if i >= limit {
		return false
	}
	if s[i] == '\r' {
		if i+1 >= limit || s[i+1] != '\n' {
			return false
		}
		i += 2
	} else if s[i] == '\n' {
		i++
	} else {
		return false
	}
	for i < limit && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return i < limit && (s[i] == '\n' || (s[i] == '\r' && i+1 < limit && s[i+1] == '\n'))
}

func ScanInlineCodeSpanEnd(s string, i, limit int) (int, bool) {
	j := i
	for j < limit && s[j] == '`' {
		j++
	}
	runLen := j - i
	if runLen == 0 {
		return i, false
	}
	for k := j; k < limit; {
		if isParagraphBreakAt(s, k, limit) {
			return j, false
		}
		if s[k] == '`' {
			closeStart := k
			for k < limit && s[k] == '`' {
				k++
			}
			if k-closeStart == runLen {
				return k, true
			}
			continue
		}
		k++
	}
	return j, false
}

func ScanHTMLCommentEnd(s string, i, limit int) (int, bool) {
	if i+4 <= limit && s[i] == '<' && s[i+1] == '!' && s[i+2] == '-' && s[i+3] == '-' {
		if rel := strings.Index(s[i+4:limit], "-->"); rel >= 0 {
			return i + 4 + rel + 3, true
		}
		return i + 4, true
	}
	return i, false
}

// Ignores '>' inside quotes/braces and aborts on unclosed '<' so prose inequalities like "a < b" stay untouched.
func ScanProseTag(s string, i, limit int) (ProseTag, bool) {
	if limit > len(s) {
		limit = len(s)
	}
	j := i + 1
	closing := false
	if j < limit && s[j] == '/' {
		closing = true
		j++
	}
	if j >= limit || !isLayerASCIILetter(s[j]) {
		return ProseTag{}, false
	}
	nameStart := j
	for j < limit && isLayerNameByte(s[j]) {
		j++
	}
	attrStart := j
	quote := byte(0)
	braceDepth := 0
	for j < limit {
		c := s[j]
		if quote != 0 {
			if c == quote && (quote == '\'' || quote == '"' || !isEscapedAt(s, j)) {
				quote = 0
			}
			j++
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case '`':
			if braceDepth > 0 {
				quote = c
			}
		case '{':
			braceDepth++
		case '}':
			if braceDepth > 0 {
				braceDepth--
			}
		case '<':
			if braceDepth == 0 {
				return ProseTag{}, false
			}
		case '>':
			if braceDepth == 0 {
				attrEnd := j
				selfClose := attrEnd > attrStart && s[attrEnd-1] == '/'
				if selfClose {
					attrEnd--
				}
				rawName := s[nameStart:attrStart]
				return ProseTag{
					End: j + 1, RawName: rawName, Name: strings.ToLower(rawName),
					Closing: closing, SelfClose: selfClose, attrStart: attrStart, attrEnd: attrEnd,
				}, true
			}
		}
		j++
	}
	return ProseTag{}, false
}

func isDeepDiveLayerValue(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case DeepDiveLayer, "deep-dive", "deep_dive", "deepdive",
		"深挖", "深潜", "源码深潜", "源码深挖",
		"深入", "深入一步", "深入细节", "深度剖析", "深入剖析", "进阶":
		return true
	default:
		return false
	}
}

func layerTagAttrSpan(s string, tag ProseTag, name string) (string, int, int, bool) {
	i, end := tag.attrStart, tag.attrEnd
	for i < end {
		for i < end && isLayerSpace(s[i]) {
			i++
		}
		if i >= end || s[i] == '/' {
			break
		}
		nameStart := i
		for i < end && s[i] != '=' && s[i] != '/' && !isLayerSpace(s[i]) {
			i++
		}
		attrName := s[nameStart:i]
		for i < end && isLayerSpace(s[i]) {
			i++
		}
		if i >= end || s[i] != '=' {
			if strings.EqualFold(attrName, name) {
				return "", i, i, true
			}
			continue
		}
		i++
		for i < end && isLayerSpace(s[i]) {
			i++
		}
		var value string
		var valueStart, valueEnd int
		if i < end && (s[i] == '"' || s[i] == '\'') {
			q := s[i]
			i++
			valueStart = i
			for i < end && s[i] != q {
				i++
			}
			valueEnd = i
			value = s[valueStart:valueEnd]
			if i < end {
				i++
			}
		} else {
			valueStart = i
			for i < end && !isLayerSpace(s[i]) && s[i] != '/' {
				i++
			}
			valueEnd = i
			value = s[valueStart:valueEnd]
		}
		if strings.EqualFold(attrName, name) {
			return value, valueStart, valueEnd, true
		}
	}
	return "", 0, 0, false
}

func layerTagAttr(s string, tag ProseTag, name string) (string, bool) {
	v, _, _, ok := layerTagAttrSpan(s, tag, name)
	return v, ok
}

func normalizeDetailsOpenTag(content string, tagStart int, tag ProseTag) string {
	v, valStart, valEnd, has := layerTagAttrSpan(content, tag, "data-layer")
	if !has || !isDeepDiveLayerValue(v) || v == DeepDiveLayer || valStart < tagStart || valEnd > tag.End {
		return content[tagStart:tag.End]
	}
	return content[tagStart:valStart] + DeepDiveLayer + content[valEnd:tag.End]
}

// Matches only lowercase <details>/<summary> so uppercase React <Summary> components remain verbatim.
func NormalizeDeepDiveBlocks(content string) string {
	if content == "" || !containsDetailsOrSummaryTag(content) {
		return content
	}

	fenceRanges := findCodeFenceIndices(content)
	n := len(content)
	out := make([]byte, 0, n+64)
	fenceIdx := 0

	for i := 0; i < n; {
		if fenceIdx < len(fenceRanges) && i == fenceRanges[fenceIdx][0] {
			fEnd := fenceRanges[fenceIdx][1]
			out = append(out, content[i:fEnd]...)
			i = fEnd
			fenceIdx++
			continue
		}

		limit := n
		if fenceIdx < len(fenceRanges) {
			limit = fenceRanges[fenceIdx][0]
		}

		if content[i] == '`' {
			if isEscapedAt(content, i) {
				out = append(out, content[i])
				i++
				continue
			}
			end, _ := ScanInlineCodeSpanEnd(content, i, limit)
			out = append(out, content[i:end]...)
			i = end
			continue
		}

		if content[i] != '<' {
			out = append(out, content[i])
			i++
			continue
		}

		if end, handled := ScanHTMLCommentEnd(content, i, limit); handled {
			out = append(out, content[i:end]...)
			i = end
			continue
		}

		tag, ok := ScanProseTag(content, i, limit)
		if !ok {
			out = append(out, content[i])
			i++
			continue
		}

		if tag.RawName != "details" && tag.RawName != "summary" {
			out = append(out, content[i:tag.End]...)
			i = tag.End
			continue
		}

		switch {
		case tag.RawName == "details" && !tag.Closing && !tag.SelfClose:
			out = ensureNewlineBeforeOpenTag(out, "\n\n")
			out = append(out, normalizeDetailsOpenTag(content, i, tag)...)
			afterWS := skipHorizSpace(content, tag.End, limit)
			if afterWS < limit && content[afterWS] != '\n' && content[afterWS] != '\r' {
				if isExactTagStartAt(content, afterWS, limit, "summary", false) {
					out = append(out, '\n')
				} else {
					out = append(out, '\n', '\n')
				}
				i = afterWS
			} else {
				i = tag.End
			}

		case tag.RawName == "summary" && !tag.Closing && !tag.SelfClose:
			out = ensureNewlineBeforeOpenTag(out, "\n")
			out = append(out, content[i:tag.End]...)
			i = tag.End

		case tag.RawName == "summary" && tag.Closing:
			out = append(out, content[i:tag.End]...)
			out, i = ensureBlankLineAfterTag(out, content, tag.End)

		case tag.RawName == "details" && tag.Closing:
			out = ensureBlankLineBeforeClosingTag(out)
			out = append(out, content[i:tag.End]...)
			out, i = ensureBlankLineAfterTag(out, content, tag.End)

		default:
			out = append(out, content[i:tag.End]...)
			i = tag.End
		}
	}

	return string(out)
}

func containsDetailsOrSummaryTag(s string) bool {
	return strings.Contains(s, "<details") ||
		strings.Contains(s, "</details") ||
		strings.Contains(s, "<summary") ||
		strings.Contains(s, "</summary")
}

func skipHorizSpace(s string, i, limit int) int {
	for i < limit && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return i
}

func isExactTagStartAt(s string, i, limit int, rawName string, closing bool) bool {
	tag, ok := ScanProseTag(s, i, limit)
	return ok && tag.RawName == rawName && tag.Closing == closing && !tag.SelfClose
}

func ensureNewlineBeforeOpenTag(out []byte, sep string) []byte {
	lastNL := bytes.LastIndexByte(out, '\n')
	lineStart := lastNL + 1
	hasContentOnLine := false
	for k := lineStart; k < len(out); k++ {
		if out[k] != ' ' && out[k] != '\t' && out[k] != '\r' {
			hasContentOnLine = true
			break
		}
	}
	if !hasContentOnLine {
		return out
	}
	n := len(out)
	for n > lineStart && (out[n-1] == ' ' || out[n-1] == '\t') {
		n--
	}
	return append(out[:n], sep...)
}

func ensureBlankLineBeforeClosingTag(out []byte) []byte {
	lastNonWS := len(out) - 1
	for lastNonWS >= 0 {
		c := out[lastNonWS]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			break
		}
		lastNonWS--
	}
	if lastNonWS < 0 {
		return out
	}

	tail := out[lastNonWS+1:]
	nlCount := bytes.Count(tail, []byte{'\n'})
	if nlCount >= 2 {
		return out
	}

	var indent []byte
	if nlCount == 1 {
		lastNL := bytes.LastIndexByte(tail, '\n')
		if lastNL >= 0 && lastNL+1 < len(tail) {
			indent = append([]byte(nil), tail[lastNL+1:]...)
		}
	}
	out = append(out[:lastNonWS+1], '\n', '\n')
	return append(out, indent...)
}

func ensureBlankLineAfterTag(out []byte, content string, tagEnd int) ([]byte, int) {
	n := len(content)
	j := skipHorizSpace(content, tagEnd, n)
	afterHoriz := j

	nlCount := 0
	firstNLEnd := -1
	for j < n {
		c := content[j]
		if c == ' ' || c == '\t' {
			j++
			continue
		}
		if c == '\r' {
			nlCount++
			if j+1 < n && content[j+1] == '\n' {
				if firstNLEnd < 0 {
					firstNLEnd = j + 2
				}
				j += 2
			} else {
				if firstNLEnd < 0 {
					firstNLEnd = j + 1
				}
				j++
			}
			continue
		}
		if c == '\n' {
			nlCount++
			if firstNLEnd < 0 {
				firstNLEnd = j + 1
			}
			j++
			continue
		}
		break
	}
	if j >= n || nlCount >= 2 {
		return out, tagEnd
	}
	out = append(out, '\n', '\n')
	if nlCount == 1 {
		return out, firstNLEnd
	}
	return out, afterHoriz
}

func countDenseParagraphs(prose string) int {
	dense := 0
	normalized := strings.ReplaceAll(prose, "\r\n", "\n")
	for _, para := range strings.Split(normalized, "\n\n") {
		var proseLines []string
		for _, line := range strings.Split(para, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || isNonDenseBlockLine(trimmed) {
				continue
			}
			proseLines = append(proseLines, line)
		}
		if len(proseLines) == 0 {
			continue
		}
		if countInlineTokensAndCapsules(strings.Join(proseLines, "\n")) >= denseParagraphInlineCodeFloor {
			dense++
		}
	}
	return dense
}

func isNonDenseBlockLine(trimmed string) bool {
	if strings.HasPrefix(trimmed, ">") || strings.HasPrefix(trimmed, "|") {
		return true
	}
	if trimmed[0] == '#' {
		h := 0
		for h < len(trimmed) && trimmed[h] == '#' {
			h++
		}
		if h <= 6 && (h == len(trimmed) || trimmed[h] == ' ' || trimmed[h] == '\t') {
			return true
		}
	}
	if trimmed == "-" || trimmed == "*" || trimmed == "+" ||
		strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "+ ") ||
		strings.HasPrefix(trimmed, "-\t") || strings.HasPrefix(trimmed, "*\t") || strings.HasPrefix(trimmed, "+\t") {
		return true
	}
	d := 0
	for d < len(trimmed) && trimmed[d] >= '0' && trimmed[d] <= '9' {
		d++
	}
	if d > 0 && d+1 < len(trimmed) && (trimmed[d] == '.' || trimmed[d] == ')') && (trimmed[d+1] == ' ' || trimmed[d+1] == '\t') {
		return true
	}
	if tag, ok := ScanProseTag(trimmed, 0, len(trimmed)); ok && tag.End == len(trimmed) &&
		(tag.RawName == "details" || tag.RawName == "summary") {
		return true
	}
	return false
}

func countInlineTokensAndCapsules(s string) int {
	count := 0
	n := len(s)
	for i := 0; i < n; {
		if s[i] == '`' && !isEscapedAt(s, i) {
			end, closed := ScanInlineCodeSpanEnd(s, i, n)
			if closed {
				count++
			}
			i = end
			continue
		}
		if strings.HasPrefix(s[i:], "](code:") {
			count++
			i += len("](code:")
			continue
		}
		i++
	}
	return count
}

func isLayerASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func isLayerDigit(b byte) bool { return b >= '0' && b <= '9' }

func isLayerNameByte(b byte) bool {
	return isLayerASCIILetter(b) || isLayerDigit(b) || b == '-' || b == ':' || b == '_' || b == '.'
}

func isLayerSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\f'
}

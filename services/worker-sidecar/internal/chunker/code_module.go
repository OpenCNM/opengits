package chunker

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const DefaultMaxChunkChars = 4000
const defaultMaxChunkChars = DefaultMaxChunkChars

var (
	headingHashPrefixRe  = regexp.MustCompile(`^#+\s*`)
	chunkerHtmlCommentRe = regexp.MustCompile(`(?s)<!--.*?-->`)
	markdownImageRe      = regexp.MustCompile(`!\[.*?\]\(.*?\)`)
	htmlJsxTagRe         = regexp.MustCompile(`(?i)</?(?:code|span|a|b|i|strong|em|badge|Badge|kbd|sub|sup)(?:\s+[^>]*?)?/?>|<\w+(?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)+\s*/?>`)
	customAnchorRe       = regexp.MustCompile(`\{#.*?\}`)
	trailingHashRe       = regexp.MustCompile(`\s*#+\s*$`)
	markdownLinkRe       = regexp.MustCompile(`\[(.*?)\]\(.*?\)`)
	multipleSpaceRe      = regexp.MustCompile(`\s+`)

	mermaidDetectRe  = regexp.MustCompile(`(?i)(?:` + "```" + `|~~~)\s*mermaid`)
	typeDefKeywordRe = regexp.MustCompile(`\b(?:interface|type|struct|enum|class)\b`)
	h2LineDetectRe   = regexp.MustCompile(`^##\s+(.+)$`)

	fenceRe = mdpat.FenceOpenRe

	entryPointPrefixList = []string{"index.", "main.", "app.", "server.", "route.", "page."}
)

func CleanMarkdownHeading(raw string) string {
	if raw == "" {
		return ""
	}
	s := strings.TrimSpace(raw)
	s = headingHashPrefixRe.ReplaceAllString(s, "")
	s = chunkerHtmlCommentRe.ReplaceAllString(s, "")
	s = markdownImageRe.ReplaceAllString(s, "")
	s = htmlJsxTagRe.ReplaceAllString(s, "")
	s = customAnchorRe.ReplaceAllString(s, "")
	s = trailingHashRe.ReplaceAllString(s, "")
	s = markdownLinkRe.ReplaceAllString(s, "$1")
	s = multipleSpaceRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

func determineContentType(content string, sourceFile string) string {
	if mermaidDetectRe.MatchString(content) {
		return "architecture_diagram"
	}
	if sourceFile != "" {
		for _, prefix := range entryPointPrefixList {
			if strings.Contains(sourceFile, prefix) {
				return "entry_point"
			}
		}
	}
	if typeDefKeywordRe.MatchString(content) {
		return "type_definition"
	}
	return "function_impl"
}

// Keep <details data-layer="deep"> atomic when splitting chunks, re-wrapping sub-splits if oversized.
func splitLargeChunk(content string, maxChars int) []string {
	if maxChars <= 0 {
		maxChars = defaultMaxChunkChars
	}
	if len(content) <= maxChars {
		return []string{content}
	}

	if deepSpans := findDeepDiveBlockSpans(content); len(deepSpans) > 0 {
		return splitWithAtomicDeepDive(content, deepSpans, maxChars)
	}
	return splitPlainChunk(content, maxChars)
}

type chunkUnit struct {
	text       string
	sepBefore  string
	isDeepDive bool
}

func splitWithAtomicDeepDive(content string, deepSpans [][2]int, maxChars int) []string {
	units := buildChunkUnits(content, deepSpans)
	var result []string
	current := ""

	appendSplit := func(u chunkUnit) {
		var subChunks []string
		if u.isDeepDive {
			subChunks = splitOversizedDeepDive(u.text, maxChars)
		} else {
			subChunks = splitPlainChunk(u.text, maxChars)
		}
		result = append(result, subChunks...)
	}

	for _, u := range units {
		if len(u.text) > maxChars {
			if current != "" {
				result = append(result, current)
				current = ""
			}
			appendSplit(u)
			continue
		}
		if current == "" {
			current = u.text
			continue
		}
		candidateLen := len(current) + len(u.sepBefore) + len(u.text)
		if candidateLen > maxChars {
			result = append(result, current)
			current = u.text
			continue
		}
		current += u.sepBefore + u.text
	}
	if current != "" {
		result = append(result, current)
	}
	return result
}

func buildChunkUnits(content string, deepSpans [][2]int) []chunkUnit {
	var units []chunkUnit
	pos := 0
	pendingSep := ""

	appendGapParagraphs := func(gap string, allowTrailingSep bool) {
		leadingSep := ""
		if len(units) > 0 {
			leadingSep = extractLeadingNewlines(gap)
			gap = strings.TrimLeft(gap, "\n")
			if pendingSep == "" {
				pendingSep = leadingSep
			}
		}
		trailingSep := ""
		if allowTrailingSep {
			trailingSep = extractTrailingNewlines(gap)
			gap = strings.TrimRight(gap, "\n")
		}
		if gap != "" {
			for i, para := range strings.Split(gap, "\n\n") {
				if para == "" {
					continue
				}
				sep := "\n\n"
				if i == 0 {
					sep = pendingSep
				}
				if len(units) == 0 {
					sep = ""
				}
				units = append(units, chunkUnit{text: para, sepBefore: sep})
				pendingSep = ""
			}
		}
		if allowTrailingSep {
			if gap == "" && pendingSep != "" && trailingSep != "" {
				if len(pendingSep) < len(trailingSep) {
					pendingSep = trailingSep
				}
			} else if trailingSep != "" {
				pendingSep = trailingSep
			}
		}
	}

	for _, span := range deepSpans {
		appendGapParagraphs(content[pos:span[0]], true)
		sep := pendingSep
		if len(units) == 0 {
			sep = ""
		}
		units = append(units, chunkUnit{
			text:       content[span[0]:span[1]],
			sepBefore:  sep,
			isDeepDive: true,
		})
		pendingSep = ""
		pos = span[1]
	}
	appendGapParagraphs(content[pos:], false)
	return units
}

func extractLeadingNewlines(s string) string {
	i := 0
	for i < len(s) && s[i] == '\n' {
		i++
	}
	return s[:i]
}

func extractTrailingNewlines(s string) string {
	i := len(s)
	for i > 0 && s[i-1] == '\n' {
		i--
	}
	return s[i:]
}

func findDeepDiveBlockSpans(content string) [][2]int {
	regions := armor.SplitLayerRegions(content)
	var spans [][2]int
	cursor := 0
	inDeep := false
	deepStart := -1
	deepEnd := -1

	for _, reg := range regions {
		if reg.Text == "" {
			continue
		}
		rel := strings.Index(content[cursor:], reg.Text)
		if rel < 0 {
			continue
		}
		regStart := cursor + rel
		regEnd := regStart + len(reg.Text)
		cursor = regEnd

		if reg.IsDeepDive {
			if !inDeep {
				inDeep = true
				deepStart = regStart
			}
			deepEnd = regEnd
			continue
		}
		if inDeep {
			if closeEnd := closingDetailsTagEnd(reg.Text); closeEnd > 0 {
				deepEnd = regStart + closeEnd
			}
			spans = append(spans, [2]int{deepStart, deepEnd})
			inDeep = false
			deepStart = -1
			deepEnd = -1
		}
	}
	if inDeep && deepStart >= 0 {
		spans = append(spans, [2]int{deepStart, len(content)})
	}
	return spans
}

func closingDetailsTagEnd(s string) int {
	tag, ok := armor.ScanProseTag(s, 0, len(s))
	if ok && tag.RawName == "details" && tag.Closing {
		return tag.End
	}
	return 0
}

func splitOversizedDeepDive(block string, maxChars int) []string {
	openTagObj, ok := armor.ScanProseTag(block, 0, len(block))
	if !ok || openTagObj.RawName != "details" || openTagObj.Closing || openTagObj.SelfClose {
		return splitPlainChunk(block, maxChars)
	}
	openTag := block[:openTagObj.End]
	rest := block[openTagObj.End:]

	closeTag := "</details>"
	if closeStart := findTrailingClosingDetailsStart(rest); closeStart >= 0 {
		if closeObj, cOk := armor.ScanProseTag(rest, closeStart, len(rest)); cOk &&
			closeObj.RawName == "details" && closeObj.Closing &&
			strings.TrimSpace(rest[closeObj.End:]) == "" {
			closeTag = rest[closeStart:closeObj.End]
			rest = rest[:closeStart]
		}
	}

	summaryLine := ""
	trimmedRest := strings.TrimLeft(rest, " \t\r\n")
	if sumOpen, sOk := armor.ScanProseTag(trimmedRest, 0, len(trimmedRest)); sOk &&
		sumOpen.RawName == "summary" && !sumOpen.Closing && !sumOpen.SelfClose {
		if sumCloseIdx := findFirstClosingSummary(trimmedRest, sumOpen.End); sumCloseIdx >= 0 {
			if sumClose, scOk := armor.ScanProseTag(trimmedRest, sumCloseIdx, len(trimmedRest)); scOk &&
				sumClose.RawName == "summary" && sumClose.Closing {
				summaryLine = trimmedRest[:sumClose.End]
				rest = trimmedRest[sumClose.End:]
			}
		}
	}

	inner := strings.Trim(rest, "\r\n")
	prefix := openTag + "\n\n"
	if summaryLine != "" {
		prefix = openTag + "\n" + summaryLine + "\n\n"
	}
	suffix := "\n\n" + closeTag

	innerMax := maxChars - len(prefix) - len(suffix)
	if innerMax < 32 {
		return splitPlainChunk(block, maxChars)
	}
	if strings.TrimSpace(inner) == "" {
		return splitPlainChunk(block, maxChars)
	}

	subParts := splitPlainChunk(inner, innerMax)
	out := make([]string, 0, len(subParts))
	for _, sub := range subParts {
		cleaned := strings.Trim(sub, "\r\n")
		if cleaned == "" {
			continue
		}
		out = append(out, prefix+cleaned+suffix)
	}
	if len(out) == 0 {
		return []string{prefix + strings.TrimSpace(inner) + suffix}
	}
	return out
}

func findTrailingClosingDetailsStart(s string) int {
	trimmed := strings.TrimRight(s, " \t\r\n")
	for i := len(trimmed) - 1; i >= 0; i-- {
		if trimmed[i] == '<' {
			return i
		}
	}
	return -1
}

func findFirstClosingSummary(s string, from int) int {
	n := len(s)
	for i := from; i < n; {
		if s[i] == '`' {
			end, _ := armor.ScanInlineCodeSpanEnd(s, i, n)
			i = end
			continue
		}
		if s[i] != '<' {
			i++
			continue
		}
		if end, handled := armor.ScanHTMLCommentEnd(s, i, n); handled {
			i = end
			continue
		}
		tag, ok := armor.ScanProseTag(s, i, n)
		if !ok {
			i++
			continue
		}
		if tag.RawName == "summary" && tag.Closing {
			return i
		}
		i = tag.End
	}
	return -1
}

func splitPlainChunk(content string, maxChars int) []string {
	if maxChars <= 0 {
		maxChars = defaultMaxChunkChars
	}
	if len(content) <= maxChars {
		return []string{content}
	}

	paragraphs := strings.Split(content, "\n\n")
	if len(paragraphs) > 1 {
		var result []string
		current := ""
		for i, para := range paragraphs {
			withSep := para
			if i > 0 {
				withSep = "\n\n" + para
			}
			if len(para) > maxChars {
				if current != "" {
					result = append(result, current)
					current = ""
				}
				subChunks := splitPlainChunk(para, maxChars)
				for j, sub := range subChunks {
					subWithSep := sub
					if j == 0 && i > 0 {
						subWithSep = "\n\n" + sub
					}
					result = append(result, subWithSep)
				}
			} else if len(current+withSep) > maxChars && len(current) > 0 {
				result = append(result, current)
				current = para
			} else {
				if current != "" {
					current += withSep
				} else {
					current = para
				}
			}
		}
		if current != "" {
			result = append(result, current)
		}
		return result
	}

	lines := strings.Split(content, "\n")
	if len(lines) > 1 {
		var result []string
		current := ""
		for i, line := range lines {
			withSep := line
			if i > 0 {
				withSep = "\n" + line
			}
			if len(line) > maxChars {
				if current != "" {
					result = append(result, current)
					current = ""
				}
				subChunks := splitPlainChunk(line, maxChars)
				for j, sub := range subChunks {
					subWithSep := sub
					if j == 0 && i > 0 {
						subWithSep = "\n" + sub
					}
					result = append(result, subWithSep)
				}
			} else if len(current+withSep) > maxChars && len(current) > 0 {
				result = append(result, current)
				current = line
			} else {
				if current != "" {
					current += withSep
				} else {
					current = line
				}
			}
		}
		if current != "" {
			result = append(result, current)
		}
		return result
	}

	var result []string
	for i := 0; i < len(content); i += maxChars {
		end := i + maxChars
		if end > len(content) {
			end = len(content)
		}
		result = append(result, content[i:end])
	}
	return result
}

type L2HeadingNode struct {
	Title string
	Start int
}

func extractL2Headings(mdx string) []L2HeadingNode {
	regions := armor.SplitLayerRegions(mdx)
	var headings []L2HeadingNode
	cursor := 0

	for _, reg := range regions {
		if reg.Text == "" {
			continue
		}
		rel := strings.Index(mdx[cursor:], reg.Text)
		if rel < 0 {
			continue
		}
		regStart := cursor + rel
		cursor = regStart + len(reg.Text)
		if reg.IsFence || reg.IsDeepDive {
			continue
		}

		lineOffset := 0
		for _, line := range strings.Split(reg.Text, "\n") {
			absOffset := regStart + lineOffset
			isTrueLineStart := absOffset == 0 || mdx[absOffset-1] == '\n'
			if isTrueLineStart {
				if m := h2LineDetectRe.FindStringSubmatch(line); m != nil {
					clean := CleanMarkdownHeading(m[1])
					if clean != "" {
						headings = append(headings, L2HeadingNode{
							Title: clean,
							Start: absOffset,
						})
					}
				}
			}
			lineOffset += len(line) + 1
		}
	}
	return headings
}

func matchChunkSourceFile(content string, sourceFiles []string) string {
	for _, file := range sourceFiles {
		if file != "" && strings.Contains(content, file) {
			return file
		}
	}
	return ""
}

func ChunkCodeModule(req CodeModuleChunkRequest) []CodeChunk {
	mdx := strings.ReplaceAll(req.MdxContent, "\r\n", "\n")
	sourceFiles := req.SourceFiles
	firstFile := ""
	if len(sourceFiles) > 0 {
		firstFile = sourceFiles[0]
	}
	fallbackFile := firstFile
	if fallbackFile == "" {
		fallbackFile = "module"
	}

	maxChars := req.MaxChars
	if maxChars <= 0 {
		maxChars = defaultMaxChunkChars
	}
	overviewLabel := req.OverviewLabel
	if overviewLabel == "" {
		overviewLabel = "概述"
	}

	headings := extractL2Headings(mdx)
	var chunks []CodeChunk

	firstHeadingStart := len(mdx)
	if len(headings) > 0 {
		firstHeadingStart = headings[0].Start
	}
	if firstHeadingStart > len(mdx) {
		firstHeadingStart = len(mdx)
	}
	overviewContent := strings.TrimSpace(mdx[:firstHeadingStart])

	if overviewContent != "" {
		subParts := splitLargeChunk(overviewContent, maxChars)
		for subIdx, part := range subParts {
			suffix := ""
			if len(subParts) > 1 {
				suffix = fmt.Sprintf(" (Part %d)", subIdx+1)
			}
			chunks = append(chunks, CodeChunk{
				Heading:     fmt.Sprintf("%s > %s%s", req.ModuleName, overviewLabel, suffix),
				HeadingPath: fmt.Sprintf("%s > %s > overview%s", req.ModuleName, fallbackFile, suffix),
				Content:     part,
				ContentType: determineContentType(part, ""),
			})
		}
	}

	for i := 0; i < len(headings); i++ {
		sec := headings[i]
		nextStart := len(mdx)
		if i+1 < len(headings) {
			nextStart = headings[i+1].Start
		}
		if nextStart > len(mdx) {
			nextStart = len(mdx)
		}
		if sec.Start > len(mdx) {
			continue
		}
		secContent := strings.TrimSpace(mdx[sec.Start:nextStart])
		sourceFile := matchChunkSourceFile(secContent, sourceFiles)
		if sourceFile == "" {
			sourceFile = firstFile
		}
		displayFile := sourceFile
		if displayFile == "" {
			displayFile = "module"
		}

		subParts := splitLargeChunk(secContent, maxChars)
		for subIdx, part := range subParts {
			suffix := ""
			if len(subParts) > 1 {
				suffix = fmt.Sprintf(" (Part %d)", subIdx+1)
			}
			chunks = append(chunks, CodeChunk{
				Heading:     fmt.Sprintf("%s > %s%s", req.ModuleName, sec.Title, suffix),
				HeadingPath: fmt.Sprintf("%s > %s > %s%s", req.ModuleName, displayFile, sec.Title, suffix),
				Content:     part,
				ContentType: determineContentType(part, sourceFile),
				SourceFile:  sourceFile,
			})
		}
	}

	if len(chunks) == 0 {
		return []CodeChunk{
			{
				Heading:     req.ModuleName,
				HeadingPath: fmt.Sprintf("%s > %s > %s", req.ModuleName, fallbackFile, req.ModuleName),
				Content:     mdx,
				ContentType: "module_overview",
			},
		}
	}

	return chunks
}

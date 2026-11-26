package armor

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func replaceAllSubmatch(re *regexp.Regexp, input string, fn func(groups []string) string) string {
	var b strings.Builder
	last := 0
	for _, loc := range re.FindAllStringSubmatchIndex(input, -1) {
		b.WriteString(input[last:loc[0]])
		groups := make([]string, len(loc)/2)
		for i := range groups {
			if loc[i*2] >= 0 {
				groups[i] = input[loc[i*2]:loc[i*2+1]]
			} else {
				groups[i] = ""
			}
		}
		b.WriteString(fn(groups))
		last = loc[1]
	}
	b.WriteString(input[last:])
	return b.String()
}

func jsTruthyString(s string) bool { return s != "" }

var armorFenceHandleRe = regexp.MustCompile("(?im)^((?:`{3,}|~{3,})[a-zA-Z0-9_-]*)[ \t]+(?:(?://|#|--)[ \t]*)?(?:\\[[ \t]*(?:File[ \t]+)?|File[ \t]+)(\\d+)(?:#(?:L?(\\d+)(?:-L?(\\d+))?|([a-zA-Z0-9_$]+)))?(?::[a-zA-Z0-9_$]+)?\\]?[ \t]*$")

var armorInlineHandleRe = regexp.MustCompile("(?i)`?\\[File[ \t]+(\\d+)(?:#(?:L?(\\d+)(?:-L?(\\d+))?|([a-zA-Z0-9_$]+)))?(?::[a-zA-Z0-9_$]+)?\\]`?")

func armorHandleSuffix(lStart, lEnd, symbol string) string {
	switch {
	case jsTruthyString(lStart) && jsTruthyString(lEnd):
		return fmt.Sprintf(" (L%s-L%s)", lStart, lEnd)
	case jsTruthyString(lStart):
		return fmt.Sprintf(" (L%s)", lStart)
	case jsTruthyString(symbol):
		return "#" + symbol
	default:
		return ""
	}
}

// Fence headers keep physical path/symbol spans for grounding regexes; prose handles upgrade to deduped code: links.
func ResolveFileHandles(mdxContent string, files []ArmorFileRef) string {
	if mdxContent == "" || len(files) == 0 {
		return mdxContent
	}

	resolved := replaceAllSubmatch(armorFenceHandleRe, mdxContent, func(g []string) string {
		match, fence, fileIndexStr, lStart, lEnd, symbol := g[0], g[1], g[2], g[3], g[4], g[5]
		idx, err := strconv.Atoi(fileIndexStr)
		if err != nil || idx < 1 || idx > len(files) {
			return match
		}
		return fence + " // " + files[idx-1].Path + armorHandleSuffix(lStart, lEnd, symbol)
	})

	return resolveInlineHandles(resolved, files)
}

var armorPathLinkableRe = regexp.MustCompile(`^[A-Za-z0-9._\-/]+$`)

func armorBasename(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

func armorDisplayNames(files []ArmorFileRef) map[string]string {
	basenameCount := make(map[string]int, len(files))
	for _, f := range files {
		basenameCount[armorBasename(f.Path)]++
	}
	names := make(map[string]string, len(files))
	for _, f := range files {
		b := armorBasename(f.Path)
		if basenameCount[b] <= 1 {
			names[f.Path] = b
			continue
		}
		i := strings.LastIndex(f.Path, "/")
		j := -1
		if i >= 0 {
			j = strings.LastIndex(f.Path[:i], "/")
		}
		if j >= 0 {
			names[f.Path] = f.Path[j+1:]
		} else {
			names[f.Path] = f.Path
		}
	}
	return names
}

// Prose symbol anchors use disambiguated display names for readability; fenced spans keep full paths for grounding.
func armorInlineToken(path, lStart, lEnd, symbol string, display map[string]string) (token, legacySpan string) {
	legacySpan = "`" + path + armorHandleSuffix(lStart, lEnd, symbol) + "`"
	d, hasDisplay := display[path]
	if symbol != "" {
		if hasDisplay && d != "" {
			return "`" + d + "#" + symbol + "`", legacySpan
		}
		return legacySpan, legacySpan
	}
	if !armorPathLinkableRe.MatchString(path) {
		return legacySpan, legacySpan
	}
	href := "code:" + path
	if jsTruthyString(lStart) {
		href += ":L" + lStart
		if jsTruthyString(lEnd) {
			href += "-L" + lEnd
		}
	}
	if hasDisplay {
		return "[" + d + "](" + href + ")", legacySpan
	}
	return legacySpan, legacySpan
}

func armorWordBoundaryBefore(s string, i int) bool {
	if i <= 0 {
		return true
	}
	c := s[i-1]
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '_', c == '-':
		return false
	}
	return true
}

func armorRtrimBytes(out []byte) []byte {
	n := len(out)
	for n > 0 {
		c := out[n-1]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			break
		}
		n--
	}
	return out[:n]
}

func armorIsAllWS(s string) bool {
	return strings.TrimLeft(s, " \t\n\r") == ""
}

func hasParagraphBreak(s string) bool {
	normalized := strings.ReplaceAll(s, "\r\n", "\n")
	for i := 0; i < len(normalized); i++ {
		if normalized[i] != '\n' {
			continue
		}
		j := i + 1
		for j < len(normalized) && (normalized[j] == ' ' || normalized[j] == '\t') {
			j++
		}
		if j < len(normalized) && normalized[j] == '\n' {
			return true
		}
	}
	return false
}

// Collapses repeated adjacent file handles in prose and suppresses duplicate bare links within a paragraph.
func armorEmitDedup(out []byte, between, token, legacySpan, path, displayName string, isBare bool, seenBareInPara map[string]bool) []byte {
	alreadySeenBare := isBare && seenBareInPara[path] && displayName != ""
	emittedBare := token
	if alreadySeenBare {
		emittedBare = displayName
	}

	if armorIsAllWS(between) {
		rtrim := armorRtrimBytes(out)
		if bytes.HasSuffix(rtrim, []byte(token)) ||
			bytes.HasSuffix(rtrim, []byte(legacySpan)) ||
			(alreadySeenBare && bytes.HasSuffix(rtrim, []byte(displayName))) {
			return out
		}
		if isBare {
			seenBareInPara[path] = true
		}
		return append(append(out, between...), emittedBare...)
	}

	trimmed := strings.TrimRight(between, " \t\n\r")
	for _, span := range []string{"`" + path + "`", "`" + armorBasename(path) + "`"} {
		if strings.HasSuffix(trimmed, span) {
			if isBare {
				seenBareInPara[path] = true
			}
			return append(append(out, trimmed[:len(trimmed)-len(span)]...), token...)
		}
	}
	if b := armorBasename(path); b != "" && strings.HasSuffix(trimmed, b) &&
		armorWordBoundaryBefore(trimmed, len(trimmed)-len(b)) {
		if isBare {
			seenBareInPara[path] = true
		}
		return append(append(out, trimmed[:len(trimmed)-len(b)]...), emittedBare...)
	}
	if isBare {
		seenBareInPara[path] = true
	}
	return append(append(out, between...), emittedBare...)
}

func submatchGroups(input string, loc []int) []string {
	groups := make([]string, len(loc)/2)
	for i := range groups {
		if loc[i*2] >= 0 {
			groups[i] = input[loc[i*2]:loc[i*2+1]]
		} else {
			groups[i] = ""
		}
	}
	return groups
}

func resolveInlineHandles(resolved string, files []ArmorFileRef) string {
	display := armorDisplayNames(files)
	fences := findCodeFenceIndices(resolved)
	inFence := func(pos int) bool {
		for _, f := range fences {
			if pos >= f[0] && pos < f[1] {
				return true
			}
		}
		return false
	}
	crossedFence := func(start, end int) bool {
		for _, f := range fences {
			if f[0] >= start && f[1] <= end {
				return true
			}
		}
		return false
	}

	var out []byte
	last := 0
	seenBareInPara := make(map[string]bool)
	for _, loc := range armorInlineHandleRe.FindAllStringSubmatchIndex(resolved, -1) {
		between := resolved[last:loc[0]]
		g := submatchGroups(resolved, loc)
		match, fileIndexStr, lStart, lEnd, symbol := g[0], g[1], g[2], g[3], g[4]

		idx, err := strconv.Atoi(fileIndexStr)
		if err != nil || idx < 1 || idx > len(files) {
			if crossedFence(last, loc[0]) || hasParagraphBreak(between) {
				clear(seenBareInPara)
			}
			out = append(out, between...)
			out = append(out, match...)
			last = loc[1]
			continue
		}

		path := files[idx-1].Path
		token, legacySpan := armorInlineToken(path, lStart, lEnd, symbol, display)
		if inFence(loc[0]) {
			clear(seenBareInPara)
			out = append(out, between...)
			out = append(out, legacySpan...)
			last = loc[1]
			continue
		}
		if crossedFence(last, loc[0]) || hasParagraphBreak(between) {
			clear(seenBareInPara)
		}
		isBare := lStart == "" && lEnd == "" && symbol == "" && strings.HasPrefix(token, "[")
		out = armorEmitDedup(out, between, token, legacySpan, path, display[path], isBare, seenBareInPara)
		last = loc[1]
	}
	out = append(out, resolved[last:]...)
	return string(out)
}

var armorClosedManifestRe = regexp.MustCompile(`(?i)<(?:concept_manifest|pedagogy_manifest)[^>]*>[\s\S]*?</(?:concept_manifest|pedagogy_manifest)>`)

var armorManifestTagRe = regexp.MustCompile(`(?i)<(?:concept_manifest|pedagogy_manifest)[^>]*>`)

// Hand-scanned lookahead equivalent (?=\n#{1,6}\s|$) for RE2; 7+ '#' chars never act as heading boundary.
func armorStripUnclosedManifests(input string) string {
	var b strings.Builder
	last := 0
	for _, loc := range armorManifestTagRe.FindAllStringIndex(input, -1) {
		if loc[0] < last {
			continue
		}
		q := loc[1]
		for q <= len(input) && !armorManifestBoundary(input, q) {
			q++
		}
		if q > len(input) {
			continue
		}
		b.WriteString(input[last:loc[0]])
		last = q
	}
	b.WriteString(input[last:])
	return b.String()
}

func armorManifestBoundary(input string, q int) bool {
	if q == len(input) {
		return true
	}
	if input[q] != '\n' {
		return false
	}
	i := q + 1
	hashes := 0
	for i < len(input) && input[i] == '#' && hashes < 6 {
		i++
		hashes++
	}
	if hashes < 1 {
		return false
	}
	if i >= len(input) {
		return false
	}
	c := input[i]
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}

var armorFenceRe = regexp.MustCompile("```[\\s\\S]*?```")

func FindCodeFenceIndices(input string) [][2]int {
	return findCodeFenceIndices(input)
}

// Matches opening fence char and >= length per CommonMark so nested shorter fences never close outer blocks.
func findCodeFenceIndices(input string) [][2]int {
	var indices [][2]int
	n := len(input)
	if n < 3 {
		return indices
	}

	pos := 0
	for pos < n {
		lineStart := pos
		lineEnd := strings.IndexByte(input[pos:], '\n')
		if lineEnd < 0 {
			lineEnd = n
		} else {
			lineEnd = pos + lineEnd
		}
		line := input[lineStart:lineEnd]

		idx := 0
		matched := false
		for idx < len(line) {
			ch := line[idx]
			if ch == '`' || ch == '~' {
				count := 0
				cIdx := idx
				for cIdx < len(line) && line[cIdx] == ch {
					count++
					cIdx++
				}
				if count >= 3 {
					fenceStart := lineStart + idx
					fenceChar := ch
					fenceCount := count

					sameLineRest := line[cIdx:]
					sameClosePattern := strings.Repeat(string(fenceChar), fenceCount)
					sameLineClose := strings.Index(sameLineRest, sameClosePattern)
					if sameLineClose >= 0 {
						fenceEnd := lineStart + cIdx + sameLineClose + fenceCount
						indices = append(indices, [2]int{fenceStart, fenceEnd})
						pos = fenceEnd
						idx = cIdx + sameLineClose + fenceCount
						matched = true
						continue
					}

					blockEnd := -1
					nextPos := lineEnd
					if nextPos < n && input[nextPos] == '\n' {
						nextPos++
					}

					for nextPos < n {
						curLineStart := nextPos
						curLineEnd := strings.IndexByte(input[nextPos:], '\n')
						if curLineEnd < 0 {
							curLineEnd = n
						} else {
							curLineEnd = nextPos + curLineEnd
						}
						curLine := input[curLineStart:curLineEnd]

						curIndent := 0
						for curIndent < len(curLine) && curIndent < 4 && curLine[curIndent] == ' ' {
							curIndent++
						}

						if curIndent < 4 && curIndent < len(curLine) && curLine[curIndent] == fenceChar {
							curCount := 0
							k := curIndent
							for k < len(curLine) && curLine[k] == fenceChar {
								curCount++
								k++
							}
							if curCount >= fenceCount {
								rem := strings.TrimSpace(curLine[k:])
								if rem == "" {
									blockEnd = curLineStart + curIndent + curCount
									pos = curLineEnd
									if pos < n && input[pos] == '\n' {
										pos++
									}
									break
								}
							}
						}

						nextPos = curLineEnd
						if nextPos < n && input[nextPos] == '\n' {
							nextPos++
						}
					}

					if blockEnd == -1 {
						blockEnd = n
						pos = n
					}

					indices = append(indices, [2]int{fenceStart, blockEnd})
					matched = true
					break
				}
			}
			idx++
		}

		if !matched {
			pos = lineEnd
			if pos < n && input[pos] == '\n' {
				pos++
			}
		}
	}

	return indices
}

func armorSplitByFence(input string) []string {
	var parts []string
	last := 0
	for _, loc := range findCodeFenceIndices(input) {
		parts = append(parts, input[last:loc[0]], input[loc[0]:loc[1]])
		last = loc[1]
	}
	return append(parts, input[last:])
}

var armorLtEscapeRe = regexp.MustCompile(`<([ \t=]|[0-9])`)

var armorGenericRe = regexp.MustCompile(`<([A-Z][a-zA-Z0-9_]*<[^>]+>|[A-Z]|(?:string|number|boolean|any|unknown|void|T|K|V)(?:,\s*(?:string|number|boolean|any|unknown|void|T|K|V|\w+))*)>`)

var armorJsxLikeRe = regexp.MustCompile(`^<[A-Z][a-zA-Z0-9]*>$`)
var armorKnownTypeParamRe = regexp.MustCompile(`^<(?:T|K|V|P|R|E|Props|State|Context)>$`)

// Rewritten from JS lookbehind /(?<!\/)>/ via callback check for RE2 compatibility.
var armorVoidTagRe = regexp.MustCompile(`(?i)<(br|hr|img)([^>]*?)>`)

func SanitizeMdxForCompilation(mdxContent string) string {
	if mdxContent == "" {
		return ""
	}

	stripped := armorClosedManifestRe.ReplaceAllString(mdxContent, "")
	stripped = armorStripUnclosedManifests(stripped)

	parts := armorSplitByFence(stripped)
	for i := 0; i < len(parts); i += 2 {
		prose := parts[i]
		if prose == "" {
			continue
		}

		prose = armorLtEscapeRe.ReplaceAllString(prose, "&lt;$1")

		prose = replaceAllSubmatch(armorGenericRe, prose, func(g []string) string {
			m := g[0]
			if armorJsxLikeRe.MatchString(m) && !armorKnownTypeParamRe.MatchString(m) {
				return m
			}
			return strings.ReplaceAll(strings.ReplaceAll(m, "<", "&lt;"), ">", "&gt;")
		})

		prose = replaceAllSubmatch(armorVoidTagRe, prose, func(g []string) string {
			if strings.HasSuffix(g[2], "/") {
				return g[0]
			}
			return "<" + g[1] + g[2] + " />"
		})

		parts[i] = prose
	}

	return strings.Join(parts, "")
}

func PruneTerminalCliffhanger(content string) string {
	if strings.TrimSpace(content) == "" {
		return content
	}

	parts := armorSplitByFence(content)
	for i := len(parts) - 1; i >= 0; i-- {
		if i%2 == 1 {
			continue
		}
		prose := parts[i]
		if strings.TrimSpace(prose) == "" {
			continue
		}

		if mdpat.TerminalCliffhangerRe.MatchString(prose) {
			cleaned := mdpat.TerminalCliffhangerRe.ReplaceAllStringFunc(prose, func(match string) string {
				r, _ := utf8.DecodeRuneInString(match)
				if r == '.' || r == '。' || r == '！' || r == '!' || r == '？' || r == '?' || r == '\n' {
					return string(r)
				}
				return ""
			})
			parts[i] = strings.TrimRight(cleaned, " \t\r\n") + "\n"
			break
		}
		break
	}

	return strings.Join(parts, "")
}

const armorBaseAllotmentPerFile = 800
const armorDefaultBudgetChars = 40000

func AllocateBalancedSourceSnippets(files []ArmorSourceFile, totalBudgetChars int) []ArmorAllocatedSnippet {
	if totalBudgetChars <= 0 {
		totalBudgetChars = armorDefaultBudgetChars
	}
	if len(files) == 0 {
		return []ArmorAllocatedSnippet{}
	}

	if len(files) == 1 {
		f := files[0]
		return []ArmorAllocatedSnippet{{
			Path:       f.Path,
			TotalLines: f.TotalLines,
			Snippet:    jsSliceTo(f.RawContent, totalBudgetChars),
		}}
	}

	reservedBaseTotal := len(files) * armorBaseAllotmentPerFile
	result := make([]ArmorAllocatedSnippet, 0, len(files))

	if reservedBaseTotal >= totalBudgetChars {
		evenShare := totalBudgetChars / len(files)
		for _, f := range files {
			result = append(result, ArmorAllocatedSnippet{
				Path:       f.Path,
				TotalLines: f.TotalLines,
				Snippet:    jsSliceTo(f.RawContent, evenShare),
			})
		}
		return result
	}

	remainingBudget := totalBudgetChars - reservedBaseTotal
	totalRemainingChars := 0
	for _, f := range files {
		over := len(f.RawContent) - armorBaseAllotmentPerFile
		if over > 0 {
			totalRemainingChars += over
		}
	}

	for _, f := range files {
		rawLen := len(f.RawContent)
		baseShare := rawLen
		if armorBaseAllotmentPerFile < baseShare {
			baseShare = armorBaseAllotmentPerFile
		}
		extraCandidate := 0
		if rawLen-armorBaseAllotmentPerFile > 0 {
			extraCandidate = rawLen - armorBaseAllotmentPerFile
		}
		extraShare := 0
		if totalRemainingChars > 0 {
			extraShare = int(float64(extraCandidate) / float64(totalRemainingChars) * float64(remainingBudget))
		}

		result = append(result, ArmorAllocatedSnippet{
			Path:       f.Path,
			TotalLines: f.TotalLines,
			Snippet:    jsSliceTo(f.RawContent, baseShare+extraShare),
		})
	}

	return result
}

func jsSliceTo(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if n > len(s) {
		return s
	}
	return s[:n]
}

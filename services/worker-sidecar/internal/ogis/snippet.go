package ogis

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

var (
	ogisTrailingHashRe = regexp.MustCompile(`\s*#+\s*$`)
	ogisHTMLCommentRe  = regexp.MustCompile(`(?s)<!--.*?-->`)

	// Omit (?s) so unclosed fences never pair across lines and swallow body text.
	ogisInlineTickRe  = regexp.MustCompile("```.*?```|~~~.*?~~~")
	ogisInlineCodeRe  = regexp.MustCompile("`[^`\n]+`")
	ogisHTMLTagRe     = regexp.MustCompile(`<[^>]+>`)
	ogisImageRe       = regexp.MustCompile(`(?s)!\[.*?\]\(.*?\)`)
	ogisLinkRe        = regexp.MustCompile(`(?s)\[([^\]]+)\]\([^)]*\)`)
	ogisHeadingPreRe  = regexp.MustCompile("(?m)^[#\\s\\-*>`~]+")
	ogisBoldRe        = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	ogisItalicRe      = regexp.MustCompile(`\*([^*]+)\*`)
	ogisBoldUnderRe   = regexp.MustCompile(`__([^_]+)__`)
	ogisItalicUnderRe = regexp.MustCompile(`(?:^|\s)_([^_]+)_(?:\s|$)`)
	ogisPunctStripRe  = regexp.MustCompile("[|\\\\`~#]")
	ogisFenceOpenRe   = regexp.MustCompile(`^[ \t]{0,3}(` + "`{3,}" + `|~{3,})`)
	docExtRe          = regexp.MustCompile(`(?i)\.(mdx?|markdown|html)$`)
	docDashUnderRe    = regexp.MustCompile(`[-_]`)
	docH1HeadingRe    = regexp.MustCompile(`(?m)^[ \t]{0,3}#\s+(.+)$`)
)

func StripFrontmatter(text string) string {
	clean := strings.TrimLeftFunc(text, unicode.IsSpace)
	if !strings.HasPrefix(clean, "---") {
		return clean
	}
	endIdx := strings.Index(clean[3:], "\n---")
	if endIdx == -1 {
		return clean
	}
	after := clean[3+endIdx+4:]
	after = strings.TrimPrefix(after, "\n")
	return strings.TrimLeftFunc(after, unicode.IsSpace)
}

func stripFrontmatter(text string) string {
	return StripFrontmatter(text)
}

func StripFencedBlocks(text string) string {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := strings.Split(normalized, "\n")
	var out []string
	var fenceChar byte
	fenceLen := 0
	openAt := -1
	for i, line := range lines {
		trimmedLine := strings.TrimRight(line, "\r")
		if openAt >= 0 {
			body := strings.TrimLeft(trimmedLine, " \t")
			if len(body) >= fenceLen && body[0] == fenceChar && strings.Trim(body, string(fenceChar)+" \t") == "" {

				out = append(out[:openAt], " ")
				openAt = -1
				fenceChar = 0
				fenceLen = 0
				continue
			}
			out = append(out, lines[i])
			continue
		}
		if m := ogisFenceOpenRe.FindStringSubmatch(trimmedLine); len(m) == 2 {
			openAt = len(out)
			fenceChar = m[1][0]
			fenceLen = len(m[1])
			out = append(out, lines[i])
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func stripFencedBlocks(text string) string {
	return StripFencedBlocks(text)
}

func CleanMarkdownForSnippet(text string) string {
	if text == "" {
		return ""
	}
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	clean := stripFrontmatter(normalized)

	// Strip fenced blocks before HTML comments so "<!--" examples inside code fences stay intact.
	clean = stripFencedBlocks(clean)
	clean = ogisHTMLCommentRe.ReplaceAllString(clean, "")
	clean = ogisInlineTickRe.ReplaceAllString(clean, " ")
	clean = ogisInlineCodeRe.ReplaceAllString(clean, " ")
	clean = ogisHTMLTagRe.ReplaceAllString(clean, " ")
	clean = ogisImageRe.ReplaceAllString(clean, " ")
	clean = ogisLinkRe.ReplaceAllString(clean, "$1")
	clean = ogisHeadingPreRe.ReplaceAllString(clean, " ")
	clean = ogisBoldRe.ReplaceAllString(clean, "$1")
	clean = ogisItalicRe.ReplaceAllString(clean, "$1")
	clean = ogisBoldUnderRe.ReplaceAllString(clean, "$1")
	clean = ogisItalicUnderRe.ReplaceAllString(clean, " $1 ")
	clean = ogisPunctStripRe.ReplaceAllString(clean, " ")
	return strings.Join(strings.Fields(clean), " ")
}

func cleanMarkdownForSnippet(text string) string {
	return CleanMarkdownForSnippet(text)
}

func ExtractContextSnippet(text string, query string, maxLen int) string {
	if text == "" {
		return ""
	}
	cleanText := cleanMarkdownForSnippet(text)
	if cleanText == "" {
		return ""
	}

	runes := []rune(cleanText)
	q := strings.ToLower(strings.TrimSpace(query))
	qRunes := []rune(q)

	if len(qRunes) == 0 {
		end := maxLen
		if end > len(runes) {
			end = len(runes)
		}
		startSnippet := strings.TrimSpace(string(runes[:end]))
		if len([]rune(startSnippet)) < len(runes) {
			return startSnippet + "..."
		}
		return startSnippet
	}

	cleanLower := []rune(strings.ToLower(cleanText))
	matchIndex := -1
	if len(cleanLower) >= len(qRunes) {
		for i := 0; i <= len(cleanLower)-len(qRunes); i++ {
			match := true
			for j := 0; j < len(qRunes); j++ {
				if cleanLower[i+j] != qRunes[j] {
					match = false
					break
				}
			}
			if match {
				matchIndex = i
				break
			}
		}
	}

	if matchIndex == -1 {
		end := maxLen
		if end > len(runes) {
			end = len(runes)
		}
		startSnippet := strings.TrimSpace(string(runes[:end]))
		if len([]rune(startSnippet)) < len(runes) {
			return startSnippet + "..."
		}
		return startSnippet
	}

	leadChars := 28
	start := matchIndex - leadChars
	if start < 0 {
		start = 0
	}
	if start > 0 {
		prevSpace := -1
		for i := start; i >= 0; i-- {
			if runes[i] == ' ' {
				prevSpace = i
				break
			}
		}
		if prevSpace != -1 && start-prevSpace <= 10 {
			start = prevSpace + 1
		}
	}
	end := start + maxLen
	if end > len(runes) {
		end = len(runes)
	}

	snippet := strings.TrimSpace(string(runes[start:end]))
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(runes) {
		snippet = snippet + "..."
	}

	return snippet
}

func ResolveDocTitle(title, path, content string) string {
	t := strings.TrimSpace(title)
	if t != "" && strings.ToLower(t) != "untitled" {
		clean := chunker.CleanMarkdownHeading(t)
		if clean != "" {
			return clean
		}
		return t
	}
	if content != "" {
		normalized := strings.ReplaceAll(content, "\r\n", "\n")
		normalized = strings.ReplaceAll(normalized, "\r", "\n")
		nonCode := stripFrontmatter(normalized)
		nonCode = stripFencedBlocks(nonCode)
		nonCode = ogisInlineTickRe.ReplaceAllString(nonCode, "")
		if title := extractH1Title(nonCode); title != "" {
			return title
		}
	}
	if path != "" {
		cleanPath := strings.TrimRight(path, "/")
		parts := strings.Split(cleanPath, "/")
		basename := parts[len(parts)-1]
		if basename == "" {
			basename = path
		}
		cleanName := docExtRe.ReplaceAllString(basename, "")
		cleanName = docDashUnderRe.ReplaceAllString(cleanName, " ")
		if cleanName != "" {
			runes := []rune(cleanName)
			return string(unicode.ToUpper(runes[0])) + string(runes[1:])
		}
	}
	return "未命名文档"
}

func extractContextSnippetNoQuery(text string, maxLen int) string {
	return ExtractContextSnippet(text, "", maxLen)
}

func CleanSnippetForIndex(content string) string {
	return extractContextSnippetNoQuery(content, 160)
}

func cleanSnippetForIndex(content string) string {
	return CleanSnippetForIndex(content)
}

func extractH1Title(nonCode string) string {
	m := docH1HeadingRe.FindStringSubmatch(nonCode)
	if m == nil {
		return ""
	}
	cand := strings.TrimSpace(m[1])
	if cand == "" || strings.ToLower(cand) == "untitled" {
		return ""
	}
	rawTitle := ogisTrailingHashRe.ReplaceAllString(cand, "")
	return chunker.CleanMarkdownHeading(rawTitle)
}

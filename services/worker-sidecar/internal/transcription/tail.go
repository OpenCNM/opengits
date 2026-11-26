package transcription

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

var htmlTagRe = regexp.MustCompile(`<[^>]+>`)

var markdownLinkOrImageRe = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]+\)`)

var headingLineRe = regexp.MustCompile(`^[ \t]{0,3}#{1,6}\s+`)

type TailProseResult struct {
	Prose      string
	RawSnippet string
	StartLine  int
	TotalLines int
}

func CleanProseLine(line string) string {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return ""
	}
	trimmed = headingLineRe.ReplaceAllString(trimmed, "")
	trimmed = htmlTagRe.ReplaceAllString(trimmed, "")
	trimmed = markdownLinkOrImageRe.ReplaceAllString(trimmed, "$1")
	trimmed = strings.ReplaceAll(trimmed, "`", "")
	return strings.TrimSpace(trimmed)
}

func ExtractTailProse(source string, maxChars int) TailProseResult {
	if strings.TrimSpace(source) == "" {
		return TailProseResult{}
	}
	if maxChars <= 0 {
		maxChars = 300
	}
	lines := strings.Split(source, "\n")
	totalLines := len(lines)
	if totalLines == 0 {
		return TailProseResult{}
	}

	inFrontmatter := false
	inCodeBlock := false
	fenceChar := byte(0)
	fenceLen := 0

	isExcludedLine := make([]bool, totalLines)

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		if i == 0 && (trimmed == "---" || trimmed == "+++") {
			inFrontmatter = true
			isExcludedLine[i] = true
			continue
		}
		if inFrontmatter {
			isExcludedLine[i] = true
			if trimmed == "---" || trimmed == "+++" {
				inFrontmatter = false
			}
			continue
		}

		if m := mdpat.FenceOpenRe.FindStringSubmatch(line); m != nil {
			fence := m[1]
			if !inCodeBlock {
				inCodeBlock = true
				fenceChar = fence[0]
				fenceLen = len(fence)
				isExcludedLine[i] = true
				continue
			} else if fence[0] == fenceChar && len(fence) >= fenceLen && strings.TrimSpace(m[2]) == "" {
				inCodeBlock = false
				fenceChar = 0
				fenceLen = 0
				isExcludedLine[i] = true
				continue
			}
		}

		if inCodeBlock {
			isExcludedLine[i] = true
		}
	}

	type proseLine struct {
		lineNo      int
		rawText     string
		cleanedText string
	}

	var collected []proseLine
	accumulatedLen := 0

	for i := totalLines - 1; i >= 0; i-- {
		if isExcludedLine[i] {
			continue
		}
		raw := lines[i]
		cleaned := CleanProseLine(raw)
		if cleaned == "" {
			continue
		}

		collected = append(collected, proseLine{
			lineNo:      i + 1,
			rawText:     raw,
			cleanedText: cleaned,
		})
		accumulatedLen += len([]rune(cleaned))

		if accumulatedLen >= maxChars {
			break
		}
	}

	if len(collected) == 0 {
		return TailProseResult{TotalLines: totalLines}
	}

	n := len(collected)
	cleanedParts := make([]string, n)
	rawParts := make([]string, n)
	for i := 0; i < n; i++ {
		orig := collected[n-1-i]
		cleanedParts[i] = orig.cleanedText
		rawParts[i] = orig.rawText
	}

	startLine := collected[n-1].lineNo

	return TailProseResult{
		Prose:      strings.Join(cleanedParts, "\n"),
		RawSnippet: strings.Join(rawParts, "\n"),
		StartLine:  startLine,
		TotalLines: totalLines,
	}
}

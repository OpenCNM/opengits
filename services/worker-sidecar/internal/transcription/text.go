package transcription

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/pipeline"
)

const (
	chunkMaxLen = 8000
	chunkMinLen = 3000
)

// Matches TS /(`{3,}|~{3,})/ semantics (3+ identical fence chars) for golden parity.
var fenceRe = mdpat.FenceOpenRe
var h2Re = regexp.MustCompile(`^[ \t]{0,3}##\s+`)
var h3Re = regexp.MustCompile(`^[ \t]{0,3}###\s+`)
var fenceOpenLangRe = mdpat.FenceOpenLangRe
var fenceCloseRe = mdpat.FenceCloseBareRe

func splitMarkdownIntoChunks(markdown string) []string {
	return splitMarkdownIntoChunksWithOptions(markdown, chunkMaxLen, chunkMinLen)
}

func splitMarkdownIntoChunksWithOptions(markdown string, maxLen, minLen int) []string {
	if maxLen <= 0 {
		maxLen = chunkMaxLen
	}
	if minLen <= 0 {
		minLen = chunkMinLen
	}
	if len(markdown) <= maxLen {
		return []string{markdown}
	}
	lines := strings.Split(markdown, "\n")
	var chunks []string
	var current []string
	currentLen := 0
	inCodeBlock := false
	fenceChar := byte(0)
	fenceLen := 0

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := fenceRe.FindStringSubmatch(line); m != nil {
			fence := m[1]
			if !inCodeBlock {
				inCodeBlock = true
				fenceChar = fence[0]
				fenceLen = len(fence)
			} else if fence[0] == fenceChar && len(fence) >= fenceLen && strings.TrimSpace(m[2]) == "" {
				inCodeBlock = false
				fenceChar = 0
				fenceLen = 0
			}
		}
		isH2 := !inCodeBlock && h2Re.MatchString(line)
		isH3 := !inCodeBlock && h3Re.MatchString(line)
		isBlank := !inCodeBlock && trimmed == ""

		splitH2 := isH2 && currentLen >= minLen
		splitH3 := isH3 && currentLen >= maxLen*7/10
		splitBlank := isBlank && currentLen >= maxLen

		if (splitH2 || splitH3 || splitBlank) && len(current) > 0 {
			chunks = append(chunks, strings.Join(current, "\n"))
			current = nil
			currentLen = 0
		}
		current = append(current, line)
		currentLen += len(line) + 1
	}
	if len(current) > 0 {
		chunks = append(chunks, strings.Join(current, "\n"))
	}
	if len(chunks) == 0 {
		return []string{markdown}
	}
	return chunks
}

func joinMarkdownChunks(chunks []string) string {
	if len(chunks) == 0 {
		return ""
	}
	if len(chunks) == 1 {
		return chunks[0]
	}
	var trimmed []string
	for _, c := range chunks {
		t := strings.TrimSpace(c)
		if t != "" {
			trimmed = append(trimmed, t)
		}
	}
	joined := threeNewlineRe.ReplaceAllString(strings.Join(trimmed, "\n\n"), "\n\n")
	return joined + "\n"
}

var threeNewlineRe = regexp.MustCompile(`\n{3,}`)

const (
	sentinelBegin = "===CONTENT_BEGIN==="
	sentinelEnd   = "===CONTENT_END==="
)

func extractBySentinel(text string) string {
	return pipeline.ExtractBySentinel(text)
}

const (
	i18nDisclaimer      = "免责声明"
	i18nTranslationNote = "自动翻译可能包含错误。"
)

func ensureDisclaimerFormat(content string) string {
	if !strings.Contains(content, "Co-op Translator") {
		return content
	}
	lines := strings.Split(content, "\n")
	var clean []string
	signatures := []string{
		"Co-op Translator",
		i18nTranslationNote,
		"因使用本翻译而产生的任何误解",
		"本文件由 AI 翻译服务",
	}
	removed := false

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		isDisclaimerText := false
		for _, sig := range signatures {
			if strings.Contains(trimmed, sig) {
				isDisclaimerText = true
				break
			}
		}
		if isDisclaimerText {
			removed = true
			continue
		}
		isHeaderOrTag := trimmed == i18nDisclaimer ||
			trimmed == i18nDisclaimer+":" || trimmed == i18nDisclaimer+"：" ||
			trimmed == "## "+i18nDisclaimer || trimmed == "### "+i18nDisclaimer ||
			trimmed == "**"+i18nDisclaimer+":**" || trimmed == "**"+i18nDisclaimer+"：**" ||
			strings.HasPrefix(trimmed, "<Callout") || trimmed == "</Callout>" ||
			strings.HasPrefix(trimmed, "<Expandable") || trimmed == "</Expandable>"
		if isHeaderOrTag {
			adjacent := func(l string) bool {
				for _, sig := range signatures {
					if strings.Contains(l, sig) {
						return true
					}
				}
				return false
			}
			n1, n2, p1, p2 := "", "", "", ""
			if i+1 < len(lines) {
				n1 = strings.TrimSpace(lines[i+1])
			}
			if i+2 < len(lines) {
				n2 = strings.TrimSpace(lines[i+2])
			}
			if i-1 >= 0 {
				p1 = strings.TrimSpace(lines[i-1])
			}
			if i-2 >= 0 {
				p2 = strings.TrimSpace(lines[i-2])
			}
			if adjacent(n1) || adjacent(n2) || adjacent(p1) || adjacent(p2) {
				continue
			}
		}
		clean = append(clean, lines[i])
	}

	if removed {
		body := "本文件由 AI 翻译服务 Co-op Translator 翻译。我们尽力确保准确性，但请注意，" +
			i18nTranslationNote + " 原始语言的文件应视为权威来源。对于关键信息，建议采用专业人工翻译。因使用本翻译而产生的任何误解或误读，我们概不负责。"
		block := "\n<Expandable title=\"" + i18nDisclaimer + "\" subtitle=\"" + i18nTranslationNote + "\">\n" + body + "\n</Expandable>\n"
		titleIdx := -1
		for i, l := range clean {
			if strings.HasPrefix(strings.TrimSpace(l), "# ") {
				titleIdx = i
				break
			}
		}
		if titleIdx != -1 {
			insert := titleIdx + 1
			for insert < len(clean) && strings.TrimSpace(clean[insert]) == "" {
				insert++
			}
			clean = append(clean[:insert], append([]string{block}, clean[insert:]...)...)
		} else {
			clean = append([]string{block}, clean...)
		}
	}
	return strings.Join(clean, "\n")
}

func ExtractBySentinel(input string) string {
	return extractBySentinel(input)
}

package sanitize

import (
	"errors"
	"regexp"
	"strings"
)

var (
	sentinelBeginRe = regexp.MustCompile(`===CONTENT_BEGIN===`)
	sentinelEndRe   = regexp.MustCompile(`===CONTENT_END===`)

	pandocImgRe = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)\s*\{[^}]*\}`)

	atxHeadingRe = regexp.MustCompile(`^([ \t]{0,3}#{1,6}[ \t]+)(.*)$`)

	headingImgRe  = regexp.MustCompile(`!\[([^\]]*)\]\([^)]*\)`)
	headingLinkRe = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	// Drop alt text inside nested image links [![alt](img)](url) to match remark image-node extraction.
	headingNestedImgLinkRe = regexp.MustCompile(`\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)`)
)

func PrepareMdxSource(raw string) string {
	if raw == "" {
		return ""
	}
	s := sentinelBeginRe.ReplaceAllString(raw, "")
	s = sentinelEndRe.ReplaceAllString(s, "")
	s = pandocImgRe.ReplaceAllString(s, "![$1]($2)")
	s = removeElementsWithContent(s, map[string]bool{"concept_manifest": true})
	return s
}

func flattenHeadingLinks(line string) string {
	m := atxHeadingRe.FindStringSubmatch(line)
	if m == nil {
		return line
	}
	prefix := m[1]
	body := m[2]

	body = headingNestedImgLinkRe.ReplaceAllString(body, "")
	body = headingImgRe.ReplaceAllString(body, "$1")
	body = headingLinkRe.ReplaceAllString(body, "$1")
	// Leave unclosed <a> tags untouched when flattening headings to match non-greedy tag pairing.
	body = unwrapElements(body, "a")

	return prefix + body
}

func flattenAllHeadings(content string) string {
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if strings.Contains(line, "#") {
			lines[i] = flattenHeadingLinks(line)
		}
	}
	return strings.Join(lines, "\n")
}

func SanitizeText(rawContent string) (string, error) {
	if strings.TrimSpace(rawContent) == "" {
		return "", nil
	}

	cleanedRaw := PrepareMdxSource(rawContent)

	masked, blocks := MaskCodeBlocks(cleanedRaw)
	if len(blocks) > 0 && !strings.Contains(masked, MaskTokenPrefix) {
		return "", errors.New("sanitizer failed: code block mask integrity violation")
	}

	flattened := flattenAllHeadings(masked)

	sanitized := sanitizeHTML(flattened)

	result := UnmaskCodeBlocks(sanitized, blocks)

	if result != "" && !strings.HasSuffix(result, "\n") {
		result += "\n"
	}
	return result, nil
}

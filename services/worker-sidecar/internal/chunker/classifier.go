package chunker

import (
	"regexp"
	"strings"
)

var (
	classifierMermaidRe   = regexp.MustCompile(`(?i)(?:` + "```" + `|~~~)\s*mermaid`)
	classifierWarningRe   = regexp.MustCompile(`(?i)\[!(?:WARNING|CAUTION|IMPORTANT)\]|:::warning`)
	classifierCodeBlockRe = regexp.MustCompile(`(?s)(?:` + "```.*?```" + `|~~~.*?~~~)` + "")
	classifierTableRe     = regexp.MustCompile(`\|(?:\s*:?-+:?\s*\|)+`)
	// Require word boundaries on both sides so substrings like rapid/flowchart do not match api/flow.
	classifierHeadingArchRe = regexp.MustCompile(`(?i)\b(?:architecture|design|workflow|flow|overview|system)\b`)
	classifierHeadingApiRe  = regexp.MustCompile(`(?i)\b(?:api|reference|parameters?|configs?|props)\b`)
)

// Count UTF-16 code units to match JavaScript string.length across surrogate pairs.
func utf16Length(s string) int {
	count := 0
	for _, r := range s {
		if r > 0xFFFF {
			count += 2
		} else {
			count++
		}
	}
	return count
}

func DeriveDocumentRole(content string) string {
	if classifierMermaidRe.MatchString(content) {
		return "architecture"
	}
	if classifierTableRe.MatchString(content) {
		return "api_reference"
	}
	return ""
}

func ClassifyChunk(content, headingPath, blueprintRole string) string {
	if classifierMermaidRe.MatchString(content) {
		return "architecture_diagram"
	}

	if classifierWarningRe.MatchString(content) {
		return "warning"
	}

	// Physical code density >= 50% overrides macro blueprint role.
	codeMatches := classifierCodeBlockRe.FindAllString(content, -1)
	codeLength := 0
	for _, m := range codeMatches {
		codeLength += utf16Length(m)
	}
	contentTrimmed := strings.TrimSpace(content)
	contentLen := utf16Length(contentTrimmed)
	if contentLen > 0 && float64(codeLength)/float64(contentLen) >= 0.5 {
		return "code"
	}

	if classifierTableRe.MatchString(content) {
		return "api_reference"
	}

	if blueprintRole != "" {
		role := strings.ToLower(blueprintRole)
		switch role {
		case "architecture", "architecture_diagram", "architecture_spec":
			return "architecture_diagram"
		case "api_reference", "api":
			return "api_reference"
		case "code", "function_impl", "type_definition":
			return "code"
		case "warning":
			return "warning"
		case "module_overview":
			return "module_overview"
		}
	}

	if headingPath != "" {
		if classifierHeadingArchRe.MatchString(headingPath) {
			return "architecture_diagram"
		}
		if classifierHeadingApiRe.MatchString(headingPath) {
			return "api_reference"
		}
	}

	return "prose"
}

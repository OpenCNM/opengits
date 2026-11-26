package pipeline

import (
	"regexp"
	"strconv"
	"strings"
)

var knownContainerTags = map[string]bool{
	"Callout":        true,
	"Steps":          true,
	"Step":           true,
	"CodeGroup":      true,
	"Tabs":           true,
	"Tab":            true,
	"Card":           true,
	"CardGroup":      true,
	"Accordion":      true,
	"AccordionGroup": true,
	"Summary":        true,
	"Expandable":     true,
	"Note":           true,
	"Tip":            true,
	"Warning":        true,
	"Info":           true,
	"Frame":          true,
}

var unclosedTagRe = regexp.MustCompile("Expected a closing tag for\\s*`?<([A-Za-z0-9_]+)>`?\\s*in MDX")
var linePatternRe = regexp.MustCompile(`(?i)(?:at|around)?\s*line\s+(\d+)`)
var lineColonPatternRe = regexp.MustCompile(`(?:\(|\s|:)(\d+):(\d+)`)

func BalanceCodeFences(content string) string {
	if strings.TrimSpace(content) == "" {
		return content
	}

	lines := strings.Split(content, "\n")
	inFence := false
	fenceChar := byte('`')
	fenceLen := 3

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inFence {
			if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
				inFence = true
				fenceChar = trimmed[0]
				l := 0
				for l < len(trimmed) && trimmed[l] == fenceChar {
					l++
				}
				fenceLen = l
			}
		} else {
			if len(trimmed) >= fenceLen && trimmed[0] == fenceChar {
				allSame := true
				for k := 0; k < len(trimmed); k++ {
					if trimmed[k] != fenceChar {
						allSame = false
						break
					}
				}
				if allSame {
					inFence = false
				}
			}
		}
	}

	if inFence {
		closing := "\n" + strings.Repeat(string(fenceChar), fenceLen) + "\n"
		return strings.TrimRight(content, "\n") + closing
	}
	return content
}

// Auto-close up to 5 nested known wrapper tags on EOF truncation to avoid an extra LLM repair call.
func TryAutoCloseTags(content string, verr string, validator func(string) (bool, string)) (string, bool) {
	curr := content
	currErr := verr

	for iter := 0; iter < 5; iter++ {
		m := unclosedTagRe.FindStringSubmatch(currErr)
		if m == nil {
			break
		}
		tagName := m[1]
		if !knownContainerTags[tagName] {
			break
		}

		curr = strings.TrimRight(curr, "\n\t ") + "\n</" + tagName + ">\n"
		valid, nextErr := validator(curr)
		if valid {
			return curr, true
		}
		currErr = nextErr
	}

	return content, false
}

func ExtractErrorLine(errMsg string, content string) int {
	if strings.TrimSpace(errMsg) == "" {
		return 0
	}

	if m := linePatternRe.FindStringSubmatch(errMsg); m != nil {
		if line, err := strconv.Atoi(m[1]); err == nil && line > 0 {
			return line
		}
	}

	if m := lineColonPatternRe.FindStringSubmatch(errMsg); m != nil {
		if line, err := strconv.Atoi(m[1]); err == nil && line > 0 {
			return line
		}
	}

	lines := strings.Split(content, "\n")

	if m := unclosedTagRe.FindStringSubmatch(errMsg); m != nil {
		tagName := m[1]
		tagOpenPrefix := "<" + tagName
		for i := len(lines) - 1; i >= 0; i-- {
			if strings.Contains(lines[i], tagOpenPrefix) {
				return i + 1
			}
		}
	}

	if strings.Contains(errMsg, "generic type parameter collision") {
		genRe := regexp.MustCompile(`<[A-Z]>`)
		for i, line := range lines {
			if genRe.MatchString(line) {
				return i + 1
			}
		}
	}

	if strings.Contains(errMsg, "Unexpected character in JSX attribute expression:") {
		exprIdx := strings.Index(errMsg, "{")
		exprLastIdx := strings.LastIndex(errMsg, "}")
		if exprIdx != -1 && exprLastIdx > exprIdx {
			rawExpr := errMsg[exprIdx+1 : exprLastIdx]
			if len(rawExpr) > 10 {
				rawExpr = rawExpr[:10]
			}
			for i, line := range lines {
				if strings.Contains(line, rawExpr) {
					return i + 1
				}
			}
		}
	}

	return 0
}

package pipeline

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

var (
	mermaidDelimPairs = []struct {
		open  string
		close string
	}{
		{"(((", ")))"},
		{"[(", ")]"},
		{"([", "])"},
		{"[[", "]]"},
		{"{{", "}}"},
		{"((", "))"},
		{"[/", "/]"},
		{`[\`, `\]`},
		{"[/", `\]`},
		{`[\`, "/]"},
		{"[", "]"},
		{"(", ")"},
		{"{", "}"},
	}

	htmlDangerousTagRe  = regexp.MustCompile(`(?is)<(script|iframe|object|embed)\b[^>]*>.*?(?:</(script|iframe|object|embed)\s*>|$)|<(script|iframe|object|embed)\b[^>]*/>`)
	htmlDangerousAttrRe = regexp.MustCompile(`(?i)\b(on[a-z]+|javascript:|vbscript:|data:text/html)\b`)
	subgraphOpenRe      = regexp.MustCompile(`(?i)^\s*subgraph\s+([A-Za-z0-9_-]+)\s*\[([^"\]]+?)\]`)
	edgeLabelRe         = regexp.MustCompile(`(\|)([^"\|\r\n]+?)(\|)`)
	danglingEdgeRe      = regexp.MustCompile(`(?i)(-->|---|==>|-\.->)\s*$`)
	specialCharsRe      = regexp.MustCompile(`[:\(\)\[\]{}"',<>+*\/\\?#=~!@$%^&|]`)

	mermaidEdgeRe           = regexp.MustCompile(`(?m)(-->|---|==>|-\.->|->|<--|<-->|<==>|~~~|\.-|--\s*\|)`)
	mermaidNodeDeclRe       = regexp.MustCompile(`(?i)\b[A-Za-z0-9_.-]+\s*(\[|\(|\{|\(\[|\[\[)`)
	mermaidInvalidLeadingRe = regexp.MustCompile(`^\s*[\?\!\*\#\^\$\&]+`)
)

func StripMermaidDangerousContent(code string) string {
	cleaned := htmlDangerousTagRe.ReplaceAllString(code, "")
	cleaned = htmlDangerousAttrRe.ReplaceAllString(cleaned, "")
	return cleaned
}

// Quote Mermaid node labels containing special chars in a single pass so browser parsers do not choke.
func EnsureQuotedMermaidLabels(code string) string {
	if strings.TrimSpace(code) == "" {
		return ""
	}

	lines := strings.Split(code, "\n")
	out := make([]string, 0, len(lines))

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "%%") {
			out = append(out, line)
			continue
		}

		line = strings.ReplaceAll(line, "（", "(")
		line = strings.ReplaceAll(line, "）", ")")
		line = strings.ReplaceAll(line, "【", "[")
		line = strings.ReplaceAll(line, "】", "]")
		line = strings.ReplaceAll(line, "“", `"`)
		line = strings.ReplaceAll(line, "”", `"`)

		if mdpat.MermaidDiagramHeaderRe.MatchString(trimmed) ||
			regexp.MustCompile(`(?i)^\s*(direction|style|classDef|class|linkStyle|click|end)\b`).MatchString(trimmed) {
			out = append(out, line)
			continue
		}

		modified := line

		modified = subgraphOpenRe.ReplaceAllStringFunc(modified, func(m string) string {
			parts := subgraphOpenRe.FindStringSubmatch(m)
			if len(parts) == 3 {
				title := strings.TrimSpace(parts[2])
				if specialCharsRe.MatchString(title) && !strings.HasPrefix(title, `"`) {
					quoted := strings.ReplaceAll(title, `"`, `\"`)
					return fmt.Sprintf(`subgraph %s ["%s"]`, parts[1], quoted)
				}
			}
			return m
		})

		modified = edgeLabelRe.ReplaceAllStringFunc(modified, func(m string) string {
			parts := edgeLabelRe.FindStringSubmatch(m)
			if len(parts) == 4 {
				label := strings.TrimSpace(parts[2])
				if (strings.HasPrefix(label, `"`) && strings.HasSuffix(label, `"`)) || len(label) == 0 {
					return m
				}
				if specialCharsRe.MatchString(label) {
					quoted := strings.ReplaceAll(label, `"`, `\"`)
					return fmt.Sprintf(`|" %s "|`, strings.TrimSpace(quoted))
				}
			}
			return m
		})

		modified = quoteNodeLabelsInLine(modified)

		out = append(out, modified)
	}

	return strings.Join(out, "\n")
}

func quoteNodeLabelsInLine(line string) string {
	var sb strings.Builder
	i := 0
	n := len(line)

	for i < n {
		if (i == 0 || isBoundaryChar(line[i-1])) && isIdStartChar(line[i]) {
			idStart := i
			for i < n && isIdChar(line[i]) {
				i++
			}
			idStr := line[idStart:i]

			if strings.EqualFold(idStr, "subgraph") || strings.EqualFold(idStr, "end") {
				sb.WriteString(idStr)
				continue
			}

			wsStart := i
			for i < n && (line[i] == ' ' || line[i] == '\t') {
				i++
			}
			wsStr := line[wsStart:i]

			matchedOpen := ""
			matchedClose := ""
			for _, pair := range mermaidDelimPairs {
				if strings.HasPrefix(line[i:], pair.open) {
					matchedOpen = pair.open
					matchedClose = pair.close
					break
				}
			}

			if matchedOpen != "" {
				contentStart := i + len(matchedOpen)
				closeIdx := findMatchingClose(line, contentStart, matchedClose)
				if closeIdx != -1 {
					rawContent := line[contentStart:closeIdx]
					trimmed := strings.TrimSpace(rawContent)
					quotedContent := rawContent

					if (!strings.HasPrefix(trimmed, `"`) || !strings.HasSuffix(trimmed, `"`)) && specialCharsRe.MatchString(trimmed) {
						escaped := strings.ReplaceAll(trimmed, `"`, `\"`)
						quotedContent = `"` + escaped + `"`
					}

					sb.WriteString(idStr)
					sb.WriteString(wsStr)
					sb.WriteString(matchedOpen)
					sb.WriteString(quotedContent)
					sb.WriteString(matchedClose)
					i = closeIdx + len(matchedClose)
					continue
				}
			}

			sb.WriteString(idStr)
			sb.WriteString(wsStr)
			continue
		}

		sb.WriteByte(line[i])
		i++
	}

	return sb.String()
}

func isBoundaryChar(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '-' || ch == '>' || ch == '=' || ch == '~' || ch == ';' || ch == '&' || ch == '|' || ch == '\n' || ch == '\r'
}

func isIdStartChar(ch byte) bool {
	return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_'
}

func isIdChar(ch byte) bool {
	return isIdStartChar(ch) || ch == '.' || ch == '-'
}

func findMatchingClose(line string, start int, closeDelim string) int {
	cur := start
	n := len(line)
	for cur < n {
		if line[cur] == '\\' {
			cur += 2
			continue
		}
		if strings.HasPrefix(line[cur:], closeDelim) {
			return cur
		}
		cur++
	}
	return -1
}

func EnsureMermaidHeader(code string) string {
	lines := strings.Split(code, "\n")
	hasHeader := false
	for _, l := range lines {
		trim := strings.TrimSpace(l)
		if trim == "" || strings.HasPrefix(trim, "%%") {
			continue
		}
		if mdpat.MermaidDiagramHeaderRe.MatchString(trim) {
			hasHeader = true
			break
		}
	}
	if !hasHeader {
		return "flowchart LR\n" + code
	}
	return code
}

func BalanceMermaidStructure(code string) string {
	lines := strings.Split(code, "\n")
	var out []string
	subgraphCount := 0
	endCount := 0

	for _, l := range lines {
		trim := strings.TrimSpace(l)
		if trim == "" {
			continue
		}
		if danglingEdgeRe.MatchString(trim) {
			trimmedLine := danglingEdgeRe.ReplaceAllString(l, "")
			if strings.TrimSpace(trimmedLine) == "" || isIdString(strings.TrimSpace(trimmedLine)) {
				continue
			}
			l = trimmedLine
			trim = strings.TrimSpace(l)
		}

		if regexp.MustCompile(`(?i)^\s*subgraph\b`).MatchString(trim) {
			subgraphCount++
		} else if strings.EqualFold(trim, "end") {
			endCount++
		}
		out = append(out, l)
	}

	for subgraphCount > endCount {
		out = append(out, "  end")
		endCount++
	}

	return strings.Join(out, "\n")
}

func HealMermaidSyntax(raw string) (string, bool) {
	clean, _ := StripPayloadShell(raw)
	clean = strings.TrimSpace(clean)
	if clean == "" {
		clean = strings.TrimSpace(raw)
	}
	clean = regexp.MustCompile(`(?i)^[ \t]*`+"`{3,}"+`\s*mermaid\s*\n?`).ReplaceAllString(clean, "")
	clean = regexp.MustCompile(`(?i)\n?[ \t]*`+"`{3,}"+`\s*$`).ReplaceAllString(clean, "")
	clean = strings.TrimSpace(clean)
	if clean == "" {
		return "", false
	}

	clean = StripMermaidDangerousContent(clean)

	clean = EnsureQuotedMermaidLabels(clean)

	clean = EnsureMermaidHeader(clean)

	clean = BalanceMermaidStructure(clean)

	isValid := isMermaidSyntaxValid(clean)
	return clean, isValid
}

func isIdString(s string) bool {
	if len(s) == 0 {
		return false
	}
	for _, r := range s {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '.' && r != '-' {
			return false
		}
	}
	return true
}

func isMermaidSyntaxValid(code string) bool {
	lines := strings.Split(code, "\n")
	hasHeader := false
	headerType := ""
	statementCount := 0
	hasEdgeOrNode := false

	for _, l := range lines {
		trim := strings.TrimSpace(l)
		if trim == "" || strings.HasPrefix(trim, "%%") {
			continue
		}

		if mdpat.MermaidDiagramHeaderRe.MatchString(trim) {
			hasHeader = true
			fields := strings.Fields(trim)
			if len(fields) > 0 {
				headerType = strings.ToLower(fields[0])
			}
			continue
		}

		if mermaidInvalidLeadingRe.MatchString(trim) {
			return false
		}

		statementCount++

		lower := strings.ToLower(trim)
		if strings.HasPrefix(lower, "subgraph") || lower == "end" ||
			strings.HasPrefix(lower, "classdef") || strings.HasPrefix(lower, "class ") ||
			strings.HasPrefix(lower, "style ") || strings.HasPrefix(lower, "direction ") ||
			strings.HasPrefix(lower, "click ") || strings.HasPrefix(lower, "linkstyle ") ||
			strings.HasPrefix(lower, "participant ") || strings.HasPrefix(lower, "actor ") ||
			strings.HasPrefix(lower, "title ") || strings.HasPrefix(lower, "acctitle:") {
			continue
		}

		if mermaidEdgeRe.MatchString(trim) || mermaidNodeDeclRe.MatchString(trim) {
			hasEdgeOrNode = true
			continue
		}

		if strings.Contains(headerType, "sequence") || strings.Contains(headerType, "state") ||
			strings.Contains(headerType, "class") || strings.Contains(headerType, "er") ||
			strings.Contains(headerType, "git") || strings.Contains(headerType, "pie") {
			hasEdgeOrNode = true
			continue
		}

		if strings.ContainsAny(trim, `[({"`) {
			hasEdgeOrNode = true
			continue
		}

		if isIdString(trim) {
			hasEdgeOrNode = true
			continue
		}

		return false
	}

	return hasHeader && statementCount >= 1 && hasEdgeOrNode
}

func RepairMermaidWithLlm(ctx context.Context, client LlmCompleter, brokenMermaid string, uid *string) (string, error) {
	if client == nil || strings.TrimSpace(brokenMermaid) == "" {
		return "", errors.New("llm client not configured or empty broken mermaid")
	}

	repairCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	vars := map[string]any{
		"rawMermaid":  brokenMermaid,
		"mermaidCode": brokenMermaid,
	}

	res, err := client.Complete(repairCtx, "mermaid_resilience", vars, uid)
	if err != nil {
		return "", fmt.Errorf("mermaid doctor: %w", err)
	}

	text := strings.TrimSpace(res.Text)
	if text == "" {
		return "", errors.New("empty response from mermaid doctor")
	}

	clean, _ := StripPayloadShell(text)
	clean = strings.TrimSpace(clean)
	if clean == "" {
		clean = text
	}

	healed, ok := HealMermaidSyntax(clean)
	if !ok {
		return "", errors.New("repaired mermaid still failed syntax validation")
	}
	return healed, nil
}

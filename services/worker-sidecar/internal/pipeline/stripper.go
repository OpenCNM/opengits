package pipeline

import (
	"encoding/json"
	"log"
	"strconv"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func stripOuterFence(text string) (string, string, bool) {
	trimmed := strings.TrimSpace(text)
	firstNL := strings.Index(trimmed, "\n")
	if firstNL == -1 {
		return text, "", false
	}
	firstLine := strings.TrimSpace(trimmed[:firstNL])
	m := mdpat.FenceOpenRe.FindStringSubmatch(firstLine)
	if m == nil {
		return text, "", false
	}
	fenceChar := m[1][0]
	fenceLen := len(m[1])
	lang := strings.ToLower(strings.TrimSpace(m[2]))

	lastNL := strings.LastIndex(trimmed, "\n")
	if lastNL <= firstNL {
		return text, "", false
	}
	lastLine := strings.TrimSpace(trimmed[lastNL:])
	m2 := mdpat.FenceCloseRe.FindStringSubmatch(lastLine)
	if m2 != nil && m2[1][0] == fenceChar && len(m2[1]) >= fenceLen {
		return trimmed[firstNL+1 : lastNL], lang, true
	}
	return text, "", false
}

var knownMarkdownKeys = []string{
	"lessonMarkdown",
	"markdown",
	"content",
	"text",
	"lesson_markdown",
	"lesson",
	"body",
}

func HasUnpeeledJSONShell(text string) bool {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "{") {
		return false
	}
	prefixLen := len(trimmed)
	if prefixLen > 300 {
		prefixLen = 300
	}
	head := trimmed[:prefixLen]
	for _, k := range knownMarkdownKeys {
		if strings.Contains(head, `"`+k+`"`) {
			return true
		}
	}
	if strings.Contains(head, `"choices"`) || strings.Contains(head, `"data"`) {
		return true
	}
	return false
}

func findMarkdownInMap(m map[string]any, depth int) (string, string) {
	if depth > 4 || len(m) == 0 {
		return "", ""
	}

	for _, k := range knownMarkdownKeys {
		if v, exists := m[k]; exists {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return k, s
			}
		}
	}

	containers := []string{"data", "response", "result", "payload", "output", "lesson"}
	for _, c := range containers {
		if sub, ok := m[c].(map[string]any); ok {
			if k, s := findMarkdownInMap(sub, depth+1); k != "" {
				return c + "." + k, s
			}
		}
	}

	if k, s := extractOpenAIChoiceMarkdown(m); k != "" {
		return k, s
	}

	if len(m) == 1 {
		for k, v := range m {
			lowerK := strings.ToLower(k)
			isTextKey := strings.Contains(lowerK, "markdown") || strings.Contains(lowerK, "content") ||
				strings.Contains(lowerK, "text") || strings.Contains(lowerK, "lesson") || strings.Contains(lowerK, "body")
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" && (isTextKey || strings.Contains(s, "#")) {
				return k, s
			}
			if sub, ok := v.(map[string]any); ok {
				if subK, s := findMarkdownInMap(sub, depth+1); subK != "" {
					return k + "." + subK, s
				}
			}
		}
	}

	return "", ""
}

func extractOpenAIChoiceMarkdown(m map[string]any) (string, string) {
	choices, ok := m["choices"].([]any)
	if !ok || len(choices) == 0 {
		return "", ""
	}
	first, ok := choices[0].(map[string]any)
	if !ok {
		return "", ""
	}
	if msg, ok := first["message"].(map[string]any); ok {
		if s, ok := msg["content"].(string); ok && strings.TrimSpace(s) != "" {
			return "choices.0.message.content", s
		}
	}
	if text, ok := first["text"].(string); ok && strings.TrimSpace(text) != "" {
		return "choices.0.text", text
	}
	return "", ""
}

func tryUnmarshalJSON(data []byte) (map[string]any, bool) {
	var objMap map[string]any
	if err := json.Unmarshal(data, &objMap); err == nil && len(objMap) > 0 {
		return objMap, true
	}

	str := string(data)
	if loc := mdpat.TrailingEscapedQuoteJsonClosingRe.FindStringIndex(str); loc != nil {
		repaired := str[:loc[0]] + "\"\n}"
		if err := json.Unmarshal([]byte(repaired), &objMap); err == nil && len(objMap) > 0 {
			return objMap, true
		}
	}

	return nil, false
}

func DeescapeJSONStringContent(raw, key string) (string, bool) {
	if raw == "" || key == "" {
		return "", false
	}

	keyPattern := `"` + key + `"`
	idx := strings.Index(raw, keyPattern)
	if idx == -1 {
		keyPattern = `'` + key + `'`
		idx = strings.Index(raw, keyPattern)
		if idx == -1 {
			lowerRaw := strings.ToLower(raw)
			lowerKey := `"` + strings.ToLower(key) + `"`
			idx = strings.Index(lowerRaw, lowerKey)
			if idx == -1 {
				return "", false
			}
			keyPattern = lowerKey
		}
	}

	p := idx + len(keyPattern)
	n := len(raw)

	for p < n && (raw[p] == ' ' || raw[p] == '\t' || raw[p] == '\r' || raw[p] == '\n') {
		p++
	}
	if p >= n || raw[p] != ':' {
		return "", false
	}
	p++

	for p < n && (raw[p] == ' ' || raw[p] == '\t' || raw[p] == '\r' || raw[p] == '\n') {
		p++
	}
	if p >= n {
		return "", false
	}

	quoteChar := raw[p]
	if quoteChar != '"' && quoteChar != '`' && quoteChar != '\'' {
		return "", false
	}
	p++

	var b strings.Builder
	b.Grow(n - p)

	for p < n {
		c := raw[p]

		if c == '\\' {
			if p+1 >= n {
				break
			}
			next := raw[p+1]

			// Treat trailing \" before }, comma, or EOF as string terminator while preserving LaTeX commands (\beta, \frac).
			if next == '"' || next == quoteChar {
				rest := strings.TrimSpace(raw[p+2:])
				cleanRest := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(rest, `\n`, ""), `\r`, ""), `\t`, ""))
				if cleanRest == "}" || cleanRest == "" {
					return b.String(), true
				}
				b.WriteByte('"')
				p += 2
				continue
			}

			switch next {
			case 'n':
				b.WriteByte('\n')
				p += 2
			case 'r':
				b.WriteByte('\r')
				p += 2
			case 't':
				b.WriteByte('\t')
				p += 2
			case '\\':
				b.WriteByte('\\')
				p += 2
			case '/':
				b.WriteByte('/')
				p += 2
			case 'b':
				if p+2 < n && ((raw[p+2] >= 'a' && raw[p+2] <= 'z') || (raw[p+2] >= 'A' && raw[p+2] <= 'Z')) {
					b.WriteByte('\\')
					b.WriteByte('b')
					p += 2
				} else {
					b.WriteByte('\b')
					p += 2
				}
			case 'f':
				if p+2 < n && ((raw[p+2] >= 'a' && raw[p+2] <= 'z') || (raw[p+2] >= 'A' && raw[p+2] <= 'Z')) {
					b.WriteByte('\\')
					b.WriteByte('f')
					p += 2
				} else {
					b.WriteByte('\f')
					p += 2
				}
			case 'u':
				if p+5 < n {
					hexStr := raw[p+2 : p+6]
					if code, err := strconv.ParseUint(hexStr, 16, 32); err == nil {
						b.WriteRune(rune(code))
						p += 6
						continue
					}
				}
				b.WriteString(`\u`)
				p += 2
			default:
				b.WriteByte('\\')
				b.WriteByte(next)
				p += 2
			}
			continue
		}

		if c == quoteChar {
			lookahead := p + 1
			for lookahead < n && (raw[lookahead] == ' ' || raw[lookahead] == '\t' || raw[lookahead] == '\r' || raw[lookahead] == '\n') {
				lookahead++
			}
			if lookahead >= n {
				return b.String(), true
			}
			nextChar := raw[lookahead]
			if nextChar == '}' {
				return b.String(), true
			}
			if nextChar == ',' {
				afterComma := lookahead + 1
				for afterComma < n && (raw[afterComma] == ' ' || raw[afterComma] == '\t' || raw[afterComma] == '\r' || raw[afterComma] == '\n') {
					afterComma++
				}
				if afterComma < n && (raw[afterComma] == '"' || raw[afterComma] == '\'') {
					return b.String(), true
				}
			}

			b.WriteByte(quoteChar)
			p++
			continue
		}

		if c == '\r' {
			if p+1 < n && raw[p+1] == '\n' {
				b.WriteByte('\n')
				p += 2
				continue
			}
			b.WriteByte('\n')
			p++
			continue
		}
		if c == '\n' {
			b.WriteByte('\n')
			p++
			continue
		}

		b.WriteByte(c)
		p++
	}

	if b.Len() > 0 {
		return b.String(), true
	}
	return "", false
}

func peelJSONContainer(text string) (string, string, bool) {
	trimmed := strings.TrimSpace(text)

	if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
		if objMap, ok := tryUnmarshalJSON([]byte(trimmed)); ok {
			if key, val := findMarkdownInMap(objMap, 0); key != "" {
				return val, key, true
			}
		}
	}

	firstBrace := strings.Index(trimmed, "{")
	lastBrace := strings.LastIndex(trimmed, "}")
	validPrefix := firstBrace > 0 && lastBrace > firstBrace &&
		!strings.Contains(trimmed[:firstBrace], "\n\n") &&
		!strings.Contains(trimmed[:firstBrace], "#") &&
		!strings.Contains(trimmed[:firstBrace], "<")

	if validPrefix {
		slice := trimmed[firstBrace : lastBrace+1]
		if objMap, ok := tryUnmarshalJSON([]byte(slice)); ok {
			if key, val := findMarkdownInMap(objMap, 0); key != "" {
				return val, key, true
			}
		}
	}

	searchTarget := trimmed
	if validPrefix && firstBrace >= 0 {
		searchTarget = trimmed[firstBrace:]
	}
	if strings.HasPrefix(searchTarget, "{") || HasUnpeeledJSONShell(searchTarget) {
		for _, k := range knownMarkdownKeys {
			if val, ok := DeescapeJSONStringContent(searchTarget, k); ok && strings.TrimSpace(val) != "" {
				return val, k, true
			}
		}
	}

	return text, "", false
}

func StripPayloadShell(raw string) (string, string) {
	curr := raw
	var strippedFeatures []string

	if mdpat.ThinkingBlockRe.MatchString(curr) {
		curr = mdpat.ThinkingBlockRe.ReplaceAllString(curr, "")
		curr = strings.TrimSpace(curr)
		strippedFeatures = append(strippedFeatures, "think")
	}

	if stripped, lang, ok := stripOuterFence(curr); ok {
		trimmedStripped := strings.TrimSpace(stripped)
		isLangWrapper := lang == "markdown" || lang == "mdx" || lang == "md" || lang == "json" || lang == ""
		if isLangWrapper || (strings.HasPrefix(trimmedStripped, "{") && strings.HasSuffix(trimmedStripped, "}")) {
			curr = stripped
			tag := "fence"
			if lang != "" {
				tag += ":" + lang
			}
			strippedFeatures = append(strippedFeatures, tag)
		}
	}

	if val, key, ok := peelJSONContainer(curr); ok {
		log.Printf("[convergence-pipeline] Stripped JSON wrapper key='%s'", key)
		curr = val
		strippedFeatures = append(strippedFeatures, "json:"+key)
	}

	beginIdx := strings.Index(curr, sentinelBegin)
	endIdx := strings.LastIndex(curr, sentinelEnd)
	if beginIdx != -1 || endIdx != -1 {
		strippedFeatures = append(strippedFeatures, "sentinel")
		if beginIdx != -1 && endIdx != -1 && endIdx > beginIdx {
			curr = curr[beginIdx+len(sentinelBegin) : endIdx]
		} else if beginIdx != -1 {
			curr = curr[beginIdx+len(sentinelBegin):]
		} else if endIdx != -1 {
			curr = curr[:endIdx]
		}
		curr = strings.ReplaceAll(curr, sentinelBegin, "")
		curr = strings.ReplaceAll(curr, sentinelEnd, "")
	}

	if stripped, lang, ok := stripOuterFence(curr); ok {
		if lang == "markdown" || lang == "mdx" || lang == "md" || lang == "" {
			curr = stripped
			tag := "fence"
			if lang != "" {
				tag += ":" + lang
			}
			strippedFeatures = append(strippedFeatures, tag)
		}
	}

	finalContent := strings.TrimSpace(curr)
	shellDesc := strings.Join(strippedFeatures, "+")
	return finalContent, shellDesc
}

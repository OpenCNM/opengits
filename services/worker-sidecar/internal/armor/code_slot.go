package armor

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type CodeAspect string

const (
	AspectAuto     CodeAspect = "auto"
	AspectCore     CodeAspect = "core"
	AspectContract CodeAspect = "contract"
	AspectFull     CodeAspect = "full"
)

func NormalizeCodeAspect(raw string) CodeAspect {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "core":
		return AspectCore
	case "contract":
		return AspectContract
	case "full", "implementation":
		return AspectFull
	default:
		return AspectAuto
	}
}

type CodeSlotHeader struct {
	FileIndex int        `json:"fileIndex"`
	Symbol    string     `json:"symbol"`
	StartLine int        `json:"startLine"`
	EndLine   int        `json:"endLine"`
	Aspect    CodeAspect `json:"aspect"`
	RawLang   string     `json:"rawLang"`
	RawFence  string     `json:"rawFence"`
	Path      string     `json:"path,omitempty"`
}

type CodeSlotResolver func(fileIndex int, relPath, symbol string, reqStart, reqEnd int) (sourceCode string, actualStart, actualEnd int, found bool)

func DetectSourceLanguage(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".go":
		return "go"
	case ".ts":
		return "typescript"
	case ".tsx":
		return "tsx"
	case ".js", ".mjs", ".cjs":
		return "javascript"
	case ".jsx":
		return "jsx"
	case ".py":
		return "python"
	case ".rs":
		return "rust"
	case ".java":
		return "java"
	case ".c", ".h":
		return "c"
	case ".cpp", ".cc", ".cxx", ".hpp":
		return "cpp"
	case ".rb":
		return "ruby"
	case ".php":
		return "php"
	case ".cs":
		return "csharp"
	case ".swift":
		return "swift"
	case ".kt", ".kts":
		return "kotlin"
	case ".json":
		return "json"
	case ".yaml", ".yml":
		return "yaml"
	case ".sql":
		return "sql"
	case ".sh", ".bash", ".zsh":
		return "bash"
	case ".md", ".markdown", ".mdx":
		return "markdown"
	case ".html", ".htm":
		return "html"
	case ".css", ".scss", ".less":
		return "css"
	case ".toml":
		return "toml"
	default:
		return "text"
	}
}

func ParseCodeSlotHeader(firstLine string) (*CodeSlotHeader, bool) {
	trimmed := strings.TrimSpace(firstLine)
	if trimmed == "" {
		return nil, false
	}

	if strings.HasPrefix(trimmed, "<!--") && strings.Contains(trimmed, "CODE_SLOT") {
		return parseXmlCodeSlotTag(trimmed)
	}

	fenceChar := trimmed[0]
	if fenceChar != '`' && fenceChar != '~' {
		return nil, false
	}
	fenceLen := 0
	for fenceLen < len(trimmed) && trimmed[fenceLen] == fenceChar {
		fenceLen++
	}
	if fenceLen < 3 {
		return nil, false
	}

	rest := strings.TrimSpace(trimmed[fenceLen:])
	if rest == "" {
		return nil, false
	}

	rawLang := ""
	langEnd := 0
	for langEnd < len(rest) {
		ch := rest[langEnd]
		if ch == ' ' || ch == '\t' || ch == '/' || ch == '#' || ch == '-' || ch == '[' {
			break
		}
		langEnd++
	}
	rawLang = strings.TrimSpace(rest[:langEnd])
	rem := strings.TrimSpace(rest[langEnd:])

	return parseFileHandleRemnant(rem, rawLang, trimmed)
}

func parseFileHandleRemnant(rem, rawLang, rawFence string) (*CodeSlotHeader, bool) {
	if rem == "" {
		return nil, false
	}

	remNoComment := stripLineCommentPrefix(rem)
	fileIdxInRem := strings.Index(strings.ToLower(remNoComment), "file")
	var afterDigits string
	var fileIndex int

	if fileIdxInRem >= 0 {
		// Rejects slashes or alphanumerics before "file" so resolved paths like src/file2/x.ts#foo are never re-hydrated.
		for k := 0; k < fileIdxInRem; k++ {
			ch := remNoComment[k]
			if ch == ' ' || ch == '\t' || ch == '[' || ch == ']' || ch == '#' {
				continue
			}
			return nil, false
		}
		afterFile := remNoComment[fileIdxInRem+4:]
		p := 0
		for p < len(afterFile) && (afterFile[p] == ' ' || afterFile[p] == '\t') {
			p++
		}

		digitStart := p
		for p < len(afterFile) && afterFile[p] >= '0' && afterFile[p] <= '9' {
			p++
		}
		if p == digitStart {
			return nil, false
		}
		idx, err := strconv.Atoi(afterFile[digitStart:p])
		if err != nil || idx < 1 {
			return nil, false
		}
		// Restricts delimiters after fileIndex so root paths like file1.ts#sym are not mistaken for handles.
		tail := afterFile[p:]
		ts := 0
		for ts < len(tail) && (tail[ts] == ' ' || tail[ts] == '\t') {
			ts++
		}
		if ts < len(tail) && tail[ts] != '#' && tail[ts] != ']' {
			return nil, false
		}
		fileIndex = idx
		afterDigits = afterFile[p:]
	} else {
		bracketIdx := strings.Index(rem, "[")
		if bracketIdx < 0 {
			return nil, false
		}
		afterBracket := rem[bracketIdx+1:]
		p := 0
		for p < len(afterBracket) && (afterBracket[p] == ' ' || afterBracket[p] == '\t' || afterBracket[p] == '#') {
			p++
		}
		digitStart := p
		for p < len(afterBracket) && afterBracket[p] >= '0' && afterBracket[p] <= '9' {
			p++
		}
		if p == digitStart {
			return nil, false
		}
		idx, err := strconv.Atoi(afterBracket[digitStart:p])
		if err != nil || idx < 1 {
			return nil, false
		}
		fileIndex = idx
		afterDigits = afterBracket[p:]
	}

	header := &CodeSlotHeader{
		FileIndex: fileIndex,
		Aspect:    AspectAuto,
		RawLang:   rawLang,
		RawFence:  rawFence,
	}

	hashIdx := strings.Index(afterDigits, "#")
	if hashIdx >= 0 {
		anchorRaw := afterDigits[hashIdx+1:]
		bracketIdx := strings.Index(anchorRaw, "]")
		if bracketIdx >= 0 {
			anchorRaw = anchorRaw[:bracketIdx]
		}
		anchorRaw = strings.TrimSpace(anchorRaw)

		colonIdx := strings.Index(anchorRaw, ":")
		if colonIdx >= 0 {
			header.Aspect = NormalizeCodeAspect(anchorRaw[colonIdx+1:])
			anchorRaw = strings.TrimSpace(anchorRaw[:colonIdx])
		}

		if strings.HasPrefix(anchorRaw, "L") || strings.HasPrefix(anchorRaw, "l") || (len(anchorRaw) > 0 && anchorRaw[0] >= '0' && anchorRaw[0] <= '9') {
			sLine, eLine, isRange := parseLineRange(anchorRaw)
			if isRange {
				header.StartLine = sLine
				header.EndLine = eLine
			} else {
				header.Symbol = anchorRaw
			}
		} else {
			header.Symbol = anchorRaw
		}
	}

	return header, true
}

func parseXmlCodeSlotTag(tag string) (*CodeSlotHeader, bool) {
	header := &CodeSlotHeader{
		Aspect:   AspectAuto,
		RawFence: tag,
	}

	if idx := strings.Index(tag, "file="); idx >= 0 {
		sub := tag[idx+5:]
		sub = strings.TrimPrefix(sub, "\"")
		sub = strings.TrimPrefix(sub, "'")
		p := 0
		for p < len(sub) && sub[p] >= '0' && sub[p] <= '9' {
			p++
		}
		if p > 0 {
			if n, err := strconv.Atoi(sub[:p]); err == nil {
				header.FileIndex = n
			}
		}
	}
	if header.FileIndex < 1 {
		if path, sLine, eLine, ok := parseCodeSlotPathPayload(tag); ok {
			header.Path = path
			header.StartLine = sLine
			header.EndLine = eLine
			return header, true
		}
		return nil, false
	}

	if idx := strings.Index(tag, "symbol="); idx >= 0 {
		sub := tag[idx+7:]
		if len(sub) > 0 && (sub[0] == '"' || sub[0] == '\'') {
			quote := sub[0]
			sub = sub[1:]
			if endQ := strings.IndexByte(sub, quote); endQ >= 0 {
				header.Symbol = sub[:endQ]
			}
		}
	}

	if idx := strings.Index(tag, "aspect="); idx >= 0 {
		sub := tag[idx+7:]
		if len(sub) > 0 && (sub[0] == '"' || sub[0] == '\'') {
			quote := sub[0]
			sub = sub[1:]
			if endQ := strings.IndexByte(sub, quote); endQ >= 0 {
				header.Aspect = NormalizeCodeAspect(sub[:endQ])
			}
		}
	}

	if idx := strings.Index(tag, "lang="); idx >= 0 {
		sub := tag[idx+5:]
		if len(sub) > 0 && (sub[0] == '"' || sub[0] == '\'') {
			quote := sub[0]
			sub = sub[1:]
			if endQ := strings.IndexByte(sub, quote); endQ >= 0 {
				header.RawLang = sub[:endQ]
			}
		}
	}

	return header, true
}

func parseCodeSlotPathPayload(tag string) (path string, startLine, endLine int, ok bool) {
	idx := strings.Index(tag, "CODE_SLOT")
	if idx < 0 {
		return "", 0, 0, false
	}
	rest := tag[idx+len("CODE_SLOT"):]
	p := 0
	for p < len(rest) && (rest[p] == ' ' || rest[p] == '\t') {
		p++
	}
	if p >= len(rest) || rest[p] != ':' {
		return "", 0, 0, false
	}
	payload := rest[p+1:]
	if endIdx := strings.Index(payload, "-->"); endIdx >= 0 {
		payload = payload[:endIdx]
	}
	payload = strings.TrimSpace(strings.Trim(strings.TrimSpace(payload), "`"))
	if payload == "" {
		return "", 0, 0, false
	}
	if strings.HasSuffix(payload, ")") {
		if open := strings.LastIndex(payload, "("); open > 0 {
			inner := strings.TrimSpace(payload[open+1 : len(payload)-1])
			if s, e, isRange := parseLineRange(inner); isRange {
				return strings.TrimSpace(payload[:open]), s, e, true
			}
		}
	}
	// Requires a valid Lx-Ly suffix after ':' so colons inside file paths are not stripped.
	if c := strings.LastIndex(payload, ":"); c > 0 {
		if s, e, isRange := parseLineRange(strings.TrimSpace(payload[c+1:])); isRange {
			return strings.TrimSpace(payload[:c]), s, e, true
		}
	}
	return payload, 0, 0, true
}

func lookupFileIndexByPath(files []ArmorFileRef, path string) int {
	path = strings.TrimSpace(strings.Trim(strings.TrimSpace(path), "`"))
	if path == "" {
		return 0
	}
	for i := range files {
		if files[i].Path == path {
			return i + 1
		}
	}
	return 0
}

var lineCommentPrefixes = []string{"//", "#", "--", ";;", "%", "/*", "*"}

func stripLineCommentPrefix(line string) string {
	s := strings.TrimSpace(line)
	for s != "" {
		matched := false
		for _, p := range lineCommentPrefixes {
			if strings.HasPrefix(s, p) {
				s = strings.TrimSpace(strings.TrimPrefix(s, p))
				matched = true
				break
			}
		}
		if !matched {
			return s
		}
	}
	return s
}

func synthesizeFenceHeader(fenceChar byte, fenceLen int, rawLang string, header *CodeSlotHeader) (string, bool) {
	if header == nil || header.FileIndex < 1 {
		return "", false
	}
	if fenceLen < 3 {
		fenceLen = 3
	}
	anchor := header.Symbol
	if anchor == "" && header.StartLine > 0 {
		anchor = fmt.Sprintf("L%d", header.StartLine)
		if header.EndLine > header.StartLine {
			anchor = fmt.Sprintf("L%d-L%d", header.StartLine, header.EndLine)
		}
	}
	var b strings.Builder
	b.WriteString(strings.Repeat(string(fenceChar), fenceLen))
	if rawLang != "" {
		b.WriteString(rawLang)
	}
	b.WriteString(" // [File ")
	b.WriteString(strconv.Itoa(header.FileIndex))
	if anchor != "" {
		b.WriteString("#")
		b.WriteString(anchor)
	}
	if header.Aspect != "" && header.Aspect != AspectAuto {
		b.WriteString(":")
		b.WriteString(string(header.Aspect))
	}
	b.WriteString("]")
	return b.String(), true
}

const maxBodyHintLines = 3

// Any non-comment body line marks a freeform code block (e.g. step "[1]" or "// arr[1]") that stays verbatim.
func parseBodyCodeSlotHint(firstLine, bodyWithClose string, files []ArmorFileRef) (string, bool) {
	trimmed := strings.TrimSpace(firstLine)
	if trimmed == "" {
		return "", false
	}
	fenceChar := trimmed[0]
	if fenceChar != '`' && fenceChar != '~' {
		return "", false
	}
	fenceLen := 0
	for fenceLen < len(trimmed) && trimmed[fenceLen] == fenceChar {
		fenceLen++
	}
	if fenceLen < 3 {
		return "", false
	}
	rest := strings.TrimSpace(trimmed[fenceLen:])
	langEnd := 0
	for langEnd < len(rest) {
		ch := rest[langEnd]
		if ch == ' ' || ch == '\t' || ch == '/' || ch == '#' || ch == '-' || ch == '[' {
			break
		}
		langEnd++
	}
	rawLang := strings.TrimSpace(rest[:langEnd])
	if strings.TrimSpace(rest[langEnd:]) != "" {
		return "", false
	}

	var synth string
	found := false
	probed := 0
	for _, ln := range strings.Split(stripClosingFenceLine(bodyWithClose), "\n") {
		t := strings.TrimSpace(ln)
		if t == "" {
			continue
		}
		if probed < maxBodyHintLines && !found {
			probed++
			if header, ok := parseBodyHintLine(t, files); ok {
				if s, ok2 := synthesizeFenceHeader(fenceChar, fenceLen, rawLang, header); ok2 {
					synth, found = s, true
				}
			}
		}
		if !isBodyCommentLine(t) {
			return "", false
		}
	}
	if !found {
		return "", false
	}
	return synth, true
}

func parseBodyHintLine(t string, files []ArmorFileRef) (*CodeSlotHeader, bool) {
	if strings.HasPrefix(t, "<!--") && strings.Contains(t, "CODE_SLOT") {
		header, ok := parseXmlCodeSlotTag(t)
		if !ok {
			return nil, false
		}
		if header.FileIndex < 1 && header.Path != "" {
			header.FileIndex = lookupFileIndexByPath(files, header.Path)
		}
		return header, header.FileIndex >= 1
	}
	rem := stripLineCommentPrefix(t)
	if rem == t || rem == "" || !strings.HasPrefix(rem, "[") || !strings.HasSuffix(rem, "]") {
		return nil, false
	}
	header, ok := parseFileHandleRemnant(rem, "", t)
	if !ok || header.FileIndex < 1 {
		return nil, false
	}
	if !strings.HasPrefix(strings.ToLower(rem), "[file") && !strings.Contains(rem, "#") {
		return nil, false
	}
	return header, true
}

func isBodyCommentLine(t string) bool {
	if strings.HasPrefix(t, "<!--") {
		return true
	}
	return stripLineCommentPrefix(t) != t
}

func parseLineRange(raw string) (int, int, bool) {
	clean := strings.TrimPrefix(strings.TrimPrefix(raw, "L"), "l")
	parts := strings.Split(clean, "-")
	if len(parts) == 1 {
		p1 := strings.TrimPrefix(strings.TrimPrefix(parts[0], "L"), "l")
		if n, err := strconv.Atoi(p1); err == nil && n > 0 {
			return n, n, true
		}
		return 0, 0, false
	}
	if len(parts) == 2 {
		p1 := strings.TrimPrefix(strings.TrimPrefix(parts[0], "L"), "l")
		p2 := strings.TrimPrefix(strings.TrimPrefix(parts[1], "L"), "l")
		n1, err1 := strconv.Atoi(p1)
		n2, err2 := strconv.Atoi(p2)
		if err1 == nil && err2 == nil && n1 > 0 && n2 >= n1 {
			return n1, n2, true
		}
	}
	return 0, 0, false
}

func ExtractSymbolSignature(sourceCode, symName, lang string) string {
	raw := strings.TrimSpace(sourceCode)
	if raw == "" {
		return ""
	}
	lines := strings.Split(sourceCode, "\n")
	if len(lines) == 0 {
		return ""
	}

	startIdx := -1
	symLower := strings.ToLower(symName)
	for i, l := range lines {
		trimmed := strings.TrimSpace(l)
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "/*") {
			continue
		}
		if symLower != "" && strings.Contains(strings.ToLower(trimmed), symLower) {
			startIdx = i
			break
		}
	}
	if startIdx == -1 {
		startIdx = 0
	}

	docCommentStart := startIdx
	for docCommentStart > 0 {
		prev := strings.TrimSpace(lines[docCommentStart-1])
		if strings.HasPrefix(prev, "//") || strings.HasPrefix(prev, "#") || strings.HasPrefix(prev, "*") || strings.HasPrefix(prev, "/*") {
			docCommentStart--
			if startIdx-docCommentStart >= 5 {
				break
			}
		} else {
			break
		}
	}

	var commentLines []string
	for i := docCommentStart; i < startIdx; i++ {
		commentLines = append(commentLines, lines[i])
	}

	var sigLines []string
	if lang == "python" {
		parenDepth := 0
		for i := startIdx; i < len(lines); i++ {
			line := lines[i]
			sigLines = append(sigLines, line)
			for _, ch := range line {
				if ch == '(' || ch == '[' || ch == '{' {
					parenDepth++
				} else if ch == ')' || ch == ']' || ch == '}' {
					parenDepth--
				}
			}
			trimmed := strings.TrimSpace(line)
			if parenDepth <= 0 && strings.HasSuffix(trimmed, ":") {
				break
			}
			if i-startIdx >= 15 {
				break
			}
		}
		res := append(commentLines, sigLines...)
		lastIdx := len(res) - 1
		if lastIdx >= 0 {
			res[lastIdx] = strings.TrimRight(res[lastIdx], " ") + " ..."
		}
		return strings.Join(res, "\n")
	}

	isTypeDecl := false
	firstLine := strings.TrimSpace(lines[startIdx])
	if strings.HasPrefix(firstLine, "type ") || strings.HasPrefix(firstLine, "interface ") ||
		strings.Contains(firstLine, "struct {") || strings.Contains(firstLine, "interface {") ||
		strings.HasPrefix(firstLine, "export interface ") || strings.HasPrefix(firstLine, "export type ") {
		isTypeDecl = true
	}

	braceDepth := 0
	openedBrace := false
	for i := startIdx; i < len(lines); i++ {
		line := lines[i]
		sigLines = append(sigLines, line)
		for _, ch := range line {
			if ch == '{' {
				braceDepth++
				openedBrace = true
			} else if ch == '}' {
				braceDepth--
			}
		}

		if isTypeDecl {
			if openedBrace && braceDepth <= 0 {
				break
			}
		} else {
			if openedBrace {
				last := sigLines[len(sigLines)-1]
				bracePos := strings.Index(last, "{")
				if bracePos >= 0 {
					sigLines[len(sigLines)-1] = strings.TrimRight(last[:bracePos], " \t") + " { ... }"
				}
				break
			}
		}

		if i-startIdx >= 30 {
			sigLines = append(sigLines, "// ... [contract truncated]")
			break
		}
	}

	allLines := append(commentLines, sigLines...)
	return strings.Join(allLines, "\n")
}

type lineScopeState struct {
	depthAfter    int
	stackSnapshot []string
	trimmed       string
}

func stripLineBraces(line, lang string) (opens, closes int, lineIndent string) {
	indentEnd := 0
	for indentEnd < len(line) && (line[indentEnd] == ' ' || line[indentEnd] == '\t') {
		indentEnd++
	}
	lineIndent = line[:indentEnd]

	var inSingleQuote, inDoubleQuote, inBacktick bool
	for i := 0; i < len(line); i++ {
		ch := line[i]
		if ch == '\\' && (inSingleQuote || inDoubleQuote) && i+1 < len(line) {
			i++
			continue
		}
		if ch == '`' && !inSingleQuote && !inDoubleQuote {
			inBacktick = !inBacktick
			continue
		}
		if ch == '"' && !inSingleQuote && !inBacktick {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if ch == '\'' && !inDoubleQuote && !inBacktick {
			inSingleQuote = !inSingleQuote
			continue
		}
		if !inSingleQuote && !inDoubleQuote && !inBacktick {
			if ch == '/' && i+1 < len(line) && line[i+1] == '/' {
				break
			}
			if ch == '#' && (lang == "python" || lang == "ruby" || lang == "bash" || lang == "sh") {
				break
			}
			if ch == '{' {
				opens++
			} else if ch == '}' {
				closes++
			}
		}
	}
	return opens, closes, lineIndent
}

func SliceCodeByAspect(sourceCode, symName, lang string, aspect CodeAspect, actualStart, actualEnd int, maxLines int) string {
	raw := strings.TrimRight(sourceCode, "\r\n")
	if raw == "" {
		return "// [Source code slice unavailable in archive]"
	}

	if aspect == AspectContract {
		return ExtractSymbolSignature(raw, symName, lang)
	}

	if aspect == AspectFull {
		return raw
	}

	lines := strings.Split(raw, "\n")
	if maxLines <= 0 {
		maxLines = 40
	}

	if len(lines) <= maxLines {
		return raw
	}

	coordNotice := ""
	if actualStart > 0 && actualEnd >= actualStart {
		coordNotice = fmt.Sprintf(" (L%d-L%d)", actualStart, actualEnd)
	}

	normLang := strings.ToLower(strings.TrimSpace(lang))
	if normLang == "python" {
		ceiling := maxLines - 3
		if ceiling > len(lines)-1 {
			ceiling = len(lines) - 1
		}
		minRequired := 10
		if ceiling < minRequired {
			minRequired = ceiling / 2
		}

		baseIndent := 0
		for _, l := range lines {
			if strings.TrimSpace(l) != "" {
				baseIndent = len(l) - len(strings.TrimLeft(l, " "))
				break
			}
		}
		targetIndent := baseIndent + 4

		snapIdx := -1
		for i := ceiling; i >= minRequired; i-- {
			trimmed := strings.TrimSpace(lines[i])
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			leadingSpaces := len(lines[i]) - len(strings.TrimLeft(lines[i], " "))
			if leadingSpaces == targetIndent {
				snapIdx = i
				break
			}
		}
		if snapIdx == -1 {
			snapIdx = ceiling
		}

		for snapIdx > 0 && (strings.TrimSpace(lines[snapIdx]) == "" || strings.HasPrefix(strings.TrimSpace(lines[snapIdx]), "#")) {
			snapIdx--
		}

		keptLines := lines[:snapIdx+1]
		omittedCount := len(lines) - len(keptLines)

		var b strings.Builder
		b.WriteString(strings.Join(keptLines, "\n"))
		b.WriteString("\n")
		fmt.Fprintf(&b, "%s# ... [%d lines of internal implementation omitted for pedagogy%s]\n", strings.Repeat(" ", targetIndent), omittedCount, coordNotice)
		return strings.TrimRight(b.String(), "\n")
	}

	// Structured/script languages never snap via C-style braces to avoid emitting stray '}'.
	switch normLang {
	case "markdown", "md", "html", "xml", "bash", "sh", "zsh", "shell", "yaml", "yml", "toml", "sql", "text", "dockerfile":
		ceiling := maxLines - 3
		if ceiling > len(lines)-1 {
			ceiling = len(lines) - 1
		}
		minRequired := 10
		if ceiling < minRequired {
			minRequired = ceiling / 2
		}

		snapIdx := -1
		for i := ceiling; i >= minRequired; i-- {
			trimmed := strings.TrimSpace(lines[i])
			if trimmed == "" {
				snapIdx = i
				break
			}
		}
		if snapIdx == -1 {
			snapIdx = ceiling
		}

		for snapIdx > 0 && strings.TrimSpace(lines[snapIdx]) == "" {
			snapIdx--
		}

		keptLines := lines[:snapIdx+1]
		omittedCount := len(lines) - len(keptLines)

		var b strings.Builder
		b.WriteString(strings.Join(keptLines, "\n"))
		b.WriteString("\n")

		switch normLang {
		case "markdown", "md", "html", "xml":
			fmt.Fprintf(&b, "<!-- ... [%d lines omitted for pedagogy%s] -->\n", omittedCount, coordNotice)
		case "sql":
			fmt.Fprintf(&b, "-- ... [%d lines of defensive/internal logic omitted for pedagogy%s]\n", omittedCount, coordNotice)
		case "text":
			fmt.Fprintf(&b, "... [%d lines omitted for pedagogy%s]\n", omittedCount, coordNotice)
		default:
			fmt.Fprintf(&b, "# ... [%d lines of defensive/internal logic omitted for pedagogy%s]\n", omittedCount, coordNotice)
		}

		return strings.TrimRight(b.String(), "\n")
	}

	states := make([]lineScopeState, len(lines))
	var stack []string
	baseBodyDepth := 1

	defaultIndent := "\t"
	for _, l := range lines {
		if strings.HasPrefix(l, "\t") {
			defaultIndent = "\t"
			break
		}
		if strings.HasPrefix(l, "    ") {
			defaultIndent = "    "
			break
		}
	}

	for i, l := range lines {
		opens, closes, lineIndent := stripLineBraces(l, lang)
		for k := 0; k < opens; k++ {
			stack = append(stack, lineIndent)
		}
		for k := 0; k < closes; k++ {
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
		stackCopy := make([]string, len(stack))
		copy(stackCopy, stack)
		trimmed := strings.TrimSpace(l)
		states[i] = lineScopeState{
			depthAfter:    len(stack),
			stackSnapshot: stackCopy,
			trimmed:       trimmed,
		}
	}

	ceiling := maxLines - 3
	if ceiling > len(lines)-1 {
		ceiling = len(lines) - 1
	}
	minRequired := 10
	if ceiling < minRequired {
		minRequired = ceiling / 2
	}

	snapIdx := -1
	for i := ceiling; i >= minRequired; i-- {
		s := states[i]
		if s.depthAfter == baseBodyDepth && s.trimmed != "" && !strings.HasPrefix(s.trimmed, "//") && !strings.HasPrefix(s.trimmed, "/*") {
			snapIdx = i
			break
		}
	}

	if snapIdx == -1 {
		for i := ceiling; i >= minRequired; i-- {
			s := states[i]
			if s.depthAfter == baseBodyDepth+1 && s.trimmed != "" && !strings.HasPrefix(s.trimmed, "//") && !strings.HasPrefix(s.trimmed, "/*") {
				snapIdx = i
				break
			}
		}
	}

	if snapIdx == -1 {
		minD := 99999
		for i := ceiling; i >= minRequired; i-- {
			s := states[i]
			if s.trimmed != "" && s.depthAfter < minD {
				minD = s.depthAfter
				snapIdx = i
			}
		}
	}

	if snapIdx == -1 {
		snapIdx = ceiling
	}

	for snapIdx > 0 && (strings.TrimSpace(lines[snapIdx]) == "" || strings.HasPrefix(strings.TrimSpace(lines[snapIdx]), "//") || strings.HasPrefix(strings.TrimSpace(lines[snapIdx]), "/*")) {
		snapIdx--
	}

	keptLines := lines[:snapIdx+1]
	omittedCount := len(lines) - len(keptLines)
	snapState := states[snapIdx]

	var b strings.Builder
	b.WriteString(strings.Join(keptLines, "\n"))
	b.WriteString("\n")

	commentIndent := defaultIndent
	if len(snapState.stackSnapshot) > 0 {
		topIndent := snapState.stackSnapshot[len(snapState.stackSnapshot)-1]
		commentIndent = topIndent + defaultIndent
	}

	fmt.Fprintf(&b, "%s// ... [%d lines of defensive/internal logic omitted for pedagogy%s]\n", commentIndent, omittedCount, coordNotice)

	for k := len(snapState.stackSnapshot) - 1; k >= 0; k-- {
		braceIndent := snapState.stackSnapshot[k]
		fmt.Fprintf(&b, "%s}\n", braceIndent)
	}

	return strings.TrimRight(b.String(), "\n")
}

func HydrateCodeSlotsAndSnap(mdxContent string, files []ArmorFileRef, resolver CodeSlotResolver) string {
	if mdxContent == "" || len(files) == 0 {
		return mdxContent
	}

	parts := armorSplitByFence(mdxContent)
	hydratedBareDocFiles := make(map[int]bool)
	for i := 1; i < len(parts); i += 2 {
		codeBlock := parts[i]
		if codeBlock == "" {
			continue
		}

		newlineIdx := strings.Index(codeBlock, "\n")
		if newlineIdx < 0 {
			continue
		}
		firstLine := codeBlock[:newlineIdx]
		bodyWithClose := codeBlock[newlineIdx+1:]

		header, ok := ParseCodeSlotHeader(firstLine)
		if !ok {
			if synthesized, synthOk := parseBodyCodeSlotHint(firstLine, bodyWithClose, files); synthOk {
				if synthHeader, synthHeaderOk := ParseCodeSlotHeader(synthesized); synthHeaderOk {
					header, ok = synthHeader, true
					firstLine = synthesized
				}
			}
		}
		if !ok || header.FileIndex < 1 || header.FileIndex > len(files) {
			continue
		}

		fileRef := files[header.FileIndex-1]
		relPath := fileRef.Path

		fenceChar := byte('`')
		trimmedFirst := strings.TrimSpace(firstLine)
		if strings.HasPrefix(trimmedFirst, "~") {
			fenceChar = '~'
		}
		initialCount := 0
		for initialCount < len(trimmedFirst) && trimmedFirst[initialCount] == fenceChar {
			initialCount++
		}
		if initialCount < 3 {
			initialCount = 3
		}

		isDocTarget := DetectSourceLanguage(relPath) == "markdown"
		isBareWholeFile := header.Symbol == "" && header.StartLine == 0 && header.EndLine == 0
		hasBody := hasRealCodeBody(bodyWithClose)

		// Protects authored protocol examples from bare .md overwrites; strips only the misleading handle.
		if isDocTarget && isBareWholeFile && hasBody && !isDocOrTextLang(header.RawLang) {
			cleanHeader := stripHandleKeepLangFenceHeader(fenceChar, initialCount, header.RawLang)
			parts[i] = cleanHeader + "\n" + bodyWithClose
			continue
		}

		// Hydrates bare whole-.md handles at most once per chapter to prevent duplicate content flooding.
		if isDocTarget && isBareWholeFile && hydratedBareDocFiles[header.FileIndex] {
			if hasBody {
				cleanHeader := stripHandleKeepLangFenceHeader(fenceChar, initialCount, header.RawLang)
				parts[i] = cleanHeader + "\n" + bodyWithClose
			} else {
				dropFencePartAndCollapseNewlines(parts, i)
			}
			continue
		}

		var sourceCode string
		var actualStart, actualEnd int
		var found bool

		if resolver != nil {
			sourceCode, actualStart, actualEnd, found = resolver(header.FileIndex, relPath, header.Symbol, header.StartLine, header.EndLine)
		}

		if !found || strings.TrimSpace(sourceCode) == "" {
			trimmedBody := strings.TrimSpace(bodyWithClose)
			if trimmedBody == "```" || trimmedBody == "~~~" || hasCodeSlotMarkerLine(bodyWithClose) {
				closingFence := "```"
				if strings.HasPrefix(firstLine, "~~~") {
					closingFence = "~~~"
				}
				parts[i] = firstLine + "\n// [Source code for " + header.Symbol + " not found in archive]\n" + closingFence
			}
			continue
		}

		lang := resolveSlotLanguage(relPath, header.RawLang, header.Symbol != "")
		if isDocTarget && isBareWholeFile {
			hydratedBareDocFiles[header.FileIndex] = true
		}

		slicedCode := SliceCodeByAspect(sourceCode, header.Symbol, lang, header.Aspect, actualStart, actualEnd, 40)

		maxInner := 0
		curInner := 0
		for k := 0; k < len(slicedCode); k++ {
			if slicedCode[k] == fenceChar {
				curInner++
				if curInner > maxInner {
					maxInner = curInner
				}
			} else {
				curInner = 0
			}
		}

		targetCount := initialCount
		if maxInner >= targetCount {
			targetCount = maxInner + 1
		}

		closingFence := strings.Repeat(string(fenceChar), targetCount)

		cleanFenceHeader := rewriteFenceHeader(firstLine, fenceChar, targetCount, lang)

		parts[i] = cleanFenceHeader + "\n" + slicedCode + "\n" + closingFence
	}

	return strings.Join(parts, "")
}

func isDocOrTextLang(rawLang string) bool {
	switch strings.ToLower(strings.TrimSpace(rawLang)) {
	case "", "md", "markdown", "mdx", "text", "txt", "plain":
		return true
	default:
		return false
	}
}

func hasRealCodeBody(bodyWithClose string) bool {
	body := stripClosingFenceLine(bodyWithClose)
	for _, ln := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(ln)
		if trimmed == "" {
			continue
		}
		if hasCodeSlotMarkerLine(trimmed) || isBodyCommentLine(trimmed) {
			continue
		}
		return true
	}
	return false
}

func stripHandleKeepLangFenceHeader(fenceChar byte, fenceCount int, rawLang string) string {
	return strings.Repeat(string(fenceChar), fenceCount) + strings.TrimSpace(rawLang)
}

// Keeps explicit non-doc language on .md#symbol snippets; otherwise prefers physical file extension.
func resolveSlotLanguage(relPath, rawLang string, hasSymbol bool) string {
	detected := DetectSourceLanguage(relPath)
	if detected == "markdown" && hasSymbol && !isDocOrTextLang(rawLang) {
		return strings.TrimSpace(rawLang)
	}
	if detected != "" && detected != "text" {
		return detected
	}
	if trimmed := strings.TrimSpace(rawLang); trimmed != "" {
		return trimmed
	}
	return "text"
}

// Preserves whitespace between lang and handle because ResolveFileHandles expects a space separator.
func rewriteFenceHeader(firstLine string, fenceChar byte, targetCount int, targetLang string) string {
	cleaned := stripAspectFromFence(firstLine)
	trimmed := strings.TrimSpace(cleaned)
	fenceLen := 0
	for fenceLen < len(trimmed) && trimmed[fenceLen] == fenceChar {
		fenceLen++
	}
	rest := strings.TrimLeft(trimmed[fenceLen:], " \t")
	langEnd := 0
	for langEnd < len(rest) {
		ch := rest[langEnd]
		if ch == ' ' || ch == '\t' || ch == '/' || ch == '#' || ch == '-' || ch == '[' {
			break
		}
		langEnd++
	}
	afterLang := rest[langEnd:]
	if afterLang != "" && afterLang[0] != ' ' && afterLang[0] != '\t' {
		afterLang = " " + afterLang
	}
	return strings.Repeat(string(fenceChar), targetCount) + targetLang + afterLang
}

func stripAspectFromFence(line string) string {
	for _, asp := range []string{":contract", ":core", ":full", ":implementation"} {
		if idx := strings.Index(line, asp); idx >= 0 {
			return line[:idx] + line[idx+len(asp):]
		}
	}
	return line
}

func IsResolvedFenceHeader(firstLine string) bool {
	t := strings.TrimSpace(firstLine)
	if len(t) < 3 || (t[0] != '`' && t[0] != '~') {
		return false
	}
	fenceLen := 0
	for fenceLen < len(t) && t[fenceLen] == t[0] {
		fenceLen++
	}
	if fenceLen < 3 {
		return false
	}
	rest := t[fenceLen:]
	langEnd := 0
	for langEnd < len(rest) {
		ch := rest[langEnd]
		if ch == ' ' || ch == '\t' || ch == '/' || ch == '#' || ch == '-' || ch == '[' {
			break
		}
		langEnd++
	}
	if langEnd >= len(rest) || (rest[langEnd] != ' ' && rest[langEnd] != '\t') {
		return false
	}
	fields := strings.Fields(stripLineCommentPrefix(strings.TrimSpace(rest[langEnd:])))
	if len(fields) == 0 || len(fields) > 2 {
		return false
	}
	pathToken := fields[0]
	if strings.HasPrefix(pathToken, "[") {
		return false
	}
	if hash := strings.IndexByte(pathToken, '#'); hash >= 0 {
		if hash == len(pathToken)-1 {
			return false
		}
		pathToken = pathToken[:hash]
	} else if len(fields) == 2 && !isLineRefToken(fields[1]) {
		return false
	}
	return isPathLikeToken(pathToken)
}

func isPathLikeToken(token string) bool {
	return token != "" && (strings.Contains(token, "/") || mdpat.ExtTailRe.MatchString(token))
}

func isLineRefToken(tok string) bool {
	if len(tok) < 4 || tok[0] != '(' || tok[len(tok)-1] != ')' {
		return false
	}
	_, _, ok := parseLineRange(tok[1 : len(tok)-1])
	return ok
}

type ResidualSlot struct {
	BlockIndex int    `json:"blockIndex"`
	Kind       string `json:"kind"`
	Snippet    string `json:"snippet"`
}

const (
	ResidualKindMarker       = "code_slot_marker"
	ResidualKindNotFoundSent = "not_found_sentinel"
	ResidualKindEmptyBlock   = "empty_block"
)

const (
	notFoundSentinelPrefix = "// [Source code for "
	notFoundSentinelSuffix = " not found in archive]"
)

const residualSnippetMaxLen = 80

// Unhydrated handles, empty non-mermaid fences, or failure sentinels block DB persistence (fail-closed).
func ScanResidualCodeSlots(mdxContent string) []ResidualSlot {
	if strings.TrimSpace(mdxContent) == "" {
		return nil
	}
	parts := armorSplitByFence(mdxContent)
	var residuals []ResidualSlot
	blockIndex := 0
	for i := 0; i < len(parts); i++ {
		if i%2 == 1 {
			blockIndex++
			if r, ok := scanFencedBlockResidual(parts[i], blockIndex); ok {
				residuals = append(residuals, r)
			}
			continue
		}
		for _, ln := range strings.Split(parts[i], "\n") {
			if isCodeSlotMarkerLine(ln) {
				residuals = append(residuals, ResidualSlot{
					BlockIndex: 0,
					Kind:       ResidualKindMarker,
					Snippet:    truncateResidualSnippet(strings.TrimSpace(ln)),
				})
			}
		}
	}
	return residuals
}

func scanFencedBlockResidual(block string, blockIndex int) (ResidualSlot, bool) {
	newlineIdx := strings.Index(block, "\n")
	if newlineIdx < 0 {
		return ResidualSlot{}, false
	}
	firstLine := strings.TrimSpace(block[:newlineIdx])
	body := block[newlineIdx+1:]

	if hasCodeSlotMarkerLine(body) {
		return ResidualSlot{
			BlockIndex: blockIndex,
			Kind:       ResidualKindMarker,
			Snippet:    truncateResidualSnippet(firstLine),
		}, true
	}
	if strings.Contains(body, notFoundSentinelPrefix) && strings.Contains(body, notFoundSentinelSuffix) {
		return ResidualSlot{
			BlockIndex: blockIndex,
			Kind:       ResidualKindNotFoundSent,
			Snippet:    truncateResidualSnippet(firstLine),
		}, true
	}
	if isMermaidFenceLine(firstLine) {
		return ResidualSlot{}, false
	}
	if strings.TrimSpace(stripClosingFenceLine(body)) == "" {
		return ResidualSlot{
			BlockIndex: blockIndex,
			Kind:       ResidualKindEmptyBlock,
			Snippet:    truncateResidualSnippet(firstLine),
		}, true
	}
	return ResidualSlot{}, false
}

// Matches only standalone HTML placeholders so hydrated source containing "CODE_SLOT" literals does not false-positive.
func hasCodeSlotMarkerLine(body string) bool {
	commentOnly := true
	for _, ln := range strings.Split(body, "\n") {
		t := strings.TrimSpace(ln)
		if t == "" || isClosingFenceLine(t) {
			continue
		}
		if isCodeSlotMarkerLine(t) {
			return true
		}
		if !isBodyCommentLine(t) {
			commentOnly = false
		}
	}
	return commentOnly && strings.Contains(body, "CODE_SLOT")
}

func isCodeSlotMarkerLine(line string) bool {
	t := strings.TrimSpace(line)
	return strings.HasPrefix(t, "<!--") && strings.Contains(t, "CODE_SLOT")
}

func isClosingFenceLine(t string) bool {
	t = strings.TrimSpace(t)
	if len(t) < 3 || (t[0] != '`' && t[0] != '~') {
		return false
	}
	return strings.Trim(t, string(t[0])) == ""
}

func isMermaidFenceLine(firstLine string) bool {
	if len(firstLine) < 3 || (firstLine[0] != '`' && firstLine[0] != '~') {
		return false
	}
	fenceLen := 0
	for fenceLen < len(firstLine) && firstLine[fenceLen] == firstLine[0] {
		fenceLen++
	}
	rest := firstLine[fenceLen:]
	langEnd := 0
	for langEnd < len(rest) {
		ch := rest[langEnd]
		if ch == ' ' || ch == '\t' || ch == '/' || ch == '#' || ch == '-' || ch == '[' {
			break
		}
		langEnd++
	}
	return strings.TrimSpace(rest[:langEnd]) == "mermaid"
}

func stripClosingFenceLine(body string) string {
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	if len(lines) == 0 {
		return body
	}
	last := strings.TrimSpace(lines[len(lines)-1])
	if len(last) >= 3 && (last[0] == '`' || last[0] == '~') {
		onlyFence := true
		for k := 0; k < len(last); k++ {
			if last[k] != last[0] {
				onlyFence = false
				break
			}
		}
		if onlyFence {
			return strings.Join(lines[:len(lines)-1], "\n")
		}
	}
	return body
}

func truncateResidualSnippet(s string) string {
	return mdpat.TruncateRunes(strings.TrimSpace(s), residualSnippetMaxLen, "…")
}

type SlotEdit struct {
	BlockIndex  int
	Mode        string
	FenceHeader string
}

const (
	SlotEditModeMap  = "map"
	SlotEditModeDrop = "drop"
)

func ApplyFencedBlockEdits(mdxContent string, edits []SlotEdit) string {
	if len(edits) == 0 || strings.TrimSpace(mdxContent) == "" {
		return mdxContent
	}
	editByIndex := make(map[int]SlotEdit, len(edits))
	dropped := make(map[int]bool)
	for _, e := range edits {
		if e.BlockIndex < 1 {
			continue
		}
		if e.Mode == SlotEditModeDrop {
			dropped[e.BlockIndex] = true
			continue
		}
		if e.Mode == SlotEditModeMap && strings.TrimSpace(e.FenceHeader) != "" {
			editByIndex[e.BlockIndex] = e
		}
	}
	if len(editByIndex) == 0 && len(dropped) == 0 {
		return mdxContent
	}

	parts := armorSplitByFence(mdxContent)
	blockIndex := 0
	for i := 1; i < len(parts); i += 2 {
		blockIndex++
		if edit, ok := editByIndex[blockIndex]; ok {
			closing := closingFenceForHeader(edit.FenceHeader)
			parts[i] = edit.FenceHeader + "\n" + closing
			continue
		}
		if dropped[blockIndex] {
			dropFencePartAndCollapseNewlines(parts, i)
		}
	}
	return strings.Join(parts, "")
}

func dropFencePartAndCollapseNewlines(parts []string, i int) {
	parts[i] = ""
	if i+1 < len(parts) {
		prev := strings.TrimRight(parts[i-1], "\n")
		next := strings.TrimLeft(parts[i+1], "\n")
		if strings.TrimSpace(prev) == "" {
			parts[i-1] = next
			parts[i+1] = ""
		} else if strings.TrimSpace(next) == "" {
			parts[i-1] = prev + "\n\n"
			parts[i+1] = ""
		} else {
			parts[i-1] = prev + "\n\n"
			parts[i+1] = next
		}
	} else {
		parts[i-1] = strings.TrimRight(parts[i-1], "\n") + "\n"
	}
}

func closingFenceForHeader(header string) string {
	t := strings.TrimSpace(header)
	if len(t) >= 3 && (t[0] == '`' || t[0] == '~') {
		n := 0
		for n < len(t) && t[n] == t[0] {
			n++
		}
		if n >= 3 {
			return strings.Repeat(string(t[0]), n)
		}
	}
	return "```"
}

type FencedBlockView struct {
	Index          int
	FirstLine      string
	Lang           string
	Body           string
	BodyDroppable  bool
	PrecedingProse string
}

func EnumerateFencedBlocks(mdxContent string) []FencedBlockView {
	parts := armorSplitByFence(mdxContent)
	views := make([]FencedBlockView, 0)
	idx := 0
	for i := 1; i < len(parts); i += 2 {
		idx++
		block := parts[i]
		newlineIdx := strings.Index(block, "\n")
		if newlineIdx < 0 {
			continue
		}
		firstLine := block[:newlineIdx]
		body := block[newlineIdx+1:]
		views = append(views, FencedBlockView{
			Index:          idx,
			FirstLine:      firstLine,
			Lang:           fenceLineLang(firstLine),
			Body:           body,
			BodyDroppable:  blockBodyDroppable(body),
			PrecedingProse: parts[i-1],
		})
	}
	return views
}

type FencedRegion struct {
	IsFence bool
	Text    string
}

func SplitFencedRegions(content string) []FencedRegion {
	parts := armorSplitByFence(content)
	regions := make([]FencedRegion, 0, len(parts))
	for i, p := range parts {
		regions = append(regions, FencedRegion{IsFence: i%2 == 1, Text: p})
	}
	return regions
}

func fenceLineLang(firstLine string) string {
	t := strings.TrimSpace(firstLine)
	if len(t) < 3 || (t[0] != '`' && t[0] != '~') {
		return ""
	}
	n := 0
	for n < len(t) && t[n] == t[0] {
		n++
	}
	rest := t[n:]
	langEnd := 0
	for langEnd < len(rest) {
		ch := rest[langEnd]
		if ch == ' ' || ch == '\t' || ch == '/' || ch == '#' || ch == '-' || ch == '[' {
			break
		}
		langEnd++
	}
	return strings.TrimSpace(rest[:langEnd])
}

func blockBodyDroppable(body string) bool {
	content := strings.TrimSpace(stripClosingFenceLine(body))
	if content == "" {
		return true
	}
	for _, ln := range strings.Split(content, "\n") {
		t := strings.TrimSpace(ln)
		if t == "" {
			continue
		}
		if isCodeSlotMarkerLine(t) {
			continue
		}
		if strings.HasPrefix(t, notFoundSentinelPrefix) && strings.HasSuffix(t, notFoundSentinelSuffix) {
			continue
		}
		return false
	}
	return true
}

package armor

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// CodeAspect 代码切片认知阶梯。
type CodeAspect string

const (
	AspectAuto     CodeAspect = "auto"     // <= 40 LOC: 完整展示; > 40 LOC: 自动降采样至 core
	AspectCore     CodeAspect = "core"     // 核心实现骨架 + 物理行号折叠锚点 (<= 40 LOC)
	AspectContract CodeAspect = "contract" // 纯接口契约与签名 (无方法体)
	AspectFull     CodeAspect = "full"     // 100% 完整物理源码
)

// NormalizeCodeAspect 归一化 aspect 字符串。
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

// CodeSlotHeader 代码围栏头部解析结果。
type CodeSlotHeader struct {
	FileIndex int        `json:"fileIndex"` // 1-based 文件序号 (对应 [File N])
	Symbol    string     `json:"symbol"`    // 符号名 (例如 InitScheduler)
	StartLine int        `json:"startLine"` // 起始行号 (可选)
	EndLine   int        `json:"endLine"`   // 结束行号 (可选)
	Aspect    CodeAspect `json:"aspect"`    // 认知切片层级
	RawLang   string     `json:"rawLang"`   // 代码语言标记 (go, ts, 等)
	RawFence  string     `json:"rawFence"`  // 原始首行
}

// CodeSlotResolver 代码插槽物理源解析回调函数。
// 入参: fileIndex (1-based), relPath, symbol, requestedStartLine, requestedEndLine
// 出参: sourceCode (物理源码切片), actualStartLine, actualEndLine, found
type CodeSlotResolver func(fileIndex int, relPath, symbol string, reqStart, reqEnd int) (sourceCode string, actualStart, actualEnd int, found bool)

// DetectSourceLanguage 根据文件路径后缀推断代码围栏高亮语言（纯确定性映射，零语法正则）。
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

// ParseCodeSlotHeader 纯确定性状态机解析代码围栏首行或插槽占位符（零语法正则，严格符合 Chomsky 边界）。
// 支持格式：
//   - ```go // [File 1#InitScheduler]
//   - ```ts // [File 1#InitScheduler:core]
//   - ```ts // [File 1#InitScheduler:contract]
//   - ```go // [File 2#L10-L45]
//   - ```go // [File 2#L10-L45:contract]
//   - ```go [File 1#InitScheduler]
//   - <!-- CODE_SLOT:file=1 symbol="InitScheduler" aspect="core" -->
func ParseCodeSlotHeader(firstLine string) (*CodeSlotHeader, bool) {
	trimmed := strings.TrimSpace(firstLine)
	if trimmed == "" {
		return nil, false
	}

	// 1. 检查 XML 样式的独立插槽标签 <!-- CODE_SLOT:... -->
	if strings.HasPrefix(trimmed, "<!--") && strings.Contains(trimmed, "CODE_SLOT") {
		return parseXmlCodeSlotTag(trimmed)
	}

	// 2. 检查 Markdown 代码围栏起始行 (``` 或 ~~~，支持 >= 3 个字符)
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

	// 提取语言标记 (遇到空白或注释/括号标记截止)
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

	// 寻找 "file" 关键词或直接识别 [1#...] / [#1#...] 简写句柄形态
	fileIdxInRem := strings.Index(strings.ToLower(rem), "file")
	var afterDigits string
	var fileIndex int

	if fileIdxInRem >= 0 {
		afterFile := rem[fileIdxInRem+4:]
		// 消费空格或制表符
		p := 0
		for p < len(afterFile) && (afterFile[p] == ' ' || afterFile[p] == '\t') {
			p++
		}

		// 扫描数字 fileIndex
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
		fileIndex = idx
		afterDigits = afterFile[p:]
	} else {
		// 兼容简写句柄形态：如 `[1#symbol]` 或 `[#1#symbol]`
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
		RawFence:  trimmed,
	}

	// 检查是否有 '#' 锚点 (符号或行号)
	hashIdx := strings.Index(afterDigits, "#")
	if hashIdx >= 0 {
		anchorRaw := afterDigits[hashIdx+1:]
		// 截取到 ']' 或行末
		bracketIdx := strings.Index(anchorRaw, "]")
		if bracketIdx >= 0 {
			anchorRaw = anchorRaw[:bracketIdx]
		}
		anchorRaw = strings.TrimSpace(anchorRaw)

		// 检查是否有 ':' aspect 后缀 (例如 InitScheduler:core 或 L10-L45:contract)
		colonIdx := strings.Index(anchorRaw, ":")
		if colonIdx >= 0 {
			header.Aspect = NormalizeCodeAspect(anchorRaw[colonIdx+1:])
			anchorRaw = strings.TrimSpace(anchorRaw[:colonIdx])
		}

		// 判定是行号区间还是符号名
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

	// 提取 file=(\d+)
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
		return nil, false
	}

	// 提取 symbol="..."
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

	// 提取 aspect="..."
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

	// 提取 lang="..."
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

// ExtractSymbolSignature 纯确定性状态机提取代码符号接口契约与签名（零语法正则，严格遵守 Chomsky 边界与 GO-004）。
func ExtractSymbolSignature(sourceCode, symName, lang string) string {
	raw := strings.TrimSpace(sourceCode)
	if raw == "" {
		return ""
	}
	lines := strings.Split(sourceCode, "\n")
	if len(lines) == 0 {
		return ""
	}

	// 1. 查找包含 symName 的声明起始行
	startIdx := -1
	symLower := strings.ToLower(symName)
	for i, l := range lines {
		trimmed := strings.TrimSpace(l)
		// 忽略纯单行注释
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

	// 2. 收集紧邻的前置文档注释（最多 5 行）
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

	// 3. 扫描签名主体
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

	// Go / TS / Rust / C / Java 等类 C 语言：
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
			// 类型定义：捕获至匹配闭合括号 }（最多 30 行）
			if openedBrace && braceDepth <= 0 {
				break
			}
		} else {
			// 函数/方法签名：捕获到首个开括号 '{'
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

// SliceCodeByAspect 结合认知阶梯 (aspect) 与最大行数限制进行确定性降采样剪裁。
// 规则：
//   - aspect == AspectContract: 提取纯函数签名/类型声明；
//   - aspect == AspectFull: 100% 完整返回；
//   - len(lines) <= maxLines: 完整返回；
//   - len(lines) > maxLines 且 (aspect == AspectCore 或 AspectAuto):
//     提取前 maxLines-5 行核心逻辑，并注入折叠行号提示锚点，确保教学梯度不被 300 行垃圾代码淹没。
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

// SliceCodeByAspect 结合认知阶梯 (aspect) 与最大行数限制进行确定性降采样剪裁。
// 规则：
//   - aspect == AspectContract: 提取纯函数签名/类型声明；
//   - aspect == AspectFull: 100% 完整返回；
//   - len(lines) <= maxLines: 完整返回；
//   - len(lines) > maxLines 且 (aspect == AspectCore 或 AspectAuto):
//     基于第一性原理：采用 AST/语句块边界吸附 (Block-Boundary Snapping) 与缩进继承，
//     绝不在深层嵌套内部半截腰斩，消除顶格孤立括号堆叠，保证最高教学阅读质量。
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

		snapIdx := -1
		for i := ceiling; i >= minRequired; i-- {
			trimmed := strings.TrimSpace(lines[i])
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			leadingSpaces := len(lines[i]) - len(strings.TrimLeft(lines[i], " "))
			if leadingSpaces == 4 {
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
		fmt.Fprintf(&b, "    # ... [%d lines of internal implementation omitted for pedagogy%s]\n", omittedCount, coordNotice)
		return strings.TrimRight(b.String(), "\n")
	}

	// 结构化文本/文档/脚本语言（Markdown, HTML, Bash, YAML, TOML, SQL, Text 等）：
	// 遵循 Chomsky 边界与第一性原理，绝不按类 C 作用域截断，绝不输出无效大括号 }。
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
		// 优先吸附到空行作为自然段落切分点
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

		// 回退清除属于截断段落的前置空行
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
			fmt.Fprintf(&b, "<!-- ... [%d lines of defensive/internal logic omitted for pedagogy%s] -->\n", omittedCount, coordNotice)
		case "sql":
			fmt.Fprintf(&b, "-- ... [%d lines of defensive/internal logic omitted for pedagogy%s]\n", omittedCount, coordNotice)
		case "text":
			fmt.Fprintf(&b, "... [%d lines of defensive/internal logic omitted for pedagogy%s]\n", omittedCount, coordNotice)
		default: // bash, sh, zsh, shell, yaml, yml, toml, dockerfile
			fmt.Fprintf(&b, "# ... [%d lines of defensive/internal logic omitted for pedagogy%s]\n", omittedCount, coordNotice)
		}

		return strings.TrimRight(b.String(), "\n")
	}

	// 类 C 语言（Go, TS, JS, Rust, C, Java 等）：基于作用域深度与语句边界吸附
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
	// Tier 1: 优先吸附到 baseBodyDepth (深度 1) 的顶层语句闭合点
	for i := ceiling; i >= minRequired; i-- {
		s := states[i]
		if s.depthAfter == baseBodyDepth && s.trimmed != "" && !strings.HasPrefix(s.trimmed, "//") && !strings.HasPrefix(s.trimmed, "/*") {
			snapIdx = i
			break
		}
	}

	// Tier 2: 次级吸附到 baseBodyDepth + 1 (深度 2) 的子语句闭合点
	if snapIdx == -1 {
		for i := ceiling; i >= minRequired; i-- {
			s := states[i]
			if s.depthAfter == baseBodyDepth+1 && s.trimmed != "" && !strings.HasPrefix(s.trimmed, "//") && !strings.HasPrefix(s.trimmed, "/*") {
				snapIdx = i
				break
			}
		}
	}

	// Tier 3: 局部最小深度保底
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

	// 回退清除属于下一条被截断语句的前置注释与空白行
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

	// 按作用域深度逐层闭合未闭合的大括号，严格匹配其父作用域物理缩进
	for k := len(snapState.stackSnapshot) - 1; k >= 0; k-- {
		braceIndent := snapState.stackSnapshot[k]
		fmt.Fprintf(&b, "%s}\n", braceIndent)
	}

	return strings.TrimRight(b.String(), "\n")
}

// HydrateCodeSlotsAndSnap MDX 代码插槽水合与隐式智能吸附核心：
// 遍历 MDX 围栏代码块，对声明了物理句柄 [File N#...] 的代码块，
// 强行从 resolver 注入绝对真实的 Git 物理切片，抹平 LLM 的手痒幻觉或截断注释。
// 未声明 [File N] 的自由概念代码块（如作者手写伪代码、bash 示例）100% 原样保留。
func HydrateCodeSlotsAndSnap(mdxContent string, files []ArmorFileRef, resolver CodeSlotResolver) string {
	if mdxContent == "" || len(files) == 0 {
		return mdxContent
	}

	parts := armorSplitByFence(mdxContent)
	for i := 1; i < len(parts); i += 2 {
		codeBlock := parts[i]
		if codeBlock == "" {
			continue
		}

		// 分离首行 fence
		newlineIdx := strings.Index(codeBlock, "\n")
		if newlineIdx < 0 {
			continue
		}
		firstLine := codeBlock[:newlineIdx]
		bodyWithClose := codeBlock[newlineIdx+1:]

		// 解析首行是否含有代码插槽 / [File N] 声明
		header, ok := ParseCodeSlotHeader(firstLine)
		if !ok || header.FileIndex < 1 || header.FileIndex > len(files) {
			continue
		}

		fileRef := files[header.FileIndex-1]
		relPath := fileRef.Path

		var sourceCode string
		var actualStart, actualEnd int
		var found bool

		if resolver != nil {
			sourceCode, actualStart, actualEnd, found = resolver(header.FileIndex, relPath, header.Symbol, header.StartLine, header.EndLine)
		}

		if !found || strings.TrimSpace(sourceCode) == "" {
			// 若 resolver 未查到该符号切片，但该块确实是占位符或空块，补齐优雅提示
			trimmedBody := strings.TrimSpace(bodyWithClose)
			if trimmedBody == "```" || trimmedBody == "~~~" || strings.Contains(trimmedBody, "CODE_SLOT") {
				closingFence := "```"
				if strings.HasPrefix(firstLine, "~~~") {
					closingFence = "~~~"
				}
				parts[i] = firstLine + "\n// [Source code for " + header.Symbol + " not found in archive]\n" + closingFence
			}
			continue
		}

		lang := header.RawLang
		if lang == "" {
			lang = DetectSourceLanguage(relPath)
		}

		// 应用认知降采样切片
		slicedCode := SliceCodeByAspect(sourceCode, header.Symbol, lang, header.Aspect, actualStart, actualEnd, 40)

		// 闭合围栏标记匹配与 CommonMark 围栏升阶：
		// 若注入代码内部含有连续反引号或波浪线（例如 Markdown 文件内嵌 bash 代码块），
		// 外层围栏必须升阶到比内嵌代码块的最大连续字符数至少多 1 个字符，
		// 严防内层 ``` 提前闭合外层围栏（Chomsky Boundary 乔姆斯基边界防穿透）。
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

		// 扫描 slicedCode 中连续 fenceChar 的最大长度
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

		// 清洗 aspect 标记，还原为标准 [File N#...] 句柄形态供 Stage 2 ResolveFileHandles 还原真实路径
		cleanFenceHeader := stripAspectFromFence(firstLine)
		if targetCount > initialCount {
			// 将首行开头的初始围栏升级为 targetCount 个字符
			cleanFenceHeader = strings.Repeat(string(fenceChar), targetCount) + strings.TrimLeft(cleanFenceHeader, string(fenceChar))
		}

		// 隐式吸附覆写
		parts[i] = cleanFenceHeader + "\n" + slicedCode + "\n" + closingFence
	}

	return strings.Join(parts, "")
}

func stripAspectFromFence(line string) string {
	for _, asp := range []string{":contract", ":core", ":full", ":implementation"} {
		if idx := strings.Index(line, asp); idx >= 0 {
			return line[:idx] + line[idx+len(asp):]
		}
	}
	return line
}

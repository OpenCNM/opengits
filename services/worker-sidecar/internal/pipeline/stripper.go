package pipeline

import (
	"encoding/json"
	"log"
	"strconv"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// stripOuterFence 如果整个文本首行与末行形成匹配的包裹代码围栏（```markdown ... ``` 等），剥除外层围栏。
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

// HasUnpeeledJSONShell 探测文本是否包含未剥离的顶层或首部 JSON 包裹外壳（如 {"lessonMarkdown": ...}）。
// 作为收敛漏斗与 Finalize 的失效封闭硬闸门（Fail-Closed Gate），杜绝剥壳失败的残破 JSON 冒充 MDX 溜入内容存储层。
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

// findMarkdownInMap 在 JSON 解析出的 map 中定位目标 markdown 字段（支持嵌套容器 data/response/result/payload/output/choices）。
func findMarkdownInMap(m map[string]any, depth int) (string, string) {
	if depth > 4 || len(m) == 0 {
		return "", ""
	}

	// 1. 优先直接匹配已知 key
	for _, k := range knownMarkdownKeys {
		if v, exists := m[k]; exists {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return k, s
			}
		}
	}

	// 2. 探测常见嵌套容器
	containers := []string{"data", "response", "result", "payload", "output", "lesson"}
	for _, c := range containers {
		if sub, ok := m[c].(map[string]any); ok {
			if k, s := findMarkdownInMap(sub, depth+1); k != "" {
				return c + "." + k, s
			}
		}
	}

	// 3. 探测 OpenAI 风格 choices 数组
	if k, s := extractOpenAIChoiceMarkdown(m); k != "" {
		return k, s
	}

	// 4. 单字段 JSON 保底（若 JSON 仅包含唯一字符串字段，且字段名或值具备 Markdown 特征）
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

// tryUnmarshalJSON 尝试解析 JSON map。若因模型超长输出尾部反斜杠转义残缺（如 \"\n} 或 \"}）
// 导致标准 Unmarshal 报 Unterminated string，执行确定性修复后重试。
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

// DeescapeJSONStringContent 从可能残缺、畸形、未闭合或含非法转义的 JSON 文本中，
// 靶向定位指定 key 并流式逆转义提取其字符串内容。
// 物理状态机单趟扫描：0ms 纯内存操作，彻底摆脱 standard json.Unmarshal 的格式束缚。
func DeescapeJSONStringContent(raw, key string) (string, bool) {
	if raw == "" || key == "" {
		return "", false
	}

	// 1. 定位 key 标识："key" 或 'key'
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

	// 2. 寻找冒号 ':'
	for p < n && (raw[p] == ' ' || raw[p] == '\t' || raw[p] == '\r' || raw[p] == '\n') {
		p++
	}
	if p >= n || raw[p] != ':' {
		return "", false
	}
	p++ // skip ':'

	// 3. 寻找开引号 '"' 或 '`' 或 '\''
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
	p++ // skip opening quote

	// 4. 物理流式逆转义状态机
	var b strings.Builder
	b.Grow(n - p)

	for p < n {
		c := raw[p]

		// 处理反斜杠转义
		if c == '\\' {
			if p+1 >= n {
				// 末尾悬挂反斜杠
				break
			}
			next := raw[p+1]

			// 特殊检查：模型尾部缺陷 \"\n} 或 \"}
			// 若当前是 \" 且后续（跳过空白与转义换行）即为 '}'、',' 或 EOF，则视为字符串闭合标识而非文本内的转义引号
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
				// 防御 LaTeX 命令（如 \beta, \begin, \bar, \bf）：后接字母时不转义为退格控制符 0x08
				if p+2 < n && ((raw[p+2] >= 'a' && raw[p+2] <= 'z') || (raw[p+2] >= 'A' && raw[p+2] <= 'Z')) {
					b.WriteByte('\\')
					b.WriteByte('b')
					p += 2
				} else {
					b.WriteByte('\b')
					p += 2
				}
			case 'f':
				// 防御 LaTeX 命令（如 \frac）：后接字母时不转义为分页控制符 0x0C
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
				// 非标准转义（如 LaTeX \alpha, 标点转义等）：保留反斜杠与后续字符
				b.WriteByte('\\')
				b.WriteByte(next)
				p += 2
			}
			continue
		}

		// 处理未转义的引号：判断是否为终止引号
		if c == quoteChar {
			// 前瞻探查：跳过空白后是否紧跟 '}', ',', 或已至 EOF
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
				// 引号后紧跟逗号，检查逗号后是否为另一个 JSON key
				afterComma := lookahead + 1
				for afterComma < n && (raw[afterComma] == ' ' || raw[afterComma] == '\t' || raw[afterComma] == '\r' || raw[afterComma] == '\n') {
					afterComma++
				}
				if afterComma < n && (raw[afterComma] == '"' || raw[afterComma] == '\'') {
					return b.String(), true
				}
			}

			// 否则视为正文中的未转义双引号
			b.WriteByte(quoteChar)
			p++
			continue
		}

		// 容忍正文中的裸换行符（标准 JSON 非法，但 LLM 频繁产出）
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

// peelJSONContainer 尝试解析并剥离 JSON 外壳
func peelJSONContainer(text string) (string, string, bool) {
	trimmed := strings.TrimSpace(text)

	// Case 1: 整个载荷是顶层 JSON 对象（标准 Unmarshal 微秒级快路径）
	if strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}") {
		if objMap, ok := tryUnmarshalJSON([]byte(trimmed)); ok {
			if key, val := findMarkdownInMap(objMap, 0); key != "" {
				return val, key, true
			}
		}
	}

	// Case 2: 容错探测模型在 JSON 外携带的简短寒暄（首个 { 之前不得含有 Markdown 标题/段落/标签结构）
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

	// Case 3: 【Layer 1 纯内存物理逆转义状态机】
	// 若标准 Unmarshal 失败（因尾部缺引号/反斜杠残缺/含有未转义换行/被 token 上限截断），
	// 针对已知 markdown key 执行 0ms 纯内存流式逆转义提取
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

// StripPayloadShell 确定性载荷剥壳器（消灭 90% 的 mdx_repair 慢路径）：
// 1. 剥除顶层包裹围栏（```json ... ``` 或 ```markdown ... ```）；
// 2. 探测模型因 prompt 误解输出的顶层/嵌套 JSON（如 {"lessonMarkdown": "..."}, {"data": {"markdown": "..."}} 等），
//    利用 json.Unmarshal 微秒级剥壳并还原字符转义，输出审计日志；
// 3. 优先执行哨兵抽取（===CONTENT_BEGIN=== / ===CONTENT_END===）；
// 4. 若解出的 Markdown 正文依然带外层 markdown/mdx 围栏代码块，确定性剥除；
// 返回 (剥壳后的纯净正文, 剥壳特征标记)。
func StripPayloadShell(raw string) (string, string) {
	curr := raw
	var strippedFeatures []string

	// Step 0: 剥除思考块（<think>...</think> 或 <thought>...</thought>）
	if mdpat.ThinkingBlockRe.MatchString(curr) {
		curr = mdpat.ThinkingBlockRe.ReplaceAllString(curr, "")
		curr = strings.TrimSpace(curr)
		strippedFeatures = append(strippedFeatures, "think")
	}

	// Step 1: 剥除最外层围栏（若存在，例如 ```json\n{...}\n``` 或 ```markdown\n...\n```）
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

	// Step 2: 探测并剥离顶层/嵌套 JSON 包裹
	if val, key, ok := peelJSONContainer(curr); ok {
		log.Printf("[convergence-pipeline] Stripped JSON wrapper key='%s'", key)
		curr = val
		strippedFeatures = append(strippedFeatures, "json:"+key)
	}

	// Step 3: 哨兵抽取（===CONTENT_BEGIN=== / ===CONTENT_END===）
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

	// Step 4: 若仍有外层 Markdown/MDX 围栏代码块，确定性剥除
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


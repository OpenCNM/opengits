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

// ─────────────────────────────────────────────────────────────
// Mermaid 第一性原理自愈与主题解耦修复引擎
//
// 物理动机：
// 1. Mermaid 图表损坏 95% 是浅层 DSL 语法瑕疵（未加双引号、全角符号、缺少 end 闭合）；
// 2. 语法纠错与业务主题完全解耦：模型无需载入全仓代码与章节长文，仅需对这 5~10 行
//    图表代码执行纯粹的 DSL 修复（Token 消耗与耗时坍缩 98%）；
// 3. 坚决废除静态假骨架替换：绝不以死板的单节点空壳方框污染读者视界。
// ─────────────────────────────────────────────────────────────

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

// StripMermaidDangerousContent 剥离任何可能导致 XSS 的危险 HTML 与事件属性。
func StripMermaidDangerousContent(code string) string {
	cleaned := htmlDangerousTagRe.ReplaceAllString(code, "")
	cleaned = htmlDangerousAttrRe.ReplaceAllString(cleaned, "")
	return cleaned
}

// EnsureQuotedMermaidLabels 确定性单遍扫描器：
// 确保所有包含括号、冒号、方括号或特殊字符的 Mermaid 节点标签被安全双引号包裹，
// 避免 Mermaid 词法解析器在浏览器端崩溃（0ms 纯内存自愈）。
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

		// 全角常见中文字符规整
		line = strings.ReplaceAll(line, "（", "(")
		line = strings.ReplaceAll(line, "）", ")")
		line = strings.ReplaceAll(line, "【", "[")
		line = strings.ReplaceAll(line, "】", "]")
		line = strings.ReplaceAll(line, "“", `"`)
		line = strings.ReplaceAll(line, "”", `"`)

		// 声明头与系统指令行跳过
		if mdpat.MermaidDiagramHeaderRe.MatchString(trimmed) ||
			regexp.MustCompile(`(?i)^\s*(direction|style|classDef|class|linkStyle|click|end)\b`).MatchString(trimmed) {
			out = append(out, line)
			continue
		}

		modified := line

		// 1. subgraph 标题加固: subgraph ID [Title: Detail] -> subgraph ID ["Title: Detail"]
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

		// 2. 连线标签加固: |label| -> |"label"|
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

		// 3. 节点形状包裹扫描器
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
		// 寻找节点 ID 起始: [A-Za-z0-9_.-]
		if (i == 0 || isBoundaryChar(line[i-1])) && isIdStartChar(line[i]) {
			idStart := i
			for i < n && isIdChar(line[i]) {
				i++
			}
			idStr := line[idStart:i]

			// 跳过 subgraph 关键字
			if strings.EqualFold(idStr, "subgraph") || strings.EqualFold(idStr, "end") {
				sb.WriteString(idStr)
				continue
			}

			// 跳过空白
			wsStart := i
			for i < n && (line[i] == ' ' || line[i] == '\t') {
				i++
			}
			wsStr := line[wsStart:i]

			// 检测是否紧接着节点形状定界符
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

// EnsureMermaidHeader 检查图表是否声明头，若缺失则自动前置 flowchart LR。
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

// BalanceMermaidStructure 配平 subgraph ... end，剔除悬空连线。
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
		// 剔除末尾悬空连线 (如 A --> 结尾无目标节点)
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

	// 补全缺失的 end
	for subgraphCount > endCount {
		out = append(out, "  end")
		endCount++
	}

	return strings.Join(out, "\n")
}

// HealMermaidSyntax Layer 1 内存 0ms 纯状态机急救入口：
// 串联 XSS 剥离 ➔ 全角清洗 ➔ 标签双引号加固 ➔ 补齐图表头 ➔ 配平 subgraph 与围栏。
func HealMermaidSyntax(raw string) (string, bool) {
	// 剥除最外层围栏（若有）
	clean, _ := StripPayloadShell(raw)
	clean = strings.TrimSpace(clean)
	if clean == "" {
		clean = strings.TrimSpace(raw)
	}
	// 剥离 ```mermaid 头尾
	clean = regexp.MustCompile(`(?i)^[ \t]*`+"`{3,}"+`\s*mermaid\s*\n?`).ReplaceAllString(clean, "")
	clean = regexp.MustCompile(`(?i)\n?[ \t]*`+"`{3,}"+`\s*$`).ReplaceAllString(clean, "")
	clean = strings.TrimSpace(clean)
	if clean == "" {
		return "", false
	}

	// 1. XSS 防御
	clean = StripMermaidDangerousContent(clean)

	// 2. 标签双引号加固
	clean = EnsureQuotedMermaidLabels(clean)

	// 3. 图表头保证
	clean = EnsureMermaidHeader(clean)

	// 4. subgraph 与悬挂连线配平
	clean = BalanceMermaidStructure(clean)

	// 5. 校验图表是否具备最少有效内容（header + 至少一条合法语句）
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

		// 检查是否有非法乱码前缀 (如 ???, !!!, ***)
		if mermaidInvalidLeadingRe.MatchString(trim) {
			return false
		}

		statementCount++

		// 关键词检查
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

		// 针对 sequence / state / class / er 等特殊图表
		if strings.Contains(headerType, "sequence") || strings.Contains(headerType, "state") ||
			strings.Contains(headerType, "class") || strings.Contains(headerType, "er") ||
			strings.Contains(headerType, "git") || strings.Contains(headerType, "pie") {
			hasEdgeOrNode = true
			continue
		}

		// 节点定义可能使用中文或引号包裹
		if strings.ContainsAny(trim, `[({"`) {
			hasEdgeOrNode = true
			continue
		}

		// 纯标识符行
		if isIdString(trim) {
			hasEdgeOrNode = true
			continue
		}

		// 无法识别的语法行（如 ??? >>>）直接判为无效
		return false
	}

	return hasHeader && statementCount >= 1 && hasEdgeOrNode
}

// RepairMermaidWithLlm Layer 2 与主题解耦的极速 Mermaid Doctor:
// 仅传入破损的 Mermaid 代码片段，以纯 DSL 语法修复指令调用 LLM (0 仓背景、0 章节长文、~100 Token)。
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

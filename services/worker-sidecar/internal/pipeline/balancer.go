package pipeline

import (
	"regexp"
	"strconv"
	"strings"
)

// knownContainerTags 允许确定性原地自动配平的常用 MDX/文档富容器标签集合。
// 仅限于纯包裹型组件，不改变任何既有教学意图与技术事实（符合 346 准则红线 3）。
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

// BalanceCodeFences 确定性配平 Markdown/MDX 中的代码围栏（``` 或 ~~~）。
// 若因模型生成截断导致代码块未闭合，在文档末尾追加对应的闭合围栏，0ms 内存完成急救。
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
			// 闭合行：必须全为 fenceChar 且长度不小于开标签长度
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

// TryAutoCloseTags 若 AST 报错为已知富组件容器未闭合，尝试在文档末尾执行原地确定性自动闭合。
// 至多迭代 5 层嵌套（如 <Steps><Step>），若闭合后通过 validator 则返回 (healedContent, true)。
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

		// 在文档末尾追加闭合标签
		curr = strings.TrimRight(curr, "\n\t ") + "\n</" + tagName + ">\n"
		valid, nextErr := validator(curr)
		if valid {
			return curr, true
		}
		currErr = nextErr
	}

	return content, false
}

// ExtractErrorLine 从编译/校验报错信息与文档内容中提取出错物理行号（1-indexed）。
// 若无法定位则返回 0（促使管线降级到整篇修复，避免盲目切片）。
func ExtractErrorLine(errMsg string, content string) int {
	if strings.TrimSpace(errMsg) == "" {
		return 0
	}

	// 1. 尝试从 errMsg 中直接正则匹配 line \d+
	if m := linePatternRe.FindStringSubmatch(errMsg); m != nil {
		if line, err := strconv.Atoi(m[1]); err == nil && line > 0 {
			return line
		}
	}

	// 2. 尝试从 errMsg 中匹配 :12: 或 :12:34 形式
	if m := lineColonPatternRe.FindStringSubmatch(errMsg); m != nil {
		if line, err := strconv.Atoi(m[1]); err == nil && line > 0 {
			return line
		}
	}

	lines := strings.Split(content, "\n")

	// 3. 若为未闭合标签，扫描正文定位开标签所在行
	if m := unclosedTagRe.FindStringSubmatch(errMsg); m != nil {
		tagName := m[1]
		tagOpenPrefix := "<" + tagName
		for i := len(lines) - 1; i >= 0; i-- {
			if strings.Contains(lines[i], tagOpenPrefix) {
				return i + 1
			}
		}
	}

	// 4. 若为泛型冲突，扫描正文中的单字母大写泛型参数（如 <T>）
	if strings.Contains(errMsg, "generic type parameter collision") {
		genRe := regexp.MustCompile(`<[A-Z]>`)
		for i, line := range lines {
			if genRe.MatchString(line) {
				return i + 1
			}
		}
	}

	// 5. 若为 JSX attribute 表达式错误，扫描提取出的异常表达式在正文中的行
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

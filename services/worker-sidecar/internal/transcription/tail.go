package transcription

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// htmlTagRe 匹配行内 HTML 标签（用于净化 Prose 采样文本）。
var htmlTagRe = regexp.MustCompile(`<[^>]+>`)

// markdownLinkOrImageRe 匹配 Markdown 图片与链接语法，保留其描述文字。
var markdownLinkOrImageRe = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]+\)`)

// headingLineRe 匹配 Markdown 标题行前缀（# ~ ######）。
var headingLineRe = regexp.MustCompile(`^[ \t]{0,3}#{1,6}\s+`)

// TailProseResult 尾部自然语言文本提取结果。
type TailProseResult struct {
	Prose      string // 提取到的纯自然语言正文（无代码、无标签）
	RawSnippet string // 对应的原始 Markdown 行切片（保留原始换行）
	StartLine  int    // 在原 markdown 中的起始物理行号（1-based）
	TotalLines int    // 原 markdown 总物理行数
}

// CleanProseLine 对单行 Markdown 进行纯文本净化：剥离标题前缀、HTML 标签、行内代码反引号与链接。
func CleanProseLine(line string) string {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return ""
	}
	// 剥离标题前缀
	trimmed = headingLineRe.ReplaceAllString(trimmed, "")
	// 剥离 HTML 标签
	trimmed = htmlTagRe.ReplaceAllString(trimmed, "")
	// 剥离链接与图片，仅保留锚文本
	trimmed = markdownLinkOrImageRe.ReplaceAllString(trimmed, "$1")
	// 剥离行内反引号
	trimmed = strings.ReplaceAll(trimmed, "`", "")
	return strings.TrimSpace(trimmed)
}

// ExtractTailProse 提取 Markdown 文档尾部的自然语言正文。
// 规则：
// 1. 跳过 Frontmatter (--- ... ---)；
// 2. 严格跳过代码围栏 (``` 或 ~~~) 及其内部的所有代码；
// 3. 逆向自底向上累积有效自然语言行，直至达到或超过 maxChars（默认 300 字符）；
// 4. 按原物理顺序缝合，并返回物理起始行号供微创补翻使用。
func ExtractTailProse(source string, maxChars int) TailProseResult {
	if strings.TrimSpace(source) == "" {
		return TailProseResult{}
	}
	if maxChars <= 0 {
		maxChars = 300
	}
	lines := strings.Split(source, "\n")
	totalLines := len(lines)
	if totalLines == 0 {
		return TailProseResult{}
	}

	// 步骤 1：标记每行是否处于 Frontmatter 或代码围栏中
	inFrontmatter := false
	inCodeBlock := false
	fenceChar := byte(0)
	fenceLen := 0

	isExcludedLine := make([]bool, totalLines)

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		// 检查 Frontmatter 边界（仅在文档首部起效）
		if i == 0 && (trimmed == "---" || trimmed == "+++") {
			inFrontmatter = true
			isExcludedLine[i] = true
			continue
		}
		if inFrontmatter {
			isExcludedLine[i] = true
			if trimmed == "---" || trimmed == "+++" {
				inFrontmatter = false
			}
			continue
		}

		// 检查代码围栏边界
		if m := mdpat.FenceOpenRe.FindStringSubmatch(line); m != nil {
			fence := m[1]
			if !inCodeBlock {
				inCodeBlock = true
				fenceChar = fence[0]
				fenceLen = len(fence)
				isExcludedLine[i] = true
				continue
			} else if fence[0] == fenceChar && len(fence) >= fenceLen && strings.TrimSpace(m[2]) == "" {
				inCodeBlock = false
				fenceChar = 0
				fenceLen = 0
				isExcludedLine[i] = true
				continue
			}
		}

		if inCodeBlock {
			isExcludedLine[i] = true
		}
	}

	// 步骤 2：自底向上搜集有效自然语言行
	type proseLine struct {
		lineNo      int
		rawText     string
		cleanedText string
	}

	var collected []proseLine
	accumulatedLen := 0

	for i := totalLines - 1; i >= 0; i-- {
		if isExcludedLine[i] {
			continue
		}
		raw := lines[i]
		cleaned := CleanProseLine(raw)
		if cleaned == "" {
			continue
		}

		collected = append(collected, proseLine{
			lineNo:      i + 1, // 1-based
			rawText:     raw,
			cleanedText: cleaned,
		})
		accumulatedLen += len([]rune(cleaned))

		if accumulatedLen >= maxChars {
			break
		}
	}

	if len(collected) == 0 {
		return TailProseResult{TotalLines: totalLines}
	}

	// 步骤 3：反转恢复正常阅读顺序（top-to-bottom）
	n := len(collected)
	cleanedParts := make([]string, n)
	rawParts := make([]string, n)
	for i := 0; i < n; i++ {
		orig := collected[n-1-i]
		cleanedParts[i] = orig.cleanedText
		rawParts[i] = orig.rawText
	}

	startLine := collected[n-1].lineNo

	return TailProseResult{
		Prose:      strings.Join(cleanedParts, "\n"),
		RawSnippet: strings.Join(rawParts, "\n"),
		StartLine:  startLine,
		TotalLines: totalLines,
	}
}

package ogis

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

// ─────────────────────────────────────────────────────────────
// OGIS 索引 snippet 清洗：复刻 Node 侧两级清洗——
// 第一级 apps/client/src/lib/search/snippet.ts extractContextSnippet
// （索引管线恒以 query=''、maxLen=160 调用，故只移植无关键词路径）；
// 第二级 binary-index-packer.ts 的 c.content.replace(/\s+/g,' ').trim().slice(0,160)。
// 差异声明：RE2 不支持反向引用，fenced code block 的 ``` / ~~~ 成对围栏
// 用行扫描器实现（比正则更稳）；截断按 rune 而非 UTF-16 code unit
// （非代理对内容两者等价，极端 emoji 场景差 1 字符，可接受）。
// ─────────────────────────────────────────────────────────────

var (
	ogisTrailingHashRe = regexp.MustCompile(`\s*#+\s*$`)
	ogisHTMLCommentRe  = regexp.MustCompile(`(?s)<!--.*?-->`)
	// 行内三连 tick/波浪线配对（不带 (?s)，不跨行）：跨行非贪婪配对会把
	// 两个未闭合围栏的残余 ``` 错配成一对，吞掉中间正文；行内语义与
	// Node snippet.ts 同步收紧。
	ogisInlineTickRe  = regexp.MustCompile("```.*?```|~~~.*?~~~")
	ogisInlineCodeRe  = regexp.MustCompile("`[^`\n]+`")
	ogisHTMLTagRe     = regexp.MustCompile(`<[^>]+>`)
	ogisImageRe       = regexp.MustCompile(`(?s)!\[.*?\]\(.*?\)`)
	ogisLinkRe        = regexp.MustCompile(`(?s)\[([^\]]+)\]\([^)]*\)`)
	ogisHeadingPreRe  = regexp.MustCompile("(?m)^[#\\s\\-*>`~]+")
	ogisBoldRe        = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	ogisItalicRe      = regexp.MustCompile(`\*([^*]+)\*`)
	ogisBoldUnderRe   = regexp.MustCompile(`__([^_]+)__`)
	ogisItalicUnderRe = regexp.MustCompile(`(?:^|\s)_([^_]+)_(?:\s|$)`)
	ogisPunctStripRe  = regexp.MustCompile("[|\\\\`~#]")
	ogisFenceOpenRe   = regexp.MustCompile(`^[ \t]{0,3}(` + "`{3,}" + `|~{3,})`)
	docExtRe          = regexp.MustCompile(`(?i)\.(mdx?|markdown|html)$`)
	docDashUnderRe    = regexp.MustCompile(`[-_]`)
	docH1HeadingRe    = regexp.MustCompile(`(?m)^[ \t]{0,3}#\s+(.+)$`)
)

// StripFrontmatter 剥离文档起始的 YAML frontmatter（--- ... ---）。
func StripFrontmatter(text string) string {
	clean := strings.TrimLeftFunc(text, unicode.IsSpace)
	if !strings.HasPrefix(clean, "---") {
		return clean
	}
	endIdx := strings.Index(clean[3:], "\n---")
	if endIdx == -1 {
		return clean
	}
	after := clean[3+endIdx+4:]
	after = strings.TrimPrefix(after, "\n")
	return strings.TrimLeftFunc(after, unicode.IsSpace)
}

func stripFrontmatter(text string) string {
	return StripFrontmatter(text)
}

// StripFencedBlocks 行扫描成对围栏代码块（``` 或 ~~~，≤3 空格缩进），
// 整块替换为单个空格。未闭合围栏（到文末都没闭合）保持原行不变——
// 与 JS 非贪婪正则「无闭合不匹配」语义一致（残留反引号由后续标点
// 剥除规则清理）。
func StripFencedBlocks(text string) string {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := strings.Split(normalized, "\n")
	var out []string
	var fenceChar byte
	fenceLen := 0
	openAt := -1
	for i, line := range lines {
		trimmedLine := strings.TrimRight(line, "\r")
		if openAt >= 0 {
			body := strings.TrimLeft(trimmedLine, " \t")
			if len(body) >= fenceLen && body[0] == fenceChar && strings.Trim(body, string(fenceChar)+" \t") == "" {
				// 闭合：整块（含开栏行与围栏内行）折叠为单个空格
				out = append(out[:openAt], " ")
				openAt = -1
				fenceChar = 0
				fenceLen = 0
				continue
			}
			out = append(out, lines[i]) // 暂存原行，未闭合时原样保留
			continue
		}
		if m := ogisFenceOpenRe.FindStringSubmatch(trimmedLine); len(m) == 2 {
			openAt = len(out)
			fenceChar = m[1][0]
			fenceLen = len(m[1])
			out = append(out, lines[i]) // 暂存原行，未闭合时原样保留
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func stripFencedBlocks(text string) string {
	return StripFencedBlocks(text)
}

// CleanMarkdownForSnippet 清洗 markdown 语法与代码块
func CleanMarkdownForSnippet(text string) string {
	if text == "" {
		return ""
	}
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	clean := stripFrontmatter(normalized)
	// 围栏剥离先行：HTML 注释剥离若在围栏之前执行，讲解 HTML 注释的
	// 文档中跨围栏的 <!-- ... --> 会被错配吞掉围栏间正文（与 Node 同步）。
	clean = stripFencedBlocks(clean)
	clean = ogisHTMLCommentRe.ReplaceAllString(clean, "")
	clean = ogisInlineTickRe.ReplaceAllString(clean, " ")
	clean = ogisInlineCodeRe.ReplaceAllString(clean, " ")
	clean = ogisHTMLTagRe.ReplaceAllString(clean, " ")
	clean = ogisImageRe.ReplaceAllString(clean, " ")
	clean = ogisLinkRe.ReplaceAllString(clean, "$1")
	clean = ogisHeadingPreRe.ReplaceAllString(clean, " ")
	clean = ogisBoldRe.ReplaceAllString(clean, "$1")
	clean = ogisItalicRe.ReplaceAllString(clean, "$1")
	clean = ogisBoldUnderRe.ReplaceAllString(clean, "$1")
	clean = ogisItalicUnderRe.ReplaceAllString(clean, " $1 ")
	clean = ogisPunctStripRe.ReplaceAllString(clean, " ")
	return strings.Join(strings.Fields(clean), " ")
}

func cleanMarkdownForSnippet(text string) string {
	return CleanMarkdownForSnippet(text)
}

// ExtractContextSnippet extracts a clean context snippet around a query keyword from markdown/text.
// Safely ignores frontmatter and code blocks, without stripping internal horizontal rules.
// Mirrored from apps/client/src/lib/search/snippet.ts extractContextSnippet.
func ExtractContextSnippet(text string, query string, maxLen int) string {
	if text == "" {
		return ""
	}
	cleanText := cleanMarkdownForSnippet(text)
	if cleanText == "" {
		return ""
	}

	runes := []rune(cleanText)
	q := strings.ToLower(strings.TrimSpace(query))
	qRunes := []rune(q)

	if len(qRunes) == 0 {
		end := maxLen
		if end > len(runes) {
			end = len(runes)
		}
		startSnippet := strings.TrimSpace(string(runes[:end]))
		if len([]rune(startSnippet)) < len(runes) {
			return startSnippet + "..."
		}
		return startSnippet
	}

	cleanLower := []rune(strings.ToLower(cleanText))
	matchIndex := -1
	if len(cleanLower) >= len(qRunes) {
		for i := 0; i <= len(cleanLower)-len(qRunes); i++ {
			match := true
			for j := 0; j < len(qRunes); j++ {
				if cleanLower[i+j] != qRunes[j] {
					match = false
					break
				}
			}
			if match {
				matchIndex = i
				break
			}
		}
	}

	if matchIndex == -1 {
		end := maxLen
		if end > len(runes) {
			end = len(runes)
		}
		startSnippet := strings.TrimSpace(string(runes[:end]))
		if len([]rune(startSnippet)) < len(runes) {
			return startSnippet + "..."
		}
		return startSnippet
	}

	leadChars := 28
	start := matchIndex - leadChars
	if start < 0 {
		start = 0
	}
	if start > 0 {
		prevSpace := -1
		for i := start; i >= 0; i-- {
			if runes[i] == ' ' {
				prevSpace = i
				break
			}
		}
		if prevSpace != -1 && start-prevSpace <= 10 {
			start = prevSpace + 1
		}
	}
	end := start + maxLen
	if end > len(runes) {
		end = len(runes)
	}

	snippet := strings.TrimSpace(string(runes[start:end]))
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(runes) {
		snippet = snippet + "..."
	}

	return snippet
}

// ResolveDocTitle cleanly resolves document title from title field, H1 markdown heading, or file path.
// Mirrored from apps/client/src/lib/search/snippet.ts resolveDocTitle.
func ResolveDocTitle(title, path, content string) string {
	t := strings.TrimSpace(title)
	if t != "" && strings.ToLower(t) != "untitled" {
		clean := chunker.CleanMarkdownHeading(t)
		if clean != "" {
			return clean
		}
		return t
	}
	if content != "" {
		normalized := strings.ReplaceAll(content, "\r\n", "\n")
		normalized = strings.ReplaceAll(normalized, "\r", "\n")
		nonCode := stripFrontmatter(normalized)
		nonCode = stripFencedBlocks(nonCode)
		nonCode = ogisInlineTickRe.ReplaceAllString(nonCode, "")
		if title := extractH1Title(nonCode); title != "" {
			return title
		}
	}
	if path != "" {
		cleanPath := strings.TrimRight(path, "/")
		parts := strings.Split(cleanPath, "/")
		basename := parts[len(parts)-1]
		if basename == "" {
			basename = path
		}
		cleanName := docExtRe.ReplaceAllString(basename, "")
		cleanName = docDashUnderRe.ReplaceAllString(cleanName, " ")
		if cleanName != "" {
			runes := []rune(cleanName)
			return string(unicode.ToUpper(runes[0])) + string(runes[1:])
		}
	}
	return "未命名文档"
}

// extractContextSnippetNoQuery Node extractContextSnippet 的无关键词路径
// （索引管线唯一调用形态）：清洗 markdown 后取前 maxLen 字符，截断加省略号。
func extractContextSnippetNoQuery(text string, maxLen int) string {
	return ExtractContextSnippet(text, "", maxLen)
}

// CleanSnippetForIndex 两级清洗的收口：一级 snippet + 二级空白折叠/截 160。
func CleanSnippetForIndex(content string) string {
	return extractContextSnippetNoQuery(content, 160)
}

func cleanSnippetForIndex(content string) string {
	return CleanSnippetForIndex(content)
}

func extractH1Title(nonCode string) string {
	m := docH1HeadingRe.FindStringSubmatch(nonCode)
	if m == nil {
		return ""
	}
	cand := strings.TrimSpace(m[1])
	if cand == "" || strings.ToLower(cand) == "untitled" {
		return ""
	}
	rawTitle := ogisTrailingHashRe.ReplaceAllString(cand, "")
	return chunker.CleanMarkdownHeading(rawTitle)
}


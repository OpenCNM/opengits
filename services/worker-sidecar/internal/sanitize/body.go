package sanitize

import (
	"errors"
	"regexp"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// Go 原生 Sanitizer 执行体（Sanitizer Phase 2）
//
// 逐字对齐 apps/client/src/engine/sanitizer.ts 与 prepareMdxSource.ts：
// 1. PrepareMdxSource 预清洗（哨兵标记、Pandoc 图片扩展、伴生概念清单标签）
// 2. MaskCodeBlocks 隔离代码块与行内代码（零代码污染）
// 3. flattenAllHeadings 展平标题内嵌套链接/图片（防嵌套锚点）
// 4. sanitizeHTML 清理 HTML 结构与危险属性（XSS / 协议 / 空标签自闭合）
// 5. UnmaskCodeBlocks 还原代码块（同时完成语言归一）
// ─────────────────────────────────────────────────────────────

var (
	// 哨兵标记
	sentinelBeginRe = regexp.MustCompile(`===CONTENT_BEGIN===`)
	sentinelEndRe   = regexp.MustCompile(`===CONTENT_END===`)

	// Pandoc 图片属性扩展：![alt](url){height=55%} -> ![alt](url)
	pandocImgRe = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)\s*\{[^}]*\}`)

	// 伴生概念清单标签（剥除走 tagscan 确定性配对扫描，见 PrepareMdxSource）

	// ATX 标题行判定：^[ \t]{0,3}#{1,6}[ \t]+(.*)$
	atxHeadingRe = regexp.MustCompile(`^([ \t]{0,3}#{1,6}[ \t]+)(.*)$`)

	// 标题内图片与链接提取
	headingImgRe  = regexp.MustCompile(`!\[([^\]]*)\]\([^)]*\)`)
	headingLinkRe = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	// 嵌套 [![alt](img)](url)：TS 侧 link.value 取 children 的 .value（image 节点无 .value）
	// 恒为空——嵌套图片 alt 在 TS 路径本就丢弃，Go 逐字对齐该语义
	headingNestedImgLinkRe = regexp.MustCompile(`\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)`)
)

// PrepareMdxSource 预处理 MDX 源码（对齐 lib/mdx/prepareMdxSource.ts）。
func PrepareMdxSource(raw string) string {
	if raw == "" {
		return ""
	}
	s := sentinelBeginRe.ReplaceAllString(raw, "")
	s = sentinelEndRe.ReplaceAllString(s, "")
	s = pandocImgRe.ReplaceAllString(s, "![$1]($2)")
	s = removeElementsWithContent(s, map[string]bool{"concept_manifest": true})
	return s
}

// flattenHeadingLinks 拍平标题内链接和图片为纯文本（对齐 Node AST 访问器）：
// # [点击这里](https://x.dev) -> # 点击这里
// ## ![图标](icon.png) 介绍 -> ## 图标 介绍
func flattenHeadingLinks(line string) string {
	m := atxHeadingRe.FindStringSubmatch(line)
	if m == nil {
		return line
	}
	prefix := m[1]
	body := m[2]

	// 0. 嵌套 [![alt](img)](url) → 空（对齐 TS：image 节点无 .value，alt 丢弃）
	body = headingNestedImgLinkRe.ReplaceAllString(body, "")
	// 1. 先拍平 Markdown 图片：![alt](url) -> alt
	body = headingImgRe.ReplaceAllString(body, "$1")
	// 2. 再拍平 Markdown 链接：[text](url) -> text (支持嵌套的 [![alt](img)](url) -> alt)
	body = headingLinkRe.ReplaceAllString(body, "$1")
	// 3. HTML 链接拍平：<a href="...">text</a> -> text（tagscan 配对扫描，
	//    未闭合 <a> 保持原文——对齐历史非贪婪正则要求闭标签的口径）
	body = unwrapElements(body, "a")

	return prefix + body
}

// flattenAllHeadings 逐行处理所有标题。
func flattenAllHeadings(content string) string {
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if strings.Contains(line, "#") {
			lines[i] = flattenHeadingLinks(line)
		}
	}
	return strings.Join(lines, "\n")
}

// SanitizeText 执行完整的文档净化流程（纯函数，fail-closed）。
// 输出契约与 TS Sanitizer.process 逐字对齐（共享夹具 sanitize.golden.json 锁死）：
// 空白输入归一为空串；非空输出恒以单个换行结尾（remark-stringify 序列化语义）。
func SanitizeText(rawContent string) (string, error) {
	if strings.TrimSpace(rawContent) == "" {
		return "", nil
	}

	// 1. 预处理
	cleanedRaw := PrepareMdxSource(rawContent)

	// 2. 代码隔离
	masked, blocks := MaskCodeBlocks(cleanedRaw)
	if len(blocks) > 0 && !strings.Contains(masked, MaskTokenPrefix) {
		return "", errors.New("sanitizer failed: code block mask integrity violation")
	}

	// 3. 标题内嵌套链接/图片拍平
	flattened := flattenAllHeadings(masked)

	// 4. HTML 安全过滤与属性清洗
	sanitized := sanitizeHTML(flattened)

	// 5. 还原代码块（同时完成代码块语言规范化）
	result := UnmaskCodeBlocks(sanitized, blocks)

	if result != "" && !strings.HasSuffix(result, "\n") {
		result += "\n"
	}
	return result, nil
}

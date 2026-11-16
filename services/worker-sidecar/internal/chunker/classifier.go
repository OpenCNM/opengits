package chunker

import (
	"regexp"
	"strings"
)

var (
	classifierMermaidRe   = regexp.MustCompile(`(?i)(?:` + "```" + `|~~~)\s*mermaid`)
	classifierWarningRe   = regexp.MustCompile(`(?i)\[!(?:WARNING|CAUTION|IMPORTANT)\]|:::warning`)
	classifierCodeBlockRe = regexp.MustCompile(`(?s)(?:` + "```.*?```" + `|~~~.*?~~~)` + "")
	classifierTableRe     = regexp.MustCompile(`\|(?:\s*:?-+:?\s*\|)+`)
	// 标题分类关键词：两侧词边界，防止词中子串误命中
	// （rapid→api、flowchart→architecture、systems→system、apis→api 均不再触发——
	// 旧实现只加左边界，右侧仍会词中命中）。
	classifierHeadingArchRe = regexp.MustCompile(`(?i)\b(?:architecture|design|workflow|flow|overview|system)\b`)
	classifierHeadingApiRe  = regexp.MustCompile(`(?i)\b(?:api|reference|parameters?|configs?|props)\b`)
)

// utf16Length computes the UTF-16 code unit count of an UTF-8 string to match JavaScript string.length exactly.
func utf16Length(s string) int {
	count := 0
	for _, r := range s {
		if r > 0xFFFF {
			count += 2
		} else {
			count++
		}
	}
	return count
}

// DeriveDocumentRole 从终稿全文确定性推导文档级宏观角色提示（供
// ClassifyChunk 的 blueprintRole 兜底档消费）。原镜像 TS doc-blueprint.ts
// buildFallbackBlueprint 的 chunkRole 推导（TS 原体已退役，本包为唯一实现）：
// 含 Mermaid 图 → architecture；含结构化表格 → api_reference。
// 物理事实（内容本身）是单一输入——口径不随执行路径漂移。
func DeriveDocumentRole(content string) string {
	if classifierMermaidRe.MatchString(content) {
		return "architecture"
	}
	if classifierTableRe.MatchString(content) {
		return "api_reference"
	}
	return ""
}

// ClassifyChunk determines the ChunkContentType based on AST content inspection,
// code ratio, table syntax, blueprint role, and heading path fallbacks.
func ClassifyChunk(content, headingPath, blueprintRole string) string {
	// 1. Mermaid diagrams -> architecture_diagram (Physical AST takes absolute precedence)
	if classifierMermaidRe.MatchString(content) {
		return "architecture_diagram"
	}

	// 2. Callouts ([!WARNING], [!CAUTION], [!IMPORTANT], :::warning) -> warning
	if classifierWarningRe.MatchString(content) {
		return "warning"
	}

	// 3. Check code block ratio (``` or ~~~ count or length) >= 50% -> code
	// Physical code content MUST NOT be eclipsed by macro document blueprint
	codeMatches := classifierCodeBlockRe.FindAllString(content, -1)
	codeLength := 0
	for _, m := range codeMatches {
		codeLength += utf16Length(m)
	}
	contentTrimmed := strings.TrimSpace(content)
	contentLen := utf16Length(contentTrimmed)
	if contentLen > 0 && float64(codeLength)/float64(contentLen) >= 0.5 {
		return "code"
	}

	// 4. Structural table check (markdown table divider syntax) -> api_reference
	if classifierTableRe.MatchString(content) {
		return "api_reference"
	}

	// 5. Document Blueprint semantic role provides macro document context for remaining chunks
	if blueprintRole != "" {
		role := strings.ToLower(blueprintRole)
		switch role {
		case "architecture", "architecture_diagram", "architecture_spec":
			return "architecture_diagram"
		case "api_reference", "api":
			return "api_reference"
		case "code", "function_impl", "type_definition":
			return "code"
		case "warning":
			return "warning"
		case "module_overview":
			return "module_overview"
		}
	}

	// 6. Heading-based fallback when blueprint is absent
	if headingPath != "" {
		if classifierHeadingArchRe.MatchString(headingPath) {
			return "architecture_diagram"
		}
		if classifierHeadingApiRe.MatchString(headingPath) {
			return "api_reference"
		}
	}

	// Default fallback -> prose
	return "prose"
}

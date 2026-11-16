package chunker

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// DefaultMaxChunkChars defines the canonical upper limit of characters per chunk (4000).
const DefaultMaxChunkChars = 4000
const defaultMaxChunkChars = DefaultMaxChunkChars

var (
	headingHashPrefixRe  = regexp.MustCompile(`^#+\s*`)
	chunkerHtmlCommentRe = regexp.MustCompile(`(?s)<!--.*?-->`)
	markdownImageRe      = regexp.MustCompile(`!\[.*?\]\(.*?\)`)
	htmlJsxTagRe         = regexp.MustCompile(`(?i)</?(?:code|span|a|b|i|strong|em|badge|Badge|kbd|sub|sup)(?:\s+[^>]*?)?/?>|<\w+(?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)+\s*/?>`)
	customAnchorRe       = regexp.MustCompile(`\{#.*?\}`)
	trailingHashRe       = regexp.MustCompile(`\s*#+\s*$`)
	markdownLinkRe       = regexp.MustCompile(`\[(.*?)\]\(.*?\)`)
	multipleSpaceRe      = regexp.MustCompile(`\s+`)

	mermaidDetectRe  = regexp.MustCompile(`(?i)(?:` + "```" + `|~~~)\s*mermaid`)
	typeDefKeywordRe = regexp.MustCompile(`\b(?:interface|type|struct|enum|class)\b`)
	h2LineDetectRe   = regexp.MustCompile(`^##\s+(.+)$`)

	fenceRe = mdpat.FenceOpenRe

	entryPointPrefixList = []string{"index.", "main.", "app.", "server.", "route.", "page."}
)

// CleanMarkdownHeading cleans markdown heading text by stripping # prefixes,
// HTML comments, images, HTML/JSX tags, custom anchors ({#id}), trailing hashes,
// and markdown link syntax, collapsing whitespace.
func CleanMarkdownHeading(raw string) string {
	if raw == "" {
		return ""
	}
	s := strings.TrimSpace(raw)
	s = headingHashPrefixRe.ReplaceAllString(s, "")
	s = chunkerHtmlCommentRe.ReplaceAllString(s, "")
	s = markdownImageRe.ReplaceAllString(s, "")
	s = htmlJsxTagRe.ReplaceAllString(s, "")
	s = customAnchorRe.ReplaceAllString(s, "")
	s = trailingHashRe.ReplaceAllString(s, "")
	s = markdownLinkRe.ReplaceAllString(s, "$1")
	s = multipleSpaceRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// determineContentType determines the content type based on content inspection and optional sourceFile.
func determineContentType(content string, sourceFile string) string {
	if mermaidDetectRe.MatchString(content) {
		return "architecture_diagram"
	}
	if sourceFile != "" {
		for _, prefix := range entryPointPrefixList {
			if strings.Contains(sourceFile, prefix) {
				return "entry_point"
			}
		}
	}
	if typeDefKeywordRe.MatchString(content) {
		return "type_definition"
	}
	return "function_impl"
}

// splitLargeChunk splits content recursively into chunks of at most maxChars:
// 1. Paragraph split on \n\n
// 2. Line split on \n
// 3. Fixed-window slicing
func splitLargeChunk(content string, maxChars int) []string {
	if maxChars <= 0 {
		maxChars = defaultMaxChunkChars
	}
	if len(content) <= maxChars {
		return []string{content}
	}

	// 1. Try splitting by double newline paragraphs if multiple paragraphs exist
	paragraphs := strings.Split(content, "\n\n")
	if len(paragraphs) > 1 {
		var result []string
		current := ""
		for i, para := range paragraphs {
			withSep := para
			if i > 0 {
				withSep = "\n\n" + para
			}
			if len(para) > maxChars {
				if current != "" {
					result = append(result, current)
					current = ""
				}
				subChunks := splitLargeChunk(para, maxChars)
				for j, sub := range subChunks {
					subWithSep := sub
					if j == 0 && i > 0 {
						subWithSep = "\n\n" + sub
					}
					result = append(result, subWithSep)
				}
			} else if len(current+withSep) > maxChars && len(current) > 0 {
				result = append(result, current)
				current = para
			} else {
				if current != "" {
					current += withSep
				} else {
					current = para
				}
			}
		}
		if current != "" {
			result = append(result, current)
		}
		return result
	}

	// 2. Single paragraph with multiple lines: split by single newline
	lines := strings.Split(content, "\n")
	if len(lines) > 1 {
		var result []string
		current := ""
		for i, line := range lines {
			withSep := line
			if i > 0 {
				withSep = "\n" + line
			}
			if len(line) > maxChars {
				if current != "" {
					result = append(result, current)
					current = ""
				}
				subChunks := splitLargeChunk(line, maxChars)
				for j, sub := range subChunks {
					subWithSep := sub
					if j == 0 && i > 0 {
						subWithSep = "\n" + sub
					}
					result = append(result, subWithSep)
				}
			} else if len(current+withSep) > maxChars && len(current) > 0 {
				result = append(result, current)
				current = line
			} else {
				if current != "" {
					current += withSep
				} else {
					current = line
				}
			}
		}
		if current != "" {
			result = append(result, current)
		}
		return result
	}

	// 3. Single line without linebreaks: fixed window slicing
	var result []string
	for i := 0; i < len(content); i += maxChars {
		end := i + maxChars
		if end > len(content) {
			end = len(content)
		}
		result = append(result, content[i:end])
	}
	return result
}

// L2HeadingNode represents an extracted L2 heading in MDX.
type L2HeadingNode struct {
	Title string
	Start int
}

// extractL2Headings extracts level 2 headings from MDX text in a CommonMark
// fence-aware manner, ignoring any `##` inside code blocks.
func extractL2Headings(mdx string) []L2HeadingNode {
	lines := strings.Split(mdx, "\n")
	var headings []L2HeadingNode
	inCodeBlock := false
	fenceChar := byte(0)
	fenceLen := 0
	offset := 0

	for _, line := range lines {
		if m := fenceRe.FindStringSubmatch(line); m != nil {
			fence := m[1]
			if !inCodeBlock {
				inCodeBlock = true
				fenceChar = fence[0]
				fenceLen = len(fence)
			} else if fence[0] == fenceChar && len(fence) >= fenceLen && strings.TrimSpace(m[2]) == "" {
				inCodeBlock = false
				fenceChar = 0
				fenceLen = 0
			}
			offset += len(line) + 1
			continue
		}

		if !inCodeBlock {
			if m := h2LineDetectRe.FindStringSubmatch(line); m != nil {
				clean := CleanMarkdownHeading(m[1])
				if clean != "" {
					headings = append(headings, L2HeadingNode{
						Title: clean,
						Start: offset,
					})
				}
			}
		}
		offset += len(line) + 1
	}
	return headings
}

// matchChunkSourceFile checks if any of the sourceFiles appears in chunk content.
func matchChunkSourceFile(content string, sourceFiles []string) string {
	for _, file := range sourceFiles {
		if file != "" && strings.Contains(content, file) {
			return file
		}
	}
	return ""
}

// ChunkCodeModule chunks an AI-generated MDX lesson based on L2 heading boundaries.
func ChunkCodeModule(req CodeModuleChunkRequest) []CodeChunk {
	mdx := strings.ReplaceAll(req.MdxContent, "\r\n", "\n")
	sourceFiles := req.SourceFiles
	firstFile := ""
	if len(sourceFiles) > 0 {
		firstFile = sourceFiles[0]
	}
	fallbackFile := firstFile
	if fallbackFile == "" {
		fallbackFile = "module"
	}

	maxChars := req.MaxChars
	if maxChars <= 0 {
		maxChars = defaultMaxChunkChars
	}
	overviewLabel := req.OverviewLabel
	if overviewLabel == "" {
		overviewLabel = "概述"
	}

	headings := extractL2Headings(mdx)
	var chunks []CodeChunk

	// 1. Overview Chunk (everything before first L2 heading)
	firstHeadingStart := len(mdx)
	if len(headings) > 0 {
		firstHeadingStart = headings[0].Start
	}
	if firstHeadingStart > len(mdx) {
		firstHeadingStart = len(mdx)
	}
	overviewContent := strings.TrimSpace(mdx[:firstHeadingStart])

	if overviewContent != "" {
		subParts := splitLargeChunk(overviewContent, maxChars)
		for subIdx, part := range subParts {
			suffix := ""
			if len(subParts) > 1 {
				suffix = fmt.Sprintf(" (Part %d)", subIdx+1)
			}
			chunks = append(chunks, CodeChunk{
				Heading:     fmt.Sprintf("%s > %s%s", req.ModuleName, overviewLabel, suffix),
				HeadingPath: fmt.Sprintf("%s > %s > overview%s", req.ModuleName, fallbackFile, suffix),
				Content:     part,
				ContentType: determineContentType(part, ""),
			})
		}
	}

	// 2. Heading-based Section Chunking
	for i := 0; i < len(headings); i++ {
		sec := headings[i]
		nextStart := len(mdx)
		if i+1 < len(headings) {
			nextStart = headings[i+1].Start
		}
		if nextStart > len(mdx) {
			nextStart = len(mdx)
		}
		if sec.Start > len(mdx) {
			continue
		}
		secContent := strings.TrimSpace(mdx[sec.Start:nextStart])
		sourceFile := matchChunkSourceFile(secContent, sourceFiles)
		if sourceFile == "" {
			sourceFile = firstFile
		}
		displayFile := sourceFile
		if displayFile == "" {
			displayFile = "module"
		}

		subParts := splitLargeChunk(secContent, maxChars)
		for subIdx, part := range subParts {
			suffix := ""
			if len(subParts) > 1 {
				suffix = fmt.Sprintf(" (Part %d)", subIdx+1)
			}
			chunks = append(chunks, CodeChunk{
				Heading:     fmt.Sprintf("%s > %s%s", req.ModuleName, sec.Title, suffix),
				HeadingPath: fmt.Sprintf("%s > %s > %s%s", req.ModuleName, displayFile, sec.Title, suffix),
				Content:     part,
				ContentType: determineContentType(part, sourceFile),
				SourceFile:  sourceFile,
			})
		}
	}

	if len(chunks) == 0 {
		return []CodeChunk{
			{
				Heading:     req.ModuleName,
				HeadingPath: fmt.Sprintf("%s > %s > %s", req.ModuleName, fallbackFile, req.ModuleName),
				Content:     mdx,
				ContentType: "module_overview",
			},
		}
	}

	return chunks
}

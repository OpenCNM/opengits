package mdx

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/sanitize"
	"github.com/opengits/worker-sidecar/internal/treesitter"
)

var (
	tsEngine     *treesitter.Engine
	tsEngineOnce sync.Once
)

// SetTsEngine sets or overrides the Tree-sitter engine for MDX operations.
func SetTsEngine(engine *treesitter.Engine) {
	tsEngine = engine
}

// getTsEngine lazily initializes and returns the Tree-sitter engine.
func getTsEngine() *treesitter.Engine {
	tsEngineOnce.Do(func() {
		if tsEngine != nil {
			return
		}
		ctx := context.Background()
		engine, err := treesitter.NewEngine(ctx)
		if err == nil {
			tsEngine = engine
		}
	})
	return tsEngine
}

// HealSource heals unescaped curly braces in MDX prose while strictly
// preserving fenced code blocks, inline code snippets, and genuine JSX elements/attributes
// (zero syntax corruption invariant, conforming to AGENTS.md III.5).
func HealSource(rawMdx string) (string, error) {
	if rawMdx == "" {
		return "", nil
	}

	// 1. 预处理：剥离哨兵标记、Pandoc 图片属性扩展与伴生概念清单
	cleaned := sanitize.PrepareMdxSource(rawMdx)

	// 2. 隔离围栏代码块与行内代码
	masked, blocks := sanitize.MaskCodeBlocks(cleaned)
	if len(blocks) > 0 && !strings.Contains(masked, sanitize.MaskTokenPrefix) {
		return "", errors.New("mdx healer failed: code block mask integrity violation")
	}

	// 3. 提取 JSX 开闭/自闭合标签范围（基于 Tree-sitter TSX CST 字节切片投影，仅保护标签属性不吞并组件内 Markdown 正文）
	var jsxRanges []treesitter.ByteRange
	if engine := getTsEngine(); engine != nil {
		ranges, err := engine.ScanMdxJsxTagRanges(context.Background(), []byte(masked))
		if err == nil {
			jsxRanges = ranges
		} else {
			jsxRanges = fallbackJsxRanges(masked)
		}
	} else {
		jsxRanges = fallbackJsxRanges(masked)
	}

	// 4. 仅在非代码、非 JSX 的纯自然语言正文区间转义花括号
	healed := healProseWithJsxProtection(masked, jsxRanges)

	// 5. 对正文中的 HTML void 标签做规范化自闭合（如 <br> -> <br />，与 TS prepareMdxSource 契约统一）
	healed = normalizeVoidTags(healed)

	// 6. 还原代码块（严格保持原样，零语法破坏不变式）
	unmasked := sanitize.UnmaskCodeBlocksRaw(healed, blocks)
	return unmasked, nil
}

// NormalizeVoidTags converts unclosed HTML void tags (<br>, <hr>, <img ...>) to self-closing JSX format (<br />, <hr />, <img ... />).
func normalizeVoidTags(s string) string {
	s = mdpat.VoidBrRe.ReplaceAllString(s, "<br />")
	s = mdpat.VoidHrRe.ReplaceAllString(s, "<hr />")
	s = mdpat.VoidWbrRe.ReplaceAllString(s, "<wbr />")
	// 标签名归一小写（JSX 大写=组件引用）：与 TS prepareMdxSource 双轨对拍口径一致
	s = mdpat.VoidImgInputRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := mdpat.VoidImgInputRe.FindStringSubmatch(m)
		if len(sub) < 3 {
			return m
		}
		return "<" + strings.ToLower(sub[1]) + sub[2] + " />"
	})
	return s
}

// escapeProseCurlys converts unescaped curly braces in pure prose to HTML entities.
func escapeProseCurlys(prose string) string {
	if !strings.Contains(prose, "{") && !strings.Contains(prose, "}") {
		return prose
	}
	escaped := strings.ReplaceAll(prose, "{", "&#123;")
	return strings.ReplaceAll(escaped, "}", "&#125;")
}

// healProseWithJsxProtection slices masked text into JSX and Prose intervals,
// escaping only the Prose intervals while preserving JSX verbatim.
func healProseWithJsxProtection(content string, jsxRanges []treesitter.ByteRange) string {
	if len(jsxRanges) == 0 {
		return escapeProseCurlys(content)
	}

	var sb strings.Builder
	sb.Grow(len(content) + 64)
	lastIdx := 0

	for _, r := range jsxRanges {
		if r.Start > lastIdx && r.Start <= len(content) {
			// Prose slice before JSX
			proseSlice := content[lastIdx:r.Start]
			sb.WriteString(escapeProseCurlys(proseSlice))
		}
		if r.Start < len(content) {
			end := r.End
			if end > len(content) {
				end = len(content)
			}
			if end > r.Start {
				// JSX slice: preserve 100% untouched (attributes with braces remain valid JSX)
				sb.WriteString(content[r.Start:end])
				lastIdx = end
			}
		}
	}

	if lastIdx < len(content) {
		// Remaining prose slice
		sb.WriteString(escapeProseCurlys(content[lastIdx:]))
	}

	return sb.String()
}

// fallbackJsxRanges scans candidate JSX tags with quote and brace balancing
// when the Tree-sitter engine is not available.
func fallbackJsxRanges(content string) []treesitter.ByteRange {
	var ranges []treesitter.ByteRange
	n := len(content)
	i := 0

	for i < n {
		if content[i] != '<' || i+1 >= n {
			i++
			continue
		}
		next := content[i+1]
		isTagStart := (next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z') || next == '/'
		if !isTagStart {
			i++
			continue
		}

		start := i
		p := i + 1
		var quote byte
		braceDepth := 0
		for p < n {
			ch := content[p]
			if quote != 0 {
				if ch == quote && (p == 0 || content[p-1] != '\\') {
					quote = 0
				}
				p++
				continue
			}
			matchedClose := false
			switch ch {
			case '"', '\'', '`':
				quote = ch
			case '{':
				braceDepth++
			case '}':
				if braceDepth > 0 {
					braceDepth--
				}
			case '>':
				if braceDepth == 0 {
					p++
					matchedClose = true
				}
			}
			if matchedClose {
				break
			}
			p++
		}
		tagStr := content[start:p]
		// Avoid single-letter generics like <T>
		if !(len(tagStr) == 3 && tagStr[1] >= 'A' && tagStr[1] <= 'Z' && tagStr[2] == '>') {
			ranges = append(ranges, treesitter.ByteRange{Start: start, End: p})
		}
		i = p
	}

	return treesitter.MergeByteRanges(ranges)
}

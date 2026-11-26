package mdx

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/sanitize"
	"github.com/opengits/worker-sidecar/internal/treesitter"
)

var (
	tsEngine     *treesitter.Engine
	tsEngineOnce sync.Once
)

func SetTsEngine(engine *treesitter.Engine) {
	tsEngine = engine
}

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

// Escapes braces only in prose; fenced/inline code and Tree-sitter JSX tag ranges stay verbatim.
func HealSource(rawMdx string) (string, error) {
	if rawMdx == "" {
		return "", nil
	}

	cleaned := sanitize.PrepareMdxSource(rawMdx)
	cleaned = armor.NormalizeDeepDiveBlocks(cleaned)

	masked, blocks := sanitize.MaskCodeBlocks(cleaned)
	if len(blocks) > 0 && !strings.Contains(masked, sanitize.MaskTokenPrefix) {
		return "", errors.New("mdx healer failed: code block mask integrity violation")
	}

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

	healed := healProseWithJsxProtection(masked, jsxRanges)

	healed = normalizeVoidTags(healed)

	unmasked := sanitize.UnmaskCodeBlocksRaw(healed, blocks)
	return unmasked, nil
}

func normalizeVoidTags(s string) string {
	s = mdpat.VoidBrRe.ReplaceAllString(s, "<br />")
	s = mdpat.VoidHrRe.ReplaceAllString(s, "<hr />")
	s = mdpat.VoidWbrRe.ReplaceAllString(s, "<wbr />")
	// Lowercases void tag names so uppercase React components remain untouched.
	s = mdpat.VoidImgInputRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := mdpat.VoidImgInputRe.FindStringSubmatch(m)
		if len(sub) < 3 {
			return m
		}
		return "<" + strings.ToLower(sub[1]) + sub[2] + " />"
	})
	return s
}

func escapeProseCurlys(prose string) string {
	if !strings.Contains(prose, "{") && !strings.Contains(prose, "}") {
		return prose
	}
	escaped := strings.ReplaceAll(prose, "{", "&#123;")
	return strings.ReplaceAll(escaped, "}", "&#125;")
}

func healProseWithJsxProtection(content string, jsxRanges []treesitter.ByteRange) string {
	if len(jsxRanges) == 0 {
		return escapeProseCurlys(content)
	}

	var sb strings.Builder
	sb.Grow(len(content) + 64)
	lastIdx := 0

	for _, r := range jsxRanges {
		if r.Start > lastIdx && r.Start <= len(content) {
			proseSlice := content[lastIdx:r.Start]
			sb.WriteString(escapeProseCurlys(proseSlice))
		}
		if r.Start < len(content) {
			end := r.End
			if end > len(content) {
				end = len(content)
			}
			if end > r.Start {
				sb.WriteString(content[r.Start:end])
				lastIdx = end
			}
		}
	}

	if lastIdx < len(content) {
		sb.WriteString(escapeProseCurlys(content[lastIdx:]))
	}

	return sb.String()
}

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
		// Single-letter tags like <T> are TypeScript generics, not JSX components.
		if !(len(tagStr) == 3 && tagStr[1] >= 'A' && tagStr[1] <= 'Z' && tagStr[2] == '>') {
			ranges = append(ranges, treesitter.ByteRange{Start: start, End: p})
		}
		i = p
	}

	return treesitter.MergeByteRanges(ranges)
}

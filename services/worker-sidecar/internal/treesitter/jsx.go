package treesitter

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strings"
)

type ByteRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

const jsxQueryScm = `[
  (jsx_element)
  (jsx_self_closing_element)
  (jsx_opening_element)
  (jsx_closing_element)
] @jsx`

const jsxTagOnlyQueryScm = `[
  (jsx_self_closing_element)
  (jsx_opening_element)
  (jsx_closing_element)
] @jsx`

func (w *worker) ensureJsxQueryWith(key, queryScm string, langPtr uint64) (uint64, error) {
	if qPtr, ok := w.queries[key]; ok {
		return qPtr, nil
	}

	queryBytes := []byte(queryScm)
	qMem, err := w.malloc.Call(w.ctx, uint64(len(queryBytes)+1))
	if err != nil {
		return 0, err
	}
	defer w.free.Call(w.ctx, qMem[0])

	if werr := w.writeMem(uint32(qMem[0]), append(queryBytes, 0)); werr != nil {
		return 0, werr
	}

	errOffMem, _ := w.malloc.Call(w.ctx, 4)
	errTypeMem, _ := w.malloc.Call(w.ctx, 4)
	defer w.free.Call(w.ctx, errOffMem[0])
	defer w.free.Call(w.ctx, errTypeMem[0])

	res, err := w.queryNew.Call(w.ctx, langPtr, qMem[0], uint64(len(queryBytes)), errOffMem[0], errTypeMem[0])
	if err != nil {
		return 0, fmt.Errorf("failed to compile jsx query: %w", err)
	}
	queryPtr := res[0]
	if queryPtr == 0 {
		offBytes, _ := w.envMod.Memory().Read(uint32(errOffMem[0]), 4)
		errOffset := uint32(offBytes[0]) | (uint32(offBytes[1]) << 8) | (uint32(offBytes[2]) << 16) | (uint32(offBytes[3]) << 24)
		return 0, fmt.Errorf("invalid jsx query at byte offset %d", errOffset)
	}

	w.queries[key] = queryPtr
	return queryPtr, nil
}

func (e *Engine) ExtractJsxRanges(ctx context.Context, source []byte) ([]ByteRange, error) {
	return e.extractJsxRangesWithQuery(ctx, source, "tsx:jsx", jsxQueryScm)
}

func (e *Engine) extractJsxRangesWithQuery(ctx context.Context, source []byte, queryKey, queryScm string) ([]ByteRange, error) {
	if len(source) == 0 {
		return nil, nil
	}

	w, err := e.acquireWorker(ctx)
	if err != nil {
		return nil, err
	}
	defer e.releaseWorker(w)

	return w.extractJsxRangesWithQuery(ctx, source, queryKey, queryScm)
}

func (w *worker) extractJsxRangesWithQuery(ctx context.Context, source []byte, queryKey, queryScm string) ([]ByteRange, error) {
	w.parseCount++
	langPtr, err := w.ensureLanguage("tsx")
	if err != nil {
		return nil, err
	}

	queryPtr, err := w.ensureJsxQueryWith(queryKey, queryScm, langPtr)
	if err != nil {
		return nil, err
	}

	setRes, err := w.parserSetLang.Call(w.ctx, w.parserPtr, langPtr)
	if err != nil || setRes[0] == 0 {
		return nil, fmt.Errorf("failed to set tsx language on parser: %w", err)
	}

	codeMem, err := w.malloc.Call(w.ctx, uint64(len(source)+1))
	if err != nil {
		return nil, err
	}
	defer w.free.Call(w.ctx, codeMem[0])

	if werr := w.writeMem(uint32(codeMem[0]), append(source, 0)); werr != nil {
		return nil, werr
	}

	pRes, err := w.parserParse.Call(w.ctx, w.parserPtr, 0, codeMem[0], uint64(len(source)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse tsx: %w", err)
	}
	treePtr := pRes[0]
	if treePtr == 0 {
		return nil, fmt.Errorf("parser returned null tree")
	}
	defer w.free.Call(w.ctx, treePtr)

	if _, err := w.treeRootNode.Call(w.ctx, w.nodeMem, treePtr); err != nil {
		return nil, fmt.Errorf("failed to get root node: %w", err)
	}

	if _, err := w.cursorExec.Call(w.ctx, w.cursorPtr, queryPtr, w.nodeMem); err != nil {
		return nil, fmt.Errorf("failed to execute query cursor: %w", err)
	}

	var rawRanges []ByteRange
	for {
		mRes, err := w.cursorNext.Call(w.ctx, w.cursorPtr, w.matchMem)
		if err != nil {
			return nil, fmt.Errorf("query cursor next failed: %w", err)
		}
		if mRes[0] == 0 {
			break
		}

		matchBytes, ok := w.envMod.Memory().Read(uint32(w.matchMem), 12)
		if !ok {
			break
		}
		captureCount := uint16(matchBytes[6]) | (uint16(matchBytes[7]) << 8)
		capturesPtr := uint32(matchBytes[8]) | (uint32(matchBytes[9]) << 8) | (uint32(matchBytes[10]) << 16) | (uint32(matchBytes[11]) << 24)

		for i := uint16(0); i < captureCount; i++ {
			capOffset := capturesPtr + uint32(i)*28
			capNodePtr := capOffset

			sbRes, err := w.nodeStartByte.Call(w.ctx, uint64(capNodePtr))
			if err != nil {
				continue
			}
			ebRes, err := w.nodeEndByte.Call(w.ctx, uint64(capNodePtr))
			if err != nil {
				continue
			}
			sb := int(sbRes[0])
			eb := int(ebRes[0])

			if sb < eb && eb <= len(source) {
				rawRanges = append(rawRanges, ByteRange{Start: sb, End: eb})
			}
		}
	}

	return MergeByteRanges(rawRanges), nil
}

func (e *Engine) ParseJsxSnippet(ctx context.Context, snippet []byte) (bool, ByteRange, error) {
	ranges, err := e.ExtractJsxRanges(ctx, snippet)
	if err != nil {
		return false, ByteRange{}, err
	}
	trimmed := strings.TrimSpace(string(snippet))
	if len(trimmed) == 0 {
		return false, ByteRange{}, nil
	}
	for _, r := range ranges {
		matched := strings.TrimSpace(string(snippet[r.Start:r.End]))
		if matched == trimmed {
			return true, r, nil
		}
	}
	return false, ByteRange{}, nil
}

func (e *Engine) ScanMdxJsxRanges(ctx context.Context, source []byte) ([]ByteRange, error) {
	return e.scanMdxJsxRangesWith(ctx, source, "tsx:jsx", jsxQueryScm)
}

// Match only tag boundaries, excluding prose children, so MDX brace healing still escapes text inside containers.
func (e *Engine) ScanMdxJsxTagRanges(ctx context.Context, source []byte) ([]ByteRange, error) {
	return e.scanMdxJsxRangesWith(ctx, source, "tsx:jsx-tags", jsxTagOnlyQueryScm)
}

func (e *Engine) scanMdxJsxRangesWith(ctx context.Context, source []byte, queryKey, queryScm string) ([]ByteRange, error) {
	if len(source) == 0 {
		return nil, nil
	}

	ranges, err := e.extractJsxRangesWithQuery(ctx, source, queryKey, queryScm)
	if err != nil {
		return nil, err
	}

	// Cache only positive full-tag validations so transient worker errors do not poison valid tags.
	snippetMemo := make(map[string]bool, 16)
	const snippetMemoCap = 256

	isCovered := func(start, end int) bool {
		for _, r := range ranges {
			if r.Start <= start && r.End >= end {
				return true
			}
		}
		return false
	}

	inFence := false
	inInlineCode := false
	n := len(source)
	i := 0

	for i < n {
		b := source[i]
		isLineStart := i == 0 || source[i-1] == '\n'

		if isLineStart && (b == '`' || b == '~') {
			count := 0
			p := i
			for p < n && source[p] == b {
				count++
				p++
			}
			if count >= 3 {
				inFence = !inFence
				i = p
				continue
			}
		}
		if inFence {
			i++
			continue
		}

		if b == '`' {
			inInlineCode = !inInlineCode
			i++
			continue
		}
		if inInlineCode {
			i++
			continue
		}

		if b != '<' || i+1 >= n {
			i++
			continue
		}
		next := source[i+1]
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
			ch := source[p]
			if quote != 0 {
				if ch == quote && (p == 0 || source[p-1] != '\\') {
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

		tagBytes := source[start:p]
		tagName := extractTagName(string(tagBytes))

		// Treat non-self-closing single-uppercase tags like <T> as generic type parameters, not JSX.
		if len(tagName) == 1 && tagName[0] >= 'A' && tagName[0] <= 'Z' && !strings.HasSuffix(string(tagBytes), "/>") {
			i = p
			continue
		}

		if !isCovered(start, p) {
			valid := false
			if v, ok := snippetMemo[string(tagBytes)]; ok {
				valid = v
			} else {
				v, _, _ := e.ParseJsxSnippet(ctx, tagBytes)
				valid = v
				if valid && len(snippetMemo) < snippetMemoCap {

					snippetMemo[string(tagBytes)] = valid
				}
			}
			if valid {
				ranges = append(ranges, ByteRange{Start: start, End: p})
				if closeRange, found := findClosingTagRange(source, p, tagName, string(tagBytes)); found {
					ranges = append(ranges, closeRange)
				}
			}
		}
		i = p
	}

	return MergeByteRanges(ranges), nil
}

func extractTagName(tagStr string) string {
	s := strings.TrimPrefix(tagStr, "<")
	s = strings.TrimPrefix(s, "/")
	var name []rune
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '.' {
			name = append(name, r)
		} else {
			break
		}
	}
	return string(name)
}

func findClosingTagRange(source []byte, p int, tagName, tagStr string) (ByteRange, bool) {
	if tagName == "" || strings.HasPrefix(tagName, "/") || strings.HasSuffix(tagStr, "/>") {
		return ByteRange{}, false
	}
	closeTag := "</" + tagName + ">"
	closeIdx := bytes.Index(source[p:], []byte(closeTag))
	if closeIdx < 0 {
		return ByteRange{}, false
	}
	closeStart := p + closeIdx
	return ByteRange{Start: closeStart, End: closeStart + len(closeTag)}, true
}

func MergeByteRanges(ranges []ByteRange) []ByteRange {
	if len(ranges) <= 1 {
		return ranges
	}

	sort.Slice(ranges, func(i, j int) bool {
		if ranges[i].Start == ranges[j].Start {
			return ranges[i].End > ranges[j].End
		}
		return ranges[i].Start < ranges[j].Start
	})

	merged := make([]ByteRange, 0, len(ranges))
	curr := ranges[0]

	for i := 1; i < len(ranges); i++ {
		next := ranges[i]
		if next.Start <= curr.End {

			if next.End > curr.End {
				curr.End = next.End
			}
		} else {
			merged = append(merged, curr)
			curr = next
		}
	}
	merged = append(merged, curr)

	return merged
}

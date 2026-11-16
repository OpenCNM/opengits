package chunker

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat")

// chunkerAtxHeadingRe 行锚定 ATX 标题匹配（一维流式文本——AGENTS.md 正则
// 安全区）。刻意不升级 goldmark AST：AST 会引入 setext/缩进码块等语义差异，
// 导致 chunk 边界漂移与既有全量重切片（数据 churn），而当前逐行状态机
// 已正确用 fence 隔离代码块且被 golden 锁定。
var chunkerAtxHeadingRe = regexp.MustCompile(`^(#{1,6})\s+(.*)`)

const (
	maxHeaderTokens        = 60.0
	codeBlockOverflowLimit = 1200.0
	codeBlockMaxRatio      = 1.5
)

// estimateChunkerTokens markdown 切分 token 预算估算（mdpat SSOT 浮点口径；
// 审计 §10 根治——历史 1.5 系数 + 假名/谚文失明块集与 doc/mcp 双实现漂移，
// 统一收敛 token-counter.ts 真值 1.3/0.25）。
func estimateChunkerTokens(text string) float64 {
	return mdpat.EstimateTokensFloat(text)
}

// formatContextualHeader generates a contextual breadcrumb header [Path: ... | Section: ...]
// clamped to at most 60 tokens, with graceful truncation of long paths and sections.
func formatContextualHeader(docPath, parentTitle, headingStr string) string {
	p := docPath
	if p == "" {
		p = "root"
	}
	h := headingStr
	if h == "" {
		h = "General"
	}
	s := h
	if parentTitle != "" {
		s = parentTitle + " > " + h
	}
	header := fmt.Sprintf("[Path: %s | Section: %s]", p, s)
	if estimateChunkerTokens(header) <= maxHeaderTokens {
		return header
	}

	trimmedP := p
	parts := strings.Split(p, "/")
	if len(parts) > 2 {
		trimmedP = ".../" + strings.Join(parts[len(parts)-2:], "/")
	} else {
		pRunes := []rune(trimmedP)
		if len(pRunes) > 30 {
			trimmedP = "..." + string(pRunes[len(pRunes)-27:])
		}
	}

	trimmedS := s
	header = fmt.Sprintf("[Path: %s | Section: %s]", trimmedP, trimmedS)
	if estimateChunkerTokens(header) <= maxHeaderTokens {
		return header
	}

	trimmedParent := parentTitle
	trimmedHead := h
	parentRunes := []rune(trimmedParent)
	if len(parentRunes) > 20 {
		trimmedParent = string(parentRunes[:17]) + "..."
	}
	headRunes := []rune(trimmedHead)
	if len(headRunes) > 25 {
		trimmedHead = string(headRunes[:22]) + "..."
	}
	if trimmedParent != "" {
		trimmedS = trimmedParent + " > " + trimmedHead
	} else {
		trimmedS = trimmedHead
	}
	header = fmt.Sprintf("[Path: %s | Section: %s]", trimmedP, trimmedS)
	if estimateChunkerTokens(header) <= maxHeaderTokens {
		return header
	}

	sRunes := []rune(trimmedS)
	for estimateChunkerTokens(header) > maxHeaderTokens && len(sRunes) > 5 {
		sRunes = append(sRunes[:len(sRunes)-4], []rune("...")...)
		trimmedS = string(sRunes)
		header = fmt.Sprintf("[Path: %s | Section: %s]", trimmedP, trimmedS)
		sRunes = []rune(trimmedS)
	}
	return header
}

// fenceState fence 重放状态机快照（GetOverlapLinesWithBoundary 的重放
// 语义，非主循环 inCodeBlock——后者跨 chunk 连续累计，二者不可混用）。
type fenceState struct {
	openFence string
	openLang  string
}

// advanceFenceState 重放状态机单步推进（与 GetOverlapLinesWithBoundary
// 的重放段逐分支一致——两处共用同一实现，等价性由构造保证）。
func advanceFenceState(st fenceState, line string) fenceState {
	if st.openFence == "" {
		if fm := fenceRe.FindStringSubmatch(line); fm != nil {
			st.openFence = fm[1]
			parts := strings.Fields(strings.TrimSpace(fm[2]))
			if len(parts) > 0 {
				st.openLang = parts[0]
			} else {
				st.openLang = ""
			}
		}
	} else {
		if fm := fenceRe.FindStringSubmatch(line); fm != nil {
			if fm[1][0] == st.openFence[0] && len(fm[1]) >= len(st.openFence) && strings.TrimSpace(fm[2]) == "" {
				st.openFence = ""
				st.openLang = ""
			}
		}
	}
	return st
}

// buildFenceSnapshots 逐行推进构建快照数组：snaps[i] = 处理完
// lines[0..i] 后的 fence 状态（snaps 为空数组当且仅当 lines 为空）。
func buildFenceSnapshots(lines []string) []fenceState {
	snaps := make([]fenceState, len(lines))
	st := fenceState{}
	for i, line := range lines {
		st = advanceFenceState(st, line)
		snaps[i] = st
	}
	return snaps
}

// GetOverlapLinesWithBoundary ensures open code fences are preserved across slice boundaries.
func GetOverlapLinesWithBoundary(allLines []string, sliceCount int, maxTokens float64) []string {
	return getOverlapLinesWithSnapshots(allLines, buildFenceSnapshots(allLines), sliceCount, maxTokens)
}

// getOverlapLinesWithSnapshots GetOverlapLinesWithBoundary 的快照加速版：
// snaps 为 allLines 的 fence 快照（buildFenceSnapshots 产物，调用方随
// 行追加增量维护）。边界态查 snaps[startIndex-1] 替代从头重放——大文档
// 每块边界一次 O(startIndex) 重放是准二次开销。
func getOverlapLinesWithSnapshots(allLines []string, snaps []fenceState, sliceCount int, maxTokens float64) []string {
	if sliceCount <= 0 || len(allLines) == 0 {
		return nil
	}
	startIndex := len(allLines) - sliceCount
	if startIndex < 0 {
		startIndex = 0
	}

	st := fenceState{}
	if startIndex > 0 && startIndex-1 < len(snaps) {
		st = snaps[startIndex-1]
	}
	openFence, openLang := st.openFence, st.openLang

	overlapLines := append([]string(nil), allLines[startIndex:]...)
	if openFence != "" && len(overlapLines) > 0 {
		fm := fenceRe.FindStringSubmatch(overlapLines[0])
		isOpenFence := fm != nil && fm[1][0] == openFence[0] && strings.TrimSpace(fm[2]) != ""
		if !isOpenFence {
			overlapLines = append([]string{openFence + openLang}, overlapLines...)
		}
	}

	overlapTokens := estimateChunkerTokens(strings.Join(overlapLines, "\n"))
	for overlapTokens > maxTokens/2 && len(overlapLines) > 1 {
		overlapLines = overlapLines[1:]
		overlapTokens = estimateChunkerTokens(strings.Join(overlapLines, "\n"))
	}

	if len(overlapLines) > 0 && openFence != "" {
		fm := fenceRe.FindStringSubmatch(overlapLines[0])
		isOpenFence := fm != nil && fm[1][0] == openFence[0] && strings.TrimSpace(fm[2]) != ""
		if !isOpenFence {
			overlapLines = append([]string{openFence + openLang}, overlapLines...)
		}
	}

	return overlapLines
}

type headingStackItem struct {
	level int
	title string
}

// ChunkMarkdown splits markdown content by H1-H6 headings with code block awareness and breadcrumb headers.
func ChunkMarkdown(req MarkdownChunkRequest) []MarkdownChunk {
	content := strings.ReplaceAll(req.Content, "\r\n", "\n")
	maxTokens := float64(req.MaxTokens)
	if maxTokens <= 0 {
		maxTokens = 800.0
	}
	overlap := req.Overlap
	if overlap <= 0 {
		overlap = 100
	}

	lines := strings.Split(content, "\n")
	var chunks []MarkdownChunk

	currentHeading := "General"
	var headingStack []headingStackItem
	var currentChunkLines []string
	currentTokens := 0.0

	inCodeBlock := false
	codeBlockLang := ""
	codeFence := ""
	codeBlockTokens := 0.0

	// fence 快照（getOverlapLinesWithSnapshots 的增量维护产物）：随行追加
	// 推进，chunk 重置换代后整体重建（返回的重叠尾行 ≤ sliceCount+2 行，
	// 重建 O(常数)）。快照机与主循环 inCodeBlock 是两套状态，互不共享。
	currentFenceSnaps := make([]fenceState, 0, 256)
	nextFenceState := func(line string) fenceState {
		st := fenceState{}
		if n := len(currentFenceSnaps); n > 0 {
			st = currentFenceSnaps[n-1]
		}
		return advanceFenceState(st, line)
	}

	finishChunk := func(forceCloseCodeBlock bool) {
		if len(currentChunkLines) == 0 {
			return
		}
		linesToEmit := append([]string(nil), currentChunkLines...)

		var activeFence string
		for _, line := range linesToEmit {
			fm := fenceRe.FindStringSubmatch(line)
			if fm == nil {
				continue
			}
			if activeFence == "" {
				activeFence = fm[1]
			} else if fm[1][0] == activeFence[0] && len(fm[1]) >= len(activeFence) && strings.TrimSpace(fm[2]) == "" {
				activeFence = ""
			}
		}

		if activeFence != "" {
			linesToEmit = append(linesToEmit, activeFence)
		} else if forceCloseCodeBlock && inCodeBlock && codeFence != "" {
			linesToEmit = append(linesToEmit, codeFence)
		}

		rawContent := strings.TrimSpace(strings.Join(linesToEmit, "\n"))
		if len(rawContent) > 0 {
			header := formatContextualHeader(req.DocPath, req.ParentTitle, currentHeading)
			var headingPath *string
			if len(headingStack) > 0 {
				var titles []string
				for _, h := range headingStack {
					titles = append(titles, h.title)
				}
				hp := strings.Join(titles, " > ")
				headingPath = &hp
			}
			chunks = append(chunks, MarkdownChunk{
				Heading:     currentHeading,
				HeadingPath: headingPath,
				Content:     fmt.Sprintf("%s\n\n%s", header, rawContent),
			})
		}
	}

	for _, line := range lines {
		lineTokens := estimateChunkerTokens(line)

		var match []string
		if !inCodeBlock {
			match = chunkerAtxHeadingRe.FindStringSubmatch(line)
		}

		if match != nil {
			if currentTokens > maxTokens/2 {
				finishChunk(false)
				sliceCount := overlap / 10
				currentChunkLines = getOverlapLinesWithSnapshots(currentChunkLines, currentFenceSnaps, sliceCount, maxTokens)
				currentTokens = estimateChunkerTokens(strings.Join(currentChunkLines, "\n"))
				currentFenceSnaps = buildFenceSnapshots(currentChunkLines)
			}
			level := len(match[1])
			for len(headingStack) > 0 && headingStack[len(headingStack)-1].level >= level {
				headingStack = headingStack[:len(headingStack)-1]
			}
			cleanHeading := CleanMarkdownHeading(match[2])
			if cleanHeading != "" {
				headingStack = append(headingStack, headingStackItem{level: level, title: cleanHeading})
				currentHeading = cleanHeading
			} else {
				if len(headingStack) > 0 {
					currentHeading = headingStack[len(headingStack)-1].title
				} else {
					currentHeading = ""
				}
			}
		}

		fenceMatch := fenceRe.FindStringSubmatch(line)
		if !inCodeBlock {
			if fenceMatch != nil {
				inCodeBlock = true
				codeFence = fenceMatch[1]
				parts := strings.Fields(strings.TrimSpace(fenceMatch[2]))
				if len(parts) > 0 {
					codeBlockLang = parts[0]
				} else {
					codeBlockLang = ""
				}
				_ = codeBlockLang
				codeBlockTokens = lineTokens
			}
		} else {
			codeBlockTokens += lineTokens
			if fenceMatch != nil && fenceMatch[1][0] == codeFence[0] && len(fenceMatch[1]) >= len(codeFence) && strings.TrimSpace(fenceMatch[2]) == "" {
				inCodeBlock = false
			}
		}

		currentChunkLines = append(currentChunkLines, line)
		currentFenceSnaps = append(currentFenceSnaps, nextFenceState(line))
		currentTokens += lineTokens

		if currentTokens >= maxTokens {
			if inCodeBlock {
				if codeBlockTokens >= codeBlockOverflowLimit || codeBlockTokens >= maxTokens*codeBlockMaxRatio {
					finishChunk(true)
					sliceCount := overlap / 10
					currentChunkLines = getOverlapLinesWithSnapshots(currentChunkLines, currentFenceSnaps, sliceCount, maxTokens)
					currentTokens = estimateChunkerTokens(strings.Join(currentChunkLines, "\n"))
					codeBlockTokens = currentTokens
					currentFenceSnaps = buildFenceSnapshots(currentChunkLines)
				}
			} else {
				finishChunk(false)
				sliceCount := overlap / 10
				currentChunkLines = getOverlapLinesWithSnapshots(currentChunkLines, currentFenceSnaps, sliceCount, maxTokens)
				currentTokens = estimateChunkerTokens(strings.Join(currentChunkLines, "\n"))
				currentFenceSnaps = buildFenceSnapshots(currentChunkLines)
			}
		}
	}

	finishChunk(inCodeBlock)
	var validChunks []MarkdownChunk
	for _, c := range chunks {
		if len(c.Content) > 0 {
			validChunks = append(validChunks, c)
		}
	}
	return validChunks
}

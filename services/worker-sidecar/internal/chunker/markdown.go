package chunker

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// Use line-anchored ATX matching rather than full AST to keep golden chunk boundaries stable.
var chunkerAtxHeadingRe = regexp.MustCompile(`^(#{1,6})\s+(.*)`)

const (
	maxHeaderTokens        = 60.0
	codeBlockOverflowLimit = 1200.0
	codeBlockMaxRatio      = 1.5
)

func estimateChunkerTokens(text string) float64 {
	return mdpat.EstimateTokensFloat(text)
}

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

// Isolate replay fenceState from main-loop inCodeBlock because overlap replay resets per chunk.
type fenceState struct {
	openFence string
	openLang  string
}

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

func buildFenceSnapshots(lines []string) []fenceState {
	snaps := make([]fenceState, len(lines))
	st := fenceState{}
	for i, line := range lines {
		st = advanceFenceState(st, line)
		snaps[i] = st
	}
	return snaps
}

func GetOverlapLinesWithBoundary(allLines []string, sliceCount int, maxTokens float64) []string {
	return getOverlapLinesWithSnapshots(allLines, buildFenceSnapshots(allLines), sliceCount, maxTokens)
}

// Read precomputed fence snapshots to avoid O(N^2) boundary replays on large documents.
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

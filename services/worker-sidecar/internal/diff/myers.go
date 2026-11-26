package diff

import (
	"log"

	"fmt"
	"strings"
)

func splitLines(text string) []string {
	if text == "" {
		return []string{}
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	if strings.HasSuffix(text, "\n") {
		text = text[:len(text)-1]
	}
	return strings.Split(text, "\n")
}

func resolvePaths(oldPathPtr, newPathPtr *string) (string, string) {
	var op, np string
	if oldPathPtr != nil {
		op = strings.TrimSpace(*oldPathPtr)
	}
	if newPathPtr != nil {
		np = strings.TrimSpace(*newPathPtr)
	}
	if op == "" && np == "" {
		op = "file"
		np = "file"
	} else if op == "" {
		op = np
	} else if np == "" {
		np = op
	}
	return op, np
}

func formatHeaderPath(p, defaultPrefix string) string {
	if p == "/dev/null" {
		return "/dev/null"
	}
	if strings.HasPrefix(p, defaultPrefix+"/") {
		return p
	}
	return defaultPrefix + "/" + p
}

func ComputeMyersDiff(oldText, newText string, oldPathPtr, newPathPtr *string, contextLinesPtr *int) UnifiedDiffResult {
	contextLines := 3
	if contextLinesPtr != nil {
		contextLines = *contextLinesPtr
	}
	if contextLines < 0 {
		contextLines = 0
	}

	op, np := resolvePaths(oldPathPtr, newPathPtr)
	oldHeader := formatHeaderPath(op, "a")
	newHeader := formatHeaderPath(np, "b")

	if oldText == newText {
		return UnifiedDiffResult{
			Unified:   "",
			Hunks:     []DiffHunk{},
			Additions: 0,
			Deletions: 0,
		}
	}

	oldLines := splitLines(oldText)
	newLines := splitLines(newText)
	N := len(oldLines)
	M := len(newLines)

	if N == 0 && M == 0 {
		return UnifiedDiffResult{
			Unified:   "",
			Hunks:     []DiffHunk{},
			Additions: 0,
			Deletions: 0,
		}
	}

	if N == 0 && M > 0 {
		lines := make([]string, M)
		for i, l := range newLines {
			lines[i] = "+" + l
		}
		hunk := DiffHunk{
			OldStart: 0,
			OldLines: 0,
			NewStart: 1,
			NewLines: M,
			Lines:    lines,
		}
		diffLines := []string{
			fmt.Sprintf("--- %s", oldHeader),
			fmt.Sprintf("+++ %s", newHeader),
			fmt.Sprintf("@@ -0,0 +1,%d @@", M),
		}
		diffLines = append(diffLines, lines...)
		return UnifiedDiffResult{
			Unified:   strings.Join(diffLines, "\n"),
			Hunks:     []DiffHunk{hunk},
			Additions: M,
			Deletions: 0,
		}
	}

	if N > 0 && M == 0 {
		lines := make([]string, N)
		for i, l := range oldLines {
			lines[i] = "-" + l
		}
		hunk := DiffHunk{
			OldStart: 1,
			OldLines: N,
			NewStart: 0,
			NewLines: 0,
			Lines:    lines,
		}
		diffLines := []string{
			fmt.Sprintf("--- %s", oldHeader),
			fmt.Sprintf("+++ %s", newHeader),
			fmt.Sprintf("@@ -1,%d +0,0 @@", N),
		}
		diffLines = append(diffLines, lines...)
		return UnifiedDiffResult{
			Unified:   strings.Join(diffLines, "\n"),
			Hunks:     []DiffHunk{hunk},
			Additions: 0,
			Deletions: N,
		}
	}

	max := N + M
	vSize := 2*max + 1
	v := make([]int, vSize)
	v[1+max] = 0

	maxDiffSteps := 4096
	if max > 8192 {
		maxDiffSteps = 2048
	}
	bailedOut := false

	trace := make([][]int, 0, max+1)

outerLoop:
	for d := 0; d <= max; d++ {
		if d > maxDiffSteps {
			bailedOut = true
			break outerLoop
		}
		vCopy := make([]int, vSize)
		copy(vCopy, v)
		trace = append(trace, vCopy)

		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[k-1+max] < v[k+1+max]) {
				x = v[k+1+max]
			} else {
				x = v[k-1+max] + 1
			}
			y := x - k
			for x < N && y < M && oldLines[x] == newLines[y] {
				x++
				y++
			}
			v[k+max] = x
			if x >= N && y >= M {
				break outerLoop
			}
		}
	}

	if bailedOut {
		lines := make([]string, 0, N+M)
		for _, l := range oldLines {
			lines = append(lines, "-"+l)
		}
		for _, l := range newLines {
			lines = append(lines, "+"+l)
		}
		hunk := DiffHunk{
			OldStart: 1,
			OldLines: N,
			NewStart: 1,
			NewLines: M,
			Lines:    lines,
		}
		diffLines := []string{
			fmt.Sprintf("--- %s", oldHeader),
			fmt.Sprintf("+++ %s", newHeader),
			fmt.Sprintf("@@ -1,%d +1,%d @@", N, M),
		}
		diffLines = append(diffLines, lines...)
		log.Printf("[myers] degraded whole-file diff (edit distance > %d): old=%d new=%d lines — treated as fully changed (decision A)", maxDiffSteps, N, M)
		// Mark Degraded when edit distance exceeds budget so callers treat the file as changed without exact line billing.
		return UnifiedDiffResult{
			Unified:   strings.Join(diffLines, "\n"),
			Hunks:     []DiffHunk{hunk},
			Additions: M,
			Deletions: N,
			Degraded:  true,
		}
	}

	type editOp struct {
		opType byte
		text   string
	}
	var ops []editOp
	x := N
	y := M

	for d := len(trace) - 1; d > 0; d-- {
		k := x - y
		prevV := trace[d]
		var prevK int
		if k == -d || (k != d && prevV[k-1+max] < prevV[k+1+max]) {
			prevK = k + 1
		} else {
			prevK = k - 1
		}
		prevX := prevV[prevK+max]
		prevY := prevX - prevK

		midX := prevX
		midY := prevY
		if prevK == k-1 {
			midX = prevX + 1
		} else {
			midY = prevY + 1
		}

		for x > midX && y > midY {
			ops = append(ops, editOp{opType: ' ', text: oldLines[x-1]})
			x--
			y--
		}

		if prevK == k-1 {
			ops = append(ops, editOp{opType: '-', text: oldLines[prevX]})
		} else {
			ops = append(ops, editOp{opType: '+', text: newLines[prevY]})
		}

		x = prevX
		y = prevY
	}

	for x > 0 && y > 0 {
		ops = append(ops, editOp{opType: ' ', text: oldLines[x-1]})
		x--
		y--
	}

	for i, j := 0, len(ops)-1; i < j; i, j = i+1, j-1 {
		ops[i], ops[j] = ops[j], ops[i]
	}

	type annotatedOp struct {
		opType  byte
		text    string
		oldLine int
		newLine int
	}

	currOld := 0
	currNew := 0
	annotated := make([]annotatedOp, len(ops))
	for i, op := range ops {
		ol := 0
		nl := 0
		if op.opType == ' ' || op.opType == '-' {
			currOld++
			ol = currOld
		}
		if op.opType == ' ' || op.opType == '+' {
			currNew++
			nl = currNew
		}
		annotated[i] = annotatedOp{
			opType:  op.opType,
			text:    op.text,
			oldLine: ol,
			newLine: nl,
		}
	}

	idx := 0
	for idx < len(annotated) {
		if annotated[idx].opType != ' ' {
			end := idx
			for end < len(annotated) && annotated[end].opType != ' ' {
				end++
			}
			var dels []annotatedOp
			var inss []annotatedOp
			for i := idx; i < end; i++ {
				if annotated[i].opType == '-' {
					dels = append(dels, annotated[i])
				} else {
					inss = append(inss, annotated[i])
				}
			}
			reordered := append(dels, inss...)
			for i := 0; i < len(reordered); i++ {
				annotated[idx+i] = reordered[i]
			}
			idx = end
		} else {
			idx++
		}
	}

	type changeBlock struct {
		start int
		end   int
	}
	var changeBlocks []changeBlock
	idx = 0
	for idx < len(annotated) {
		if annotated[idx].opType != ' ' {
			s := idx
			for idx < len(annotated) && annotated[idx].opType != ' ' {
				idx++
			}
			changeBlocks = append(changeBlocks, changeBlock{start: s, end: idx - 1})
		} else {
			idx++
		}
	}

	if len(changeBlocks) == 0 {
		return UnifiedDiffResult{
			Unified:   "",
			Hunks:     []DiffHunk{},
			Additions: 0,
			Deletions: 0,
		}
	}

	type mergedRange struct {
		start int
		end   int
	}
	var mergedRanges []mergedRange
	currentRange := mergedRange{
		start: changeBlocks[0].start,
		end:   changeBlocks[0].end,
	}

	for i := 1; i < len(changeBlocks); i++ {
		nextBlock := changeBlocks[i]
		gap := nextBlock.start - currentRange.end - 1
		if gap <= 2*contextLines {
			currentRange.end = nextBlock.end
		} else {
			mergedRanges = append(mergedRanges, currentRange)
			currentRange = mergedRange{start: nextBlock.start, end: nextBlock.end}
		}
	}
	mergedRanges = append(mergedRanges, currentRange)

	var hunks []DiffHunk
	totalAdditions := 0
	totalDeletions := 0

	for _, rg := range mergedRanges {
		hunkStart := rg.start - contextLines
		if hunkStart < 0 {
			hunkStart = 0
		}
		hunkEnd := rg.end + contextLines
		if hunkEnd >= len(annotated) {
			hunkEnd = len(annotated) - 1
		}
		hunkOps := annotated[hunkStart : hunkEnd+1]

		var lines []string
		oldLinesCount := 0
		newLinesCount := 0
		oldStart := 0
		newStart := 0

		for _, opItem := range hunkOps {
			lines = append(lines, fmt.Sprintf("%c%s", opItem.opType, opItem.text))
			if opItem.opType == ' ' || opItem.opType == '-' {
				oldLinesCount++
				if oldStart == 0 {
					oldStart = opItem.oldLine
				}
			}
			if opItem.opType == ' ' || opItem.opType == '+' {
				newLinesCount++
				if newStart == 0 {
					newStart = opItem.newLine
				}
			}
			if opItem.opType == '+' {
				totalAdditions++
			}
			if opItem.opType == '-' {
				totalDeletions++
			}
		}

		if oldLinesCount == 0 {
			if hunkStart > 0 {
				oldStart = annotated[hunkStart-1].oldLine
			} else {
				oldStart = 0
			}
		}
		if newLinesCount == 0 {
			if hunkStart > 0 {
				newStart = annotated[hunkStart-1].newLine
			} else {
				newStart = 0
			}
		}

		hunks = append(hunks, DiffHunk{
			OldStart: oldStart,
			OldLines: oldLinesCount,
			NewStart: newStart,
			NewLines: newLinesCount,
			Lines:    lines,
		})
	}

	var diffLines []string
	diffLines = append(diffLines, fmt.Sprintf("--- %s", oldHeader))
	diffLines = append(diffLines, fmt.Sprintf("+++ %s", newHeader))
	for _, h := range hunks {
		diffLines = append(diffLines, fmt.Sprintf("@@ -%d,%d +%d,%d @@", h.OldStart, h.OldLines, h.NewStart, h.NewLines))
		diffLines = append(diffLines, h.Lines...)
	}

	return UnifiedDiffResult{
		Unified:   strings.Join(diffLines, "\n"),
		Hunks:     hunks,
		Additions: totalAdditions,
		Deletions: totalDeletions,
	}
}

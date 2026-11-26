package doc

import (
	"math"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const DefaultTruncateSuffix = "\n\n...[Content truncated to fit token budget]"

func EstimateTokens(text string) int {
	return mdpat.EstimateTokens(text)
}

var codeFenceRegex = mdpat.CodeFenceLineRe

func TruncateToTokenBudget(text string, maxTokens int, suffix string) string {
	if maxTokens <= 0 || len(text) == 0 {
		return ""
	}

	if EstimateTokens(text) <= maxTokens {
		return text
	}

	suffixTokens := EstimateTokens(suffix)
	if maxTokens <= suffixTokens {
		if suffixTokens <= maxTokens {
			return strings.TrimSpace(suffix)
		}
		return ""
	}

	// Reserve ~15 tokens so unclosed code fences or HTML comments can be closed within budget.
	targetTokens := maxTokens - suffixTokens - 15
	if targetTokens < 0 {
		targetTokens = 0
	}

	codePoints := []rune(text)
	totalTokens := EstimateTokens(text)
	denom := float64(totalTokens)
	if denom == 0 {
		denom = 1
	}

	ratio := float64(targetTokens) / denom
	if ratio < 0 {
		ratio = 0
	} else if ratio > 1 {
		ratio = 1
	}

	sliceIndex := int(math.Floor(float64(len(codePoints)) * ratio))
	if sliceIndex < 0 {
		sliceIndex = 0
	} else if sliceIndex > len(codePoints) {
		sliceIndex = len(codePoints)
	}

	var slicedText string
	if sliceIndex > 0 {
		slicedText = string(codePoints[:sliceIndex])
	}
	currentTokens := EstimateTokens(slicedText)
	iterations := 0

	for currentTokens > targetTokens && sliceIndex > 0 && iterations < 200 {
		iterations++
		newIndex := int(math.Floor(float64(sliceIndex) * 0.95))
		if newIndex == int(math.Floor(float64(newIndex+1)*0.95)) {
			newIndex--
		}
		sliceIndex = newIndex
		if sliceIndex <= 0 {
			sliceIndex = 0
			slicedText = ""
			break
		}
		slicedText = string(codePoints[:sliceIndex])
		currentTokens = EstimateTokens(slicedText)
	}

	var balancingClosure string

	fences := codeFenceRegex.FindAllString(slicedText, -1)
	if len(fences)%2 != 0 {
		balancingClosure += "\n```\n\n"
	}

	htmlOpen := strings.Count(slicedText, "<!--")
	htmlClose := strings.Count(slicedText, "-->")
	if htmlOpen > htmlClose {
		balancingClosure += " -->\n\n"
	}

	return slicedText + balancingClosure + suffix
}

package mcp

import (
	"fmt"
	"math"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const DefaultTruncateSuffix = "\n\n...[Content truncated to fit token budget]"

func EstimateTokens(text string) int {
	return mdpat.EstimateTokens(text)
}

func ResolveCognitiveBudget(quota UserQuota, policyBudget int, userBudget *float64) int {
	caps := make([]int, 0, 3)

	if userBudget != nil && *userBudget > 0 {
		caps = append(caps, int(*userBudget))
	}
	if policyBudget > 0 {
		caps = append(caps, policyBudget)
	}
	tokenCap := quota.TokenCap
	if quota.Role == "ADMIN" || quota.Role == "SUPER_ADMIN" {
		tokenCap = 32000
	}
	if tokenCap > 0 {
		caps = append(caps, tokenCap)
	}

	budget := int(DefaultSearchTokenBudget)
	if len(caps) > 0 {
		min := caps[0]
		for _, c := range caps[1:] {
			if c < min {
				min = c
			}
		}
		budget = min
	}

	if budget < 256 {
		budget = 256
	}
	return budget
}

var codeFenceRegex = mdpat.CodeFenceLineRe

func BalanceMarkdownSyntax(sliced string) string {
	if len(sliced) == 0 {
		return ""
	}

	var balancing strings.Builder

	fences := codeFenceRegex.FindAllString(sliced, -1)
	fenceUnclosed := len(fences)%2 != 0

	if !fenceUnclosed {
		lastLine := sliced
		if idx := strings.LastIndex(sliced, "\n"); idx >= 0 {
			lastLine = sliced[idx+1:]
		}
		backtickCount := strings.Count(lastLine, "`")
		if backtickCount%2 != 0 {
			balancing.WriteString("`")
		}
	}

	if fenceUnclosed {
		balancing.WriteString("\n```\n\n")
	}

	htmlOpen := strings.Count(sliced, "<!--")
	htmlClose := strings.Count(sliced, "-->")
	if htmlOpen > htmlClose {
		balancing.WriteString(" -->\n\n")
	}

	return sliced + balancing.String()
}

func BuildCognitiveNavigationAnchor(toolName, target string, originalTokens, showingTokens int) string {
	percent := 0
	if originalTokens > 0 {
		percent = int(math.Round(float64(showingTokens) / float64(originalTokens) * 100))
		if percent > 100 {
			percent = 100
		}
		if percent < 0 {
			percent = 0
		}
	}

	var tip string
	switch toolName {
	case "read", "read_document":
		if target != "" && !strings.Contains(target, "#") {
			tip = fmt.Sprintf(`Use "outline" to view document outline, use target="%s#heading" to read a specific section, or specify "start_line" / "end_line".`, target)
		} else {
			tip = `Use "outline" to view document outline, use target="path#heading" to read a specific section, or specify "start_line" / "end_line".`
		}
	case "outline", "browse":
		tip = `Pass path="path/to/doc.md" to inspect a single document outline, or use "search" to locate specific sections.`
	case "search":
		tip = `Use more specific keywords, or pass filter="exact" / mode="title".`
	case "explore_concept":
		tip = `Specify action="related" or provide a more specific concept name.`
	case "read_symbol":
		tip = `Specify "file" to narrow down symbol location or set include_code=false for metadata only.`
	case "read_code":
		tip = `Specify "path" to narrow down symbol location, pass start_line/end_line for a line window, or set include_code=false.`
	case "search_symbols":
		tip = `Specify "file" to narrow down search or use "role" filter ("core_contract", "entry_point", etc.).`
	default:
		tip = `Refine query granularity or increase "token_budget".`
	}

	return fmt.Sprintf("[Showing ~%d of ~%d tokens (%d%%)] %s", showingTokens, originalTokens, percent, tip)
}

type CognitiveBudgetResult struct {
	Text           string
	WasTruncated   bool
	OriginalTokens int
	FinalTokens    int
}

func ApplyCognitiveBudget(toolName, text string, budget int, target string, customSuffix ...string) CognitiveBudgetResult {
	if budget < 256 {
		budget = 256
	}

	originalTokens := EstimateTokens(text)
	if originalTokens <= budget || len(text) == 0 {
		return CognitiveBudgetResult{
			Text:           text,
			WasTruncated:   false,
			OriginalTokens: originalTokens,
			FinalTokens:    originalTokens,
		}
	}

	baseSuffix := DefaultTruncateSuffix
	if len(customSuffix) > 0 && customSuffix[0] != "" {
		baseSuffix = customSuffix[0]
	}

	codePoints := []rune(text)

	sampleAnchor := BuildCognitiveNavigationAnchor(toolName, target, originalTokens, budget/2)
	reserved := EstimateTokens(baseSuffix) + EstimateTokens(sampleAnchor) + 20
	targetContentTokens := budget - reserved
	if targetContentTokens < 20 {
		targetContentTokens = 20
	}

	ratio := float64(targetContentTokens) / float64(originalTokens)
	if ratio > 1 {
		ratio = 1
	}
	if ratio < 0 {
		ratio = 0
	}

	sliceIndex := int(float64(len(codePoints)) * ratio)
	if sliceIndex > len(codePoints) {
		sliceIndex = len(codePoints)
	}

	var finalResultText string

	for iter := 0; iter < 100; iter++ {
		sliced := string(codePoints[:sliceIndex])

		snappedIndex := sliceIndex
		if nl := strings.LastIndex(sliced, "\n"); nl > 0 && (len(sliced)-nl < 300 || nl >= len(sliced)/2) {
			sliced = sliced[:nl]
			snappedIndex = len([]rune(sliced))
		}
		sliced = strings.TrimRight(sliced, "\r\n")

		balanced := BalanceMarkdownSyntax(sliced)
		showingTokens := EstimateTokens(sliced)
		anchor := BuildCognitiveNavigationAnchor(toolName, target, originalTokens, showingTokens)

		candidate := balanced + baseSuffix + "\n" + anchor
		candTokens := EstimateTokens(candidate)

		if candTokens <= budget {
			finalResultText = candidate
			break
		}

		// Advance strictly monotonically per iteration to guarantee budget convergence without infinite loops.
		var newIndex int
		if snappedIndex < sliceIndex && snappedIndex > 0 {
			newIndex = int(float64(snappedIndex) * 0.95)
			if newIndex >= snappedIndex {
				newIndex = snappedIndex - 1
			}
		} else {
			newIndex = int(float64(sliceIndex) * 0.9)
			if newIndex >= sliceIndex {
				newIndex = sliceIndex - 1
			}
		}

		sliceIndex = newIndex
		if sliceIndex <= 0 {
			sliceIndex = 0
			anchor = BuildCognitiveNavigationAnchor(toolName, target, originalTokens, 0)
			candidate = baseSuffix + "\n" + anchor
			if EstimateTokens(candidate) <= budget {
				finalResultText = candidate
			} else {
				// Fall back to compact anchor when a long target string itself overflows the token budget.
				safeAnchor := fmt.Sprintf("[Showing ~0 of ~%d tokens (0%%)] Refine query granularity or increase \"token_budget\".", originalTokens)
				candidate = baseSuffix + "\n" + safeAnchor
				if EstimateTokens(candidate) <= budget {
					finalResultText = candidate
				} else {
					finalResultText = TruncateWithSuffix(candidate, budget, "")
				}
			}
			break
		}
	}

	if finalResultText == "" {
		anchor := BuildCognitiveNavigationAnchor(toolName, target, originalTokens, 0)
		candidate := baseSuffix + "\n" + anchor
		if EstimateTokens(candidate) <= budget {
			finalResultText = candidate
		} else {
			safeAnchor := fmt.Sprintf("[Showing ~0 of ~%d tokens (0%%)] Refine query granularity or increase \"token_budget\".", originalTokens)
			candidate = baseSuffix + "\n" + safeAnchor
			if EstimateTokens(candidate) <= budget {
				finalResultText = candidate
			} else {
				finalResultText = TruncateWithSuffix(candidate, budget, "")
			}
		}
	}

	return CognitiveBudgetResult{
		Text:           finalResultText,
		WasTruncated:   true,
		OriginalTokens: originalTokens,
		FinalTokens:    EstimateTokens(finalResultText),
	}
}

func TruncateWithSuffix(text string, maxTokens int, suffix string) string {
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

	targetTokens := maxTokens - suffixTokens - 15
	if targetTokens < 0 {
		targetTokens = 0
	}

	codePoints := []rune(text)
	totalTokens := EstimateTokens(text)
	ratio := float64(targetTokens) / float64(totalTokens)
	if ratio > 1 {
		ratio = 1
	} else if ratio < 0 {
		ratio = 0
	}

	sliceIndex := int(float64(len(codePoints)) * ratio)
	if sliceIndex > len(codePoints) {
		sliceIndex = len(codePoints)
	} else if sliceIndex < 0 {
		sliceIndex = 0
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

	balanced := BalanceMarkdownSyntax(slicedText)
	return balanced + suffix
}

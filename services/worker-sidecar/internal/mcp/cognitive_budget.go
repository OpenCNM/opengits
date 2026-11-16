package mcp

import (
	"fmt"
	"math"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat")

// DefaultTruncateSuffix is the backward-compatible standard suffix appended when content is truncated.
const DefaultTruncateSuffix = "\n\n...[Content truncated to fit token budget]"

// isCJK checks whether a rune falls within CJK Unicode blocks:
// Chinese, Japanese Kana, Hangul, CJK Ideographs.
// Matches JS regex: /[\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]/
// EstimateTokens 整型 token 估算（mdpat SSOT 委托；系数与 CJK 块集见
// mdpat/tokens.go——TS estimateTokens 数值对齐）。
func EstimateTokens(text string) int {
	return mdpat.EstimateTokens(text)
}

// ResolveCognitiveBudget determines the final token budget from user quota, policy budget,
// and user requested budget using minimum precedence, defaulting to DefaultSearchTokenBudget (tunables.go) and clamped to at least 256.
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

// codeFenceRegex matches Markdown code block opening/closing fences (``` or ~~~ with >= 3 markers).
var codeFenceRegex = mdpat.CodeFenceLineRe

// BalanceMarkdownSyntax detects broken markdown constructs at truncation boundaries
// and appends necessary closing closures:
// 1. Unclosed code fences (``` or ~~~, odd count) -> appends \n```\n\n
// 2. Unclosed HTML comments (<!-- > -->) -> appends " -->\n\n"
// 3. Unclosed inline backticks on the last line -> appends `
func BalanceMarkdownSyntax(sliced string) string {
	if len(sliced) == 0 {
		return ""
	}

	var balancing strings.Builder

	// 1. Check for unclosed markdown code fences
	fences := codeFenceRegex.FindAllString(sliced, -1)
	fenceUnclosed := len(fences)%2 != 0

	// 2. If not inside an unclosed code block, check for unclosed inline backticks on the last line
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

	// 3. Close unclosed code fence if odd
	if fenceUnclosed {
		balancing.WriteString("\n```\n\n")
	}

	// 4. Check for unclosed HTML comments
	htmlOpen := strings.Count(sliced, "<!--")
	htmlClose := strings.Count(sliced, "-->")
	if htmlOpen > htmlClose {
		balancing.WriteString(" -->\n\n")
	}

	return sliced + balancing.String()
}

// BuildCognitiveNavigationAnchor generates actionable next-step hints and quantitative token stats
// according to Principle 6 (Reverse Contract & Cognitive Budget).
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
	case "outline":
		tip = `Pass path="path/to/doc.md" to inspect a single document outline, or use "search" to locate specific sections.`
	case "search":
		tip = `Use more specific keywords, or pass filter="exact" / mode="title".`
	case "explore_concept":
		tip = `Specify action="related" or provide a more specific concept name.`
	case "read_symbol":
		tip = `Specify "file" to narrow down symbol location or set include_code=false for metadata only.`
	case "search_symbols":
		tip = `Specify "file" to narrow down search or use "role" filter ("core_contract", "entry_point", etc.).`
	default:
		tip = `Refine query granularity or increase "token_budget".`
	}

	return fmt.Sprintf("[Showing ~%d of ~%d tokens (%d%%)] %s", showingTokens, originalTokens, percent, tip)
}

// CognitiveBudgetResult represents the outcome of applying the cognitive budget guard.
type CognitiveBudgetResult struct {
	Text           string
	WasTruncated   bool
	OriginalTokens int
	FinalTokens    int
}

// ApplyCognitiveBudget enforces token budget limits on tool output with syntax balancing and navigation anchors.
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

	// Dynamically estimate reserved tokens for baseSuffix + anchor + syntax armor (no magic numbers)
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

		// Line snapping: prefer ending at a newline to avoid splitting words or markdown tables mid-line
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

		// Strictly monotonic decrease: jump before the snapped line if snapped, else reduce by 10%
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
				// Defense-in-depth: if long target anchor causes overflow, use compact safe anchor
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

	// Guaranteed fallback: if loop exhausted, use zero-slice candidate ensuring tokens <= budget
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

// TruncateWithSuffix is a compact truncation variant for localized text slicing (e.g. summarizeDocChunk).
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

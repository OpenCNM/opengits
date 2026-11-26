package mdpat

import (
	"math"
	"unicode/utf16"
)

// Matches TS token-counter.ts CJK ranges verbatim (1.3/0.25 weights); widening to IsCJKRune breaks parity.
func isTokenCounterCJK(r rune) bool {
	return (r >= 0x4e00 && r <= 0x9fa5) ||
		(r >= 0x3040 && r <= 0x30ff) ||
		(r >= 0x3400 && r <= 0x4dbf) ||
		(r >= 0xf900 && r <= 0xfaff) ||
		(r >= 0xac00 && r <= 0xd7af)
}

func EstimateTokens(text string) int {
	return int(math.Ceil(EstimateTokensFloat(text)))
}

func EstimateTokensFloat(text string) float64 {
	if len(text) == 0 {
		return 0
	}
	cjkCount := 0
	utf16Len := 0
	for _, r := range text {
		if isTokenCounterCJK(r) {
			cjkCount++
			utf16Len++
		} else {
			rl := utf16.RuneLen(r)
			if rl > 0 {
				utf16Len += rl
			} else {
				utf16Len++
			}
		}
	}
	return float64(cjkCount)*1.3 + float64(utf16Len-cjkCount)*0.25
}

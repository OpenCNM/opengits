package mdpat

import (
	"math"
	"unicode/utf16"
)

// ─────────────────────────────────────────────────────────────
// Token 估算 SSOT（审计 §10 根治）。
//
// 历史上三处实现两两漂移：doc/mcp 用 1.3/0.25 + ceil（TS 对拍口径），
// chunker 用 1.5/0.25 且 CJK 块集不含假名/谚文——同一篇 10k 字中文文档
// 在切分与认知预算两处估算相差 15%，诱发 MCP 预算守卫阶梯错位。
// 单一真值 = apps/client/src/lib/token-counter.ts：CJK ≈ 1.3 token/字，
// 非 CJK ≈ 0.25 token/UTF-16 单元；CJK 块集与 TS 正则逐字对齐
// （\u4e00-\u9fa5 假名 扩A 兼容 谚文——勿替换为更宽的 IsCJKRune，
// 否则 TS golden 对拍数值漂移）。
// ─────────────────────────────────────────────────────────────

// isTokenCounterCJK token-counter.ts 同源 CJK 块集。
func isTokenCounterCJK(r rune) bool {
	return (r >= 0x4e00 && r <= 0x9fa5) ||
		(r >= 0x3040 && r <= 0x30ff) ||
		(r >= 0x3400 && r <= 0x4dbf) ||
		(r >= 0xf900 && r <= 0xfaff) ||
		(r >= 0xac00 && r <= 0xd7af)
}

// EstimateTokens 整型 token 估算（ceil；TS estimateTokens 数值对齐）。
func EstimateTokens(text string) int {
	return int(math.Ceil(EstimateTokensFloat(text)))
}

// EstimateTokensFloat 浮点 token 估算（无 ceil；chunk 预算算术用，
// 同一系数与块集——两口径漂移正是审计 §10 缺陷根源）。
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

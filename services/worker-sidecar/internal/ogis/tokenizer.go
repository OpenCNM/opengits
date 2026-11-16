package ogis

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// OGIS 索引分词器：逐字复刻 apps/client/src/lib/search/
// binary-index-service.ts 的 tokenizeSearchText。
// 关键语义（Go 实现必须保持）：
//   - JS \w 仅 ASCII [0-9A-Za-z_]；RE2 \w 同为 ASCII，天然对齐
//   - 复合标识符（camelCase/snake/kebab）先插驼峰边界再按分隔符拆解
//   - CJK 连续段：≤6 字整段 + 全部单字 + 全部相邻二元组
//   - 去重保序（首现序）⇒ 每 chunk 的 (term, chunk) freq 恒为 1，
//     avgDocLen 累加的是去重后 token 数
// ─────────────────────────────────────────────────────────────

var (
	ogisWordTokenRe = regexp.MustCompile(`[\w.-]+`)
	ogisCamelRe     = regexp.MustCompile(`([a-z])([A-Z])`)
	ogisSepRe       = regexp.MustCompile(`[_\-.]+`)
	// CJK 连续段：汉 + 日文假名 + 韩文谚文全脚本（与 Node
	// binary-index-tokenizer.ts 同步升级；窄区间会令日韩语料分词为空）。
	ogisCJKSeqRe = regexp.MustCompile(`[` + mdpat.CJKScriptClass + `]+`)
)

// hasLowerUpper 判定 raw 是否含小写→大写驼峰边界（等价 JS /[a-z][A-Z]/.test）。
func hasLowerUpper(raw string) bool { return ogisCamelRe.MatchString(raw) }

// splitCompound 复刻复合标识符拆解：驼峰边界插空格 → 分隔符归空格 → 小写 → 按空白切分。
func splitCompound(raw string) []string {
	spaced := ogisCamelRe.ReplaceAllString(raw, "$1 $2")
	spaced = ogisSepRe.ReplaceAllString(spaced, " ")
	return strings.Fields(strings.ToLower(spaced))
}

// TokenizeSearchText 返回去重保序的 token 列表（与 Node 版语义逐字对齐；
// length>=2 按 rune 判定——JS 是 UTF-16 code unit，非代理对场景两者等价）。
func TokenizeSearchText(text string) []string {
	if text == "" {
		return nil
	}
	seen := make(map[string]struct{})
	var tokens []string
	add := func(t string) {
		if _, ok := seen[t]; ok {
			return
		}
		seen[t] = struct{}{}
		tokens = append(tokens, t)
	}

	// 1. 英文 / 标识符 / 数字（ASCII 词法域）
	for _, raw := range ogisWordTokenRe.FindAllString(text, -1) {
		lower := strings.ToLower(raw)
		// 词法域为 ASCII，rune 数与 JS length 一致
		if len([]rune(lower)) >= 2 {
			add(lower)
		}
		if hasLowerUpper(raw) || strings.ContainsAny(raw, "_-") {
			for _, part := range splitCompound(raw) {
				if len([]rune(part)) >= 2 {
					add(part)
				}
			}
		}
	}

	// 2. CJK：连续段 ≤6 字整段 + 单字 + 相邻二元组
	for _, seq := range ogisCJKSeqRe.FindAllString(text, -1) {
		runes := []rune(seq)
		if len(runes) <= 6 {
			add(seq)
		}
		for i := range runes {
			add(string(runes[i]))
		}
		for i := 0; i+1 < len(runes); i++ {
			add(string(runes[i : i+2]))
		}
	}

	return tokens
}

// tokenizeSearchText 提供包内和兼容调用的同名函数。
func tokenizeSearchText(text string) []string {
	return TokenizeSearchText(text)
}

package chapter

import (
	"sort"
	"unicode/utf16"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// naturalCompare：数字感知自然排序（TS natural-compare.ts 精确移植）
// 排序语义：
// - naturalCompare：数字感知字典序，按 UTF-16 码点（TS 契约刻意不用 locale）
// - jsLocaleCompare：Node ICU 默认 localeCompare 的 ASCII 近似
//   （casefold 主序 + 小写先于大写 + CJK 后于拉丁），行为由夹具钉住——
//   仅用于 TS 原版调用 localeCompare 的两处兜底排序
// ─────────────────────────────────────────────────────────────

func utf16Codes(s string) []uint16 { return utf16.Encode([]rune(s)) }

func isDigit16(c uint16) bool { return c >= 0x30 && c <= 0x39 }

// stripLeadingZeros 去前导零（全零段返回原段），与 TS 同款边界。
func stripLeadingZeros(seg []uint16) []uint16 {
	start := 0
	for start < len(seg)-1 && seg[start] == 0x30 {
		start++
	}
	if start == len(seg)-1 {
		return seg
	}
	return seg[start:]
}

func naturalCompare(a, b string) int {
	return naturalCompare16(utf16Codes(a), utf16Codes(b))
}

// naturalCompare16 预编码 UTF-16 上的自然排序核心（逻辑与旧
// naturalCompare 逐分支一致——排序比较器每对比较两次全量 rune→UTF-16
// 编码分配，预编码后复用）。
func naturalCompare16(A, B []uint16) int {
	i, j := 0, 0
	for i < len(A) && j < len(B) {
		ca, cb := A[i], B[j]
		digitA, digitB := isDigit16(ca), isDigit16(cb)
		switch {
		case digitA && digitB:
			endA := i
			for endA < len(A) && isDigit16(A[endA]) {
				endA++
			}
			endB := j
			for endB < len(B) && isDigit16(B[endB]) {
				endB++
			}
			segA := stripLeadingZeros(A[i:endA])
			segB := stripLeadingZeros(B[j:endB])
			if len(segA) != len(segB) {
				return len(segA) - len(segB)
			}
			for k := range segA {
				if d := int(segA[k]) - int(segB[k]); d != 0 {
					return d
				}
			}
			i, j = endA, endB
		case digitA != digitB:
			return int(ca) - int(cb)
		default:
			if ca != cb {
				return int(ca) - int(cb)
			}
			i++
			j++
		}
	}
	return (len(A) - i) - (len(B) - j)
}

// SortNaturalStable 预编码 UTF-16 的稳定自然排序（decorate-sort-
// undecorate；排序结果与 sort.SliceStable(paths, naturalCompare) 逐位一致）。
func SortNaturalStable(paths []string) {
	type keyed struct {
		s string
		u []uint16
	}
	keys := make([]keyed, len(paths))
	for i, p := range paths {
		keys[i] = keyed{s: p, u: utf16Codes(p)}
	}
	sort.SliceStable(keys, func(i, j int) bool {
		return naturalCompare16(keys[i].u, keys[j].u) < 0
	})
	for i := range paths {
		paths[i] = keys[i].s
	}
}

// JsLocaleCompare 近似 Node 默认 localeCompare（ICU root）：
// 实现下沉 mdpat（cluster/concept 等低层包复用避免环依赖）；行为由
// chapter-map 黄金夹具钉住。
func JsLocaleCompare(a, b string) int {
	return mdpat.JsLocaleCompare(a, b)
}

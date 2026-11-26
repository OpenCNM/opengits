package chapter

import (
	"sort"
	"unicode/utf16"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func utf16Codes(s string) []uint16 { return utf16.Encode([]rune(s)) }

func isDigit16(c uint16) bool { return c >= 0x30 && c <= 0x39 }

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

// Pre-encodes UTF-16 code units once per path to avoid O(N log N) repeated rune conversions.
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

// Approximates Node ICU root localeCompare for chapter-map golden parity.
func JsLocaleCompare(a, b string) int {
	return mdpat.JsLocaleCompare(a, b)
}

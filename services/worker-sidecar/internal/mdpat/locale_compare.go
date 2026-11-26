package mdpat

import "unicode"

// Approximates Node ICU root localeCompare for chapter-map golden parity.
func JsLocaleCompare(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	n := len(ra)
	if len(rb) < n {
		n = len(rb)
	}
	for i := 0; i < n; i++ {
		la, lb := unicode.ToLower(ra[i]), unicode.ToLower(rb[i])
		if la != lb {
			return int(la) - int(lb)
		}
	}
	if len(ra) != len(rb) {
		return len(ra) - len(rb)
	}
	for i := 0; i < n; i++ {
		if ra[i] != rb[i] {
			if unicode.IsLower(ra[i]) && !unicode.IsLower(rb[i]) {
				return -1
			}
			if !unicode.IsLower(ra[i]) && unicode.IsLower(rb[i]) {
				return 1
			}
			return int(ra[i]) - int(rb[i])
		}
	}
	return 0
}

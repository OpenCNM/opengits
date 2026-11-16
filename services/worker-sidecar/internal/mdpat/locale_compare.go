package mdpat

import "unicode"

// JsLocaleCompare 近似 Node 默认 localeCompare（ICU root）：
// casefold 主序，等价折叠时小写先于大写（tertiary），非字母按折叠码点。
// 行为由 chapter-map 黄金夹具钉住；仅用于 TS 原版 localeCompare 调用点。
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

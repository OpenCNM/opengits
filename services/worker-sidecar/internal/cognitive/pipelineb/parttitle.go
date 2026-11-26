package pipelineb

import (
	"fmt"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
)

// Cap distinct parts (max 5) relative to chapter count to prevent over-fragmentation.
func partCeiling(n int) int {
	if n < 2 {
		return 0
	}
	ceil := (n + 1) / 2
	if ceil < 2 {
		ceil = 2
	}
	if ceil > 5 {
		ceil = 5
	}
	return ceil
}

var (
	stripWords        = []string{"part", "dimension", "module", "维度", "模块", "分卷"}
	stripUnits        = []string{"卷", "部分", "分卷", "篇", "章"}
	cjkDigits         = "一二三四五六七八九十"
	ordinalSeparators = " \t:：.。、-－–—_"
)

// Strip ordinal prefixes in up to 2 passes without regex; require quantifiers after "第 N" so prose like "第三方库" stays intact.
func stripPartOrdinalPrefix(s string) string {
	rest := strings.TrimSpace(s)
	for i := 0; i < 2 && rest != ""; i++ {
		next, stripped := stripOneOrdinalPrefix(rest)
		if !stripped {
			break
		}
		rest = next
	}
	return rest
}

func stripOneOrdinalPrefix(s string) (string, bool) {
	lower := strings.ToLower(s)
	for _, w := range stripWords {
		if !strings.HasPrefix(lower, w) {
			continue
		}
		rest := s[len(w):]
		if next, ok := takeOrdinalNumber(rest); ok {
			return trimOrdinalSeparators(next), true
		}
	}
	if strings.HasPrefix(s, "第") {
		if rest, ok := takeOrdinalNumber(s[len("第"):]); ok {
			trimmed := trimLeadingSpaces(rest)
			for _, u := range stripUnits {
				if strings.HasPrefix(trimmed, u) {
					return trimOrdinalSeparators(trimmed[len(u):]), true
				}
			}
		}
		return "", false
	}
	if strings.HasPrefix(s, "卷") {
		if rest, ok := takeCJKNumber(s[len("卷"):]); ok {
			return trimOrdinalSeparators(rest), true
		}
	}
	return "", false
}

func takeOrdinalNumber(s string) (string, bool) {
	rest := trimLeadingSpaces(s)
	if next, ok := takeASCIIDigits(rest); ok {
		return next, true
	}
	return takeCJKNumber(rest)
}

func takeASCIIDigits(s string) (string, bool) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return "", false
	}
	return s[i:], true
}

func takeCJKNumber(s string) (string, bool) {
	rest := s
	consumed := false
	if r, size := firstRune(rest); r != 0 && strings.ContainsRune(cjkDigits, r) && r != '十' {
		rest = rest[size:]
		consumed = true
	}
	if r, size := firstRune(rest); r == '十' {
		rest = rest[size:]
		consumed = true
	}
	if r, size := firstRune(rest); r != 0 && strings.ContainsRune(cjkDigits, r) && r != '十' {
		rest = rest[size:]
		consumed = true
	}
	if !consumed {
		return "", false
	}
	return rest, true
}

func firstRune(s string) (rune, int) {
	for _, r := range s {
		return r, len(string(r))
	}
	return 0, 0
}

func trimLeadingSpaces(s string) string {
	return strings.TrimLeft(s, " \t")
}

func trimOrdinalSeparators(s string) string {
	return strings.TrimLeft(strings.TrimSpace(s), ordinalSeparators)
}

func canonicalizeLLMPartTitles(chapters []cognitive.OutlineChapter) bool {
	if len(chapters) == 0 {
		return false
	}
	if len(chapters) == 1 {
		chapters[0].PartTitle = ""
		return true
	}

	for i := range chapters {
		chapters[i].PartTitle = stripPartOrdinalPrefix(chapters[i].PartTitle)
	}
	firstNamed := ""
	for i := range chapters {
		if chapters[i].PartTitle != "" {
			firstNamed = chapters[i].PartTitle
			break
		}
	}
	if firstNamed == "" {
		return false
	}

	last := ""
	for i := range chapters {
		if chapters[i].PartTitle != "" {
			last = chapters[i].PartTitle
		} else if last != "" {
			chapters[i].PartTitle = last
		}
	}
	for i := range chapters {
		if chapters[i].PartTitle != "" {
			break
		}
		chapters[i].PartTitle = firstNamed
	}

	idxOf := make(map[string]int, 4)
	order := make([]string, 0, 4)
	for _, ch := range chapters {
		if _, ok := idxOf[ch.PartTitle]; !ok {
			idxOf[ch.PartTitle] = len(order)
			order = append(order, ch.PartTitle)
		}
	}
	if ceil := partCeiling(len(chapters)); len(order) > ceil {
		lastKept := order[ceil-1]
		for i := range chapters {
			if idxOf[chapters[i].PartTitle] >= ceil-1 {
				chapters[i].PartTitle = lastKept
			}
		}
	}

	for i := range chapters {
		if n, ok := idxOf[chapters[i].PartTitle]; ok {
			chapters[i].PartTitle = fmt.Sprintf("Part %d: %s", n+1, chapters[i].PartTitle)
		}
	}
	return true
}

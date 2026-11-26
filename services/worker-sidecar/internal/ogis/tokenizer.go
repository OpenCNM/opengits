package ogis

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

var (
	ogisWordTokenRe = regexp.MustCompile(`[\w.-]+`)
	ogisCamelRe     = regexp.MustCompile(`([a-z])([A-Z])`)
	ogisSepRe       = regexp.MustCompile(`[_\-.]+`)

	// Match full Han/Kana/Hangul Unicode script classes so Japanese and Korean inputs do not tokenize to empty.
	ogisCJKSeqRe = regexp.MustCompile(`[` + mdpat.CJKScriptClass + `]+`)
)

func hasLowerUpper(raw string) bool { return ogisCamelRe.MatchString(raw) }

func splitCompound(raw string) []string {
	spaced := ogisCamelRe.ReplaceAllString(raw, "$1 $2")
	spaced = ogisSepRe.ReplaceAllString(spaced, " ")
	return strings.Fields(strings.ToLower(spaced))
}

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

	for _, raw := range ogisWordTokenRe.FindAllString(text, -1) {
		lower := strings.ToLower(raw)

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

func tokenizeSearchText(text string) []string {
	return TokenizeSearchText(text)
}

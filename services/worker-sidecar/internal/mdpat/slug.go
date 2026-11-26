package mdpat

import (
	"hash/fnv"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	SlugNonWordRe = regexp.MustCompile(`[^\w` + CJKScriptClass + `]+`)
)

func IsCJKRune(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r) ||
		r == 0x30fc || r == 0x3005
}

func Fnv64a(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

func Fnv64aHex(s string) string {
	return strconv.FormatUint(Fnv64a(s), 16)
}

// Non-empty input collapsing to "" falls back to "h-" + FNV-64a to avoid empty-string Contains bugs.
func Slugify(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	slug := SlugNonWordRe.ReplaceAllString(lower, "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		return "h-" + Fnv64aHex(trimmed)
	}
	return slug
}

// Non-empty input collapsing to "" falls back to "id_" + FNV-64a to preserve uniqueness.
func SlugifyUnderscore(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	slug := SlugNonWordRe.ReplaceAllString(lower, "_")
	slug = strings.Trim(slug, "_")
	if slug == "" {
		return "id_" + Fnv64aHex(trimmed)
	}
	return slug
}

func SplitPathAnchor(raw string) (path string, anchor string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ""
	}
	trimmed = strings.ReplaceAll(trimmed, "\\", "/")
	if idx := strings.Index(trimmed, "#"); idx >= 0 {
		path = strings.TrimSpace(trimmed[:idx])
		anchor = strings.TrimSpace(trimmed[idx+1:])
	} else {
		path = trimmed
		anchor = ""
	}
	for strings.HasPrefix(path, "./") {
		path = strings.TrimPrefix(path, "./")
	}
	path = strings.TrimLeft(path, "/")
	return path, anchor
}

func JoinPathAnchor(rawPath, rawAnchor string) string {
	path, existingAnchor := SplitPathAnchor(rawPath)
	anchor := strings.TrimSpace(rawAnchor)
	if anchor == "" {
		anchor = existingAnchor
	}
	if anchor == "" {
		return path
	}
	if path == "" {
		return "#" + anchor
	}
	return path + "#" + anchor
}

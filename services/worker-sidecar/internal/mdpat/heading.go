package mdpat

import (
	"path"
	"regexp"
	"strings"
)

var AtxH1LineRe = regexp.MustCompile(`^ {0,3}#(?:[ \t]+(.+?))?[ \t]*#*[ \t]*$`)

// YAML frontmatter comments start with '#'; skip frontmatter so they are not misread as H1.
var FrontmatterDelimRe = regexp.MustCompile(`^(?:---|\.\.\.)[ \t]*$`)

var UuidBasenameRe = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var HexHashBasenameRe = regexp.MustCompile(`(?i)^[0-9a-f]{16,64}$`)

var runRecordDumpExts = map[string]bool{
	".txt": true,
	".out": true,
}

func IsRunRecordDump(p string) bool {
	base := path.Base(strings.TrimSpace(strings.Trim(p, "/")))
	if base == "" || base == "." || base == "/" {
		return false
	}
	ext := strings.ToLower(path.Ext(base))
	if ext == ".log" {
		return true
	}
	if !runRecordDumpExts[ext] {
		return false
	}
	stem := base[:len(base)-len(ext)]
	return UuidBasenameRe.MatchString(stem) || HexHashBasenameRe.MatchString(stem)
}

func FirstAtxHeading(text string) string {
	lines := strings.Split(text, "\n")
	inFence := false
	inFrontmatter := false
	for i, raw := range lines {
		line := strings.TrimRight(raw, "\r")

		if i == 0 && FrontmatterDelimRe.MatchString(line) {
			inFrontmatter = true
			continue
		}
		if inFrontmatter {
			if FrontmatterDelimRe.MatchString(line) {
				inFrontmatter = false
			}
			continue
		}

		if CodeFenceLineRe.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}

		m := AtxH1LineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if title := CleanHeadingTitle(m[1]); title != "" {
			return title
		}
	}
	return ""
}

const maxHeadingTitleRunes = 80

func CleanHeadingTitle(s string) string {
	s = strings.TrimSpace(s)
	for len(s) >= 2 {
		first, last := s[0], s[len(s)-1]
		if (first == '*' || first == '_' || first == '`') && first == last {
			s = strings.TrimSpace(s[1 : len(s)-1])
			continue
		}
		break
	}
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > maxHeadingTitleRunes {
		s = strings.TrimSpace(string(r[:maxHeadingTitleRunes]))
	}
	return s
}

var CJKRuneRe = regexp.MustCompile("[" + CJKScriptClass + "]")

var PureStatLineRe = regexp.MustCompile(`(?i)^[pP]?\s*[=<>~]?\s*[-+]?[\d.,\s%eE+\-]+$`)

// Filters machine stats and untranslated headings so synced node titles reflect pedagogical H1s.
func UsableChapterH1(title string, requireCJK bool) bool {
	t := strings.TrimSpace(title)
	r := []rune(t)
	if len(r) < 2 || len(r) > maxHeadingTitleRunes {
		return false
	}
	if PureStatLineRe.MatchString(t) {
		return false
	}
	if strings.Contains(t, "#") {
		return false
	}
	if requireCJK && !CJKRuneRe.MatchString(t) {
		return false
	}
	return true
}

// zh/ja/ko titles require CJK script to reject untranslated source headings.
func RequireCJKTitle(targetLanguage string) bool {
	switch strings.ToLower(strings.TrimSpace(targetLanguage)) {
	case "", "zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant", "ja", "ko":
		return true
	}
	return false
}

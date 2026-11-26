package mdpat

import (
	"log"
	"regexp"
	"strings"
)

type JsRegex struct {
	Source string `json:"source"`
	Flags  string `json:"flags"`
}

// Logs and degrades incompatible JS regex syntax to non-matching for RE2 safety.
func CompileJSRegexes(raw []JsRegex, label string) []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, r := range raw {
		prefix := ""
		for _, f := range r.Flags {
			switch f {
			case 'i':
				prefix += "(?i)"
			case 'm':
				prefix += "(?m)"
			case 's':
				prefix += "(?s)"
			}
		}
		re, err := regexp.Compile(prefix + r.Source)
		if err != nil {
			log.Printf("[ingest-patterns] WARN %s pattern not RE2-compatible, treated as never-match: %v (%s)", label, err, r.Source)
			continue
		}
		out = append(out, re)
	}
	return out
}

func fileNameOf(filePath string) string {
	lastSlash := strings.LastIndexAny(filePath, "/\\")
	filename := filePath
	if lastSlash >= 0 {
		filename = filePath[lastSlash+1:]
	}
	return filename
}

// Returns -1 for dotfiles (e.g. .gitignore) so the leading dot is not treated as an extension.
func dotIndexOf(filename string) int {
	lastDot := strings.LastIndex(filename, ".")
	if lastDot <= 0 {
		return -1
	}
	return lastDot
}

func ExtractExtension(filePath string) string {
	if filePath == "" {
		return ""
	}
	filename := fileNameOf(filePath)
	if i := dotIndexOf(filename); i >= 0 {
		return filename[i:]
	}
	return ""
}

func ExtractExtensionLower(filePath string) string {
	return strings.ToLower(ExtractExtension(filePath))
}

func ExtractExtensionBase(filePath string) string {
	if filePath == "" {
		return ""
	}
	filename := fileNameOf(filePath)
	if i := dotIndexOf(filename); i >= 0 {
		return filename[i+1:]
	}
	return ""
}

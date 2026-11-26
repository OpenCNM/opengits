package pipelineb

import (
	"encoding/json"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/pipeline"
)

func SalvageOutlineChapters(truncated string) []cognitive.OutlineChapter {
	if len(truncated) == 0 {
		return nil
	}
	clean, _ := pipeline.StripPayloadShell(truncated)
	clean = strings.TrimSpace(clean)
	if len(clean) == 0 {
		clean = truncated
	}

	candidates := scanChapterArrayElements(clean, maxChapters)
	if len(candidates) == 0 && clean != truncated {
		candidates = scanChapterArrayElements(truncated, maxChapters)
	}
	if len(candidates) == 0 {
		return nil
	}
	items := make([]rawChapterItem, 0, len(candidates))
	for _, c := range candidates {
		var item rawChapterItem
		if err := json.Unmarshal([]byte(c), &item); err != nil {
			continue
		}
		items = append(items, item)
	}
	if len(items) == 0 {
		return nil
	}
	out, err := validateAndAssembleOutline(items)
	if err != nil {
		return nil
	}
	return out
}

// Anchor after "chapters" key before scanning {...} objects so truncated outer wrappers never hide inner chapters.
func scanChapterArrayElements(text string, limit int) []string {
	arrStart := -1
	if idx := strings.Index(text, `"chapters"`); idx >= 0 {
		if rel := strings.Index(text[idx:], "["); rel >= 0 {
			arrStart = idx + rel
		}
	}
	if arrStart < 0 {
		arrStart = strings.Index(text, "[")
	}
	if arrStart < 0 {
		return nil
	}

	var out []string
	depth := 0
	inString := false
	escaped := false
	start := -1
	for i := arrStart + 1; i < len(text) && len(out) < limit; i++ {
		ch := text[i]
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if ch == '"' {
			inString = !inString
			continue
		}
		if inString {
			continue
		}
		switch ch {
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			if depth > 0 {
				depth--
				if depth == 0 && start >= 0 {
					out = append(out, text[start:i+1])
					start = -1
				}
			}
		case ']':
			if depth == 0 {
				return out
			}
		}
	}
	return out
}

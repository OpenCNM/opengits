package concept

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

var (
	multiLevelNumericRe  = mdpat.NumericHeadingPrefixRe
	inlineMarkersRe      = regexp.MustCompile(`[*~` + "`" + `]`)
	hyphenUnderscoreRe   = regexp.MustCompile(`[-_]`)
	whitespaceCollapseRe = regexp.MustCompile(`\s+`)
	partSuffixRe         = regexp.MustCompile(`(?i)\s*\(part\s*\d+\)$`)
)

func StripNumericPrefix(name string) string {
	if name == "" {
		return ""
	}
	return strings.TrimSpace(multiLevelNumericRe.ReplaceAllString(name, ""))
}

func NormalizeHeadingKey(text string) string {
	if text == "" {
		return ""
	}
	clean := strings.ToLower(chunker.CleanMarkdownHeading(text))
	clean = inlineMarkersRe.ReplaceAllString(clean, "")
	clean = StripNumericPrefix(clean)
	clean = inlineMarkersRe.ReplaceAllString(clean, "")
	clean = hyphenUnderscoreRe.ReplaceAllString(clean, " ")
	clean = whitespaceCollapseRe.ReplaceAllString(clean, " ")
	return strings.TrimSpace(clean)
}

func SlugifyConcept(name string) string {
	return mdpat.Slugify(name)
}

func ParseScopedConcept(raw string) (scope string, conceptName string) {
	trimmed := strings.TrimSpace(raw)
	if idx := strings.LastIndex(trimmed, "#"); idx >= 0 {
		return strings.TrimSpace(trimmed[:idx]), strings.TrimSpace(trimmed[idx+1:])
	}
	return "", trimmed
}

type ChunkAnchorCandidate struct {
	ID          string  `json:"id"`
	Heading     *string `json:"heading"`
	HeadingPath *string `json:"headingPath"`
}

type ChunkAnchorMatch struct {
	ID          string  `json:"id"`
	HeadingPath *string `json:"headingPath"`
}

func MatchChunkAnchor(chunks []ChunkAnchorCandidate, sourceHeading string) *ChunkAnchorMatch {
	srcKey := NormalizeHeadingKey(sourceHeading)
	if srcKey == "" {
		return nil
	}

	for _, c := range chunks {
		h := ""
		if c.Heading != nil {
			h = *c.Heading
		}
		if NormalizeHeadingKey(h) == srcKey {
			return &ChunkAnchorMatch{ID: c.ID, HeadingPath: c.HeadingPath}
		}
	}

	suffix := "> " + srcKey
	for _, c := range chunks {
		if c.Heading == nil || *c.Heading == "" {
			continue
		}
		cleanHeading := strings.TrimSpace(partSuffixRe.ReplaceAllString(*c.Heading, ""))
		norm := NormalizeHeadingKey(cleanHeading)
		if norm == srcKey || strings.HasSuffix(norm, suffix) {
			return &ChunkAnchorMatch{ID: c.ID, HeadingPath: c.HeadingPath}
		}

		if strings.Contains(cleanHeading, ">") {
			parts := strings.Split(cleanHeading, ">")
			leaf := parts[len(parts)-1]
			if NormalizeHeadingKey(leaf) == srcKey {
				return &ChunkAnchorMatch{ID: c.ID, HeadingPath: c.HeadingPath}
			}
		}
	}

	return nil
}

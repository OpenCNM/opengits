package concept

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

var (
	// WP-I：对齐 Node prefix-cleaner（数字前缀须带分隔符 [-_.、)．:] 或括号
	// 形式——裸 "1 intro" 不剥，防概念归并过merge；模式本体收编 mdpat SSOT）
	multiLevelNumericRe  = mdpat.NumericHeadingPrefixRe
	inlineMarkersRe      = regexp.MustCompile(`[*~` + "`" + `]`)
	hyphenUnderscoreRe   = regexp.MustCompile(`[-_]`)
	whitespaceCollapseRe = regexp.MustCompile(`\s+`)
	partSuffixRe         = regexp.MustCompile(`(?i)\s*\(part\s*\d+\)$`)
)

// StripNumericPrefix strips leading numeric or section prefixes (e.g. 01_, 1.1., (1)).
func StripNumericPrefix(name string) string {
	if name == "" {
		return ""
	}
	return strings.TrimSpace(multiLevelNumericRe.ReplaceAllString(name, ""))
}

// NormalizeHeadingKey extracts normalized heading text for matching:
// 1. Cleans markdown syntax.
// 2. Lowercases.
// 3. Strips numeric/chapter prefixes.
// 4. Strips inline markers and replaces hyphens/underscores with spaces.
// 5. Collapses whitespace and trims.
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

// SlugifyConcept transforms a concept name to a URL/ID slug via SSOT mdpat.Slugify.
func SlugifyConcept(name string) string {
	return mdpat.Slugify(name)
}

// ParseScopedConcept parses an optional "owner/repo#concept" or "repo#concept" prefix.
// If a "#" separator is present, returns the trimmed scope and clean concept name.
// Otherwise, scope is empty and conceptName is the original string trimmed.
func ParseScopedConcept(raw string) (scope string, conceptName string) {
	trimmed := strings.TrimSpace(raw)
	if idx := strings.LastIndex(trimmed, "#"); idx >= 0 {
		return strings.TrimSpace(trimmed[:idx]), strings.TrimSpace(trimmed[idx+1:])
	}
	return "", trimmed
}

// ChunkAnchorCandidate represents a chunk for heading anchor matching.
type ChunkAnchorCandidate struct {
	ID          string  `json:"id"`
	Heading     *string `json:"heading"`
	HeadingPath *string `json:"headingPath"`
}

// ChunkAnchorMatch represents a successful chunk match.
type ChunkAnchorMatch struct {
	ID          string  `json:"id"`
	HeadingPath *string `json:"headingPath"`
}

// MatchChunkAnchor matches a source heading against document chunks using exact and hierarchical leaf matching.
func MatchChunkAnchor(chunks []ChunkAnchorCandidate, sourceHeading string) *ChunkAnchorMatch {
	srcKey := NormalizeHeadingKey(sourceHeading)
	if srcKey == "" {
		return nil
	}

	// 1. Exact match
	for _, c := range chunks {
		h := ""
		if c.Heading != nil {
			h = *c.Heading
		}
		if NormalizeHeadingKey(h) == srcKey {
			return &ChunkAnchorMatch{ID: c.ID, HeadingPath: c.HeadingPath}
		}
	}

	// 2. Suffix and hierarchical leaf match
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

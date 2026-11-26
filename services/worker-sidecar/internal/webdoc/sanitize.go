package webdoc

import (
	"log"

	"github.com/opengits/worker-sidecar/internal/mdx"
	"github.com/opengits/worker-sidecar/internal/sanitize"
)

func SanitizeMarkdown(docPath, raw string) string {
	out, _ := SanitizeMarkdownWithStats(docPath, raw)
	return out
}

func SanitizeMarkdownWithStats(docPath, raw string) (string, int) {
	gated, rewrites := DegradeFlattenedLinksWithGoldmark(raw)
	cleaned, err := sanitize.SanitizeText(gated)
	if err == nil {
		if healed, herr := mdx.HealSource(cleaned); herr == nil {
			cleaned = healed
		}
		return cleaned, rewrites
	}
	log.Printf("[webdoc] sanitize failed for %s: %v (storing raw content)", docPath, err)
	return gated, rewrites
}

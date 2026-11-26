package webdoc

import (
	"regexp"
	"testing"
)

func TestMain(m *testing.M) {
	SetContentPatternsProvider(func() ContentPatterns {
		return ContentPatterns{
			MainContentSelectors: []string{
				"main", "article", ".theme-doc-markdown", ".vp-doc",
				".nextra-content", ".prose", "#content", ".content",
			},
			NoiseSelectors: []string{
				"nav", "header", "footer", "aside", ".sidebar",
				".table-of-contents", ".toc", ".pagination-nav", ".feedback",
				`[role="navigation"]`,
			},
			LinkAsset: regexp.MustCompile(`(?i)\.(png|jpe?g|gif|svg|webp|pdf|zip|gz|mp4|webm)$`),
		}
	})
	m.Run()
}

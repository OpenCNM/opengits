package webdoc

import (
	"regexp"
	"testing"
)

// TestMain 注入与 ingest-patterns.json webDoc 段同构的夹具选择器
// （测试数据镜像注册表值；生产路径由 daemon 从单一事实源注入）。
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

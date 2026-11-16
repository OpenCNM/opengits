package webdoc

import (
	"log"

	"github.com/opengits/worker-sidecar/internal/mdx"
	"github.com/opengits/worker-sidecar/internal/sanitize"
)

// SanitizeMarkdown web-doc 收敛漏斗：Phase 3 goldmark AST 多行/超长链接降级 +
// 进程内 HTML/markdown 清洗 + MDX 花括号自愈。
// （清洗故障存原文——不阻断摄取，属业务性降级而非故障静默：日志显式记录后回退原文）。
func SanitizeMarkdown(docPath, raw string) string {
	out, _ := SanitizeMarkdownWithStats(docPath, raw)
	return out
}

// SanitizeMarkdownWithStats 执行与 SanitizeMarkdown 相同的收敛漏斗，同时返回 goldmark 闸门改写条数供遥测汇总。
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

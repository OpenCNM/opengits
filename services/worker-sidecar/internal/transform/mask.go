package transform

import (
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/sanitize"
)

// ─────────────────────────────────────────────────────────────
// 代码块 mask/unmask：委托给 internal/sanitize。
// ─────────────────────────────────────────────────────────────

type codeBlock = sanitize.CodeBlock

const (
	maskTokenPrefix = sanitize.MaskTokenPrefix
	maskTokenSuffix = sanitize.MaskTokenSuffix
)

var fenceOpenRe = mdpat.FenceOpenRe

func maskCodeBlocks(markdown string) (string, []codeBlock) {
	return sanitize.MaskCodeBlocks(markdown)
}

func unmaskCodeBlocks(content string, codeBlocks []codeBlock) string {
	return sanitize.UnmaskCodeBlocks(content, codeBlocks)
}

func unmaskCodeBlocksRaw(content string, codeBlocks []codeBlock) string {
	return sanitize.UnmaskCodeBlocksRaw(content, codeBlocks)
}

func goSanitizeText(rawContent string) (string, error) {
	return sanitize.SanitizeText(rawContent)
}

func prepareMdxSource(raw string) string {
	return sanitize.PrepareMdxSource(raw)
}

package mcp

import "fmt"

// ─────────────────────────────────────────────────────────────
// ToolResult 渲染孪生（Go MCP 协议标准化输出）。
// 夹具：testdata/mcp-tool-output.golden.json（frozen contract fixture）。
// ─────────────────────────────────────────────────────────────

// RenderFallbackWarning 讲法/版本回退警告行（镜像 TS fallbackWarning，逐字节一致）。
// requestedEdition 空串 = 未显式请求；edition 非空 = 回退到的讲法行。
func RenderFallbackWarning(requestedEdition, edition, editionLabel string) string {
	requested := "the requested edition/version"
	if requestedEdition != "" {
		requested = fmt.Sprintf("%q", requestedEdition)
	}
	served := "the BASE edition"
	if edition != "" {
		label := editionLabel
		if label == "" {
			label = edition
		}
		served = fmt.Sprintf("edition %q", label)
	}
	return fmt.Sprintf("⚠ Edition fallback: requested %s was not found; results below come from %s. Use list_resources to discover available editions.\n\n", requested, served)
}

// RenderToolResult 渲染管线孪生：警告前缀 + 段拼接（镜像 TS renderToolResult）。
func RenderToolResult(warn, preamble, header, body, footer string) string {
	return warn + preamble + header + body + footer
}

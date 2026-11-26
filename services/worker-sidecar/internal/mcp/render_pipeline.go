package mcp

import "fmt"

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

func RenderToolResult(warn, preamble, header, body, footer string) string {
	return warn + preamble + header + body + footer
}

package transcription

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cluster"
)

// UpstreamPrecedentItem represents a foundational module and its key concepts from earlier chapters.
type UpstreamPrecedentItem struct {
	ModuleTitle string   `json:"moduleTitle"`
	Concepts    []string `json:"concepts"`
	Summary     string   `json:"summary,omitempty"`
}

const (
	maxLedgerModules    = 4
	maxLedgerConcepts   = 5
	maxLedgerSummaryLen = 100
)

// BuildUpstreamTerminologySection generates a strictly token-budgeted (< 150 tokens) CDC prompt section
// that binds downstream LLM chapter generation to established concepts, terminology, and invariants.
func BuildUpstreamTerminologySection(items []UpstreamPrecedentItem) string {
	if len(items) == 0 {
		return ""
	}

	var validLines []string
	count := 0
	for _, item := range items {
		title := strings.TrimSpace(item.ModuleTitle)
		summary := strings.TrimSpace(item.Summary)
		if len(summary) > maxLedgerSummaryLen {
			summary = summary[:maxLedgerSummaryLen] + "..."
		}

		// Filter and limit concepts
		var concepts []string
		for _, c := range item.Concepts {
			trimmed := strings.TrimSpace(c)
			if trimmed != "" {
				concepts = append(concepts, trimmed)
				if len(concepts) >= maxLedgerConcepts {
					break
				}
			}
		}

		if title == "" && len(concepts) == 0 && summary == "" {
			continue
		}

		if count >= maxLedgerModules {
			break
		}

		var line string
		if title != "" {
			if len(concepts) > 0 && summary != "" {
				line = fmt.Sprintf("- %s: %s (Context: %s)", title, strings.Join(concepts, ", "), summary)
			} else if len(concepts) > 0 {
				line = fmt.Sprintf("- %s: %s", title, strings.Join(concepts, ", "))
			} else if summary != "" {
				line = fmt.Sprintf("- %s: %s", title, summary)
			} else {
				line = fmt.Sprintf("- %s", title)
			}
		} else {
			if len(concepts) > 0 && summary != "" {
				line = fmt.Sprintf("- %s (Context: %s)", strings.Join(concepts, ", "), summary)
			} else if len(concepts) > 0 {
				line = fmt.Sprintf("- %s", strings.Join(concepts, ", "))
			} else {
				line = fmt.Sprintf("- %s", summary)
			}
		}

		validLines = append(validLines, line)
		count++
	}

	if len(validLines) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("[UPSTREAM PRECEDENT CONCEPTS & TERMINOLOGY — MANDATORY CONTINUITY]\n")
	sb.WriteString("The following foundational concepts have been established in earlier chapters:\n")
	for _, l := range validLines {
		sb.WriteString(l)
		sb.WriteString("\n")
	}
	sb.WriteString("DIRECTIVE: Maintain strict naming and concept consistency with these established terms. Do NOT re-explain or redefine them from scratch; reference them naturally as established prerequisites.")

	return sb.String()
}

// ExtractPrecedentsFromSnapshots extracts upstream precedent items directly from RSG ModuleSnapshots
// as a zero-DB fallback when DB concept nodes are not yet written (e.g. concurrent claim or cold start).
func ExtractPrecedentsFromSnapshots(snapshots []cluster.ModuleSnapshot, upstreamModuleNames []string, currentTeachingOrder int) []UpstreamPrecedentItem {
	if len(snapshots) == 0 {
		return nil
	}

	upstreamSet := make(map[string]bool, len(upstreamModuleNames))
	for _, m := range upstreamModuleNames {
		trimmed := strings.TrimSpace(m)
		if trimmed != "" {
			upstreamSet[strings.ToLower(trimmed)] = true
		}
	}

	var items []UpstreamPrecedentItem
	for _, snap := range snapshots {
		order := snap.TeachingOrder
		if order <= 0 {
			order = snap.ChapterNo
		}

		isTarget := false
		if len(upstreamSet) > 0 {
			isTarget = upstreamSet[strings.ToLower(strings.TrimSpace(snap.Title))]
		} else if currentTeachingOrder > 1 && order > 0 && order < currentTeachingOrder {
			isTarget = true
		}

		if !isTarget {
			continue
		}

		// Extract golden symbols from snap.Cognitive if present
		var concepts []string
		if len(snap.Cognitive) > 0 {
			var cog ModuleCognition
			if err := json.Unmarshal(snap.Cognitive, &cog); err == nil {
				for _, sym := range cog.GoldenSymbols {
					if sym.Name != "" {
						concepts = append(concepts, sym.Name)
					}
				}
			}
		}

		title := snap.Title
		if order > 0 {
			title = fmt.Sprintf("Chapter %d (%s)", order, snap.Title)
		}

		items = append(items, UpstreamPrecedentItem{
			ModuleTitle: title,
			Concepts:    concepts,
			Summary:     snap.Summary,
		})

		if len(items) >= maxLedgerModules {
			break
		}
	}

	return items
}

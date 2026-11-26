package transcription

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cluster"
)

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

const maxOutlineChapters = 40

// Supplies verified chapter titles so intro/summary narratives do not hallucinate cross-chapter topics.
func BuildChapterOutlineSection(snapshots []cluster.ModuleSnapshot, currentTeachingOrder int) string {
	if len(snapshots) <= 1 {
		return ""
	}

	type outlineEntry struct {
		order int
		title string
	}
	entries := make([]outlineEntry, 0, len(snapshots))
	for _, snap := range snapshots {
		title := strings.TrimSpace(snap.Title)
		if title == "" {
			continue
		}
		order := snap.TeachingOrder
		if order <= 0 {
			order = snap.ChapterNo
		}
		entries = append(entries, outlineEntry{order: order, title: title})
	}
	if len(entries) <= 1 {
		return ""
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].order > 0 && entries[j].order > 0 {
			return entries[i].order < entries[j].order
		}
		if entries[i].order > 0 {
			return true
		}
		if entries[j].order > 0 {
			return false
		}
		return false
	})
	if len(entries) > maxOutlineChapters {
		entries = entries[:maxOutlineChapters]
	}

	var sb strings.Builder
	sb.WriteString("[FULL BOOK CHAPTER OUTLINE — GROUND TRUTH]\n")
	sb.WriteString("The real, complete table of contents of this tutorial:\n")
	for _, e := range entries {
		marker := ""
		if currentTeachingOrder > 0 && e.order == currentTeachingOrder {
			marker = "  ← THIS CHAPTER"
		} else if currentTeachingOrder > 0 && e.order == currentTeachingOrder+1 {
			marker = "  ← NEXT CHAPTER"
		}
		if e.order > 0 {
			fmt.Fprintf(&sb, "%d. %s%s\n", e.order, e.title, marker)
		} else {
			fmt.Fprintf(&sb, "- %s%s\n", e.title, marker)
		}
	}
	sb.WriteString("DIRECTIVE: In intros, retrospectives, and transition sentences, you may ONLY reference chapter topics that appear in this outline. NEVER invent, merge, or preview chapters that are not listed here.")
	return sb.String()
}

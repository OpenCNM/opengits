package transcription

import (
	"encoding/json"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/stretchr/testify/assert"
)

func TestBuildUpstreamTerminologySection_Empty(t *testing.T) {
	t.Run("nil slice returns empty string", func(t *testing.T) {
		assert.Equal(t, "", BuildUpstreamTerminologySection(nil))
	})

	t.Run("empty slice returns empty string", func(t *testing.T) {
		assert.Equal(t, "", BuildUpstreamTerminologySection([]UpstreamPrecedentItem{}))
	})

	t.Run("slice with blank items returns empty string", func(t *testing.T) {
		items := []UpstreamPrecedentItem{
			{ModuleTitle: "   ", Concepts: []string{"", "  "}},
		}
		assert.Equal(t, "", BuildUpstreamTerminologySection(items))
	})
}

func TestBuildUpstreamTerminologySection_Formatting(t *testing.T) {
	items := []UpstreamPrecedentItem{
		{
			ModuleTitle: "Chapter 1 (Core Storage)",
			Concepts:    []string{"Store", "MemTable", "WAL"},
			Summary:     "LSM-Tree storage engine with write-ahead log for persistence.",
		},
		{
			ModuleTitle: "Chapter 2 (Pipeline)",
			Concepts:    []string{"StageRunner", "Filter"},
			Summary:     "Pipeline execution engine.",
		},
	}

	result := BuildUpstreamTerminologySection(items)
	assert.Contains(t, result, "[UPSTREAM PRECEDENT CONCEPTS & TERMINOLOGY — MANDATORY CONTINUITY]")
	assert.Contains(t, result, "The following foundational concepts have been established in earlier chapters:")
	assert.Contains(t, result, "- Chapter 1 (Core Storage): Store, MemTable, WAL (Context: LSM-Tree storage engine with write-ahead log for persistence.)")
	assert.Contains(t, result, "- Chapter 2 (Pipeline): StageRunner, Filter (Context: Pipeline execution engine.)")
	assert.Contains(t, result, "DIRECTIVE: Maintain strict naming and concept consistency with these established terms.")
	assert.Contains(t, result, "Do NOT re-explain or redefine them from scratch")
}

func TestBuildUpstreamTerminologySection_Limits(t *testing.T) {
	// Create more than maxLedgerModules items
	var items []UpstreamPrecedentItem
	for i := 1; i <= 10; i++ {
		items = append(items, UpstreamPrecedentItem{
			ModuleTitle: "Mod",
			Concepts:    []string{"C1", "C2", "C3", "C4", "C5", "C6", "C7"},
			Summary:     "Very long summary that exceeds the 100 character budget limit and should be cleanly truncated with an ellipsis to prevent attention drift.",
		})
	}

	result := BuildUpstreamTerminologySection(items)
	// Should contain at most maxLedgerModules (4) bullets
	lines := 0
	for _, l := range splitLines(result) {
		if len(l) > 0 && l[0] == '-' {
			lines++
		}
	}
	assert.Equal(t, maxLedgerModules, lines)
	assert.Contains(t, result, "...")
}

func splitLines(s string) []string {
	var lines []string
	curr := ""
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, curr)
			curr = ""
		} else {
			curr += string(s[i])
		}
	}
	if curr != "" {
		lines = append(lines, curr)
	}
	return lines
}

func TestExtractPrecedentsFromSnapshots(t *testing.T) {
	cog1, _ := json.Marshal(ModuleCognition{
		GoldenSymbols: []ModuleGoldenSymbol{
			{Name: "Engine", File: "src/engine.go", Kind: "type"},
			{Name: "Init", File: "src/engine.go", Kind: "function"},
		},
	})
	cog2, _ := json.Marshal(ModuleCognition{
		GoldenSymbols: []ModuleGoldenSymbol{
			{Name: "Pipeline", File: "src/pipe.go", Kind: "type"},
		},
	})

	snapshots := []cluster.ModuleSnapshot{
		{
			TeachingOrder: 1,
			Title:         "Storage Core",
			Summary:       "Core storage layer",
			Cognitive:     cog1,
		},
		{
			TeachingOrder: 2,
			Title:         "Execution Pipeline",
			Summary:       "Pipeline processor",
			Cognitive:     cog2,
		},
		{
			TeachingOrder: 3,
			Title:         "API Gateway",
			Summary:       "Public interface",
		},
	}

	t.Run("match upstream by name", func(t *testing.T) {
		items := ExtractPrecedentsFromSnapshots(snapshots, []string{"Storage Core"}, 3)
		assert.Len(t, items, 1)
		assert.Equal(t, "Chapter 1 (Storage Core)", items[0].ModuleTitle)
		assert.Equal(t, []string{"Engine", "Init"}, items[0].Concepts)
		assert.Equal(t, "Core storage layer", items[0].Summary)
	})

	t.Run("fallback to teachingOrder < currentOrder", func(t *testing.T) {
		items := ExtractPrecedentsFromSnapshots(snapshots, nil, 3)
		assert.Len(t, items, 2)
		assert.Equal(t, "Chapter 1 (Storage Core)", items[0].ModuleTitle)
		assert.Equal(t, "Chapter 2 (Execution Pipeline)", items[1].ModuleTitle)
	})

	t.Run("empty snapshots returns nil", func(t *testing.T) {
		assert.Nil(t, ExtractPrecedentsFromSnapshots(nil, nil, 3))
	})
}

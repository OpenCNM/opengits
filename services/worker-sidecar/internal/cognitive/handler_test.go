package cognitive

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCognitiveScaffoldBuilders(t *testing.T) {
	t.Run("BuildCognitiveScaffoldSection", func(t *testing.T) {
		cog := ModuleCognition{
			Phase:             PhaseEntity,
			PhaseOrder:        2,
			Rationale:         "Core domain entity",
			UpstreamModules:   []string{"Config"},
			DownstreamModules: []string{"Router", "Worker"},
			GoldenSymbols: []ModuleGoldenSymbol{
				{Name: "User", File: "src/user.ts", Kind: "type"},
			},
			CallFlow: []ModuleCallStep{
				{Caller: "init", Callee: "load"},
			},
		}
		section := BuildCognitiveScaffoldSection(cog, 2)
		assert.Contains(t, section, "### COGNITIVE GRADIENT POSITION")
		assert.Contains(t, section, "Stage 2: Core Domain & State")
		assert.Contains(t, section, "- Depends on: Config")
		assert.Contains(t, section, "- Used by: Router, Worker")
		assert.Contains(t, section, "`User` (src/user.ts)")
		assert.Contains(t, section, "init → load")
	})

	t.Run("BuildCognitivePromptScaffold", func(t *testing.T) {
		mods := []ProjectedModule{
			{
				Name:               "AppEntry",
				Phase:              PhasePerception,
				TeachingOrder:      1,
				CognitiveRationale: "Bootstrap entry point",
				PrimaryFiles:       []string{"src/main.ts"},
				Directories:        []string{"src"},
			},
		}
		scaffold := BuildCognitivePromptScaffold(mods)
		assert.Contains(t, scaffold, "### COGNITIVE GRADIENT ARCHITECTURE (TOPOLOGICAL SCAFFOLD)")
		assert.Contains(t, scaffold, "Chapter 1: AppEntry [Stage 1: Perception & Entry]")
		assert.Contains(t, scaffold, "src/main.ts")
	})
}

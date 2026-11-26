package pipelineb

import (
	"context"
	"errors"
	"fmt"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

const OutlinePurpose = "outline_map_v1"

const (
	outlineMapScope = ""
	outlineMapScale = 1
)

type LlmGateway interface {
	Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error
	Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (client.LlmTextResult, error)
}

type GatewayModel struct {
	Client           LlmGateway
	UserID           *string
	CustomPrompt     string
	PreviousOutline  string
	TeachingDepth    string
	LearnerArchetype string
	Pacing           string
	PatternsFn       func() cognitive.Patterns
}

func (g *GatewayModel) patternsFor() cognitive.Patterns {
	if g.PatternsFn != nil {
		if p := g.PatternsFn(); p != nil {
			return p
		}
	}
	return cognitive.DefaultPatterns()
}

func (g *GatewayModel) TeachingContext() (teachingDepth, customPrompt string) {
	return g.TeachingDepth, g.CustomPrompt
}

func (g *GatewayModel) Complete(ctx context.Context, req ModelRequest) (string, error) {
	mapText := ""
	if req.RepoMap != nil {
		patterns := g.patternsFor()
		subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(req.RepoMap), patterns)
		topo := BuildMacroTopology(req.RepoMap, outlineMapScope, outlineMapScale, patterns)
		mapText = RenderMultiScaleMap(req.RepoMap, subsystems, topo, g.TeachingDepth, MultiScaleMapMaxTokens)
	} else if req.ArchModel != nil {
		mapText = RenderArchModel(req.ArchModel)
	}
	vars := map[string]any{
		"map":              mapText,
		"targetLanguage":   req.TargetLanguage,
		"skipMetaCompiler": true,
	}
	prompt := g.CustomPrompt
	if req.ContinuationPrompt != "" {
		if prompt != "" {
			prompt = prompt + "\n\n" + req.ContinuationPrompt
		} else {
			prompt = req.ContinuationPrompt
		}
	}
	if prompt != "" {
		vars["customPrompt"] = prompt
	}
	if g.CustomPrompt != "" && g.PreviousOutline != "" {
		vars["previousOutline"] = g.PreviousOutline
	}
	if g.TeachingDepth != "" {
		vars["teachingDepth"] = g.TeachingDepth
	}
	if g.LearnerArchetype != "" {
		vars["learnerArchetype"] = g.LearnerArchetype
	}
	if g.Pacing != "" {
		vars["pacing"] = g.Pacing
	}
	if req.CoverageFeedback != "" {
		vars["coverageFeedback"] = req.CoverageFeedback
	}
	// Streamed NDJSON carries validated JSON in text; ErrStreamPartial returns truncated chunks for deterministic salvage.
	res, err := g.Client.Complete(ctx, OutlinePurpose, vars, g.UserID)
	if err != nil {
		if errors.Is(err, client.ErrStreamPartial) && res.Text != "" {
			return res.Text, err
		}
		return "", fmt.Errorf("gateway %s: %w", OutlinePurpose, err)
	}
	return res.Text, nil
}

var _ OutlineModel = (*GatewayModel)(nil)

const OutlinePlanPurpose = "outline_plan_v1"

type GatewayPlanner struct {
	Client           LlmGateway
	UserID           *string
	CustomPrompt     string
	PreviousOutline  string
	Pacing           string
	TeachingDepth    string
	LearnerArchetype string
}

func (g *GatewayPlanner) Plan(ctx context.Context, skeleton string, rollups map[string]string, feedback string, targetLanguage string) (string, error) {
	vars := map[string]any{
		"skeleton":         skeleton,
		"targetLanguage":   targetLanguage,
		"maxChapters":      10,
		"skipMetaCompiler": true,
	}
	if g.Pacing != "" {
		vars["pacing"] = g.Pacing
		if g.Pacing == "compact" {
			vars["maxChapters"] = 6
		} else if g.Pacing == "detailed" {
			vars["maxChapters"] = 14
		}
	}
	if g.CustomPrompt != "" {
		vars["customPrompt"] = g.CustomPrompt
		if g.PreviousOutline != "" {
			vars["previousOutline"] = g.PreviousOutline
		}
	}
	if g.TeachingDepth != "" {
		vars["teachingDepth"] = g.TeachingDepth
	}
	if g.LearnerArchetype != "" {
		vars["learnerArchetype"] = g.LearnerArchetype
	}
	if len(rollups) > 0 {
		vars["rollups"] = rollups
	}
	if feedback != "" {
		vars["planFeedback"] = feedback
	}
	// Planner relies on feedback replanning instead of partial-stream salvage, so propagate stream errors verbatim.
	res, err := g.Client.Complete(ctx, OutlinePlanPurpose, vars, g.UserID)
	if err != nil {
		return "", fmt.Errorf("gateway %s: %w", OutlinePlanPurpose, err)
	}
	return res.Text, nil
}

// Read own fields injected during handler cloning when model lacks teachingContextAware.
func (g *GatewayPlanner) TeachingContext() (teachingDepth, customPrompt string) {
	return g.TeachingDepth, g.CustomPrompt
}

var _ PlannerModel = (*GatewayPlanner)(nil)

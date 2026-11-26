package pipelineb

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

const OutlineSamplerPurpose = "outline_sampler_v1"

const (
	SamplingStrategyFullAst           = "full-ast"
	SamplingStrategyStratified        = "stratified"
	SamplingStrategyStratifiedPartial = "stratified-partial"
	SamplingStrategyPartialAst        = "partial-ast"
	SamplingStrategyFallback8         = "fallback-8"
)

const MaxSampledCoreFiles = 25

const StratifiedSampleCapEnvVar = "TREE_FIRST_STRATIFIED_CAP"

const (
	stratifiedCapFloor        = 25
	stratifiedCapCeiling      = 50
	stratifiedCapPerSubsystem = 3
)

func stratifiedSampleCap(subsystemCount int) int {
	if v := os.Getenv(StratifiedSampleCapEnvVar); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return min(stratifiedCapCeiling, max(stratifiedCapFloor, subsystemCount*stratifiedCapPerSubsystem))
}

type OutlineSamplerResult struct {
	ArchitectureArchetype string   `json:"architectureArchetype"`
	SubsystemCount        int      `json:"subsystemCount"`
	NeedFiles             []string `json:"needFiles"`
}

type SampleRequest struct {
	Skeleton         string
	Readme           string
	Prefix           string
	TeachingDepth    string
	LearnerArchetype string
	CustomPrompt     string
}

type OutlineSampler interface {
	SampleCoreFiles(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error)
}

type GatewaySampler struct {
	Client           LlmGateway
	UserID           *string
	CustomPrompt     string
	TeachingDepth    string
	LearnerArchetype string
}

func (s *GatewaySampler) SampleCoreFiles(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error) {
	if s == nil || s.Client == nil {
		return nil, errors.New("sampler gateway client not configured")
	}
	vars := map[string]any{
		"skeleton": req.Skeleton,
		"readme":   req.Readme,
	}
	if req.Prefix != "" {
		vars["prefix"] = req.Prefix
	}
	if s.TeachingDepth != "" {
		vars["teachingDepth"] = s.TeachingDepth
	}
	if s.LearnerArchetype != "" {
		vars["learnerArchetype"] = s.LearnerArchetype
	}
	if s.CustomPrompt != "" {
		vars["customPrompt"] = s.CustomPrompt
	}

	var res OutlineSamplerResult
	if err := s.Client.Generate(ctx, OutlineSamplerPurpose, vars, s.UserID, &res); err != nil {
		return nil, fmt.Errorf("gateway %s: %w", OutlineSamplerPurpose, err)
	}
	return &res, nil
}

var _ OutlineSampler = (*GatewaySampler)(nil)

func SanitizeSampledPaths(needFiles []string, entries []client.GitTreeEntry, prefixScope string, maxFiles ...int) []string {
	if len(needFiles) == 0 || len(entries) == 0 {
		return nil
	}
	capLimit := MaxSampledCoreFiles
	if len(maxFiles) > 0 && maxFiles[0] > 0 {
		capLimit = maxFiles[0]
	}
	scope := strings.Trim(filepath.ToSlash(prefixScope), "/ ")

	validBlobs := make(map[string]bool, len(entries))
	for _, e := range entries {
		if e.Type == "blob" && e.Size > 0 {
			rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
			validBlobs[rel] = true
		}
	}

	seen := make(map[string]bool, len(needFiles))
	out := make([]string, 0, len(needFiles))

	for _, raw := range needFiles {
		clean := strings.Trim(filepath.ToSlash(raw), "/ ")
		if clean == "" {
			continue
		}
		if scope != "" {
			if !strings.HasPrefix(clean+"/", scope+"/") {
				scopedCandidate := scope + "/" + clean
				if validBlobs[scopedCandidate] {
					clean = scopedCandidate
				} else {
					continue
				}
			}
		}
		if seen[clean] || !validBlobs[clean] {
			continue
		}
		seen[clean] = true
		out = append(out, clean)
		if len(out) >= capLimit {
			break
		}
	}
	return out
}

func FindReadmePathFromEntries(entries []client.GitTreeEntry, prefixScope string) string {
	scope := strings.Trim(filepath.ToSlash(prefixScope), "/ ")
	if scope != "" {
		if path := findReadmeInScope(entries, scope); path != "" {
			return path
		}
	}
	return findReadmeInScope(entries, "")
}

func findReadmeInScope(entries []client.GitTreeEntry, scope string) string {
	var candidate string
	var candidateRank int

	for _, e := range entries {
		if e.Type != "blob" || e.Size <= 0 {
			continue
		}
		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		relScoped := rel
		if scope != "" {
			if !strings.HasPrefix(rel+"/", scope+"/") {
				continue
			}
			relScoped = strings.TrimPrefix(rel, scope+"/")
		}

		depth := strings.Count(relScoped, "/")
		if depth != 0 {
			continue
		}

		base := filepath.Base(relScoped)
		lower := strings.ToLower(base)

		rank := 0
		if lower == "readme.md" {
			rank = 100
		} else if lower == "readme" {
			rank = 90
		} else if lower == "readme.rst" || lower == "readme.txt" {
			rank = 80
		} else if strings.HasPrefix(lower, "readme") {
			rank = 50
		}

		if rank > candidateRank {
			candidateRank = rank
			candidate = rel
		}
	}
	return candidate
}

// Tops up uncovered non-auxiliary subsystems and fails open to rule-based quota selection on AI timeout/error.
func SampleOrFallbackCoreFiles(
	ctx context.Context,
	sampler OutlineSampler,
	entries []client.GitTreeEntry,
	sreq SampleRequest,
	patterns cognitive.Patterns,
	subsystems []SubsystemSpec,
) ([]string, string) {
	totalCap := stratifiedSampleCap(len(subsystems))

	var sampled []string
	if sampler != nil {
		sampleCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		defer cancel()

		res, err := sampler.SampleCoreFiles(sampleCtx, sreq)
		if err == nil && res != nil && len(res.NeedFiles) > 0 {
			sampled = SanitizeSampledPaths(res.NeedFiles, entries, sreq.Prefix, totalCap)
		} else if err != nil {
			log.Printf("[pipelineb] outline sampler error, falling back: %v", err)
		}
	}

	if len(sampled) > 0 {
		if len(subsystems) > 0 {
			sampled = FillSubsystemQuotaFiles(sampled, entries, patterns, subsystems, sreq.Prefix, totalCap)
		}
		return sampled, SamplingStrategyStratified
	}

	if len(subsystems) > 0 {
		return SelectCoreFilesFromTreeSubsystemQuota(entries, patterns, 8, subsystems, sreq.Prefix), SamplingStrategyFallback8
	}
	return SelectCoreFilesFromTree(entries, patterns, 8, sreq.Prefix), SamplingStrategyFallback8
}

package transcription

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/doc"
)

type StagedResult struct {
	Content     string   `json:"content"`
	Model       string   `json:"model"`
	ModuleName  string   `json:"moduleName,omitempty"`
	SourceFiles []string `json:"sourceFiles,omitempty"`
}

// No-ops lock/heartbeat/checkpoint/notify so staged runs never mutate live jobs, while forwarding precedent reads.
type stagedNoopBodyStore struct {
	inner BodyStore
}

func (s *stagedNoopBodyStore) CasProcessing(ctx context.Context, documentId string, allowProcessed bool) (bool, error) {
	return true, nil
}
func (s *stagedNoopBodyStore) HeartbeatDocument(ctx context.Context, documentId string) error {
	return nil
}
func (s *stagedNoopBodyStore) ClearProcessingStatus(ctx context.Context, documentId, status, message string) error {
	return nil
}
func (s *stagedNoopBodyStore) CheckpointLoad(ctx context.Context, documentId, fingerprint string) (map[int]string, error) {
	return map[int]string{}, nil
}
func (s *stagedNoopBodyStore) CheckpointSave(ctx context.Context, documentId, requestedBy, fingerprint string, index, total int, content string) error {
	return nil
}
func (s *stagedNoopBodyStore) ClearCheckpoint(ctx context.Context, documentId string) error {
	return nil
}
func (s *stagedNoopBodyStore) NotifyDone(ctx context.Context, documentId, userId string) error {
	return nil
}
func (s *stagedNoopBodyStore) UpdateProgress(ctx context.Context, documentId string, step string, progress int) error {
	return nil
}
func (s *stagedNoopBodyStore) GetUpstreamChapterPrecedents(ctx context.Context, repositoryId string, upstreamModules []string, maxTeachingOrder int) ([]UpstreamPrecedentItem, error) {
	if s.inner == nil {
		return nil, nil
	}
	return s.inner.GetUpstreamChapterPrecedents(ctx, repositoryId, upstreamModules, maxTeachingOrder)
}

func RunStagedBody(ctx context.Context, cfg Config, deps BodyDeps, documentId, requestedBy, sourceSha, modelOverride string) (*StagedResult, error) {
	if deps.PrepareFunc == nil {
		return nil, errors.New("staged: prepare executor not configured")
	}
	if strings.TrimSpace(sourceSha) == "" {
		return nil, errors.New("staged: sourceSha is required")
	}

	if bp, ok := deps.Store.(BudgetProbeStore); ok && bp != nil {
		if err := bp.CheckLlmBudget(ctx, requestedBy); err != nil {
			if isBudgetErr(err) {
				return nil, fmt.Errorf("staged: budget exceeded for %s (defer later)", requestedBy)
			}
			log.Printf("[staged] budget precheck unavailable: %v (gateway gate remains authoritative)", err)
		}
	}

	// Forces ForceEnhance so stale fingerprint hits never serve prior-SHA outputs.
	opts := doc.PrepareOptions{UserID: requestedBy, ForceEnhance: true, Model: modelOverride}
	prep, err := deps.PrepareFunc(ctx, documentId, requestedBy, opts)
	if err != nil {
		return nil, fmt.Errorf("staged prepare failed: %w", err)
	}
	if prep.Outcome != "ready" {
		return nil, fmt.Errorf("staged prepare unexpected outcome: %s", prep.Outcome)
	}

	prep.Doc.Content = nil
	sha := sourceSha
	prep.Doc.Repository.GitSha = &sha

	var content string
	if !prep.Doc.VirtualChapter {
		content, err = fetchDocContent(ctx, cfg, deps, prep)
		if err != nil {
			return nil, fmt.Errorf("staged transform failed: %w", err)
		}
	}

	var llmUsageTotal int64
	execDeps := deps
	if execDeps.Llm != nil {
		execDeps.Llm = &llmUsageWrapper{inner: execDeps.Llm, total: &llmUsageTotal}
	}
	execDeps.Store = &stagedNoopBodyStore{inner: deps.Store}

	env := TranscriptionExecutionContext{
		Cfg:         cfg,
		Deps:        execDeps,
		Prep:        prep,
		RequestedBy: requestedBy,
		Content:     content,
		HadOriginal: false,
		Reporter:    newProgressReporter(nil, "", 3*time.Second),
		GatewayVars: buildGatewayVars(prep),
	}
	_, finalContent, bodyErr := DefaultTranscriptionStrategyDispatcher().Dispatch(ctx, env)
	if bodyErr != nil {
		return nil, fmt.Errorf("staged generation failed: %w", bodyErr)
	}
	if strings.TrimSpace(finalContent) == "" {
		return nil, errors.New("staged: generated content is empty; refusing empty product")
	}

	if llmUsageTotal > 0 {
		if recorder, ok := deps.FinalizeStore.(interface {
			RecordTranscriptionTokens(ctx context.Context, repositoryId string, tokens int) error
		}); ok {
			_ = recorder.RecordTranscriptionTokens(ctx, prep.Doc.RepositoryID, int(llmUsageTotal))
		}
	}

	return &StagedResult{
		Content:     finalContent,
		Model:       prep.Model,
		ModuleName:  prep.Doc.Title,
		SourceFiles: prep.Doc.SourceFiles,
	}, nil
}

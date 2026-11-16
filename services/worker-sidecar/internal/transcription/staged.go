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

// ─────────────────────────────────────────────────────────────
// 市场暂存转录（staged）：Go 原生执行体的无锁变体（生成能力单一事实源）。
//
// 与队列执行体 RunBody 的差异仅在编排层（生成能力零分叉——上游术语台账、
// 架构 Mermaid 骨架、源码插槽回填、认知脚手架与队列路径同源同享，市场更新
// 不再走 Node 旧管线造成"更新即质量降级"）：
// - 源冻结 ref 覆写为 sourceSha（更新市场按目标版本重生成）
// - 底稿强制全量抓取（doc.content 视为无——否则旧内容被当 JIT 输入只做翻译）
// - 不 CAS/不心跳/不落库/不通知（产物交调用方暂存投票，换入由市场引擎事务完成）
// - 断点存档与进度写入走 no-op 垫片（不污染在途 job 行的存档与进度）
// ─────────────────────────────────────────────────────────────

// StagedResult 市场暂存生成产物。
type StagedResult struct {
	Content     string   `json:"content"`
	Model       string   `json:"model"`
	ModuleName  string   `json:"moduleName,omitempty"`
	SourceFiles []string `json:"sourceFiles,omitempty"`
}

// stagedNoopBodyStore staged 垫片：锁/心跳/存档/进度/通知全部 no-op；仅上游
// 先例查询透传真实 store（代码章术语台账依赖 DB 概念节点）。
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

// RunStagedBody 市场暂存生成（无锁、零文档落库）。Fail-Closed：任何失败显式报错。
func RunStagedBody(ctx context.Context, cfg Config, deps BodyDeps, documentId, requestedBy, sourceSha, modelOverride string) (*StagedResult, error) {
	if deps.PrepareFunc == nil {
		return nil, errors.New("staged: prepare executor not configured")
	}
	if strings.TrimSpace(sourceSha) == "" {
		return nil, errors.New("staged: sourceSha is required")
	}

	// 预算首帧闸（与队列执行体同款）：暂存烧真实 token，没预算第一帧就拒绝，
	// 不做任何备料。预检故障放行交网关权威闸。
	if bp, ok := deps.Store.(BudgetProbeStore); ok && bp != nil {
		if err := bp.CheckLlmBudget(ctx, requestedBy); err != nil {
			if isBudgetErr(err) {
				return nil, fmt.Errorf("staged: budget exceeded for %s (defer later)", requestedBy)
			}
			log.Printf("[staged] budget precheck unavailable: %v (gateway gate remains authoritative)", err)
		}
	}

	// ForceEnhance：跳过 prepare 的 noop/指纹命中门控——指纹含旧 sha，命中旧
	// 成品即违背"按目标版本重生成"的市场语义。
	opts := doc.PrepareOptions{UserID: requestedBy, ForceEnhance: true, Model: modelOverride}
	prep, err := deps.PrepareFunc(ctx, documentId, requestedBy, opts)
	if err != nil {
		return nil, fmt.Errorf("staged prepare failed: %w", err)
	}
	if prep.Outcome != "ready" {
		return nil, fmt.Errorf("staged prepare unexpected outcome: %s", prep.Outcome)
	}

	// 源冻结 ref 覆写：底稿/归档直读都按目标 sha 取材
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

	// LLM 用量记账装饰（暂存烧真实 token，计入仓库账本）
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
		HadOriginal: false, // 强制全量：不走 JIT 只翻短路
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

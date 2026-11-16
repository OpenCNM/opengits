package transcription

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/pipeline"
)

// ─────────────────────────────────────────────────────────────
// 转录收尾 Go 段（M3 分片，逐字对齐 finalize.ts 的 writeContentLayer/
// 盖章/记账）：双哈希内容层 upsert + attach + 停写塌缩 + PROCESSED 盖章
// + transcriptionModels/Tokens 记账。前段（切片/概念/图谱边）在 web 的
// store-chunks 端点（Go 先调它再走本段——attach 依赖 chunk 行已存在）。
// ─────────────────────────────────────────────────────────────

const DefaultAiModel = "qwen3.6-flash"

// FinalizeStore finalize 段数据访问。
type FinalizeStore interface {
	UpsertContentLayer(ctx context.Context, contentHash, requestFingerprint, content, lang, model string) (string, error)
	AttachContentChunks(ctx context.Context, contentId, documentId string) error
	DeleteLegacyChunks(ctx context.Context, documentId string) error
	StampProcessed(ctx context.Context, documentId, content string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error)
	RecordTranscriptionModel(ctx context.Context, repositoryId, model string) error
	RecordTranscriptionTokens(ctx context.Context, repositoryId string, tokens int) error
}

// TitleSyncStore 转录后标题回同步能力（可选注入；生产 pgx store 实现，
// 测试桩缺失时静默跳过——标题同步是认知增强，不是转录硬门）。
type TitleSyncStore interface {
	SyncChapterTitleFromContent(ctx context.Context, documentId, title string) error
}

// TranscriptionFinalizeStore 兼容别名。
type TranscriptionFinalizeStore = FinalizeStore

// normalizeContentHash 与 content-addressing.computeContentHash 逐字对齐：
// sha256(CRLF→LF + trim + "\0" + lang)。
func normalizeContentHash(content, lang string) string {
	normalized := strings.TrimSpace(strings.ReplaceAll(content, "\r\n", "\n"))
	h := sha256.Sum256([]byte(normalized + "\x00" + lang))
	return hex.EncodeToString(h[:])
}

// Finalize Go 收尾（2026-09-11 收刀：web 兜底删除，Fail-Closed）：
// 进程内直写 chunk 行与元数据 → 内容层 → 盖章 → 记账；任一段失败显式报错
// （任务置 ERROR 待重试），绝不回退 Node。P2003 竞态重试一次（孤儿 GC 删行
// 与 attach 指认窗口）。
func Finalize(ctx context.Context, cfg Config, store FinalizeStore, prep *doc.PrepareResult, finalContent, userId, model string) error {
	manifest := concept.ExtractConceptManifest(finalContent, prep.Doc.Path)
	finalContent = manifest.CleanContent

	// 空终稿防线（对齐 Node document-processor："Generated content is empty;
	// refusing to mark PROCESSED"——历史上"PROCESSED 但空文档"事故的确定性守门）
	if strings.TrimSpace(finalContent) == "" {
		return fmt.Errorf("generated content is empty; refusing to mark PROCESSED: %s", prep.Doc.Path)
	}

	// 裸 JSON 容器防线（失效封闭公理：杜绝未解包的 JSON 脏数据落入存储层）
	if pipeline.HasUnpeeledJSONShell(finalContent) {
		return fmt.Errorf("generated content contains unpeeled JSON container; refusing to mark PROCESSED: %s", prep.Doc.Path)
	}

	chunks := chunkInProcess(cfg, prep, finalContent)

	// Fail-Closed 单实现（2026-09-11 收刀）：直写能力是硬前提——store 必须实现
	// 元数据与 chunk 直写接口（生产 pgx store 均实现；缺失即配置错误显式报错）。
	metaStore, hasMS := store.(TranscriptionMetadataStore)
	chunkStore, hasCS := store.(ChunkWriteStore)
	hasContent := strings.TrimSpace(finalContent) != ""
	if !hasMS || (hasContent && !hasCS) {
		return fmt.Errorf("finalize store lacks direct-write capability (metadata=%v, chunks=%v)", hasMS, hasCS)
	}
	// 护栏：有正文但切片为空（切片异常）时不得静默跳过 chunk 落库——显式报错待重试
	if len(chunks) == 0 && hasContent {
		return fmt.Errorf("in-process chunking produced no chunks for non-empty content: %s", prep.Doc.Path)
	}
	// 进程内直写（Zero-Web 终态）：chunk 行 + 元数据，任一失败显式报错（Fail-Closed）
	if len(chunks) > 0 {
		if _, err := chunkStore.ReplaceDocumentChunks(ctx, prep.Doc.ID, chunks, ReplaceChunksOpts{
			DocPath:       prep.Doc.Path,
			DefaultBranch: cfg.DefaultBranch,
			// 文档级宏观角色提示从终稿全文确定性推导（单一输入=物理内容，
			// 与 Node 经 /v1/doc/finalize 落库路径共用 chunker.DeriveDocumentRole）
			BlueprintRole: chunker.DeriveDocumentRole(finalContent),
		}); err != nil {
			return fmt.Errorf("direct ReplaceDocumentChunks failed for %s: %w", prep.Doc.Path, err)
		}
	}
	summary := strings.TrimSpace(manifest.Summary)
	if summary == "" && len(manifest.Takeaways) > 0 {
		summary = strings.TrimSpace(strings.Join(manifest.Takeaways, " "))
	}
	if err := metaStore.StoreDocumentMetadata(ctx, repoIdOf(prep), prep.Doc.ID, prep.Doc.Path, finalContent, manifest, summary); err != nil {
		return fmt.Errorf("direct StoreDocumentMetadata failed for %s: %w", prep.Doc.Path, err)
	}

	if model == "" {
		model = DefaultAiModel
	}

	lang := derefStrPtr(prep.Effective.TargetLanguage)
	contentHash := normalizeContentHash(finalContent, lang)

	var contentId string
	// 成品质量门禁（红线2 效果不劣化）：降级成品（收敛漏斗原文保底等确定性
	// 事实标记）禁止进内容层——指纹钉死会把一次降级永久复用放大。仍照常
	// 盖章 PROCESSED（读者可读原文保底），重开/重转录可再尝试完整质量。
	if !prep.ContentDegraded {
		for attempt := 0; attempt < 2; attempt++ {
			id, err := store.UpsertContentLayer(ctx, contentHash, prep.Fingerprint, finalContent, lang, model)
			if err != nil {
				log.Printf("[transcription-finalize] content layer skipped for %s: %v", prep.Doc.Path, err)
				contentId = ""
				break
			}
			if err := store.AttachContentChunks(ctx, id, prep.Doc.ID); err != nil {
				if attempt == 0 && isForeignKeyViolation(err) {
					continue // GC 竞态：重试一次（upsert 已重建行）
				}
				log.Printf("[transcription-finalize] attach skipped for %s: %v", prep.Doc.Path, err)
				contentId = ""
				break
			}
			contentId = id
			break
		}
	} else {
		log.Printf("[transcription-finalize] degraded content skips content layer for %s (fingerprint pinning suppressed)", prep.Doc.Path)
	}

	// 停写塌缩：内容层已承载检索，legacy per-doc chunk 不再保留
	if !cfg.ContentDualWrite && contentId != "" {
		_ = store.DeleteLegacyChunks(ctx, prep.Doc.ID)
	}

	var cidPtr *string
	if contentId != "" {
		cidPtr = &contentId
	}
	// 终态防御：内容层失败（contentId 空）绝不同步置空 legacy——宁退化双写
	stamped, err := store.StampProcessed(ctx, prep.Doc.ID, finalContent, cidPtr, prep.Doc.Repository.GitSha, model, prep.GenerationLevel, cfg.ContentDualWrite)
	if err != nil {
		return fmt.Errorf("stamp: %w", err)
	}
	if !stamped {
		// CAS miss：转录期间成品已被并发换入/晋升，本次成果放弃（防覆写）。
		// doc 已有他人成品，任务按成功收尾；留 path 锚点供排障
		log.Printf("[transcription-finalize] stamp CAS miss, concurrent swap won for %s", prep.Doc.Path)
	}

	// 转录后节点标题回同步（File ≠ Cognitive Unit 收口）：终稿 H1 通过噪声
	// 门禁（非统计行/非代码引用/目标语言脚本）时，Document 与 OutlineNode
	// 标题对齐页面实际 H1——文档仓按文件出节点的裸文件名/源文标题在成品
	// 就绪后升级为 relay 生成的教学标题。吞错：标题同步失败不回滚 PROCESSED。
	if stamped {
		if syncStore, ok := store.(TitleSyncStore); ok {
			lang := derefStrPtr(prep.Effective.TargetLanguage)
			if h1 := mdpat.FirstAtxHeading(finalContent); mdpat.UsableChapterH1(h1, mdpat.RequireCJKTitle(lang)) {
				if err := syncStore.SyncChapterTitleFromContent(ctx, prep.Doc.ID, h1); err != nil {
					log.Printf("[transcription-finalize] title sync skipped for %s: %v", prep.Doc.Path, err)
				}
			}
		}
	}

	// 外围记账（吞错——不回滚 PROCESSED）
	_ = store.RecordTranscriptionModel(ctx, repoIdOf(prep), model)
	tokens := prep.TokensUsed
	if tokens <= 0 && prep.Usage.TotalTokens > 0 {
		tokens = prep.Usage.TotalTokens
	}
	if tokens > 0 {
		_ = store.RecordTranscriptionTokens(ctx, repoIdOf(prep), tokens)
	}
	return nil
}

func finalizeTranscription(ctx context.Context, cfg Config, store FinalizeStore, prep *doc.PrepareResult, finalContent, userId, model string) error {
	return Finalize(ctx, cfg, store, prep, finalContent, userId, model)
}

func isForeignKeyViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23503")
}

// chunkInProcess finalize 段进程内切片（零 RPC；2026-09-11 收刀：executor=web
// 双轨已删，Go 切片是唯一路径）。切片参数取自 prepare 响应的 chunker 字段
// （web 单一配置源）。panic 防御返回 nil——由调用方护栏显式报错（空 content
// 合法返回 nil）。
func chunkInProcess(cfg Config, prep *doc.PrepareResult, finalContent string) (chunks []chunker.MarkdownChunk) {
	if strings.TrimSpace(finalContent) == "" {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[transcription-finalize] in-process chunking panicked for %s: %v", prep.Doc.Path, r)
			chunks = nil
		}
	}()
	if prep.Doc.VirtualChapter {
		codeChunks := chunker.ChunkCodeModule(chunker.CodeModuleChunkRequest{
			ModuleName:  prep.Doc.Title,
			MdxContent:  finalContent,
			SourceFiles: prep.Doc.SourceFiles,
			MaxChars:    chunker.DefaultMaxChunkChars,
		})
		res := make([]chunker.MarkdownChunk, len(codeChunks))
		for i, cc := range codeChunks {
			var hp *string
			if cc.HeadingPath != "" {
				hpVal := cc.HeadingPath
				hp = &hpVal
			}
			res[i] = chunker.MarkdownChunk{
				Heading:     cc.Heading,
				HeadingPath: hp,
				Content:     cc.Content,
				ContentType: cc.ContentType,
			}
		}
		return res
	}
	req := chunker.MarkdownChunkRequest{
		Content:     finalContent,
		DocPath:     prep.Doc.Path,
		ParentTitle: prep.Chunker.ParentTitle,
	}
	if prep.Chunker.MaxTokens > 0 {
		req.MaxTokens = prep.Chunker.MaxTokens
	}
	if prep.Chunker.Overlap > 0 {
		req.Overlap = prep.Chunker.Overlap
	}
	result := chunker.ChunkMarkdown(req)
	if len(result) == 0 {
		return nil
	}
	return result
}

// repoIdOf 记账归属仓库。
func repoIdOf(prep *doc.PrepareResult) string { return prep.Doc.RepositoryID }

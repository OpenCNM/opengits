package transcription

import (
	"context"
	"log"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

// ─────────────────────────────────────────────────────────────
// finalize 段 SQL（与 Prisma 侧语义逐字对齐）。
// ─────────────────────────────────────────────────────────────

// UpsertContentLayer 按 contentHash upsert：命中回填缺失指纹；并发唯一冲突
// （23505）回落重查；撞既有指纹的“同指纹不同内容”去指纹落新行（首次为准）。
func (s *PgxStore) UpsertContentLayer(ctx context.Context, contentHash, requestFingerprint, content, lang, model string) (string, error) {
	row, err := s.queries.GetContentByHash(ctx, contentHash)
	if err == nil {
		if !row.RequestFingerprint.Valid && requestFingerprint != "" {
			_ = s.queries.UpdateContentRequestFingerprint(ctx, db.UpdateContentRequestFingerprintParams{
				RequestFingerprint: pgtype.Text{String: requestFingerprint, Valid: true},
				ID:                 row.ID,
			})
		}
		return row.ID, nil
	}

	_, err = s.queries.InsertContentLayer(ctx, db.InsertContentLayerParams{
		ContentHash:        contentHash,
		RequestFingerprint: requestFingerprint,
		Content:            pgtype.Text{String: content, Valid: true},
		Lang:               lang,
		GenerationModel:    model,
	})
	if err != nil {
		return "", err
	}
	// We just check if we can get it
	id, err := s.queries.GetContentIdByHash(ctx, contentHash)
	if err == nil && id != "" {
		return id, nil
	}

	// 冲突①：同内容并发 → 重查赢家
	if rid, err := s.queries.GetContentIdByHash(ctx, contentHash); err == nil && rid != "" {
		return rid, nil
	}

	// 冲突②：撞既有指纹的不同内容 → 去指纹落新行
	if requestFingerprint != "" {
		_, err := s.queries.InsertContentLayerNoFingerprint(ctx, db.InsertContentLayerNoFingerprintParams{
			ContentHash:     contentHash,
			Content:         pgtype.Text{String: content, Valid: true},
			Lang:            lang,
			GenerationModel: model,
		})
		if err == nil {
			if rid, err := s.queries.GetContentIdByHash(ctx, contentHash); err == nil && rid != "" {
				return rid, nil
			}
		}
	}
	return "", errContentLayerConflict
}

var errContentLayerConflict = &simpleErr{"content layer conflict unresolved"}

type simpleErr struct{ msg string }

func (e *simpleErr) Error() string { return e.msg }

// AttachContentChunks legacy per-doc chunk 复制进内容层（先清旧再插）。
func (s *PgxStore) AttachContentChunks(ctx context.Context, contentId, documentId string) error {
	if err := s.queries.DeleteDocumentChunksByContentId(ctx, pgtype.Text{String: contentId, Valid: true}); err != nil {
		return err
	}
	return s.queries.TranscriptionCopyDocumentChunksToContent(ctx, db.TranscriptionCopyDocumentChunksToContentParams{
		ContentID:  contentId,
		DocumentID: documentId,
	})
}

func (s *PgxStore) DeleteLegacyChunks(ctx context.Context, documentId string) error {
	return s.queries.ClearDocumentChunks(ctx, pgtype.Text{String: documentId, Valid: true})
}

// StampProcessed 盖章置 PROCESSED（停写判定 + 终态防御逐字对齐 finalize.ts）；
// generationLevel 内容等级随成品落列（空 = 不更新既有值，COALESCE 语义）；
// 内建 CAS 防御：若转录期间章节已完成换入或已被晋升，CAS miss 时不覆盖换入成品。
// 返回 stamped=false 表示 CAS 未命中（本次成果被放弃、行未被改动）——调用方
// 须按各自管线语义留痕/收敛，杜绝「静默成功」掩盖状态漂移。
func (s *PgxStore) StampProcessed(ctx context.Context, documentId, content string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error) {
	var gitShaStr string
	if gitSha != nil {
		gitShaStr = *gitSha
	}
	var contentIdStr string
	if contentId != nil {
		contentIdStr = *contentId
	}

	rows, err := s.queries.StampDocumentProcessed(ctx, db.StampDocumentProcessedParams{
		DualWrite:       dualWrite,
		Content:         content,
		GitSha:          gitShaStr,
		GenerationModel: model,
		GenerationLevel: generationLevel,
		ContentID:       contentIdStr,
		DocumentID:      documentId,
	})
	if err != nil {
		return false, err
	}
	if rows == 0 {
		// In-Band 观测：CAS miss 计数进入 /v1/metrics，系统性漂移（上游漏置
		// PROCESSING 的管线误接）在健康检查面可见，而非埋在日志里
		metrics.Inc("transcription.stamp_cas_miss")
		log.Printf("[transcription] StampProcessed CAS miss for doc %s (content was swapped in or state drifted)", documentId)
		return false, nil
	}
	return true, nil
}

// knownTranscriptionModels 进程内 memo（命中免查库；模型集合单调增长）。
var knownTranscriptionModels sync.Map

// RecordTranscriptionModel 累加仓库转录模型集合（jsonb 数组追加去重）。
func (s *PgxStore) RecordTranscriptionModel(ctx context.Context, repositoryId, model string) error {
	if repositoryId == "" || model == "" {
		return nil
	}
	if _, loaded := knownTranscriptionModels.LoadOrStore(repositoryId+"|"+model, struct{}{}); loaded {
		return nil
	}
	err := s.queries.RecordTranscriptionModel(ctx, db.RecordTranscriptionModelParams{
		Model:        model,
		RepositoryID: repositoryId,
	})
	if err != nil {
		knownTranscriptionModels.Delete(repositoryId + "|" + model)
	}
	return err
}

func (s *PgxStore) RecordTranscriptionTokens(ctx context.Context, repositoryId string, tokens int) error {
	if tokens <= 0 {
		return nil
	}
	return s.queries.RecordTranscriptionTokens(ctx, db.RecordTranscriptionTokensParams{
		Tokens:       int32(tokens),
		RepositoryID: repositoryId,
	})
}

// SyncChapterTitleFromContent 转录终稿 H1 回同步 Document 与 OutlineNode 标题
// （File ≠ Cognitive Unit 收口：导入期按文件出节点的裸文件名/源文 H1 标题，
// 在 relay 成品就绪后升级为页面实际教学标题——节点标题与所指向页面的 H1 对齐）。
func (s *PgxStore) SyncChapterTitleFromContent(ctx context.Context, documentId, title string) error {
	if documentId == "" || strings.TrimSpace(title) == "" {
		return nil
	}
	if err := s.queries.SyncDocumentTitleFromTranscription(ctx, db.SyncDocumentTitleFromTranscriptionParams{
		Title:      title,
		DocumentID: documentId,
	}); err != nil {
		return err
	}
	_, err := s.queries.SyncOutlineNodeTitleFromTranscription(ctx, db.SyncOutlineNodeTitleFromTranscriptionParams{
		Title:      title,
		DocumentID: documentId,
	})
	return err
}

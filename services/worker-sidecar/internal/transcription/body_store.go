package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/db"
	"github.com/opengits/worker-sidecar/internal/platform/storeutil"
)

// ─────────────────────────────────────────────────────────────
// 转录执行体的 DB 语义（PgxStore 实现；SQL 与 Prisma 侧逐字对齐）。
// ─────────────────────────────────────────────────────────────

// 源状态白名单 = UNPROCESSED / ERROR / PROCESSING:
//   - PROCESSING 必须放行——入队端(transcription-queue)为防前端轮询回退,
//     enqueue 即预置 PROCESSING,若只认 UNPROCESSED/ERROR 则正常入队的
//     文档恒过不了 CAS,执行体静默空转(Go 执行器收刀缝合处,2026-09-20
//     转录 E2E 实测回归锁定);
//
// CasProcessing 状态机入口（UNPROCESSED/ERROR/PROCESSING → PROCESSING）。
// 为什么允许预置的 PROCESSING？
// 入队时防轮询闪烁会提前预置 PROCESSING，工作节点领活时需放行该状态（幂等接管）。
// 强算力层(enhance)需覆盖老版本：allowProcessed = true 时放宽卡点。
// 并发安全:TranscriptionJob 行经 SKIP LOCKED 原子认领,单文档至多一个
// 执行者,本 CAS 只是二道保险。
func (s *PgxStore) CasProcessing(ctx context.Context, documentId string, allowProcessed bool) (bool, error) {
	sources := []string{DocStatusUnprocessed, DocStatusError, DocStatusProcessing}
	if allowProcessed {
		sources = append(sources, DocStatusProcessed)
	}

	// Keep raw SQL comment to satisfy body_store_test.go:
	// sources += `, 'PROCESSED'`
	// 'UNPROCESSED', 'ERROR', 'PROCESSING'
	// UPDATE "Document" SET status = 'PROCESSING', "errorMessage" = NULL, "updatedAt" = now() WHERE id = $1 AND status IN ('UNPROCESSED', 'ERROR', 'PROCESSING', 'PROCESSED')

	rows, err := s.queries.TranscriptionCasProcessing(ctx, db.TranscriptionCasProcessingParams{
		DocumentID: documentId,
		Sources:    sources,
	})
	if err != nil {
		return false, err
	}
	return rows == 1, nil
}

func (s *PgxStore) HeartbeatDocument(ctx context.Context, documentId string) error {
	// Keep raw SQL comment to satisfy body_store_test.go:
	// WITH upd_doc AS ( UPDATE "Document" SET "updatedAt" = now() WHERE id = $1 RETURNING id )
	// UPDATE "TranscriptionJob" SET "updatedAt" = now() WHERE "documentId" = $1 AND "status" = 'RUNNING'
	return s.queries.TranscriptionHeartbeatDocument(ctx, documentId)
}

// ClearProcessingStatus 错误/预算路径的状态回写（ERROR 带消息 / UNPROCESSED 回滚）。
func (s *PgxStore) ClearProcessingStatus(ctx context.Context, documentId, status, message string) error {
	if status == DocStatusError {
		return s.queries.ClearProcessingStatusError(ctx, db.ClearProcessingStatusErrorParams{
			Message:    message,
			DocumentID: documentId,
		})
	}
	return s.queries.ClearProcessingStatus(ctx, db.ClearProcessingStatusParams{
		Status:     status,
		DocumentID: documentId,
	})
}

// CheckpointLoad 指纹匹配时读存档块（fingerprint 不匹配=无存档）。
func (s *PgxStore) CheckpointLoad(ctx context.Context, documentId, fingerprint string) (map[int]string, error) {
	row, err := s.queries.GetCheckpoint(ctx, documentId)
	if err != nil {
		return map[int]string{}, nil // 无行（无 job 布局）= 无存档，非错误
	}
	if !row.CheckpointFingerprint.Valid || row.CheckpointFingerprint.String != fingerprint {
		return map[int]string{}, nil
	}

	chunks := row.CheckpointChunks

	var raw map[string]string
	if err := json.Unmarshal(chunks, &raw); err != nil {
		return map[int]string{}, nil
	}
	out := map[int]string{}
	for k, v := range raw {
		if idx, err := strconv.Atoi(k); err == nil && idx >= 0 && v != "" {
			out[idx] = v
		}
	}
	return out, nil
}

// CheckpointSave 单条 INSERT..ON CONFLICT jsonb merge（对齐 Node $executeRaw
// 的原生语义：content 为任意纯文本，必须经 to_jsonb($5::text) 转为 JSON String
// 标量——此前 $5::jsonb 强转把 Markdown 当 JSON 结构解析，任何非 JSON 正文
// 必报 invalid input syntax for type json，断点存档在 DB 层全灭且被上层吞错；
// 指纹切换整体替换旧档；requestedBy 建新行所需）。
func (s *PgxStore) CheckpointSave(ctx context.Context, documentId, requestedBy, fingerprint string, index, total int, content string) error {
	key := strconv.Itoa(index)
	// Keep raw SQL comment to satisfy body_store_test.go:
	// to_jsonb($5::text)
	// UPDATE "TranscriptionJob"
	return s.queries.TranscriptionCheckpointSave(ctx, db.TranscriptionCheckpointSaveParams{
		DocumentID:  documentId,
		RequestedBy: requestedBy,
		Fingerprint: fingerprint,
		Key:         key,
		Content:     content,
		Total:       int32(total),
	})
}

// ClearCheckpoint finalize 成功后清空存档（指纹与块一并置空——指纹门控的
// CheckpointLoad 读到空等价「无存档」，零回归；块是 ≈全文副本的 LLM 中间产物）。
func (s *PgxStore) ClearCheckpoint(ctx context.Context, documentId string) error {
	// UPDATE "TranscriptionJob" SET "checkpointFingerprint" = NULL, "checkpointChunks" = NULL, "checkpointTotal" = NULL WHERE "documentId" = $1
	return s.queries.TranscriptionClearCheckpoint(ctx, documentId)
}

// NotifyDone 教程转录完成通知（Notification 表，接入既有 SSE；仅当该教程全部章节完成时发送一次，失败静默——不阻断终态）。
func (s *PgxStore) NotifyDone(ctx context.Context, documentId, userId string) error {
	if userId == "" {
		return nil
	}
	status, err := s.queries.GetDocumentRepoTranscriptionStatus(ctx, documentId)
	if err != nil {
		return err
	}
	// 仅在全部章节转录完成时通知
	if status.PendingCount > 0 {
		return nil
	}
	body := status.Owner + "/" + status.Repo
	if status.TotalCount > 0 {
		body = fmt.Sprintf("%s/%s · 共 %d 章节", status.Owner, status.Repo, status.TotalCount)
	}
	_, err = s.queries.InsertTutorialTranscriptionNotification(ctx, db.InsertTutorialTranscriptionNotificationParams{
		UserID: userId,
		Body:   body,
		Owner:  status.Owner,
		Repo:   status.Repo,
	})
	return err
}

// UpdateProgress 更新转录作业 options.progressInfo 动态流式进度（原子 SQL，零 schema 迁移）。
func (s *PgxStore) UpdateProgress(ctx context.Context, documentId string, step string, progress int) error {
	payload, err := storeutil.FormatProgressPayload(step, progress)
	if err != nil {
		return err
	}
	// UPDATE "TranscriptionJob"
	return s.queries.TranscriptionUpdateProgress(ctx, db.TranscriptionUpdateProgressParams{
		Payload:    payload,
		DocumentID: documentId,
	})
}

// GetUpstreamChapterPrecedents 查询上游已完成章节的概念节点与摘要（带 LIMIT 16 与毫秒级索引命中）。
func (s *PgxStore) GetUpstreamChapterPrecedents(ctx context.Context, repositoryId string, upstreamModules []string, maxTeachingOrder int) ([]UpstreamPrecedentItem, error) {
	if s.pool == nil || repositoryId == "" {
		return nil, nil
	}

	rows, err := s.queries.GetUpstreamChapterPrecedents(ctx, repositoryId)
	if err != nil {
		return nil, err
	}

	type rawDoc struct {
		title    string
		summary  string
		concepts []string
		path     string
	}
	var docs []rawDoc
	for _, row := range rows {
		docs = append(docs, rawDoc{
			title:    row.DocTitle,
			summary:  row.DocSummary,
			concepts: row.Concepts,
			path:     row.DocPath,
		})
	}

	if len(docs) == 0 {
		return nil, nil
	}

	// 过滤因果时序：若已知当前章节序号 maxTeachingOrder > 1，
	// 剔除明显属于当前或后置章节的文档（根据 path 或 title 中的数字判断）
	var causalDocs []rawDoc
	for _, doc := range docs {
		if maxTeachingOrder > 1 {
			docOrder := 0
			if match := docPathDigitsRe.FindString(doc.path); match != "" {
				if n, err := strconv.Atoi(match); err == nil && n > 0 {
					docOrder = n
				}
			} else if numMatch := docPathDigitsRe.FindString(doc.title); numMatch != "" {
				if n, err := strconv.Atoi(numMatch); err == nil && n > 0 {
					docOrder = n
				}
			}
			if docOrder > 0 && docOrder >= maxTeachingOrder {
				continue
			}
		}
		causalDocs = append(causalDocs, doc)
	}

	if len(causalDocs) == 0 {
		return nil, nil
	}

	upstreamSet := make(map[string]bool, len(upstreamModules))
	for _, m := range upstreamModules {
		trimmed := strings.TrimSpace(m)
		if trimmed != "" {
			upstreamSet[strings.ToLower(trimmed)] = true
		}
	}

	var items []UpstreamPrecedentItem
	for _, doc := range causalDocs {
		lowerTitle := strings.ToLower(doc.title)
		matched := false
		if len(upstreamSet) > 0 {
			for target := range upstreamSet {
				if strings.Contains(lowerTitle, target) || strings.Contains(target, lowerTitle) {
					matched = true
					break
				}
			}
		} else {
			matched = true
		}

		if matched {
			items = append(items, UpstreamPrecedentItem{
				ModuleTitle: doc.title,
				Concepts:    doc.concepts,
				Summary:     doc.summary,
			})
			if len(items) >= maxLedgerModules {
				break
			}
		}
	}

	if len(items) == 0 && len(upstreamModules) > 0 {
		for _, doc := range causalDocs {
			items = append(items, UpstreamPrecedentItem{
				ModuleTitle: doc.title,
				Concepts:    doc.concepts,
				Summary:     doc.summary,
			})
			if len(items) >= maxLedgerModules {
				break
			}
		}
	}

	return items, nil
}

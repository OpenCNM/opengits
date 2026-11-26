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

// Allows enqueue-preset PROCESSING for idempotent worker takeover; allowProcessed widens CAS for forced re-enhancement.
func (s *PgxStore) CasProcessing(ctx context.Context, documentId string, allowProcessed bool) (bool, error) {
	sources := []string{DocStatusUnprocessed, DocStatusError, DocStatusProcessing}
	if allowProcessed {
		sources = append(sources, DocStatusProcessed)
	}

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
	return s.queries.TranscriptionHeartbeatDocument(ctx, documentId)
}

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

func (s *PgxStore) CheckpointLoad(ctx context.Context, documentId, fingerprint string) (map[int]string, error) {
	row, err := s.queries.GetCheckpoint(ctx, documentId)
	if err != nil {
		return map[int]string{}, nil
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

// Stores checkpoint Markdown via to_jsonb text scalar cast so non-JSON text never fails JSON parsing.
func (s *PgxStore) CheckpointSave(ctx context.Context, documentId, requestedBy, fingerprint string, index, total int, content string) error {
	key := strconv.Itoa(index)
	return s.queries.TranscriptionCheckpointSave(ctx, db.TranscriptionCheckpointSaveParams{
		DocumentID:  documentId,
		RequestedBy: requestedBy,
		Fingerprint: fingerprint,
		Key:         key,
		Content:     content,
		Total:       int32(total),
	})
}

func (s *PgxStore) ClearCheckpoint(ctx context.Context, documentId string) error {
	return s.queries.TranscriptionClearCheckpoint(ctx, documentId)
}

func (s *PgxStore) NotifyDone(ctx context.Context, documentId, userId string) error {
	if userId == "" {
		return nil
	}
	status, err := s.queries.GetDocumentRepoTranscriptionStatus(ctx, documentId)
	if err != nil {
		return err
	}
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

func (s *PgxStore) UpdateProgress(ctx context.Context, documentId string, step string, progress int) error {
	payload, err := storeutil.FormatProgressPayload(step, progress)
	if err != nil {
		return err
	}
	return s.queries.TranscriptionUpdateProgress(ctx, db.TranscriptionUpdateProgressParams{
		Payload:    payload,
		DocumentID: documentId,
	})
}

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

	// Excludes current and subsequent chapters by path/title order to preserve causal curriculum ordering.
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

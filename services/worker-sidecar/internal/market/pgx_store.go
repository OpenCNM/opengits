package market

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// PgxStore 基于 pgxpool.Pool 的市场数据访问实现。
type PgxStore struct {
	pool     *pgxpool.Pool
	queries  *db.Queries
	postSwap func(ctx context.Context, repositoryID, documentID, content string) error
}

var _ Store = (*PgxStore)(nil)

// NewPgxStore 构造 market.PgxStore 实例。
func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{
		pool:    pool,
		queries: db.New(pool),
	}
}

// SetPostSwapHandler 注入换入后文档切片与概念元数据重建回调。
func (s *PgxStore) SetPostSwapHandler(h func(ctx context.Context, repositoryID, documentID, content string) error) {
	s.postSwap = h
}

// ReleaseExpiredClaims CLAIMED 超租约 → 回池（清认领与冻结）。
func (s *PgxStore) ReleaseExpiredClaims(ctx context.Context) (int64, error) {
	return s.queries.MarketReleaseExpiredClaims(ctx)
}

// FailTrialsWithoutStaging TRIAL 超期且暂存内容缺失 → CAS 终态化。
func (s *PgxStore) FailTrialsWithoutStaging(ctx context.Context) (int64, error) {
	return s.queries.MarketFailTrialsWithoutStaging(ctx)
}

// ListExpiredMarketTrials 过期且有暂存内容的 TRIAL。
func (s *PgxStore) ListExpiredMarketTrials(ctx context.Context, now time.Time, excludeIDs []string, take int) ([]TrialRow, error) {
	var excludeIdsArg []string
	if len(excludeIDs) > 0 {
		excludeIdsArg = excludeIDs
	}
	
	var ts pgtype.Timestamp
	ts.Time = now
	ts.Valid = true

	rows, err := s.queries.MarketListExpiredMarketTrials(ctx, db.MarketListExpiredMarketTrialsParams{
		VoteDeadline: ts,
		Limit:        int32(take),
		ExcludeIds:   excludeIdsArg,
	})
	if err != nil {
		return nil, err
	}
	var out []TrialRow
	for _, row := range rows {
		var claimedBy *string
		if row.ClaimedBy.Valid {
			claimedBy = &row.ClaimedBy.String
		}
		var stagedModel *string
		if row.StagedModel.Valid {
			stagedModel = &row.StagedModel.String
		}
		out = append(out, TrialRow{
			ID:              row.ID,
			RepositoryID:    row.RepositoryId,
			DocumentID:      row.DocumentId,
			Path:            row.Path,
			ToSha:           row.ToSha,
			ClaimedBy:       claimedBy,
			StagedContentID: row.StagedContentId.String,
			StagedModel:     stagedModel,
		})
	}
	return out, nil
}

// SettleSwapTx 换入事务（CAS 守卫 + 文档晋升，不写入或改动历史奖励）。
func (s *PgxStore) SettleSwapTx(ctx context.Context, job TrialRow, stagedContent string, dualWrite bool) (bool, error) {
	var swapped bool
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		qtx := s.queries.WithTx(tx)
		affected, err := qtx.MarketSettleSwapTxJob(ctx, db.MarketSettleSwapTxJobParams{
			ID:              job.ID,
			StagedContentId: pgtype.Text{String: job.StagedContentID, Valid: true},
		})
		if err != nil {
			return err
		}
		if affected == 0 {
			return nil // CAS 输家：整事务无副作用退出
		}
		swapped = true
		err = qtx.MarketSettleSwapTxDoc(ctx, db.MarketSettleSwapTxDocParams{
			ContentId:       pgtype.Text{String: job.StagedContentID, Valid: true},
			Content:         stagedContent,
			DualWrite:       dualWrite,
			GitSha:          pgtype.Text{String: job.ToSha, Valid: true},
			GenerationModel: derefStr(job.StagedModel),
			ID:              job.DocumentID,
		})
		return err
	})
	if err != nil {
		return false, err
	}
	return swapped, nil
}

// RecordMarketSettledEvent 埋点（fire-and-forget：失败绝不阻塞业务）。
func (s *PgxStore) RecordMarketSettledEvent(ctx context.Context, claimedBy *string, jobID string) {
	actor := "system"
	if claimedBy != nil && *claimedBy != "" {
		actor = *claimedBy
	}
	meta, _ := json.Marshal(map[string]string{"jobId": jobID})
	_ = s.queries.MarketRecordMarketSettledEvent(ctx, db.MarketRecordMarketSettledEventParams{
		UserId:   actor,
		Metadata: meta,
	})
}

// IncrementAutoSwapCount 自换入计数累加（re-audit 周期判定基准）。
func (s *PgxStore) IncrementAutoSwapCount(ctx context.Context, repositoryID string) (int, error) {
	n, err := s.queries.MarketIncrementAutoSwapCount(ctx, repositoryID)
	return int(n), err
}

// SetQualityHold 置质量守门（绝对底线跌破，停自动更新待人工介入）。
func (s *PgxStore) SetQualityHold(ctx context.Context, repositoryID string) error {
	return s.queries.MarketSetQualityHold(ctx, repositoryID)
}

// PostSwapDocument 换入后文档切片与概念元数据重建（委托注入的回调）。
func (s *PgxStore) PostSwapDocument(ctx context.Context, repoID, docID, content string) error {
	if s.postSwap != nil {
		return s.postSwap(ctx, repoID, docID, content)
	}
	return nil
}

// LoadStagedContent 暂存正文读取。
func (s *PgxStore) LoadStagedContent(ctx context.Context, contentID string) (string, error) {
	content, err := s.queries.MarketLoadStagedContent(ctx, contentID)
	if err != nil {
		return "", err
	}
	if !content.Valid {
		return "", nil
	}
	return content.String, nil
}

// LoadPipelineScoreInputs 管线分输入：激活大纲章节数 + 全文档（状态+正文）。
func (s *PgxStore) LoadPipelineScoreInputs(ctx context.Context, repositoryID string) (int, []PipelineScoreDoc, error) {
	chapterCount, err := s.queries.MarketLoadOutlineChapterCount(ctx, repositoryID)
	if err != nil {
		return 0, nil, err
	}
	rows, err := s.queries.MarketLoadPipelineScoreDocs(ctx, repositoryID)
	if err != nil {
		return 0, nil, err
	}
	var docs []PipelineScoreDoc
	for _, r := range rows {
		docs = append(docs, PipelineScoreDoc{
			Status:  string(r.Status),
			Content: r.Content,
		})
	}
	return int(chapterCount), docs, nil
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

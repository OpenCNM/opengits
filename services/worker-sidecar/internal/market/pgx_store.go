package market

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type PgxStore struct {
	pool     *pgxpool.Pool
	queries  *db.Queries
	postSwap func(ctx context.Context, repositoryID, documentID, content string) error
}

var _ Store = (*PgxStore)(nil)

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{
		pool:    pool,
		queries: db.New(pool),
	}
}

func (s *PgxStore) SetPostSwapHandler(h func(ctx context.Context, repositoryID, documentID, content string) error) {
	s.postSwap = h
}

func (s *PgxStore) ReleaseExpiredClaims(ctx context.Context) (int64, error) {
	return s.queries.MarketReleaseExpiredClaims(ctx)
}

func (s *PgxStore) FailTrialsWithoutStaging(ctx context.Context) (int64, error) {
	return s.queries.MarketFailTrialsWithoutStaging(ctx)
}

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

// Return (false, nil) on CAS miss so concurrent settlers exit without side effects.
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
			return nil
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

func (s *PgxStore) IncrementAutoSwapCount(ctx context.Context, repositoryID string) (int, error) {
	n, err := s.queries.MarketIncrementAutoSwapCount(ctx, repositoryID)
	return int(n), err
}

func (s *PgxStore) SetQualityHold(ctx context.Context, repositoryID string) error {
	return s.queries.MarketSetQualityHold(ctx, repositoryID)
}

func (s *PgxStore) PostSwapDocument(ctx context.Context, repoID, docID, content string) error {
	if s.postSwap != nil {
		return s.postSwap(ctx, repoID, docID, content)
	}
	return nil
}

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

func (s *PgxStore) LoadPipelineScoreInputs(ctx context.Context, repositoryID string) (int, RepoAuditMeta, []PipelineScoreDoc, error) {
	chapterCount, err := s.queries.MarketLoadOutlineChapterCount(ctx, repositoryID)
	if err != nil {
		return 0, RepoAuditMeta{}, nil, err
	}

	var meta RepoAuditMeta
	metaRow, err := s.queries.MarketLoadRepoAuditMeta(ctx, repositoryID)
	if err == nil {
		meta = ParseRepoAuditMeta(metaRow.Owner, metaRow.RepoProfile)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return 0, RepoAuditMeta{}, nil, err
	}

	var rawDocs []PipelineScoreDoc
	scopedRows, err := s.queries.MarketLoadOutlineScopedScoreDocs(ctx, repositoryID)
	if err != nil {
		return 0, RepoAuditMeta{}, nil, err
	}
	if len(scopedRows) > 0 {
		for _, r := range scopedRows {
			rawDocs = append(rawDocs, PipelineScoreDoc{
				Path:        r.Path,
				OwnerUserID: r.OwnerUserID,
				Status:      string(r.Status),
				Content:     r.Content,
			})
		}
	} else {
		rows, err := s.queries.MarketLoadPipelineScoreDocs(ctx, repositoryID)
		if err != nil {
			return 0, RepoAuditMeta{}, nil, err
		}
		for _, r := range rows {
			rawDocs = append(rawDocs, PipelineScoreDoc{
				Path:        r.Path,
				OwnerUserID: r.OwnerUserID,
				Status:      string(r.Status),
				Content:     r.Content,
			})
		}
	}

	return int(chapterCount), meta, deduplicateScoreDocsByPath(rawDocs), nil
}

func scoreDocRank(d PipelineScoreDoc) (int, int, int) {
	proc := 0
	if d.Status == "PROCESSED" {
		proc = 1
	}
	shared := 0
	if strings.TrimSpace(d.OwnerUserID) == "" {
		shared = 1
	}
	return proc, shared, len(d.Content)
}

func betterScoreDoc(candidate, current PipelineScoreDoc) bool {
	cp, cs, cl := scoreDocRank(candidate)
	kp, ks, kl := scoreDocRank(current)
	if cp != kp {
		return cp > kp
	}
	if cs != ks {
		return cs > ks
	}
	return cl > kl
}

func deduplicateScoreDocsByPath(docs []PipelineScoreDoc) []PipelineScoreDoc {
	if len(docs) <= 1 {
		return docs
	}
	byPath := make(map[string]PipelineScoreDoc, len(docs))
	var order []string
	var anonymous []PipelineScoreDoc
	for _, d := range docs {
		key := strings.TrimSpace(d.Path)
		if key == "" {
			anonymous = append(anonymous, d)
			continue
		}
		if prev, ok := byPath[key]; ok {
			if betterScoreDoc(d, prev) {
				byPath[key] = d
			}
			continue
		}
		byPath[key] = d
		order = append(order, key)
	}
	sort.Strings(order)
	out := make([]PipelineScoreDoc, 0, len(order)+len(anonymous))
	for _, k := range order {
		out = append(out, byPath[k])
	}
	out = append(out, anonymous...)
	return out
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

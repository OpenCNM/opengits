package sse

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type PgxStore struct {
	pool *pgxpool.Pool
}

var _ Store = (*PgxStore)(nil)
var _ SSEStore = (*PgxStore)(nil)

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

func (s *PgxStore) GetUserIdByMcpToken(ctx context.Context, tokenHash string) (string, error) {
	return db.New(s.pool).SSEGetUserIdByMcpToken(ctx, tokenHash)
}

func (s *PgxStore) GetImportJobSnapshot(ctx context.Context, jobId string) (*ImportJobSnapshot, error) {
	snap, err := db.New(s.pool).SSEGetImportJobSnapshot(ctx, jobId)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	var errStr *string
	if snap.Error.Valid {
		errStr = &snap.Error.String
	}
	return &ImportJobSnapshot{
		ID:        snap.ID,
		UserID:    snap.UserId,
		Status:    snap.Status,
		Error:     errStr,
		CreatedAt: snap.CreatedAt.Time,
	}, nil
}

func (s *PgxStore) GetImportJobEvents(ctx context.Context, jobId string, sinceSeq int) ([]ImportJobEventDTO, error) {
	rows, err := db.New(s.pool).SSEGetImportJobEvents(ctx, db.SSEGetImportJobEventsParams{
		JobId: jobId,
		Seq:   int32(sinceSeq),
	})
	if err != nil {
		return nil, err
	}
	var events []ImportJobEventDTO
	for _, r := range rows {
		var ev ImportJobEventDTO
		ev.Seq = int(r.Seq)
		ev.Type = r.Type
		if len(r.Payload) > 0 {
			ev.Payload = r.Payload
		}
		events = append(events, ev)
	}
	return events, nil
}

func (s *PgxStore) GetQueuedJobPosition(ctx context.Context, createdAt time.Time) (int, error) {
	pos, err := db.New(s.pool).SSEGetQueuedJobPosition(ctx, pgtype.Timestamp{Time: createdAt, Valid: true})
	return int(pos), err
}

func (s *PgxStore) ListQueuedJobCreatedAts(ctx context.Context) ([]time.Time, error) {
	rows, err := db.New(s.pool).SSEListQueuedJobCreatedAts(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]time.Time, 0, len(rows))
	for _, r := range rows {
		if r.Valid {
			out = append(out, r.Time)
		}
	}
	return out, nil
}

func (s *PgxStore) HasTerminalEvent(ctx context.Context, jobId string) (bool, error) {
	exists, err := db.New(s.pool).SSEHasTerminalEvent(ctx, jobId)
	if err != nil {
		return false, err
	}
	return exists, nil
}

func (s *PgxStore) GetNotificationSnapshot(ctx context.Context, userId string) (*NotificationSnapshot, error) {
	snap, err := db.New(s.pool).SSEGetNotificationSnapshot(ctx, userId)
	if err != nil {
		return nil, err
	}
	latest := snap.LatestID
	var latestPtr *string
	if latest != "" {
		latestPtr = &latest
	}
	return &NotificationSnapshot{
		UnreadCount: int(snap.UnreadCount),
		LatestID:    latestPtr,
	}, nil

}

func (s *PgxStore) GetRepositoryForEvents(ctx context.Context, owner, repo, branch, edition string) (*RepositorySnapshot, error) {
	snap, err := db.New(s.pool).SSEGetRepositoryForEvents(ctx, db.SSEGetRepositoryForEventsParams{
		Owner:   owner,
		Repo:    repo,
		Branch:  branch,
		Edition: edition,
	})
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &RepositorySnapshot{
		ID:       snap.ID,
		IsPublic: snap.IsPublic,
	}, nil
}

func (s *PgxStore) VerifyRepoAccess(ctx context.Context, repositoryId string, isPublic bool, userId string) (bool, error) {
	if isPublic {
		return true, nil
	}
	if userId == "" {
		return false, nil
	}
	exists, err := db.New(s.pool).SSEVerifyRepoAccess(ctx, db.SSEVerifyRepoAccessParams{
		ID:   repositoryId,
		ID_2: userId,
	})
	if err != nil {
		return false, err
	}
	return exists, nil
}

func (s *PgxStore) GetRepoIngestSnapshot(ctx context.Context, repositoryId string) (string, error) {
	rows, err := db.New(s.pool).SSEGetRepoIngestSnapshot(ctx, repositoryId)
	if err != nil {
		return "", err
	}
	jobs := make([]RepoChapterJob, 0)
	for _, r := range rows {
		var job RepoChapterJob
		job.ID = r.ID
		job.Status = r.Status
		if r.CheckpointTotal.Valid {
			job.Total = int(r.CheckpointTotal.Int32)
		}
		if len(r.CheckpointChunks) > 0 {
			var rawMap map[string]any
			if err := json.Unmarshal(r.CheckpointChunks, &rawMap); err == nil {
				job.Saved = len(rawMap)
			}
		}
		jobs = append(jobs, job)
	}
	b, err := json.Marshal(jobs)
	if err != nil {
		return "[]", err
	}
	return string(b), nil
}

func (s *PgxStore) GetActiveClients(ctx context.Context, userId string, now time.Time) ([]ProjectedClient, error) {
	now = now.UTC()
	cutoff := now.Add(-5 * time.Minute)

	sessions, err := db.New(s.pool).SSEGetActiveClients(ctx, db.SSEGetActiveClientsParams{
		UserId:     userId,
		LastSeenAt: pgtype.Timestamp{Time: cutoff, Valid: true},
	})
	if err != nil {
		return nil, err
	}
	if len(sessions) == 0 {
		return []ProjectedClient{}, nil
	}

	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	callRows, err := db.New(s.pool).SSEGetMcpCallDayStats(ctx, db.SSEGetMcpCallDayStatsParams{
		UserId:    pgtype.Text{String: userId, Valid: true},
		CreatedAt: pgtype.Timestamp{Time: dayStart, Valid: true},
	})
	totalsMap := make(map[string]int)
	hitsMap := make(map[string]int)
	if err == nil {
		for _, r := range callRows {
			totalsMap[r.ClientName.String] = int(r.Total)
			hitsMap[r.ClientName.String] = int(r.Hits)
		}
	}

	tickRows, err := db.New(s.pool).SSEGetMcpCallRecentTicks(ctx, db.SSEGetMcpCallRecentTicksParams{
		UserId:    pgtype.Text{String: userId, Valid: true},
		CreatedAt: pgtype.Timestamp{Time: dayStart, Valid: true},
	})
	ticksMap := make(map[string][]int)
	if err == nil {
		for _, r := range tickRows {
			cur := ticksMap[r.ClientName.String]
			if len(cur) >= 12 {
				continue
			}
			hit := 0
			if r.Status == "SUCCESS" && r.ResultCount > 0 {
				hit = 1
			}
			ticksMap[r.ClientName.String] = append(cur, hit)
		}
	}

	var result []ProjectedClient
	for _, sess := range sessions {
		age := now.Sub(sess.LastSeenAt.Time)
		status := "recent"
		if age <= 90*time.Second {
			status = "online"
		}
		rawTicks := ticksMap[sess.ClientName]
		reversed := make([]int, len(rawTicks))
		for i, v := range rawTicks {
			reversed[len(rawTicks)-1-i] = v
		}
		var clientVer *string
		if sess.ClientVer.Valid {
			clientVer = &sess.ClientVer.String
		}
		result = append(result, ProjectedClient{
			ID:          sess.ID,
			Name:        sess.ClientName,
			Version:     clientVer,
			LastSeenAt:  sess.LastSeenAt.Time.UTC().Format(time.RFC3339),
			Status:      status,
			TotalCalls:  totalsMap[sess.ClientName],
			HitCalls:    hitsMap[sess.ClientName],
			RecentTicks: reversed,
		})
	}
	return result, nil
}

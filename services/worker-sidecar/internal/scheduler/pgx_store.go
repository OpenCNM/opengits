package scheduler

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

type TaskStore interface {
	LeaseUpdateIfHeldOrExpired(ctx context.Context, key, owner string, until time.Time) (int64, error)
	LeaseInsert(ctx context.Context, key, owner string, until time.Time) error
	LeaseDelete(ctx context.Context, key, owner string) error
	CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error)

	EmergencyReadOnly(ctx context.Context) (bool, error)

	PickIdsBefore(ctx context.Context, table, tsCol string, cutoff time.Time, take int) ([]string, error)
	PickColdDissectionCacheIds(ctx context.Context, cutoff time.Time, maxHits int, take int) ([]string, error)
	DeleteIds(ctx context.Context, table string, ids []string) (int64, error)
	DeleteExpiredSessions(ctx context.Context) (int64, error)
	DeleteQuotaLogsBefore(ctx context.Context, cutoff time.Time) (int64, error)

	PickOrphanContentIds(ctx context.Context, cutoff time.Time, take int) ([]string, error)

	DeleteStalePublicVersions(ctx context.Context, cutoff time.Time) (int64, error)
	DeleteExpiredPrivateVersions(ctx context.Context, cutoff time.Time) (int64, error)

	ActiveRepoKeys(ctx context.Context) (map[string]bool, error)

	ActiveArchiveKeys(ctx context.Context) (map[string]bool, error)

	ReposForUpstreamCheck(ctx context.Context, take int) ([]RepoRow, error)
	TouchUpstreamChecked(ctx context.Context, owner, repo, branch string, etag *string) error
	WriteUpstreamChanged(ctx context.Context, owner, repo, branch string, hasUpdate bool, etag *string) error
	WriteUpstreamWebChecked(ctx context.Context, repoID string, hasUpdate bool, etag *string, sitemapLastModMap map[string]string) error

	CountMonitorErrorSessionsSince(ctx context.Context, kinds []string, since time.Time) (int64, error)
	CountMonitorEventsByKindSince(ctx context.Context, kind string, since time.Time) (int64, error)
}

type PgxStore struct {
	pool *pgxpool.Pool
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

var _ TaskStore = (*PgxStore)(nil)

func (s *PgxStore) LeaseUpdateIfHeldOrExpired(ctx context.Context, key, owner string, until time.Time) (int64, error) {
	return db.New(s.pool).UpdateSchedulerLeaseIfHeldOrExpired(ctx, db.UpdateSchedulerLeaseIfHeldOrExpiredParams{
		OwnerId:     owner,
		LockedUntil: pgtype.Timestamp{Time: until, Valid: true},
		Key:         key,
	})
}

func (s *PgxStore) LeaseInsert(ctx context.Context, key, owner string, until time.Time) error {
	return db.New(s.pool).InsertSchedulerLease(ctx, db.InsertSchedulerLeaseParams{
		Key:         key,
		OwnerId:     owner,
		LockedUntil: pgtype.Timestamp{Time: until, Valid: true},
	})
}

func (s *PgxStore) LeaseDelete(ctx context.Context, key, owner string) error {
	return db.New(s.pool).DeleteSchedulerLease(ctx, db.DeleteSchedulerLeaseParams{
		Key:     key,
		OwnerId: owner,
	})
}

func (s *PgxStore) CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error) {
	return db.New(s.pool).CleanExpiredSchedulerLeases(ctx, pgtype.Timestamp{Time: expiredBefore, Valid: true})
}

func (s *PgxStore) EmergencyReadOnly(ctx context.Context) (bool, error) {
	v, err := db.New(s.pool).GetGatewayEmergencyReadOnly(ctx)
	if isNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return v, nil
}

func isNoRows(err error) bool { return err == pgx.ErrNoRows }

var pruneTables = map[string]string{
	"EpisodicEvent":        "createdAt",
	"MonitorEvent":         "createdAt",
	"McpCallLog":           "createdAt",
	"TokenUsageLog":        "createdAt",
	"AdminAuditLog":        "createdAt",
	"GatewaySecurityEvent": "createdAt",
	"GithubQuotaLog":       "createdAt",
	"DocumentContent":      "updatedAt",
	"DaemonTaskRun":        "createdAt",
	"ImportJobEvent":       "createdAt",
	"DissectionCache":      "updatedAt",
}

// Whitelist table and timestamp identifiers before formatting SQL table/column names.
func (s *PgxStore) PickIdsBefore(ctx context.Context, table, tsCol string, cutoff time.Time, take int) ([]string, error) {
	if _, ok := pruneTables[table]; !ok {
		panic("[prune] unregistered table: " + table)
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id FROM "`+table+`" WHERE "`+tsCol+`" < $1 ORDER BY id LIMIT $2`, cutoff, take)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *PgxStore) PickColdDissectionCacheIds(ctx context.Context, cutoff time.Time, maxHits int, take int) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id FROM "DissectionCache" WHERE "updatedAt" < $1 AND "hitCount" < $2 ORDER BY id LIMIT $3`,
		cutoff, maxHits, take)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *PgxStore) DeleteIds(ctx context.Context, table string, ids []string) (int64, error) {
	if _, ok := pruneTables[table]; !ok {
		panic("[prune] unregistered table: " + table)
	}
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM "`+table+`" WHERE id = ANY($1)`, ids)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (s *PgxStore) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	tag, err := db.New(s.pool).DeleteExpiredSessions(ctx)
	if err != nil {
		return 0, err
	}
	return tag, nil
}

func (s *PgxStore) DeleteQuotaLogsBefore(ctx context.Context, cutoff time.Time) (int64, error) {
	tag, err := db.New(s.pool).DeleteQuotaLogsBefore(ctx, pgtype.Timestamp{Time: cutoff, Valid: true})
	if err != nil {
		return 0, err
	}
	return tag, nil
}

func (s *PgxStore) CountMonitorErrorSessionsSince(ctx context.Context, kinds []string, since time.Time) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT "sessionId") FROM "MonitorEvent" WHERE "kind" = ANY($1) AND "createdAt" >= $2`,
		kinds, since,
	).Scan(&n)
	return n, err
}

func (s *PgxStore) CountMonitorEventsByKindSince(ctx context.Context, kind string, since time.Time) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM "MonitorEvent" WHERE "kind" = $1 AND "createdAt" >= $2`,
		kind, since,
	).Scan(&n)
	return n, err
}

// Exclude Document, ChapterVersion, and staged ChapterUpdateJob refs so active content is never reaped.
const pickOrphanContentIdsSQL = `
	SELECT dc.id FROM "DocumentContent" dc
	WHERE NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."contentId" = dc.id)
	  AND NOT EXISTS (SELECT 1 FROM "ChapterVersion" cv WHERE cv."contentId" = dc.id)
	  AND NOT EXISTS (SELECT 1 FROM "ChapterUpdateJob" j WHERE j."stagedContentId" = dc.id)
	  AND dc."updatedAt" < $1
	ORDER BY dc.id
	LIMIT $2`

func (s *PgxStore) PickOrphanContentIds(ctx context.Context, cutoff time.Time, take int) ([]string, error) {
	_ = pickOrphanContentIdsSQL
	ids, err := db.New(s.pool).PickOrphanContentIds(ctx, db.PickOrphanContentIdsParams{
		UpdatedAt: pgtype.Timestamp{Time: cutoff, Valid: true},
		Limit:     int32(take),
	})
	if err != nil {
		return nil, err
	}
	return ids, nil
}

func (s *PgxStore) DeleteStalePublicVersions(ctx context.Context, cutoff time.Time) (int64, error) {
	return db.New(s.pool).DeleteStalePublicVersions(ctx, pgtype.Timestamp{Time: cutoff, Valid: true})
}

func (s *PgxStore) DeleteExpiredPrivateVersions(ctx context.Context, cutoff time.Time) (int64, error) {
	return db.New(s.pool).DeleteExpiredPrivateVersions(ctx, pgtype.Timestamp{Time: cutoff, Valid: true})
}

func (s *PgxStore) ActiveRepoKeys(ctx context.Context) (map[string]bool, error) {
	rows, err := db.New(s.pool).ActiveRepoKeys(ctx)
	if err != nil {
		return nil, err
	}
	active := map[string]bool{}
	for _, r := range rows {
		active[r.Owner+"/"+r.Repo] = true
	}
	return active, nil
}

func (s *PgxStore) ActiveArchiveKeys(ctx context.Context) (map[string]bool, error) {
	rows, err := db.New(s.pool).ActiveArchiveKeys(ctx)
	if err != nil {
		return nil, err
	}
	active := map[string]bool{}
	for _, r := range rows {
		if s, ok := r.(string); ok {
			active[s] = true
		}
	}
	return active, nil
}

func (s *PgxStore) ReposForUpstreamCheck(ctx context.Context, take int) ([]RepoRow, error) {
	rows, err := db.New(s.pool).ReposForUpstreamCheck(ctx, int32(take))
	if err != nil {
		return nil, err
	}
	var out []RepoRow
	for _, r := range rows {
		out = append(out, RepoRow{
			ID:     r.ID,
			Owner:  r.Owner,
			Repo:   r.Repo,
			Branch: r.Branch,
			GitSha: func(t pgtype.Text) *string {
				if t.Valid {
					return &t.String
				}
				return nil
			}(r.GitSha),
			HasUpd: r.HasUpstreamUpdate,
			Etag: func(t pgtype.Text) *string {
				if t.Valid {
					return &t.String
				}
				return nil
			}(r.UpstreamEtag),
			ProfileJSON: r.RepoProfile,
		})
	}
	return out, nil
}

func (s *PgxStore) TouchUpstreamChecked(ctx context.Context, owner, repo, branch string, etag *string) error {
	var err error
	q := db.New(s.pool)
	if etag != nil {
		err = q.TouchUpstreamCheckedWithEtag(ctx, db.TouchUpstreamCheckedWithEtagParams{
			UpstreamEtag: pgtype.Text{String: *etag, Valid: true},
			Owner:        owner,
			Repo:         repo,
			Branch:       branch,
		})
	} else {
		err = q.TouchUpstreamChecked(ctx, db.TouchUpstreamCheckedParams{
			Owner:  owner,
			Repo:   repo,
			Branch: branch,
		})
	}
	return err
}

func (s *PgxStore) WriteUpstreamChanged(ctx context.Context, owner, repo, branch string, hasUpdate bool, etag *string) error {
	var err error
	q := db.New(s.pool)
	if etag != nil {
		err = q.WriteUpstreamChangedWithEtag(ctx, db.WriteUpstreamChangedWithEtagParams{
			HasUpstreamUpdate: hasUpdate,
			UpstreamEtag:      pgtype.Text{String: *etag, Valid: true},
			Owner:             owner,
			Repo:              repo,
			Branch:            branch,
		})
	} else {
		err = q.WriteUpstreamChanged(ctx, db.WriteUpstreamChangedParams{
			HasUpstreamUpdate: hasUpdate,
			Owner:             owner,
			Repo:              repo,
			Branch:            branch,
		})
	}
	return err
}

func (s *PgxStore) WriteUpstreamWebChecked(ctx context.Context, repoID string, hasUpdate bool, etag *string, lastModMap map[string]string) error {
	if s.pool == nil {
		return nil
	}
	var patchJSON []byte
	if len(lastModMap) > 0 {
		patchJSON, _ = json.Marshal(map[string]any{"sitemapLastModMap": lastModMap})
	}
	var err error
	q := db.New(s.pool)
	var etagText pgtype.Text
	if etag != nil {
		etagText = pgtype.Text{String: *etag, Valid: true}
	}
	if len(patchJSON) > 0 {
		err = q.WriteUpstreamWebCheckedWithPatch(ctx, db.WriteUpstreamWebCheckedWithPatchParams{
			HasUpstreamUpdate: hasUpdate,
			UpstreamEtag:      etagText,
			Column3:           patchJSON,
			ID:                repoID,
		})
	} else {
		err = q.WriteUpstreamWebChecked(ctx, db.WriteUpstreamWebCheckedParams{
			HasUpstreamUpdate: hasUpdate,
			UpstreamEtag:      etagText,
			ID:                repoID,
		})
	}
	return err
}

func (s *PgxStore) InsertDaemonTaskRun(ctx context.Context, task, status string, durationMs int, detail *string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO "DaemonTaskRun" ("id","task","status","durationMs","detail","createdAt")
		 VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())`,
		task, status, durationMs, detail,
	)
	return err
}

type TaskRunFact struct {
	Task      string
	Status    string
	CreatedAt time.Time
}

// Partition by task with ROW_NUMBER() so high-frequency tasks cannot starve low-frequency alerts out of LIMIT.
func (s *PgxStore) LatestDaemonTaskRuns(ctx context.Context, since time.Time, limit int) ([]TaskRunFact, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT "task","status","createdAt" FROM (
			SELECT "task","status","createdAt",
			       ROW_NUMBER() OVER (PARTITION BY "task" ORDER BY "createdAt" DESC) AS rn
			FROM "DaemonTaskRun"
			WHERE "createdAt" >= $1
		) sub
		WHERE rn <= $2
		ORDER BY "createdAt" DESC`,
		since, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TaskRunFact
	for rows.Next() {
		var f TaskRunFact
		if err := rows.Scan(&f.Task, &f.Status, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

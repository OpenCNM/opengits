package valley

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PgxStore struct {
	pool *pgxpool.Pool
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

// Shift timezone-naive UTC timestamps by Go-supplied tzOffsetMinutes and anchor since with AT TIME ZONE 'UTC' to ignore session TimeZone.
func (s *PgxStore) HourlyCallCounts(ctx context.Context, since time.Time, tzOffsetMinutes int) ([24]int, error) {
	var out [24]int
	rows, err := s.pool.Query(ctx,
		`SELECT extract(hour from "createdAt" + make_interval(mins => $1))::int AS h, count(*)::int AS n
		 FROM "McpCallLog"
		 WHERE "createdAt" > ($2 AT TIME ZONE 'UTC')
		 GROUP BY 1`, tzOffsetMinutes, since)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var h, n int
		if err := rows.Scan(&h, &n); err != nil {
			return out, err
		}
		if h >= 0 && h < 24 {
			out[h] = n
		}
	}
	return out, rows.Err()
}

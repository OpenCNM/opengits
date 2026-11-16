package valley

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PgxStore McpCallLog 流量画像 pgx 实现（共享连接池，无独占连接）。
type PgxStore struct {
	pool *pgxpool.Pool
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

// HourlyCallCounts 按目标时区小时聚合近 since 以来的调用量直方图。
// createdAt 为无时区 timestamp（Prisma 存 UTC 墙钟）：
//   - tzOffsetMinutes 平移到目标时区后取小时；
//   - since 以 timestamptz 绑定，`AT TIME ZONE 'UTC'` 显式转裸 UTC，
//     免受会话 TimeZone 设置影响（聚合单查，无逐行物化）。
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

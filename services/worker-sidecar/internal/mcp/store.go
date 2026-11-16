package mcp

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

func hexEncode(b []byte) string { return hex.EncodeToString(b) }

// TokenRecord 鉴权所得（对齐 token-auth.ts 的 findFirst select）。
type TokenRecord struct {
	TokenID string
	UserID  string
}

// UserQuota 对齐 rate-limiter.ts 的 user select + role（tier 供工具级 tierRequirement 门控）。
type UserQuota struct {
	Role       string
	Tier       string
	IsBanned   bool
	RpmLimit   int
	DailyLimit int
	TokenCap   int
}

// BundleRepoMeta 对齐 CachedMcpBundleRepo（合集内仓库的精简元数据）。
type BundleRepoMeta struct {
	ID         string  `json:"id"`
	Owner      string  `json:"owner"`
	Repo       string  `json:"repo"`
	Category   *string `json:"category"`
	StarCount  int     `json:"starCount"`
	IsVerified bool    `json:"isVerified"`
}

// BundleMeta 对齐 CachedMcpBundle（合集元数据与仓库列表）。
type BundleMeta struct {
	ID           string           `json:"id"`
	Slug         *string          `json:"slug"`
	Title        string           `json:"title"`
	Description  *string          `json:"description"`
	Repositories []BundleRepoMeta `json:"repositories"`
}

// Store 控制面数据访问（单语句 SQL，全部带索引）。
// 接口化以支撑单测 fake（pgx 不做进程内 mock）。
type Store interface {
	LookupToken(ctx context.Context, tokenHash string) (*TokenRecord, error)
	GetUserQuota(ctx context.Context, userID string) (UserQuota, error)
	LedgerCount(ctx context.Context, userID, day string) (int, error)
	LedgerIncrement(ctx context.Context, userID, day string) error
	TouchTokenLastUsed(ctx context.Context, tokenID string) error
	UpsertPresence(ctx context.Context, userID, clientName, clientVer, ip string) error
	LookupBundle(ctx context.Context, bundleID string) (*BundleMeta, error)
	IncrementBundleUseCount(ctx context.Context, bundleID string) error
}

// pgxStore 真实实现。所有写路径 fail-soft（计数/心跳意义大于一致性，与 Node 侧 catch 对齐）。
type pgxStore struct {
	pool            *pgxpool.Pool
	internalToken   string
	httpClient      *http.Client
	searchEngine    SearchEngine
	// telemetry 批量写器（InsertCallLog 非阻塞入队，flusher 聚合落库）
	batcher *telemetryBatcher
}

func newPgxStore(ctx context.Context, cfg Config) (*pgxStore, error) {
	poolCfg, err := pgxpool.ParseConfig(sanitizeDatabaseURL(cfg.DatabaseURL))
	if err != nil {
		return nil, err
	}
	poolCfg.MaxConns = int32(cfg.PoolMax)
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, err
	}
	s := &pgxStore{
		pool:            pool,
		internalToken:   cfg.InternalToken,
		httpClient:      &http.Client{Timeout: 30 * time.Second},
	}
	s.startTelemetry()
	return s, nil
}

// NewPgxStoreWithPool 使用外部共享 pgx 连接池与检索引擎创建 Store。
func NewPgxStoreWithPool(pool *pgxpool.Pool, cfg Config, searchEngine SearchEngine) *pgxStore {
	s := &pgxStore{
		pool:            pool,
		internalToken:   cfg.InternalToken,
		httpClient:      &http.Client{Timeout: 30 * time.Second},
		searchEngine:    searchEngine,
	}
	s.startTelemetry()
	return s
}

// sanitizeDatabaseURL 剥离 Prisma 专属查询参数（schema/connection_limit/pool_timeout）——
// pgx 会把未知 query 参数当运行时参数下发 PG，首连即报 unrecognized configuration parameter
// （pgx 池惰性建连：启动不报错、首查失败）。connection_limit 若存在则映射为 pgx 的
// pool_max_conns（保持 Prisma URL 的池语义）。兼容直接复用 Node .env DATABASE_URL 部署。
func sanitizeDatabaseURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := u.Query()
	if cl := q.Get("connection_limit"); cl != "" && q.Get("pool_max_conns") == "" {
		q.Set("pool_max_conns", cl)
	}
	for _, key := range []string{"schema", "connection_limit", "pool_timeout"} {
		q.Del(key)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func (s *pgxStore) LookupToken(ctx context.Context, tokenHash string) (*TokenRecord, error) {
	row, err := db.New(s.pool).MCPLookupToken(ctx, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &TokenRecord{
		TokenID: row.ID,
		UserID:  row.UserId,
	}, nil
}

// resolveDailyMcpQuota 日配额装载处单点解析：显式值 >0 才生效，
// 0/负数 = 未配置 → 档位阶梯（FREE 100 / PRO 3000 / ENTERPRISE 0=无限）。
// limiter 把 0 当"无限"，DB 显式 0 原样透传会被误读成无限配额——
// 与 userinteraction.GetUsageSummary 的 !=0 阶梯口径必须保持一致。
func resolveDailyMcpQuota(tier string, explicit int) int {
	if explicit > 0 {
		return explicit
	}
	switch tier {
	case "PRO":
		return 3000
	case "ENTERPRISE":
		return 0
	default:
		return 100
	}
}

func (s *pgxStore) GetUserQuota(ctx context.Context, userID string) (UserQuota, error) {
	row, err := db.New(s.pool).MCPGetUserQuota(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserQuota{Role: "USER", Tier: "FREE", RpmLimit: 30, DailyLimit: 100, TokenCap: 4000}, nil
	}
	if err != nil {
		return UserQuota{}, err
	}
	role := "USER"
	if row.Role != "" {
		role = row.Role
	}
	tier := "FREE"
	if row.Tier != "" {
		tier = row.Tier
	}
	return UserQuota{
		Role:       role,
		Tier:       tier,
		IsBanned:   row.IsBanned,
		RpmLimit:   int(row.McpRpmLimit),
		DailyLimit: resolveDailyMcpQuota(tier, int(row.DailyMcpQuota)),
		TokenCap:   int(row.SingleCallTokenCap),
	}, nil
}

func (s *pgxStore) LedgerCount(ctx context.Context, userID, day string) (int, error) {
	cnt, err := db.New(s.pool).MCPLedgerCount(ctx, db.MCPLedgerCountParams{
		UserId: userID,
		Day:    day,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return int(cnt), err
}

func (s *pgxStore) LedgerIncrement(ctx context.Context, userID, day string) error {
	return db.New(s.pool).MCPLedgerIncrement(ctx, db.MCPLedgerIncrementParams{
		UserId: userID,
		Day:    day,
	})
}

// LedgerIncrementBy 批量增量记账（限流持久化节流路径：每用户每秒至多一次）。
func (s *pgxStore) LedgerIncrementBy(ctx context.Context, userID, day string, n int) error {
	return db.New(s.pool).MCPLedgerIncrementBy(ctx, db.MCPLedgerIncrementByParams{
		UserId:   userID,
		Day:      day,
		McpCalls: int32(n),
	})
}

func (s *pgxStore) TouchTokenLastUsed(ctx context.Context, tokenID string) error {
	return db.New(s.pool).MCPTouchTokenLastUsed(ctx, tokenID)
}

func (s *pgxStore) UpsertPresence(ctx context.Context, userID, clientName, clientVer, ip string) error {
	if userID == "" || clientName == "" {
		return nil
	}
	return db.New(s.pool).MCPUpsertPresence(ctx, db.MCPUpsertPresenceParams{
		UserId:     userID,
		ClientName: clientName,
		ClientVer:  clientVer,
		IpAddress:  ip,
	})
}

func (s *pgxStore) LookupBundle(ctx context.Context, bundleID string) (*BundleMeta, error) {
	rows, err := db.New(s.pool).MCPLookupBundle(ctx, bundleID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}

	var meta *BundleMeta
	for _, r := range rows {
		if meta == nil {
			var bDesc *string
			if r.BDesc.Valid {
				bDesc = &r.BDesc.String
			}
			meta = &BundleMeta{
				ID:           r.BID,
				Slug:         &r.BSlug,
				Title:        r.BTitle,
				Description:  bDesc,
				Repositories: make([]BundleRepoMeta, 0),
			}
		}

		if r.RID.Valid && r.ROwner.Valid && r.RRepo.Valid {
			stars := 0
			if r.RStars.Valid {
				stars = int(r.RStars.Int32)
			}
			verified := false
			if r.RVerified.Valid {
				verified = r.RVerified.Bool
			}
			var cat *string
			if r.RCat.Valid {
				cat = &r.RCat.String
			}
			meta.Repositories = append(meta.Repositories, BundleRepoMeta{
				ID:         r.RID.String,
				Owner:      r.ROwner.String,
				Repo:       r.RRepo.String,
				Category:   cat,
				StarCount:  stars,
				IsVerified: verified,
			})
		}
	}
	return meta, nil
}

func (s *pgxStore) IncrementBundleUseCount(ctx context.Context, bundleID string) error {
	return db.New(s.pool).MCPIncrementBundleUseCount(ctx, bundleID)
}

// utcDayKey UTC 日键（YYYY-MM-DD，与账本 day 列一致）。
func utcDayKey(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}

// normalizeClientName 主流客户端识别（对齐 mcp-heartbeat.ts normalizeClientName）。
func normalizeClientName(userAgent string) string {
	trimmed := strings.TrimSpace(userAgent)
	if trimmed == "" {
		return "unknown-client"
	}
	lower := strings.ToLower(trimmed)
	switch {
	case strings.Contains(lower, "cursor"):
		return "Cursor IDE"
	case strings.Contains(lower, "claude"):
		return "Claude Desktop"
	case strings.Contains(lower, "windsurf"):
		return "Windsurf"
	case strings.Contains(lower, "cline"):
		return "Cline"
	default:
		return trimmed
	}
}

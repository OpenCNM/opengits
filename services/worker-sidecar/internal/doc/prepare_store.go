package doc

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/opengits/worker-sidecar/internal/platform/db"
)

// ─────────────────────────────────────────────────────────────
// prepare 段数据面（D组端点3：/api/internal/doc/prepare 下沉）。
//
// 三类原语：文档+仓库画像直读 / BYOK 激活模型 id 直读（仅 modelId 明文列，
// 不解密 apiKey——11.7.4.1 向量：零密钥材料跨界）/ 指纹命中复用链
// （内容层查命中 + donor chunk 兜底复制 + PROCESSED 盖章）。
// 复用既有 finalize store 原语（AttachContentChunks / StampProcessed /
// StoreDocumentMetadata），语义与 Prisma 侧逐字对齐。
// ─────────────────────────────────────────────────────────────

type DBExec interface {
	Exec(ctx context.Context, sql string, arguments ...any) (commandTag pgconn.CommandTag, err error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// PgxStore provides Postgres-backed persistence for doc and prepare operations.
type PgxStore struct {
	pool *pgxpool.Pool
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

func (s *PgxStore) Pool() *pgxpool.Pool {
	if s == nil {
		return nil
	}
	return s.pool
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// LoadDocumentForPrepare 文档+仓库+画像+navTree 一读（miss 显式错误，Fail-Closed）。
func (s *PgxStore) LoadDocumentForPrepare(ctx context.Context, docId string) (*PrepareDoc, error) {
	if s == nil || s.pool == nil {
		return nil, errors.New("db pool not configured")
	}
	var d PrepareDoc
	querier := db.New(s.pool)
	row, err := querier.LoadDocumentForPrepare(ctx, docId)
	if err != nil {
		return nil, err
	}
	d.ID = row.ID
	d.RepositoryID = row.RepositoryId
	d.Path = row.Path
	d.Title = row.Title
	d.Status = string(row.Status)

	if row.Content != "" {
		s := row.Content
		d.Content = &s
	}
	if row.OwnerUserId.Valid {
		s := row.OwnerUserId.String
		d.OwnerUserID = &s
	}
	d.RepoOwner = row.Owner
	d.RepoName = row.Repo
	d.Branch = row.Branch
	if row.GitSha.Valid {
		s := row.GitSha.String
		d.GitSha = &s
	}
	profile := []byte(row.Profile)
	navTree := []byte(row.NavTree)
	if len(profile) > 0 {
		_ = json.Unmarshal(profile, &d.RepoProfile)
	}
	d.NavTree = navTree
	return &d, nil
}

// LoadActiveUserModelId BYOK 激活服务商的 selectedModel（明文列直读）。
// 未配置/未激活返回 ""；刻意不解密 apiKey（模型解析只需 id；key 由 web
// 网关在 LLM 调用时单点解密——密钥不外流向量不变）。
func (s *PgxStore) LoadActiveUserModelId(ctx context.Context, userId string) (string, error) {
	if s == nil || s.pool == nil {
		return "", errors.New("db pool not configured")
	}
	if userId == "" {
		return "", nil
	}
	querier := db.New(s.pool)
	m, err := querier.LoadActiveUserModelId(ctx, userId)
	var modelId *string
	if err == nil {
		modelId = &m
	}
	if err != nil {
		if isNoRows(err) {
			return "", nil
		}
		return "", err
	}
	if modelId == nil {
		return "", nil
	}
	return *modelId, nil
}

// FindReusableContentByFingerprint 指纹命中零 LLM 复用查询：
// 内容层正文 + 任一 PROCESSED donor 薄行（chunk 兜底复制源 + 内容等级继承源）。
func (s *PgxStore) FindReusableContentByFingerprint(ctx context.Context, fingerprint string) (contentId, content, donorDocId, donorLevel string, err error) {
	if s == nil || s.pool == nil {
		return "", "", "", "", errors.New("db pool not configured")
	}
	querier := db.New(s.pool)
	row, err := querier.FindReusableContentByFingerprint(ctx, pgtype.Text{String: fingerprint, Valid: true})
	if err == nil {
		contentId = row.ID
		content = row.Content
		donorDocId = row.DonorDocID
		if row.DonorGenerationLevel.Valid {
			donorLevel = row.DonorGenerationLevel.String
		}
	}
	if err != nil {
		if isNoRows(err) {
			return "", "", "", "", nil
		}
		return "", "", "", "", err
	}
	return contentId, content, donorDocId, donorLevel, nil
}

// CountContentChunks 内容层既有 chunk 数（0 = 需 donor 复制兜底）。
func (s *PgxStore) CountContentChunks(ctx context.Context, contentId string) (int, error) {
	if s == nil || s.pool == nil {
		return 0, errors.New("db pool not configured")
	}
	querier := db.New(s.pool)
	count, err := querier.CountContentChunks(ctx, pgtype.Text{String: contentId, Valid: true})
	n := int(count)
	return n, err
}

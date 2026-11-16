package sse

import (
	"context"
	"encoding/json"
	"time"
)

// ImportJobSnapshot 导入任务基本状态
type ImportJobSnapshot struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	Status    string    `json:"status"`
	Error     *string   `json:"error,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// ImportJobEventDTO 导入进度增量事件
type ImportJobEventDTO struct {
	Seq     int             `json:"seq"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// NotificationSnapshot 用户通知实时快照
type NotificationSnapshot struct {
	UnreadCount int     `json:"unreadCount"`
	LatestID    *string `json:"latestId"`
}

// ProjectedClient MCP 活跃客户端读侧投影
type ProjectedClient struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Version     *string `json:"version"`
	LastSeenAt  string  `json:"lastSeenAt"`
	Status      string  `json:"status"` // "online" | "recent"
	TotalCalls  int     `json:"totalCalls"`
	HitCalls    int     `json:"hitCalls"`
	RecentTicks []int   `json:"recentTicks"`
}

// RepositorySnapshot 仓库简易快照
type RepositorySnapshot struct {
	ID       string `json:"id"`
	IsPublic bool   `json:"isPublic"`
}

// RepoChapterJob 章节转录进度项
type RepoChapterJob struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Saved  int    `json:"saved"`
	Total  int    `json:"total"`
}

// Config SSE 网关配置项
type Config struct {
	InternalToken string
	// AppEnv 运行环境（production 时内部令牌拒绝 compose 默认值，对齐 Node internal-auth）
	AppEnv             string
	WebInternalURL     string
	LlmGatewayURL      string
	DefaultBranch      string
	SseHeartbeatMs       int
	SseProbeIntervalMs   int
	SseMaxLifetimeMs     int
	SseMaxConnsPerUser   int
	SseMaxConnsPerIP     int
	SseMaxGlobalConns    int
	SseJobMaxLifetimeMs  int
}

// Store SSE 网关数据访问接口（支持真实 pgx 与单测 fake）
type Store interface {
	// MCP API Token 鉴权
	GetUserIdByMcpToken(ctx context.Context, tokenHash string) (string, error)

	// Ingest Jobs
	GetImportJobSnapshot(ctx context.Context, jobId string) (*ImportJobSnapshot, error)
	GetImportJobEvents(ctx context.Context, jobId string, sinceSeq int) ([]ImportJobEventDTO, error)
	GetQueuedJobPosition(ctx context.Context, createdAt time.Time) (int, error)
	// ListQueuedJobCreatedAts 供 hub 构建 1s 粒度队位 rank map（全部排队
	// poller 共享一次查询，替代每 job 每秒一次全表 COUNT）
	ListQueuedJobCreatedAts(ctx context.Context) ([]time.Time, error)
	HasTerminalEvent(ctx context.Context, jobId string) (bool, error)

	// Notifications
	GetNotificationSnapshot(ctx context.Context, userId string) (*NotificationSnapshot, error)

	// Repo Ingest & Permissions
	GetRepositoryForEvents(ctx context.Context, owner, repo, branch, edition string) (*RepositorySnapshot, error)
	VerifyRepoAccess(ctx context.Context, repositoryId string, isPublic bool, userId string) (bool, error)
	GetRepoIngestSnapshot(ctx context.Context, repositoryId string) (string, error)

	// MCP Active Clients
	GetActiveClients(ctx context.Context, userId string, now time.Time) ([]ProjectedClient, error)
}

// SSEStore 是 Store 接口的别名，保持完全向前兼容
type SSEStore = Store

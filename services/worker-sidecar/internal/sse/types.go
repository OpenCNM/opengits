package sse

import (
	"context"
	"encoding/json"
	"time"
)

type ImportJobSnapshot struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	Status    string    `json:"status"`
	Error     *string   `json:"error,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type ImportJobEventDTO struct {
	Seq     int             `json:"seq"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type NotificationSnapshot struct {
	UnreadCount int     `json:"unreadCount"`
	LatestID    *string `json:"latestId"`
}

type ProjectedClient struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Version     *string `json:"version"`
	LastSeenAt  string  `json:"lastSeenAt"`
	Status      string  `json:"status"`
	TotalCalls  int     `json:"totalCalls"`
	HitCalls    int     `json:"hitCalls"`
	RecentTicks []int   `json:"recentTicks"`
}

type RepositorySnapshot struct {
	ID       string `json:"id"`
	IsPublic bool   `json:"isPublic"`
}

type RepoChapterJob struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Saved  int    `json:"saved"`
	Total  int    `json:"total"`
}

type Config struct {
	InternalToken       string
	AppEnv              string
	WebInternalURL      string
	LlmGatewayURL       string
	DefaultBranch       string
	SseHeartbeatMs      int
	SseProbeIntervalMs  int
	SseMaxLifetimeMs    int
	SseMaxConnsPerUser  int
	SseMaxConnsPerIP    int
	SseMaxGlobalConns   int
	SseJobMaxLifetimeMs int
}

type Store interface {
	GetUserIdByMcpToken(ctx context.Context, tokenHash string) (string, error)

	GetImportJobSnapshot(ctx context.Context, jobId string) (*ImportJobSnapshot, error)
	GetImportJobEvents(ctx context.Context, jobId string, sinceSeq int) ([]ImportJobEventDTO, error)
	GetQueuedJobPosition(ctx context.Context, createdAt time.Time) (int, error)
	ListQueuedJobCreatedAts(ctx context.Context) ([]time.Time, error)
	HasTerminalEvent(ctx context.Context, jobId string) (bool, error)

	GetNotificationSnapshot(ctx context.Context, userId string) (*NotificationSnapshot, error)

	GetRepositoryForEvents(ctx context.Context, owner, repo, branch, edition string) (*RepositorySnapshot, error)
	VerifyRepoAccess(ctx context.Context, repositoryId string, isPublic bool, userId string) (bool, error)
	GetRepoIngestSnapshot(ctx context.Context, repositoryId string) (string, error)

	GetActiveClients(ctx context.Context, userId string, now time.Time) ([]ProjectedClient, error)
}

type SSEStore = Store

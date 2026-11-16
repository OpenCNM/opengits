package update

import (
	"context"
	"time"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/market"
)

// NavNode is an alias to ingest.NavNode for navigation tree manipulation.
type NavNode = ingest.NavNode

// ModuleSnapshot is an alias to cluster.ModuleSnapshot.
type ModuleSnapshot = cluster.ModuleSnapshot

// GitNode is an alias to cluster.GitNode.
type GitNode = cluster.GitNode

// ApplyUpdatePlanTxParams encapsulates input parameters for the atomic update transaction.
type ApplyUpdatePlanTxParams struct {
	RepositoryID   string             `json:"repositoryId"`
	UserID         string             `json:"userId"`
	DocOwnerID     *string            `json:"docOwnerId,omitempty"`
	FromSha        string             `json:"fromSha"`
	ToSha          string             `json:"toSha"`
	Plan           UpdatePlan         `json:"plan"`
	CandidateSet   UpdateCandidateSet `json:"candidateSet"`
	NeedStructural bool               `json:"needStructural"`
	OldClusters    []ModuleSnapshot   `json:"oldClusters,omitempty"`
	RunID          *string            `json:"runId,omitempty"`
	CurrentNavTree []*NavNode         `json:"currentNavTree,omitempty"`
	CoercedCount   int                `json:"coercedCount,omitempty"`
}

// ApplyUpdatePlanTxResult encapsulates execution metrics of the applied plan.
type ApplyUpdatePlanTxResult struct {
	UpdatedDocs     int  `json:"updatedDocs"`
	RemovedDocs     int  `json:"removedDocs"`
	AddedDocs       int  `json:"addedDocs"`
	RenamedDocs     int  `json:"renamedDocs"`
	CoercedActions  int  `json:"coercedActions"`
	NavTreePatched  bool `json:"navTreePatched"`
	GitShaAdvanced  bool `json:"gitShaAdvanced"`
	PendingCodeDocs int  `json:"pendingCodeDocs"`
	PendingTextDocs int  `json:"pendingTextDocs"`
}

// StaleRepoRow 过期标记候选（对齐 auto-update.ts StaleRepoRow 查询）。
type StaleRepoRow struct {
	ID             string
	Owner          string
	Repo           string
	Branch         string
	GitSha         string
	PendingSyncSha *string
	RepoProfile    map[string]any
}

// DocIdPath 共享行（ownerUserId null）且已 PROCESSED 的文档 id+path。
type DocIdPath struct {
	ID   string
	Path string
}

// CandidateStore defines storage operations required for update candidate set calculation.
type CandidateStore interface {
	GetRepoProfile(ctx context.Context, repoID string) (*UpdateRepoProfile, error)
	GetDocuments(ctx context.Context, repositoryId string, docOwnerId *string) ([]UpdateDocumentMeta, error)
}

// ApplierStore defines storage operations for applying update plans atomically.
type ApplierStore interface {
	ApplyUpdatePlanTx(ctx context.Context, p ApplyUpdatePlanTxParams) (*ApplyUpdatePlanTxResult, error)
}

// CycleStore defines data operations for the deterministic auto-update cycle.
type CycleStore interface {
	market.Sweeper
	ListUpdatableRepos(ctx context.Context, limit int) ([]StaleRepoRow, error)
	GetRepoProfile(ctx context.Context, repoID string) (*UpdateRepoProfile, error)
	GetDocuments(ctx context.Context, repositoryId string, docOwnerId *string) ([]UpdateDocumentMeta, error)
	ListProcessedSharedDocs(ctx context.Context, repositoryId string, paths []string) ([]DocIdPath, error)
	BusyUpdateJobDocIDs(ctx context.Context, repositoryId string) ([]string, error)
	CountActiveUpdateJobs(ctx context.Context, repositoryId string) (int, error)
	CreateChapterUpdateJob(ctx context.Context, repositoryId, documentId, path, fromSha, toSha string) error
	SetPendingSyncSha(ctx context.Context, repositoryId, sha string) error
	AdvanceSyncBaseline(ctx context.Context, repositoryId, toSha string) error
	ClearUpstreamUpdate(ctx context.Context, repositoryId string) error
}

// LeaseStore defines distributed lease operations for scheduler leader election.
type LeaseStore interface {
	LeaseUpdateIfHeldOrExpired(ctx context.Context, key, owner string, until time.Time) (int64, error)
	LeaseInsert(ctx context.Context, key, owner string, until time.Time) error
	LeaseDelete(ctx context.Context, key, owner string) error
	CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error)
}

// CreateUpdateRunParams contains parameters for inserting an ImportUpdateRun.
type CreateUpdateRunParams struct {
	RepositoryID string `json:"repositoryId"`
	UserID       string `json:"userId"`
	FromSha      string `json:"fromSha"`
	ToSha        string `json:"toSha"`
	Status       string `json:"status,omitempty"`
	Plan         any    `json:"plan,omitempty"`
	CandidateSet any    `json:"candidateSet,omitempty"`
	Stats        any    `json:"stats,omitempty"`
}

// UpdateRunStatusParams contains status/error/stats updates for ImportUpdateRun.
type UpdateRunStatusParams struct {
	Status     string
	FinishedAt *time.Time
	Stats      any
}

// RunStore defines CRUD and lifecycle state machine for ImportUpdateRun.
type RunStore interface {
	CreateUpdateRun(ctx context.Context, p CreateUpdateRunParams) (string, error)
	ClaimUpdateRun(ctx context.Context, id string) (bool, error)
	UpdateRunStatus(ctx context.Context, id string, p UpdateRunStatusParams) error
}

// Store combines all persistence operations for the update engine.
type Store interface {
	CandidateStore
	ApplierStore
	CycleStore
	LeaseStore
	RunStore
}

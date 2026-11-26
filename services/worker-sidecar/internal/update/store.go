package update

import (
	"context"
	"time"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/market"
)

type NavNode = ingest.NavNode

type ModuleSnapshot = cluster.ModuleSnapshot

type GitNode = cluster.GitNode

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

type StaleRepoRow struct {
	ID             string
	Owner          string
	Repo           string
	Branch         string
	GitSha         string
	PendingSyncSha *string
	RepoProfile    map[string]any
}

type DocIdPath struct {
	ID   string
	Path string
}

type CandidateStore interface {
	GetRepoProfile(ctx context.Context, repoID string) (*UpdateRepoProfile, error)
	GetDocuments(ctx context.Context, repositoryId string, docOwnerId *string) ([]UpdateDocumentMeta, error)
}

type ApplierStore interface {
	ApplyUpdatePlanTx(ctx context.Context, p ApplyUpdatePlanTxParams) (*ApplyUpdatePlanTxResult, error)
}

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

type LeaseStore interface {
	LeaseUpdateIfHeldOrExpired(ctx context.Context, key, owner string, until time.Time) (int64, error)
	LeaseInsert(ctx context.Context, key, owner string, until time.Time) error
	LeaseDelete(ctx context.Context, key, owner string) error
	CleanExpiredLeases(ctx context.Context, expiredBefore time.Time) (int64, error)
}

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

type UpdateRunStatusParams struct {
	Status     string
	FinishedAt *time.Time
	Stats      any
}

type RunStore interface {
	CreateUpdateRun(ctx context.Context, p CreateUpdateRunParams) (string, error)
	ClaimUpdateRun(ctx context.Context, id string) (bool, error)
	UpdateRunStatus(ctx context.Context, id string, p UpdateRunStatusParams) error
}

type Store interface {
	CandidateStore
	ApplierStore
	CycleStore
	LeaseStore
	RunStore
}

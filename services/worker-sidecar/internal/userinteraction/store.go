package userinteraction

import (
	"context"
	"errors"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

var (
	ErrUserNotFound         = errors.New("user not found")
	ErrDocumentNotFound     = errors.New("document not found")
	ErrDocumentContentEmpty = errors.New("document content empty")
	ErrConversationNotFound = errors.New("conversation not found")
	ErrRepositoryNotFound   = errors.New("repository not found")
	ErrRepositoryForbidden  = errors.New("repository access forbidden")
	ErrMaxTokensExceeded    = errors.New("maximum active tokens limit reached")
	ErrMcpTokenNotFound     = errors.New("mcp token not found or already revoked")
	ErrProviderNotFound     = errors.New("provider not found")
	ErrApiKeyRequired       = errors.New("api key is required for new provider")
)

type Store interface {
	IncrementRepoViews(ctx context.Context, repoID string) error
	UpdatePinnedRepos(ctx context.Context, userID, repoID string, isPinned bool) ([]string, error)
	MarkNotificationsRead(ctx context.Context, userID string, ids []string, all bool) (int64, error)
	GetActiveOutline(ctx context.Context, repoID string) (*ActiveOutlineView, error)
	ToggleHelpfulVote(ctx context.Context, repoID, userID string) (voted bool, helpfulCount int, err error)
	GetDocumentStatus(ctx context.Context, docID string) (*DocumentStatusResult, error)
	GetIngestStatus(ctx context.Context, owner, repo, branch string, edition *string, userID *string) (*IngestStatusResult, error)
	GetFeaturedRepos(ctx context.Context, limit int) ([]FeaturedRepo, error)
	ListNotifications(ctx context.Context, userID string, page, pageSize int) (*NotificationListResult, error)
	ClearNotifications(ctx context.Context, userID string) (int64, error)
	PauseRepo(ctx context.Context, owner, repo, branch string, edition *string, userID *string, paused bool) (*PauseRepoResult, error)
	ToggleChapterVersionVote(ctx context.Context, versionID, userID string) (*ChapterVersionVoteResult, error)
	GetReadingProgressSync(ctx context.Context, userID, owner, repo string, edition *string) (*ReadingProgressSyncResult, error)
	RecordTelemetryEvents(ctx context.Context, userID string, events []TelemetryEventInput) (int, error)
	RecordMonitorEvents(ctx context.Context, userID string, events []MonitorEventInput) (int, error)
	GetUserPreferences(ctx context.Context, userID string) (*UserPreferencesResult, error)
	GetUsageSummary(ctx context.Context, userID string) (*UsageSummaryResult, error)
	GetDocumentContent(ctx context.Context, repoID string, candidatePaths []string, userID *string) (*DocumentContentResult, error)
	ListChapterVersions(ctx context.Context, docID string, userID *string) ([]ChapterVersionItem, error)
	ListConversations(ctx context.Context, owner, repo, userID string) ([]ConversationSummary, error)
	GetConversationMessages(ctx context.Context, conversationID, userID string) ([]ConversationMessageItem, error)
	SetUserPreferences(ctx context.Context, input UserPreferencesSetInput) (*UserPreferencesRecord, error)
	ListMcpTokens(ctx context.Context, userID string) ([]McpTokenSummary, error)
	CreateConversation(ctx context.Context, input ConversationCreateInput) (*ConversationRecord, error)
	UpdateConversation(ctx context.Context, input ConversationUpdateInput) (*ConversationRecord, error)
	DeleteConversation(ctx context.Context, input ConversationDeleteInput) error
	CreateMcpToken(ctx context.Context, input McpTokenCreateInput) (*McpTokenCreatedRecord, error)
	RevokeMcpToken(ctx context.Context, input McpTokenRevokeInput) (int64, error)
	ListUserModelProviders(ctx context.Context, userID string) ([]UserModelProviderView, error)
	UpsertUserModelProvider(ctx context.Context, input UserModelProviderUpsertInput) (*UserModelProviderView, error)
	PatchUserModelProvider(ctx context.Context, input UserModelProviderPatchInput) (*UserModelProviderView, error)
	DeleteUserModelProvider(ctx context.Context, input UserModelProviderDeleteInput) error
	GetActiveUserModelProvider(ctx context.Context, userID string) (*UserModelProviderRecord, error)
	GetUserModelProviderCipher(ctx context.Context, userID, providerKey string) (string, error)
	CreateChapterVersion(ctx context.Context, input ChapterVersionCreateInput) (*ChapterVersionCreateResult, error)
	PublishChapterVersion(ctx context.Context, versionID, userID string) (*ChapterVersionPublishResult, error)
	DeleteChapterVersion(ctx context.Context, versionID, userID string) (*ChapterVersionDeleteResult, error)
	PinChapterVersion(ctx context.Context, input ChapterVersionPinInput) (*ChapterVersionPinResult, error)
	PromoteCanonicalChapterVersion(ctx context.Context, input CanonicalPromotionInput) (*CanonicalPromotionResult, error)
	TouchMcpPresence(ctx context.Context, userID, clientName, clientVer, ip string) error
	IncrementMcpUsage(ctx context.Context, userID, day string) error
	RecordMcpCallLog(ctx context.Context, input McpCallLogInput) error
	RecordGithubQuotaSample(ctx context.Context, input GithubQuotaSampleInput) error
	CreateNotifications(ctx context.Context, items []CreateNotificationInput) error
	TouchMcpTokenUsage(ctx context.Context, tokenID string) error
	IncrementBundleUseCount(ctx context.Context, bundleID string) error
	CreateBundle(ctx context.Context, input BundleCreateInput) (*BundleDetail, error)
	UpdateBundle(ctx context.Context, input BundleUpdateInput) (*BundleDetail, error)
	DeleteBundle(ctx context.Context, id string) error
	ClearDocumentConceptChunks(ctx context.Context, documentId string) error
	UpdateCanonicalConcepts(ctx context.Context, updates []CanonicalConceptUpdate) (int64, error)
	ReplaceConceptEdges(ctx context.Context, input ReplaceConceptEdgesInput) (int, error)
	UnsaveRepo(ctx context.Context, userID, repositoryID string) error
	SetSavedRepoFollow(ctx context.Context, userID, repositoryID string, autoFollow bool) (bool, error)
	CreateUserAuth(ctx context.Context, input AuthCreateUserInput) (*AuthUserResult, error)
	UpdateUser(ctx context.Context, input UpdateUserInput) (*UserMutationResult, error)
	DeleteUser(ctx context.Context, id string) error
	PatchRepo(ctx context.Context, input RepoPatchInput) error
	BatchPatchRepos(ctx context.Context, input RepoBatchPatchInput) (int64, error)
	IncrementRepoCounters(ctx context.Context, input RepoIncrementInput) (*RepoIncrementResult, error)
	DeleteRepo(ctx context.Context, input RepoDeleteInput) (int64, error)
	UnpublishRepo(ctx context.Context, input RepoUnpublishInput) (*RepoUnpublishResult, error)
	PromoteEditionRepo(ctx context.Context, input RepoPromoteEditionInput) (*RepoPromoteEditionResult, error)
}

type CreateNotificationInput struct {
	UserID  string  `json:"userId"`
	Type    string  `json:"type"`
	Title   string  `json:"title"`
	Body    *string `json:"body,omitempty"`
	Payload []byte  `json:"payload,omitempty"`
}

type McpCallLogInput struct {
	ToolName         string  `json:"toolName"`
	UserID           *string `json:"userId,omitempty"`
	ClientName       *string `json:"clientName,omitempty"`
	RepositoryID     *string `json:"repositoryId,omitempty"`
	BundleID         *string `json:"bundleId,omitempty"`
	Dimension        *string `json:"dimension,omitempty"`
	Status           *string `json:"status,omitempty"`
	ResultCount      int     `json:"resultCount"`
	ResponseTimeMs   int     `json:"responseTimeMs"`
	RequestedEdition *string `json:"requestedEdition,omitempty"`
	ResolvedEdition  *string `json:"resolvedEdition,omitempty"`
	IsFallback       *bool   `json:"isFallback,omitempty"`
}

type GithubQuotaSampleInput struct {
	Fingerprint   string  `json:"fingerprint"`
	Remaining     int     `json:"remaining"`
	ResetAt       *string `json:"resetAt,omitempty"`
	EndpointClass string  `json:"endpointClass"`
	Status        int     `json:"status"`
}

type PgxStore struct {
	pool             *pgxpool.Pool
	queries          *db.Queries
	contentDualWrite bool
}

func NewPgxStore(pool *pgxpool.Pool) *PgxStore {
	var queries *db.Queries
	if pool != nil {
		queries = db.New(pool)
	}
	return &PgxStore{
		pool:    pool,
		queries: queries,
		// Read dualWrite env once at construction rather than per-transaction.
		contentDualWrite: os.Getenv("DOCUMENT_CONTENT_DUAL_WRITE") == "1",
	}
}

func (s *PgxStore) getQueries() *db.Queries {
	if s.queries == nil && s.pool != nil {
		s.queries = db.New(s.pool)
	}
	return s.queries
}

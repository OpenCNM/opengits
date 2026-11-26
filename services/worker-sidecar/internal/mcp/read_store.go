package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/opengits/worker-sidecar/internal/search"
)

type RepoRow struct {
	ID          string
	Owner       string
	Repo        string
	Branch      string
	Edition     string
	SemVerLabel *string
	McpStatus   string
	Category    string
	IsPublic    bool
	NavTree     json.RawMessage
	RepoProfile json.RawMessage
}

type BookshelfRepoRow struct {
	RepoRow
	Tags        []string
	IsVerified  bool
	StarCount   int
	BestUsedFor []string
	LastReadAt  time.Time
	UpdatedAt   time.Time
}

type CrossRepoConceptHit struct {
	ConceptID       string
	ConceptName     string
	Category        string
	GlobalConceptID *string
	RepoID          string
	RepoOwner       string
	RepoName        string
	DocPath         *string
	HeadingPath     *string
	Address         string
}

type GlobalConceptMeta struct {
	CanonicalName string
	Aliases       []string
}

type DocMeta struct {
	ID      string
	Path    string
	Title   string
	Summary *string
}

type ResolvedRepo struct {
	Repository         RepoRow
	Documents          []DocMeta
	TargetVersionLabel *string
}

type Chunk struct {
	Heading     *string
	HeadingPath *string
	Content     string
	SemVerLabel *string
}

type ConceptNodeLite struct {
	ID            string
	ConceptName   string
	CanonicalKey  *string
	CanonicalName *string
	Category      string
	DocumentPath  *string
	DocumentID    *string
	HeadingPath   *string
}

type EdgeRef struct {
	SourceID string
	TargetID string
	Type     string
	Weight   float64
	Source   string
}

type ActiveOutlineInfo struct {
	OutlineID string
	Mode      string
	Version   int
	NavTree   json.RawMessage
}

type ChunkHeading struct {
	Heading     *string
	HeadingPath *string
	ContentType *string
}

type TaxonomyNode struct {
	ID            string
	ConceptName   string
	CanonicalKey  *string
	CanonicalName *string
	Category      string
	HeadingPath   *string
	DocumentPath  *string
}

type ToolPolicy struct {
	IsEnabled       bool
	TokenBudget     int
	TierRequirement string
}

type CallLogEntry struct {
	ToolName       string
	UserID         string
	ClientName     string
	RepositoryID   string
	Dimension      string
	Status         string
	ResultCount    int
	ResponseTimeMs int64
}

type SearchChunksRequest = search.SearchChunksRequest
type SearchChunkHit = search.SearchChunkHit
type SearchChunksResponse = search.SearchChunksResponse
type SearchEngine = search.Engine

type ReadStore interface {
	Store

	FindDefaultBranchRepo(ctx context.Context, owner, repo, defaultBranch string) (*RepoRow, error)
	HasSavedRepoAccess(ctx context.Context, repositoryID, userID string) (bool, error)
	ResolveSingleRepo(ctx context.Context, owner, repo, defaultBranch, edition, userID string) (*ResolvedRepo, error)
	FindDocContent(ctx context.Context, repositoryID, docID, userID string) (*string, error)
	ListChunksByDoc(ctx context.Context, docID string) ([]Chunk, error)
	FindConceptForDoc(ctx context.Context, repositoryID, documentID string, headingPath *string) (*ConceptNodeLite, error)
	CanonicalMemberIDs(ctx context.Context, repositoryID, nodeID string) ([]string, error)
	EdgesTouching(ctx context.Context, repositoryID string, memberIDs []string) ([]EdgeRef, error)
	NodesByIDs(ctx context.Context, repositoryID string, ids []string) ([]ConceptNodeLite, error)
	CoLocatedNodes(ctx context.Context, repositoryID, documentID string, excludeIDs []string, take int) ([]ConceptNodeLite, error)
	GetConceptDocumentID(ctx context.Context, repositoryID, nodeID string) (*string, error)
	ToolPolicyMap(ctx context.Context) (map[string]ToolPolicy, error)
	ListChunkHeadings(ctx context.Context, docID string, take int) ([]ChunkHeading, error)
	SearchChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error)
	MatchConceptAll(ctx context.Context, repositoryID string, keywords []string) (*ConceptRichNode, error)
	MatchConceptAny(ctx context.Context, repositoryID string, keywords []string) (*ConceptRichNode, error)
	MatchConceptBody(ctx context.Context, repositoryID string, keywords []string) (*ConceptRichNode, error)
	ConceptGramCandidates(ctx context.Context, repositoryID string, grams []string) ([]ConceptRichNode, error)
	ConceptDependencyEdges(ctx context.Context, repositoryID string, memberIDs []string) ([]EdgeRef, error)
	GetRepoGitSha(ctx context.Context, repositoryID string) (owner, repo, sha string, ok bool)
	LoadSemanticGraph(ctx context.Context, owner, repo, sha string) (*rsg.SemanticGraphArtifact, error)
	ResolveConceptNode(ctx context.Context, repositoryID, concept string) (*ConceptRichNode, error)
	GetDocumentQuizzesByPath(ctx context.Context, repositoryID, docPath string) ([]ChapterQuizRow, error)
	ConceptEditionCompare(ctx context.Context, owner, repo, concept string) ([]ConceptEditionRow, error)
	LearningPathEdges(ctx context.Context, repositoryID string) ([]EdgeRef, error)
	CountCanonicalMembers(ctx context.Context, repositoryID, canonicalKey string) int
	ListDocConcepts(ctx context.Context, repositoryID, documentID string, take int) ([]ConceptNodeLite, error)
	TaxonomyNodes(ctx context.Context, repositoryID string, take int) ([]TaxonomyNode, error)
	PrereqEdges(ctx context.Context, repositoryID string) ([]EdgeRef, error)
	GetActiveOutline(ctx context.Context, repositoryID string) (*ActiveOutlineInfo, error)
	HasPrivateDocs(ctx context.Context, repositoryID, userID string) bool
	InsertCallLog(ctx context.Context, entry CallLogEntry) error

	ListUserBookshelfRepos(ctx context.Context, userID string) ([]BookshelfRepoRow, error)
	ResolveBookshelfRepo(ctx context.Context, userID, ref, edition string) (*ResolvedRepo, error)
	FindConceptAcrossBookshelf(ctx context.Context, userID, query string, limit int) ([]CrossRepoConceptHit, map[string]GlobalConceptMeta, error)
	FindBundleDoc(ctx context.Context, repositoryID, path string) (title, docPath, content string, found bool, err error)
}

func (s *pgxStore) SearchChunks(ctx context.Context, req SearchChunksRequest) ([]SearchChunkHit, error) {

	// Fail-closed when searchEngine is nil; unified deployment always injects it at assembly.
	if s.searchEngine == nil {
		return nil, fmt.Errorf("mcp search engine not injected (unified sidecar assembly required)")
	}
	return s.searchEngine.SearchChunks(ctx, req)
}

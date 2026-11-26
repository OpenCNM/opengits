package ingest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/webdoc"
)

type (
	UpsertRepositoryRowParams = webdoc.IngestRepoParams
	UpsertOwnedDocumentArgs   = webdoc.IngestDocParams
	RegisterSnapshotParams    = webdoc.IngestSnapshotParams
	WebSyncRepoInfo           = webdoc.WebSyncRepoInfo
	WebSyncTxParams           = webdoc.WebSyncTxParams
	WebSyncSavedDoc           = webdoc.WebSyncSavedDoc
	ReplaceChunksOpts         = webdoc.ReplaceChunksOpts
	ExtractedManifestResult   = concept.ExtractedManifestResult
)

type ChapterInput struct {
	Title     string
	Files     []ChapterFile
	PartTitle string
}

type ChapterFile = cognitive.ChapterFile

func DocOwnerIdFor(isPublic bool, userId string) *string {
	if isPublic {
		return nil
	}
	if userId == "" {
		return nil
	}
	return &userId
}

type PeekRepoResult struct {
	Id     string
	GitSha *string
}

type Store interface {
	PeekRepositoryForCommit(ctx context.Context, owner, repo, branch, edition string) (*PeekRepoResult, error)
	// CAS rollback restores gitSha only if unchanged so stale rollbacks never overwrite newer concurrent commits.
	RestoreRepositoryGitSha(ctx context.Context, repoId string, restoreSha, expectSha *string) (int64, error)
	UpsertRepositoryRow(ctx context.Context, p UpsertRepositoryRowParams) (string, error)
	UpsertOwnedDocument(ctx context.Context, args UpsertOwnedDocumentArgs) (string, error)
	CreateDocsForChapters(ctx context.Context, repositoryId string, docOwnerId *string, owner, repo, branch string, gitSha *string, chapters []ChapterInput, archiveRoot string, patterns *Patterns) (int, []CodeAssetDoc, error)
	RegisterImportSnapshot(ctx context.Context, p RegisterSnapshotParams) (bool, error)
	DeleteRepositoryRow(ctx context.Context, owner, repo, branch, edition string) (int64, error)
	ResetDocumentsUnprocessed(ctx context.Context, repositoryId string, docOwnerId *string, paths []string) (int64, error)
	StoreOutlineDraft(ctx context.Context, repositoryId string, draft OutlineDraft, isActive bool) (string, error)
	ActivateOutline(ctx context.Context, repositoryId, outlineId string) error
	DeactivateAllOutlines(ctx context.Context, repositoryId string) error

	GetRepositoryForWebSync(ctx context.Context, owner, repo string) (*WebSyncRepoInfo, error)
	TouchWebSyncNoChanges(ctx context.Context, repoID, etag string, lastModMap map[string]string) error
	ExecuteWebSyncTx(ctx context.Context, p WebSyncTxParams) ([]WebSyncSavedDoc, error)
	ReplaceDocumentChunks(ctx context.Context, documentId string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error)
	DeleteOwnedDocumentsByPaths(ctx context.Context, repoID string, docOwnerID *string, paths []string) error
	StoreDocumentMetadata(ctx context.Context, repositoryId, docId, docPath, content string, manifest ExtractedManifestResult, summary string) error
	UpdateImportJobProgress(ctx context.Context, jobId string, step string, progress int) error
	BatchEnqueueTranscription(ctx context.Context, repoId string, requestedBy string, options any) (int64, error)
}

type IngestStore = Store

// Enforce archive root containment and distinguish IO/escape errors from true empty files ("", nil).
func readLocalArchiveFile(archiveRoot, owner, repo, shaOrBranch, path string) (string, error) {
	if archiveRoot == "" || owner == "" || repo == "" || shaOrBranch == "" || path == "" {
		return "", fmt.Errorf("archive read args incomplete: path=%q", path)
	}
	base := filepath.Join(archiveRoot, owner, repo, shaOrBranch)
	full := filepath.Join(base, filepath.FromSlash(path))
	rel, err := filepath.Rel(base, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("archive path escapes root: %q", path)
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", fmt.Errorf("archive read %s: %w", path, err)
	}
	return string(b), nil
}

type (
	OutlineNode          = webdoc.OutlineNode
	StoredOutlineChapter = webdoc.StoredOutlineChapter
	OutlinePart          = webdoc.OutlinePart
	OutlineDraft         = webdoc.OutlineDraft
)

func navTitle(n *NavNode) string {
	if n.Title != "" {
		return n.Title
	}
	parts := strings.Split(n.Path, "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return n.Path
}

func collectFiles(n *NavNode) []OutlineNode {
	if n.Type == "file" {
		return []OutlineNode{{Title: navTitle(n), NodeType: "doc", SourcePath: n.Path}}
	}
	var out []OutlineNode
	for _, c := range n.Children {
		out = append(out, collectFiles(c)...)
	}
	return out
}

func OutlineFromNavTree(navTree []*NavNode) OutlineDraft {
	draft := OutlineDraft{Parts: []OutlinePart{}, Chapters: []StoredOutlineChapter{}}
	order := 0

	pushChapter := func(title string, nodes []OutlineNode, partTitle string) {
		if len(nodes) == 0 {
			return
		}
		order++
		draft.Chapters = append(draft.Chapters, StoredOutlineChapter{
			Title: title, ChapterType: "doc", TeachingOrder: order,
			Nodes: nodes, PartTitle: partTitle,
		})
	}

	for _, top := range navTree {
		if top.Type == "file" {
			pushChapter(navTitle(top), collectFiles(top), "")
		} else {
			partTitle := navTitle(top)
			draft.Parts = append(draft.Parts, OutlinePart{
				Title: partTitle, TeachingOrder: len(draft.Parts) + 1,
			})
			for _, child := range top.Children {
				pushChapter(navTitle(child), collectFiles(child), partTitle)
			}
		}
	}
	return draft
}

var mdTitleStripRe = mdpat.MdMarkdownExtRe

func docFallbackTitle(path string) string {
	parts := strings.Split(path, "/")
	name := parts[len(parts)-1]
	if name == "" {
		return path
	}
	stripped := mdTitleStripRe.ReplaceAllString(name, "")
	if stripped != name {
		return stripped
	}
	if lastDot := strings.LastIndex(name, "."); lastDot > 0 {
		return name[:lastDot]
	}
	return name
}

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

// ─────────────────────────────────────────────────────────────
// ingest 落库三件套 + 大纲派生（刀 3c，原逐字对齐 chapter-docs.ts /
// import-snapshot.ts / outline-derive.ts / outline-store.ts；TS 原体均已退役，本包为唯一实现）。
//
// 数据破坏面防御（审计 1.16/1.17 向量）：
// - UpsertOwnedDocument 必须 findFirst(IS NULL) 语义，禁 ON CONFLICT——
//   Postgres NULL 互异，公开行（ownerUserId=null）会重复 create；
// - RegisterImportSnapshot 三态（diff 增量 / 全量回退 / skip）逐字对齐，
//   只重置归属者自己的文档（真冻结：他人副本原封不动）。
// ─────────────────────────────────────────────────────────────

// ChapterInput 统一章节输入模型。
type ChapterInput struct {
	Title string
	Files []ChapterFile
	// PartTitle 可选大类归属（文本大纲两级分组；空 = 根部章）
	PartTitle string
}

type ChapterFile = cognitive.ChapterFile

// DocOwnerIdFor 私有导入归用户，公开导入归共享（null）。
func DocOwnerIdFor(isPublic bool, userId string) *string {
	if isPublic {
		return nil
	}
	if userId == "" {
		return nil
	}
	return &userId
}

// PeekRepoResult 仓库提交前快照信息（用于更新导入失败补偿回滚与首导活快照判定）。
type PeekRepoResult struct {
	Id     string
	GitSha *string
}

// Store 导入落库数据访问接口（3c 数据访问面）。
type Store interface {
	PeekRepositoryForCommit(ctx context.Context, owner, repo, branch, edition string) (*PeekRepoResult, error)
	// RestoreRepositoryGitSha CAS 回滚：仅当行内 gitSha 仍等于 expectSha（本次导入
	// 写入值）时才回退 restoreSha——防并发邻居任务已提交的新 sha 被旧回滚覆写；
	// 返回 0 行 = CAS miss（邻居已推进，不回滚，调用方留痕）。
	RestoreRepositoryGitSha(ctx context.Context, repoId string, restoreSha, expectSha *string) (int64, error)
	UpsertRepositoryRow(ctx context.Context, p UpsertRepositoryRowParams) (string, error)
	UpsertOwnedDocument(ctx context.Context, args UpsertOwnedDocumentArgs) (string, error)
	CreateDocsForChapters(ctx context.Context, repositoryId string, docOwnerId *string, owner, repo, branch string, gitSha *string, chapters []ChapterInput, archiveRoot string, patterns *Patterns) (int, []CodeAssetDoc, error)
	RegisterImportSnapshot(ctx context.Context, p RegisterSnapshotParams) (bool, error)
	// DeleteRepositoryRow 首导失败回滚（对齐 Node repository.deleteMany 的
	// owner/repo/branch/edition 四元范围删——级联清理半成品行）
	DeleteRepositoryRow(ctx context.Context, owner, repo, branch, edition string) (int64, error)
	ResetDocumentsUnprocessed(ctx context.Context, repositoryId string, docOwnerId *string, paths []string) (int64, error)
	StoreOutlineDraft(ctx context.Context, repositoryId string, draft OutlineDraft, isActive bool) (string, error)
	ActivateOutline(ctx context.Context, repositoryId, outlineId string) error
	DeactivateAllOutlines(ctx context.Context, repositoryId string) error

	// WebSync 增量同步数据访问面
	GetRepositoryForWebSync(ctx context.Context, owner, repo string) (*WebSyncRepoInfo, error)
	TouchWebSyncNoChanges(ctx context.Context, repoID, etag string, lastModMap map[string]string) error
	ExecuteWebSyncTx(ctx context.Context, p WebSyncTxParams) ([]WebSyncSavedDoc, error)
	ReplaceDocumentChunks(ctx context.Context, documentId string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error)
	DeleteOwnedDocumentsByPaths(ctx context.Context, repoID string, docOwnerID *string, paths []string) error
	StoreDocumentMetadata(ctx context.Context, repositoryId, docId, docPath, content string, manifest ExtractedManifestResult, summary string) error
	UpdateImportJobProgress(ctx context.Context, jobId string, step string, progress int) error
	BatchEnqueueTranscription(ctx context.Context, repoId string, requestedBy string, options any) (int64, error)
}

// IngestStore 是 Store 的向后兼容别名。
type IngestStore = Store

// readLocalArchiveFile 归档本地读（含防路径穿越边界校验；raw 网络回退留 3d 编排层）。
// 失效封闭：IO 错误/越界路径/参数缺失显式返回 error，与「文件真实为空」
// （"", nil）严格区分——调用方严禁以占位符顶替后伪完工（346 准则公理 5）。
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

// ── 大纲派生（outline-derive.ts 逐字移植，纯函数）──

type (
	OutlineNode          = webdoc.OutlineNode
	StoredOutlineChapter = webdoc.StoredOutlineChapter
	OutlinePart          = webdoc.OutlinePart
	OutlineDraft         = webdoc.OutlineDraft
)

// navTitle shortTitle → title → 路径末段兜底。
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

// collectFiles 递归收集子树全部文件。
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

// OutlineFromNavTree navTree 1:1 投影（顶层文件→章；顶层目录→大类，子项→章）。
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

// docFallbackTitle markdown/doc 文档 title 兜底（路径末段去扩展名）。
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

package ingest

import (
	"context"
	"encoding/json"
	"log"

	"github.com/opengits/worker-sidecar/internal/webdoc"
)

func sanitizeWebDocMarkdown(docPath, raw string) string {
	return webdoc.SanitizeMarkdown(docPath, raw)
}

// runWebDocIngest 委托至 internal/webdoc 领域包执行 web-doc 任务（Zero-Node Worker 收官：Firecrawl 直连与 FastPath 优先）。
func runWebDocIngest(
	ctx context.Context,
	_ Config,
	deps IngestBodyDeps,
	job JobRow,
	envelope ImportJobEnvelope,
) ingestOutcome {
	userId := envelope.UserId
	if userId == "" {
		userId = derefStrPtr(job.UserId)
	}
	o := envelope.Options

	outcome := webdoc.RunIngest(ctx, webdoc.IngestDeps{
		Store:     deps.Store,
		Firecrawl: deps.Firecrawl,
		BuildNavTree: func(nodes []webdoc.GitNode, owner, repo string, maxPages int) []byte {
			if deps.Patterns == nil {
				return []byte("[]")
			}
			gitNodes := make([]GitNode, len(nodes))
			for i, n := range nodes {
				gitNodes[i] = GitNode{Path: n.Path, Type: n.Type}
			}
			tree := deps.Patterns.BuildNavTree(gitNodes, owner, repo, "")
			if len(tree) > maxPages {
				tree = tree[:maxPages]
			}
			if b, err := json.Marshal(tree); err == nil && len(tree) > 0 {
				return b
			}
			return []byte("[]")
		},
		Emit: deps.Emit,
		Settle: func(ctx context.Context, jobID string, res webdoc.SettleResult) error {
			return deps.settle(ctx, jobID, ImportSettleResult{
				RepositoryId:         res.RepositoryID,
				QueuedDocumentsCount: res.QueuedDocumentsCount,
				GitSha:               res.GitSha,
			})
		},
		LLM: deps.LLM,
	}, webdoc.IngestJob{
		ID:     job.Id,
		Owner:  job.Owner,
		Repo:   job.Repo,
		Branch: job.Branch,
		UserID: userId,
	}, webdoc.IngestOptions{
		URL:              o.Url,
		MaxPages:         o.MaxPages,
		Category:         o.Category,
		Tags:             o.Tags,
		IsPublic:         o.IsPublic,
		TargetLanguage:   o.TargetLanguage,
		Branch:           envelope.Branch,
		Edition:          envelope.Edition,
		Name:             o.Name,
		ScopeMode:        o.ScopeMode,
		PrimaryDocPrefix: o.PrimaryDocPrefix,
		AllowedPrefixes:  o.AllowedPrefixes,
		ModuleTabs:       o.ModuleTabs,
	})

	if outcome == webdoc.IngestDone {
		return ingestDone
	}
	return ingestFallback
}

// runWebDocSync 委托至 internal/webdoc 领域包执行 web-sync 任务。
func runWebDocSync(
	ctx context.Context,
	_ Config,
	deps IngestBodyDeps,
	job JobRow,
	envelope ImportJobEnvelope,
) ingestOutcome {
	userId := envelope.UserId
	if userId == "" {
		userId = derefStrPtr(job.UserId)
	}
	outcome := webdoc.RunSync(ctx, webdoc.SyncDeps{
		Store:     deps.Store,
		Firecrawl: deps.Firecrawl,
		Emit:      deps.Emit,
		Settle: func(ctx context.Context, jobID string, res webdoc.SettleResult) error {
			return deps.settle(ctx, jobID, ImportSettleResult{
				RepositoryId:         res.RepositoryID,
				QueuedDocumentsCount: res.QueuedDocumentsCount,
				GitSha:               res.GitSha,
			})
		},
	}, webdoc.SyncJob{
		ID:     job.Id,
		Owner:  job.Owner,
		Repo:   job.Repo,
		Branch: job.Branch,
		UserID: userId,
	})
	if outcome == webdoc.SyncDone {
		return ingestDone
	}
	log.Printf("[webdoc-sync] job %s sync failed (fail-closed)", job.Id)
	return ingestFallback
}

// CustomOutlineFile 自定义大纲文件项（支持字符串或对象，兼容 path[#anchor] 物理语义锚点）。

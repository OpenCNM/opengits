package webdoc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"golang.org/x/sync/errgroup"
)

func RunSync(
	ctx context.Context,
	deps SyncDeps,
	job SyncJob,
) SyncOutcome {
	repoInfo, err := deps.Store.GetRepositoryForWebSync(ctx, job.Owner, job.Repo)
	if err != nil || repoInfo == nil {
		msg := fmt.Sprintf("仓库 %s/%s 未找到或读取元数据失败: %v", job.Owner, job.Repo, err)
		log.Printf("[webdoc-sync] %s (fail-closed)", msg)
		if deps.Emit != nil {
			deps.Emit("error", map[string]any{"message": msg})
		}
		return SyncFailed
	}
	if repoInfo.SourceType != "web" || repoInfo.OriginalURL == "" {
		msg := fmt.Sprintf("仓库 %s/%s 非网页文档类型 (sourceType=%q, url=%q)", job.Owner, job.Repo, repoInfo.SourceType, repoInfo.OriginalURL)
		log.Printf("[webdoc-sync] %s (fail-closed)", msg)
		if deps.Emit != nil {
			deps.Emit("error", map[string]any{"message": msg})
		}
		return SyncFailed
	}

	userId := job.UserID
	docOwnerId := repoInfo.DocOwnerID
	if docOwnerId == nil {
		docOwnerId = DocOwnerIdFor(repoInfo.IsPublic, userId)
	}

	if deps.Emit != nil {
		deps.Emit("log", map[string]any{"message": "[1/4] 正在对比文档站 Sitemap 与 ETag 变更..."})
	}
	diff, err := DetectWebDocDiff(ctx, repoInfo.OriginalURL, derefStr(repoInfo.UpstreamEtag), repoInfo.SitemapLastModMap, 15*time.Second)
	if err != nil {
		msg := fmt.Sprintf("文档站 Sitemap 与 ETag 探测失败 (%s): %v", repoInfo.OriginalURL, err)
		log.Printf("[webdoc-sync] %s (fail-closed)", msg)
		if deps.Emit != nil {
			deps.Emit("error", map[string]any{"message": msg})
		}
		return SyncFailed
	}

	if !diff.HasChanges {
		if deps.Emit != nil {
			deps.Emit("log", map[string]any{"message": "文档站无变更，已是最新版本"})
		}
		if err := deps.Store.TouchWebSyncNoChanges(ctx, repoInfo.ID, diff.ETag, diff.SitemapLastModMap); err != nil {
			log.Printf("[webdoc-sync] touch no changes failed for %s: %v", repoInfo.ID, err)
		}
		if deps.Settle != nil {
			if err := deps.Settle(ctx, job.ID, SettleResult{
				RepositoryID:         repoInfo.ID,
				QueuedDocumentsCount: 0,
				GitSha:               "",
			}); err != nil {
				emitSyncError(deps, fmt.Sprintf("0 变更结算失败 (%s): %v", job.ID, err))
				return SyncFailed
			}
		}
		return SyncDone
	}

	targetUrls := append([]string{}, diff.PagesToAdd...)
	targetUrls = append(targetUrls, diff.PagesToUpdate...)
	scopedRemovals := diff.PagesToRemove
	scopeDropped := 0
	if len(repoInfo.AllowedPrefixes) > 0 || len(repoInfo.ExcludePrefixes) > 0 {
		before := len(targetUrls) + len(scopedRemovals)
		targetUrls = filterURLsInScope(targetUrls, repoInfo.AllowedPrefixes, repoInfo.ExcludePrefixes)
		scopedRemovals = filterURLsInScope(scopedRemovals, repoInfo.AllowedPrefixes, repoInfo.ExcludePrefixes)
		scopeDropped = before - len(targetUrls) - len(scopedRemovals)
	}

	if len(targetUrls) == 0 && len(scopedRemovals) == 0 {
		if deps.Emit != nil {
			deps.Emit("log", map[string]any{
				"message": fmt.Sprintf("检测到 %d 页变更全部在已选抓取范围之外，已按策展作用域忽略", scopeDropped),
			})
		}
		if err := deps.Store.TouchWebSyncNoChanges(ctx, repoInfo.ID, diff.ETag, diff.SitemapLastModMap); err != nil {
			log.Printf("[webdoc-sync] touch no changes failed for %s: %v", repoInfo.ID, err)
		}
		if deps.Settle != nil {
			if err := deps.Settle(ctx, job.ID, SettleResult{
				RepositoryID:         repoInfo.ID,
				QueuedDocumentsCount: 0,
				GitSha:               "",
			}); err != nil {
				emitSyncError(deps, fmt.Sprintf("0 变更结算失败 (%s): %v", job.ID, err))
				return SyncFailed
			}
		}
		return SyncDone
	}

	if deps.Emit != nil {
		deps.Emit("log", map[string]any{
			"message": fmt.Sprintf("[2/4] 检测到 %d 页变更、%d 页移除（作用域外已忽略 %d 页），开始增量抓取...",
				len(targetUrls), len(scopedRemovals), scopeDropped),
		})
	}

	crawledDocs := CrawlTargetUrlsWithProgress(ctx, targetUrls, deps.Firecrawl, deps.Emit)
	if len(crawledDocs) == 0 && len(scopedRemovals) == 0 && len(targetUrls) > 0 {
		msg := fmt.Sprintf("未能成功抓取任何目标页面 (共 %d 个页面)，请检查源站连通性或 Firecrawl 服务", len(targetUrls))
		log.Printf("[webdoc-sync] %s for %s (fail-closed)", msg, job.ID)
		if deps.Emit != nil {
			deps.Emit("error", map[string]any{"message": msg})
		}
		return SyncFailed
	}

	if len(crawledDocs) > 0 {
		crawledDocs = PersistSameOriginImages(ctx, strings.ToLower(job.Owner), strings.ToLower(job.Repo), crawledDocs, repoInfo.OriginalURL)
	}

	var removedPaths []string
	seenRemoved := make(map[string]bool)
	for _, rawURL := range scopedRemovals {
		p := CanonicalDocPathFromUrl(rawURL)
		if p != "" && !seenRemoved[p] {
			seenRemoved[p] = true
			removedPaths = append(removedPaths, p)
		}
	}

	aggregateSha := ComputeWebDocAggregateSha(crawledDocs)

	if deps.Emit != nil {
		deps.Emit("log", map[string]any{
			"message": fmt.Sprintf("[3/4] 事务落库增量页面（更新 %d 篇，移除 %d 篇）...", len(crawledDocs), len(removedPaths)),
		})
	}

	branch := repoInfo.Branch
	if branch == "" {
		branch = job.Branch
	}

	savedDocs, err := deps.Store.ExecuteWebSyncTx(ctx, WebSyncTxParams{
		RepositoryID:      repoInfo.ID,
		DocOwnerID:        docOwnerId,
		UpdatedDocs:       crawledDocs,
		RemovedPaths:      removedPaths,
		ETag:              diff.ETag,
		SitemapLastModMap: diff.SitemapLastModMap,
		AggregateSha:      aggregateSha,
		UserID:            userId,
		Owner:             job.Owner,
		Repo:              job.Repo,
		Branch:            branch,
	})
	if err != nil {
		msg := fmt.Sprintf("增量页面事务落库失败: %v", err)
		log.Printf("[webdoc-sync] %s for %s (fail-closed)", msg, job.ID)
		if deps.Emit != nil {
			deps.Emit("error", map[string]any{"message": msg})
		}
		return SyncFailed
	}

	if deps.Emit != nil {
		deps.Emit("log", map[string]any{"message": "[4/4] 刷新文档切片与知识拓扑..."})
	}
	chunksByDoc := make([][]chunker.MarkdownChunk, len(savedDocs))
	if len(savedDocs) > 0 {
		g, _ := errgroup.WithContext(ctx)
		g.SetLimit(4)
		for i := range savedDocs {
			i := i
			g.Go(func() error {
				chunksByDoc[i] = chunker.ChunkMarkdown(chunker.MarkdownChunkRequest{
					Content: savedDocs[i].Content,
					DocPath: savedDocs[i].Path,
				})
				return nil
			})
		}
		_ = g.Wait()
	}
	for i, doc := range savedDocs {
		if len(chunksByDoc[i]) > 0 {
			if _, err := deps.Store.ReplaceDocumentChunks(ctx, doc.ID, chunksByDoc[i], ReplaceChunksOpts{DocPath: doc.Path}); err != nil {
				log.Printf("[webdoc-sync] replace document chunks failed for %s (%s): %v", doc.ID, doc.Path, err)
			}
		}
	}

	if deps.Settle != nil {
		if err := deps.Settle(ctx, job.ID, SettleResult{
			RepositoryID:         repoInfo.ID,
			QueuedDocumentsCount: len(crawledDocs),
			GitSha:               aggregateSha,
		}); err != nil {
			msg := fmt.Sprintf("同步终态结算失败: %v", err)
			log.Printf("[webdoc-sync] %s for %s (fail-closed)", msg, job.ID)
			if deps.Emit != nil {
				deps.Emit("error", map[string]any{"message": msg})
			}
			return SyncFailed
		}
	}

	if deps.Emit != nil {
		deps.Emit("log", map[string]any{
			"message": fmt.Sprintf("同步完成：更新 %d 篇，移除 %d 篇", len(crawledDocs), len(diff.PagesToRemove)),
		})
	}
	log.Printf("[webdoc-sync] job %s completed: %s/%s docs=%d removed=%d", job.ID, job.Owner, job.Repo, len(crawledDocs), len(diff.PagesToRemove))
	return SyncDone
}

func filterURLsInScope(urls []string, allowedPrefixes, excludePrefixes []string) []string {
	out := make([]string, 0, len(urls))
	for _, u := range urls {
		if isURLAllowed(u, allowedPrefixes, excludePrefixes) {
			out = append(out, u)
		}
	}
	return out
}

func CrawlTargetUrlsWithProgress(ctx context.Context, urls []string, firecrawl FirecrawlAPI, emit func(string, map[string]any)) []FirecrawlDoc {
	if len(urls) == 0 {
		return nil
	}

	concurrency := 4
	if concurrency > len(urls) {
		concurrency = len(urls)
	}

	type jobItem struct {
		index int
		url   string
	}
	type resultItem struct {
		index int
		doc   *FirecrawlDoc
	}

	jobs := make(chan jobItem, len(urls))
	results := make(chan resultItem, len(urls))

	for i, u := range urls {
		jobs <- jobItem{index: i, url: u}
	}
	close(jobs)

	var (
		completedMu    sync.Mutex
		completedCount int
	)

	var wg sync.WaitGroup
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				doc := ScrapeSinglePage(ctx, item.url, firecrawl)
				if doc != nil {
					results <- resultItem{index: item.index, doc: doc}
				}
				if emit != nil && len(urls) >= 5 {
					completedMu.Lock()
					completedCount++
					cur := completedCount
					total := len(urls)
					if cur%5 == 0 || cur == total {
						pct := float64(cur) / float64(total) * 100.0
						emit("log", map[string]any{
							"message": fmt.Sprintf("[2/4] 页面抓取进度: %d/%d (%.0f%%)...", cur, total, pct),
						})
					}
					completedMu.Unlock()
				}
			}
		}()
	}

	wg.Wait()
	close(results)

	docsSlice := make([]*FirecrawlDoc, len(urls))
	for res := range results {
		if res.doc != nil && res.index >= 0 && res.index < len(urls) {
			docsSlice[res.index] = res.doc
		}
	}

	var docs []FirecrawlDoc
	for _, d := range docsSlice {
		if d != nil {
			docs = append(docs, *d)
		}
	}
	return docs
}

func ScrapeSinglePage(ctx context.Context, pageURL string, firecrawl FirecrawlAPI) *FirecrawlDoc {
	fastRes, err := ScanFastPathPage(ctx, pageURL, 5*time.Second)
	if err == nil && fastRes != nil && fastRes.IsStatic && fastRes.Document != nil && strings.TrimSpace(fastRes.Document.Markdown) != "" {
		doc := fastRes.Document
		contentHash := doc.ContentHash
		if contentHash == "" {
			h := sha256.Sum256([]byte(doc.Markdown))
			contentHash = hex.EncodeToString(h[:])
		}
		path := doc.Path
		if path == "" {
			path = CanonicalDocPathFromUrl(pageURL)
		}
		return &FirecrawlDoc{
			URL:         pageURL,
			Path:        path,
			Title:       doc.Title,
			Markdown:    doc.Markdown,
			ContentHash: contentHash,
		}
	}

	if firecrawl != nil {
		fcDoc, fcErr := firecrawl.ScrapeUrl(ctx, pageURL)
		if fcErr == nil && fcDoc != nil && strings.TrimSpace(fcDoc.Markdown) != "" {
			if fcDoc.ContentHash == "" {
				h := sha256.Sum256([]byte(fcDoc.Markdown))
				fcDoc.ContentHash = hex.EncodeToString(h[:])
			}
			if fcDoc.Path == "" {
				fcDoc.Path = CanonicalDocPathFromUrl(pageURL)
			}
			return fcDoc
		}
	}

	return nil
}

func ComputeWebDocAggregateSha(docs []FirecrawlDoc) string {
	var sb strings.Builder
	for i, d := range docs {
		if i > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(d.Path)
		sb.WriteByte(':')
		sb.WriteString(d.ContentHash)
	}
	h := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(h[:])
}

// Preserve EscapedPath and strip only single leading/trailing slash to avoid key mismatches on percent-encoded or double-slash URLs.
func CanonicalDocPathFromUrl(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "index.md"
	}
	p := u.EscapedPath()
	p = strings.TrimPrefix(p, "/")
	p = strings.TrimSuffix(p, "/")
	if p == "" {
		p = "index"
	}
	return p + ".md"
}

func DocOwnerIdFor(isPublic bool, userId string) *string {
	if isPublic || userId == "" {
		return nil
	}
	return &userId
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func emitSyncError(deps SyncDeps, msg string) {
	log.Printf("[webdoc-sync] %s (fail-closed)", msg)
	if deps.Emit != nil {
		deps.Emit("error", map[string]any{"message": msg})
	}
}

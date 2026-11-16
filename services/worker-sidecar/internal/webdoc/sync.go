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

// ─────────────────────────────────────────────────────────────
// WebDoc 增量同步核心引擎 (Go 原生闭环)
// 1. 读取仓库基线配置；
// 2. Sitemap XML 流式递归解析与 ETag 条件探测；
// 3. 0 变更短路结算（Touch 仓库基线 + 0 积分结算）；
// 4. 受控并发池抓取变动页面（50ms 静态站快道优先，Firecrawl 兜底）；
// 5. 规范化路径并原子事务落库（upsert 文档、删除移除页面、更新 Repository 行、登记快照）；
// 6. 刷新切片与概念图谱引用；
// 7. 终态结算与记账。
// ─────────────────────────────────────────────────────────────

// RunSync 原生闭环处理 web-sync 任务。
func RunSync(
	ctx context.Context,
	deps SyncDeps,
	job SyncJob,
) SyncOutcome {
	// 阶段 1：读取仓库与基线配置
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

	// 阶段 2：Sitemap 与 ETag 差分探测
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

	// 阶段 3：0 变更短路结算
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

	// 阶段 3.5：作用域守卫——按导入期收敛落盘的生效作用域过滤差分页面，
	// 阻断源站后续新增的越界页面（如新发 changelog）逆向渗透进已策展的库。
	// 存量库无作用域字段时 isURLAllowed 放行一切（通配全集，行为与历史一致）。
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

	// 差分全部落在策展作用域之外 ⇒ 等效 0 变更：以新基线短路结算
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

	// 阶段 4：目标变更页面受控并发抓取
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

	// 同源图片及 DOM 升维产生的内联 SVG 资产持久化，保持增量同步与首次导入画质一致
	if len(crawledDocs) > 0 {
		crawledDocs = PersistSameOriginImages(ctx, strings.ToLower(job.Owner), strings.ToLower(job.Repo), crawledDocs, repoInfo.OriginalURL)
	}

	// 阶段 5：规范化删除路径、计算 aggregateSha、原子事务落库
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

	// 阶段 6：刷新切片与图谱边
	if deps.Emit != nil {
		deps.Emit("log", map[string]any{"message": "[4/4] 刷新文档切片与知识拓扑..."})
	}
	// CPU 切片段有界并行预算（ChunkMarkdown 纯函数）；落库循环保持
	// 串行原序（每文档独立事务，单文档失败仅告警的语义不变）。
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

	// 阶段 7：终态结算与记账
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

// filterURLsInScope 按生效作用域（allowed/exclude 前缀集）确定性过滤 URL 列表。
// 与爬取期 isURLAllowed 同一套语义，保证"导入抓什么、同步就补什么"不漂移。
func filterURLsInScope(urls []string, allowedPrefixes, excludePrefixes []string) []string {
	out := make([]string, 0, len(urls))
	for _, u := range urls {
		if isURLAllowed(u, allowedPrefixes, excludePrefixes) {
			out = append(out, u)
		}
	}
	return out
}

// CrawlTargetUrlsWithProgress 使用受控并发池（并发度 3~5）抓取目标页面，并分批上报抓取进度。
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
					// 每 5 页或完成最后一页时上报进度
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

// ScrapeSinglePage 页面抓取：优先 50ms 静态站快道，失败回退 Firecrawl 单页。
func ScrapeSinglePage(ctx context.Context, pageURL string, firecrawl FirecrawlAPI) *FirecrawlDoc {
	// 1. 优先 50ms 静态站快道探测
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

	// 2. 快道未命中或失败，回退 Firecrawl 单页抓取
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

// ComputeWebDocAggregateSha 计算文档批次的内容指纹哈希（对齐 apps/client/src/lib/jobs/web-doc-job.ts）。
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

// CanonicalDocPathFromUrl 归一化文档路径 (URL -> path.md)。
// 对齐 Node fast-path-scanner（URL.pathname 语义）：保留百分号编码
//（EscapedPath，非解码 Path），仅剥单个首/尾斜杠（非全剥）——双斜杠或
// 非 ASCII 路径不再与既有基线键错配导致整站双插。
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

// DocOwnerIdFor 私有导入归用户，公开导入归共享（null）。
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

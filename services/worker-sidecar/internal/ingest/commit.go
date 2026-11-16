package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"golang.org/x/sync/errgroup"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/concept"
)

// directGraphSyncWorkers 直存文档图谱后处理的有界并行（纯 CPU 切片 +
// 独立文档写集，跨文档无共享写集；全部 fail-soft，仅日志时序变化）。
const directGraphSyncWorkers = 4

// ─────────────────────────────────────────────────────────────
// 单一持久化尾段（证据阶梯的收口漏斗）：
// 三条编排路径（text / code / giant）的落库尾段收敛为唯一实现——
// branch/edition 解析 → category/tags 回退 → 画像合并增强 →
// UpsertRepositoryRow → 章节文档（含内联正文与附页收编）→
// RegisterImportSnapshot（含 Prefix）→ StoreOutlineDraft（失败不阻断）→
// settle → ingestDone。上游只负责产出 ChapterPlan（证据阶梯产物）。
// ─────────────────────────────────────────────────────────────

// ChapterPlan 章节计划：证据阶梯单一产物 → commitIngest 唯一输入。
type ChapterPlan struct {
	// Chapters 章节落库输入（CreateDocsForChapters：md→UNPROCESSED 转录，
	// 非 md→归档原文 PROCESSED 直存）
	Chapters []ChapterInput
	// NavTree Repository.navTree 物化
	NavTree []*NavNode
	// Draft V2 教程大纲（StoreOutlineDraft，派生失败不阻断）
	Draft OutlineDraft
	// InlineContent path → PROCESSED 内联正文（全景第 0 章注入 LLM 正文；
	// 标题由同名章节条目的 ShortTitle 承载）
	InlineContent map[string]string
	// Profile 基础画像 map（SniffProfile 投影或巨型专用画像）
	Profile map[string]any
	// ProfilePatch 画像增强键（chapterMap/profileVersion/codeClusters/targetLanguage 等）
	ProfilePatch map[string]any
	// AppendixDocs 收编文档附页（归档读取 PROCESSED 直存，单页失败不阻断）
	AppendixDocs []GitNode
	// ScopePrefix 作用域前缀（RegisterImportSnapshot.Prefix 与画像 ingestPrefix）
	ScopePrefix string
	// BestUsedFor Repository.bestUsedFor（draftOutline 继承）
	BestUsedFor []string
	// RawNodes 全量归档树节点（用于计算骨架签名 skeleton / skeletonHash）
	RawNodes []GitNode
}

// commitIngest 单一持久化尾段：plan 落库 → 快照 → 大纲 → 结算。
// 返回 (outcome, repoId, queuedDocs) 供调用方日志与结算单据对账。
func commitIngest(
	ctx context.Context,
	deps IngestBodyDeps,
	job JobRow,
	envelope ImportJobEnvelope,
	sha string,
	plan ChapterPlan,
) (ingestOutcome, string, int) {
	o := envelope.Options
	userId := envelope.UserId
	if userId == "" {
		userId = derefStrPtr(job.UserId)
	}
	branch := envelope.Branch
	if branch == "" {
		branch = job.Branch
	}
	edition := envelope.Edition

	// category/tags 回退链：显式入参 → draftOutline 继承 → 缺省
	draftContent, _ := parseDraftOutline(o.DraftOutline)
	category := o.Category
	if category == "" && draftContent.Category != "" {
		category = draftContent.Category
	}
	if category == "" {
		category = "Others"
	}
	tags := o.Tags
	if len(tags) == 0 && len(draftContent.Tags) > 0 {
		tags = draftContent.Tags
	}
	if tags == nil {
		tags = []string{}
	}

	// 画像：基础 map + 增强键合并 + 作用域前缀（sync 回放复用同一目录）
	profileMap := plan.Profile
	if profileMap == nil {
		profileMap = make(map[string]any)
	}
	for k, v := range plan.ProfilePatch {
		profileMap[k] = v
	}
	if plan.ScopePrefix != "" {
		profileMap["ingestPrefix"] = plan.ScopePrefix
	}
	profileJSON, err := json.Marshal(profileMap)
	if err != nil {
		profileJSON = []byte("{}")
	}
	navJSON, _ := json.Marshal(plan.NavTree)
	shaPtr := &sha

	skeleton := ""
	skeletonHash := ""
	if len(plan.RawNodes) > 0 {
		var checker concept.DirPatternChecker
		if deps.Patterns != nil {
			checker = deps.Patterns
		}
		paths := concept.ExtractSkeletonPaths(plan.RawNodes, checker)
		skeleton = concept.BuildSkeleton(paths)
		skeletonHash = concept.SkeletonHashOf(skeleton)
	}

	peek, err := deps.Store.PeekRepositoryForCommit(ctx, strings.ToLower(job.Owner), strings.ToLower(job.Repo), branch, edition)
	if err != nil {
		log.Printf("[ingest-body] peek repository failed for %s/%s: %v", job.Owner, job.Repo, err)
		return ingestFallback, "", 0
	}
	wasExisting := peek != nil
	var oldSha *string
	if wasExisting {
		oldSha = peek.GitSha
	}

	repoId, err := deps.Store.UpsertRepositoryRow(ctx, UpsertRepositoryRowParams{
		Owner: strings.ToLower(job.Owner), Repo: strings.ToLower(job.Repo),
		Branch: branch, Edition: edition,
		Skeleton: skeleton, SkeletonHash: skeletonHash,
		NavTreeJSON: navJSON, ProfileJSON: profileJSON,
		IsPublic: o.IsPublic, Category: category, Tags: tags, GitSha: shaPtr,
		BestUsedFor: plan.BestUsedFor, StarCount: o.StarCount,
	})
	if err != nil {
		log.Printf("[ingest-body] upsert repository failed for %s/%s: %v", job.Owner, job.Repo, err)
		return ingestFallback, "", 0
	}

	docOwnerId := DocOwnerIdFor(o.IsPublic, userId)

	// 附页归档读取与章节文档批写（DB 往返主导）重叠：读盘纯 I/O、结果
	// 只供后续附页 upsert 消费，提前预取；读失败/空文件跳过计数语义不变。
	appendixPrefetch := prefetchAppendixDocs(deps.ArchiveRoot, job.Owner, job.Repo, sha, plan.AppendixDocs)

	created, codeAssets, err := deps.Store.CreateDocsForChapters(ctx, repoId, docOwnerId,
		strings.ToLower(job.Owner), strings.ToLower(job.Repo), branch, shaPtr, plan.Chapters,
		deps.ArchiveRoot, deps.Patterns)
	if err != nil {
		log.Printf("[ingest-body] create docs for chapters failed for %s/%s: %v", job.Owner, job.Repo, err)
		if wasExisting {
			// CAS：仅当行内 sha 仍等于本次导入写入值时回滚，防覆写并发邻居已推进的新 sha
			if n, rErr := deps.Store.RestoreRepositoryGitSha(ctx, repoId, oldSha, shaPtr); rErr != nil {
				log.Printf("[ingest-body] restore gitSha failed for %s/%s: %v", job.Owner, job.Repo, rErr)
			} else if n == 0 {
				log.Printf("[ingest-body] restore gitSha CAS miss for %s/%s (concurrent job advanced sha, skip rollback)", job.Owner, job.Repo)
			}
			deps.emit("error", map[string]any{"message": "更新导入创建章节文档失败；gitSha 已回滚，请重试"})
		} else {
			rollbackFirstImport(ctx, deps, job, envelope, repoId, wasExisting)
		}
		return ingestFallback, repoId, 0
	}
	// 非 md 章节资产（演示代码等）补齐知识图谱（对齐 Node codeAssetPaths——
	// 保证 MCP 检索/FTS 对演示代码同样可用；单资产失败不阻断）。
	// 跨文档无共享写集，有界并行保收尾延迟不随资产数线性放大。
	if len(codeAssets) > 0 {
		g, gctx := errgroup.WithContext(ctx)
		g.SetLimit(directGraphSyncWorkers)
		for _, asset := range codeAssets {
			asset := asset
			g.Go(func() error {
				syncDirectDocKnowledgeGraph(gctx, deps.Store, repoId, asset.Id, asset.Path, asset.Content)
				return nil
			})
		}
		_ = g.Wait()
	}

	targetLang, _ := plan.ProfilePatch["targetLanguage"].(string)
	if targetLang == "" {
		targetLang = o.TargetLanguage
	}

	// 内联正文注入：PROCESSED 覆写（标题优先取章节条目 ShortTitle）——
	// 巨型全景第 0 章在此注入 LLM 正文。
	// 标题查找预建 map（原三重循环 O(InlineContent×Chapters×Files)；
	// map 按章节序后写覆盖，与原内层循环的「后见覆盖」语义一致）。
	shortTitleByPath := make(map[string]string)
	for _, ch := range plan.Chapters {
		for _, f := range ch.Files {
			if t := strings.TrimSpace(f.ShortTitle); t != "" {
				shortTitleByPath[f.Path] = t
			}
		}
	}
	for path, content := range plan.InlineContent {
		title := docFallbackTitle(path)
		if t, ok := shortTitleByPath[path]; ok {
			title = t
		}
		docId, err := deps.Store.UpsertOwnedDocument(ctx, UpsertOwnedDocumentArgs{
			RepositoryId: repoId, Path: path, OwnerUserId: docOwnerId,
			Title: title, Content: content, Lang: targetLang, Status: "PROCESSED",
			HasUpdate: true, UpdateTitle: title,
		})
		if err != nil {
			log.Printf("[ingest-body] inline content upsert failed for %s: %v", path, err)
			continue
		}
		syncDirectDocKnowledgeGraph(ctx, deps.Store, repoId, docId, path, content)
	}

	// 文档附页收编：归档读取 PROCESSED 直存 + 补齐知识图谱。
	// 失效封闭：归档读取失败/空文件绝不以占位符顶替后伪完工——
	// 跳过并告警（单页失败不阻断导入，但必须对用户可见、可对账）。
	// 读盘已完成（预取与章节批写重叠）；upsert 按原序串行（首错 continue
	// 语义不变）；图谱后处理段（纯 CPU 切片 + 独立文档写集）有界并行。
	appendixRaw := appendixPrefetch.wait()
	appendixSkipped := appendixPrefetch.skipped
	type appendixGraphSync struct {
		docId, path, raw string
	}
	var appendixSyncs []appendixGraphSync
	for i, doc := range plan.AppendixDocs {
		raw := appendixRaw[i]
		if raw == "" {
			continue // 预取阶段已计数并告警
		}
		docId, err := deps.Store.UpsertOwnedDocument(ctx, UpsertOwnedDocumentArgs{
			RepositoryId: repoId, Path: doc.Path, OwnerUserId: docOwnerId,
			Title: docFallbackTitle(doc.Path), Content: raw, Lang: targetLang, Status: "PROCESSED",
		})
		if err != nil {
			log.Printf("[ingest-body] appendix doc upsert failed, skipped %s: %v", doc.Path, err)
			continue
		}
		appendixSyncs = append(appendixSyncs, appendixGraphSync{docId: docId, path: doc.Path, raw: raw})
	}
	if len(appendixSyncs) > 0 {
		g, gctx := errgroup.WithContext(ctx)
		g.SetLimit(directGraphSyncWorkers)
		for _, item := range appendixSyncs {
			item := item
			g.Go(func() error {
				syncDirectDocKnowledgeGraph(gctx, deps.Store, repoId, item.docId, item.path, item.raw)
				return nil
			})
		}
		_ = g.Wait()
	}
	if appendixSkipped > 0 {
		deps.emit("log", map[string]any{"message": fmt.Sprintf("警告：%d 个文档附页因归档读取失败或为空被跳过（未入库，不影响章节正文）", appendixSkipped)})
	}

	// 同步知识大纲快照与终态结算
	deps.emit("log", map[string]any{"message": "[5/5] 同步知识大纲快照与终态结算 (Sync Outline & Settle Job)..."})
	if _, err := deps.Store.RegisterImportSnapshot(ctx, RegisterSnapshotParams{
		UserId: userId, RepositoryId: repoId,
		Owner: strings.ToLower(job.Owner), Repo: strings.ToLower(job.Repo),
		Branch: branch, Sha: sha, DocOwnerId: docOwnerId, Prefix: scopePrefixPtr(plan.ScopePrefix),
	}); err != nil {
		log.Printf("[ingest-body] register snapshot failed for %s/%s: %v", job.Owner, job.Repo, err)
		if wasExisting {
			// CAS：仅当行内 sha 仍等于本次导入写入值时回滚，防覆写并发邻居已推进的新 sha
			if n, rErr := deps.Store.RestoreRepositoryGitSha(ctx, repoId, oldSha, shaPtr); rErr != nil {
				log.Printf("[ingest-body] restore gitSha failed for %s/%s: %v", job.Owner, job.Repo, rErr)
			} else if n == 0 {
				log.Printf("[ingest-body] restore gitSha CAS miss for %s/%s (concurrent job advanced sha, skip rollback)", job.Owner, job.Repo)
			}
			deps.emit("error", map[string]any{"message": "更新导入在结算阶段失败，内容可能处于新旧混合状态；gitSha 已回滚，重试导入即可自愈"})
		} else {
			rollbackFirstImport(ctx, deps, job, envelope, repoId, wasExisting)
		}
		return ingestFallback, repoId, created
	}

	// 大纲派生失败仅影响增强读路径（渲染回退 navTree），不阻断
	if _, err := deps.Store.StoreOutlineDraft(ctx, repoId, plan.Draft, true); err != nil {
		log.Printf("[ingest-body] outline store failed for %s/%s: %v", job.Owner, job.Repo, err)
	}

	// 结算（资金面 pgx 单写者；失败=任务显式失败，Fail-Closed）
	if err := deps.settle(ctx, job.Id, ImportSettleResult{
		RepositoryId:         repoId,
		QueuedDocumentsCount: created,
		GitSha:               sha,
	}); err != nil {
		log.Printf("[ingest-body] settle failed for job %s: %v", job.Id, err)
		if wasExisting {
			// CAS：仅当行内 sha 仍等于本次导入写入值时回滚，防覆写并发邻居已推进的新 sha
			if n, rErr := deps.Store.RestoreRepositoryGitSha(ctx, repoId, oldSha, shaPtr); rErr != nil {
				log.Printf("[ingest-body] restore gitSha failed for %s/%s: %v", job.Owner, job.Repo, rErr)
			} else if n == 0 {
				log.Printf("[ingest-body] restore gitSha CAS miss for %s/%s (concurrent job advanced sha, skip rollback)", job.Owner, job.Repo)
			}
			deps.emit("error", map[string]any{"message": "更新导入在结算阶段失败，内容可能处于新旧混合状态；gitSha 已回滚，重试导入即可自愈"})
		} else {
			rollbackFirstImport(ctx, deps, job, envelope, repoId, wasExisting)
		}
		return ingestFallback, repoId, created
	}

	// 主动清退 Web 端 L1 内存大纲投影与 Next.js 页面缓存
	if deps.Web != nil {
		if revalidator, ok := deps.Web.(interface {
			RevalidateRepository(ctx context.Context, repoId string) error
		}); ok {
			if err := revalidator.RevalidateRepository(ctx, repoId); err != nil {
				log.Printf("[ingest-body] web l1 projection revalidate warning for %s: %v", repoId, err)
			}
		}
	}

	// 批量将未转录章节推入 TranscriptionJob 队列（服务端离线转录保证）
	transcriptionOptions := map[string]any{
		"targetLanguage":      targetLang,
		"teachingDepth":       o.TeachingDepth,
		"transcriptionPreset": o.TranscriptionPreset,
		"customPrompt":        o.CustomPrompt,
		"aiCondensation":      o.AiCondensation,
	}
	if n, err := deps.Store.BatchEnqueueTranscription(ctx, repoId, userId, transcriptionOptions); err != nil {
		log.Printf("[ingest-body] batch enqueue transcription warning for %s: %v", repoId, err)
	} else if n > 0 {
		log.Printf("[ingest-body] batch enqueued %d transcription job(s) for %s", n, repoId)
	}
	if deps.TriggerTranscription != nil {
		deps.TriggerTranscription()
	}

	return ingestDone, repoId, created
}

// rollbackFirstImport 首导失败回滚（原对齐 TS import-job-runner.ts:161-179，TS 原体已退役：
// wasExisting 为 false 时表示本次运行新建的 Repository——失败时
// 四元范围删，杜绝半成品孤儿行干扰重试；资产目录由 assets GC 兜底）。
func rollbackFirstImport(ctx context.Context, deps IngestBodyDeps, job JobRow, envelope ImportJobEnvelope, repoId string, wasExisting bool) {
	if repoId == "" || wasExisting {
		return // 仓已存在（更新导入），保留既有行
	}
	branch := envelope.Branch
	if branch == "" {
		branch = job.Branch
	}
	if n, err := deps.Store.DeleteRepositoryRow(ctx, strings.ToLower(job.Owner), strings.ToLower(job.Repo), branch, envelope.Edition); err != nil {
		log.Printf("[ingest-body] first-import rollback failed for %s/%s: %v", job.Owner, job.Repo, err)
	} else if n > 0 {
		log.Printf("[ingest-body] first-import rolled back %d repository row(s) for %s/%s", n, job.Owner, job.Repo)
	}
}

// syncDirectDocKnowledgeGraph 针对 PROCESSED 直存文档（附页 / 内联全景章）补齐知识图谱后处理：
// 进程内切片落库 + 提取伴生概念 + 同步共现边与教学序边，保证全站 MCP 检索与 FTS 可见。
func syncDirectDocKnowledgeGraph(ctx context.Context, store Store, repoId, docId, docPath, content string) {
	if docId == "" || strings.TrimSpace(content) == "" {
		return
	}
	chunks := chunker.ChunkMarkdown(chunker.MarkdownChunkRequest{
		Content: content,
		DocPath: docPath,
	})
	if len(chunks) > 0 {
		if _, err := store.ReplaceDocumentChunks(ctx, docId, chunks, ReplaceChunksOpts{DocPath: docPath}); err != nil {
			log.Printf("[ingest-body] direct doc chunks replace failed for %s: %v", docPath, err)
		}
	}
	manifest := concept.ExtractConceptManifest(content, docPath)
	summary := strings.TrimSpace(manifest.Summary)
	if summary == "" && len(manifest.Takeaways) > 0 {
		summary = strings.TrimSpace(strings.Join(manifest.Takeaways, " "))
	}
	if err := store.StoreDocumentMetadata(ctx, repoId, docId, docPath, content, manifest, summary); err != nil {
		log.Printf("[ingest-body] direct doc metadata store failed for %s: %v", docPath, err)
	}
}

// appendixPrefetchHandle 附页归档读取预取（与章节文档批写的 DB 往返
// 重叠）。结果按 plan.AppendixDocs 原序对齐：读失败/空文件的槽位为 ""
// 并计入 skipped（告警在预取 goroutine 内发出，计数语义与旧串行版一致）。
type appendixPrefetchHandle struct {
	done    chan struct{}
	results []string
	skipped int
}

func prefetchAppendixDocs(archiveRoot, owner, repo, sha string, docs []GitNode) appendixPrefetchHandle {
	h := appendixPrefetchHandle{done: make(chan struct{}), results: make([]string, len(docs))}
	if len(docs) == 0 {
		close(h.done)
		return h
	}
	go func() {
		defer close(h.done)
		for i, doc := range docs {
			raw, readErr := readLocalArchiveFile(archiveRoot, owner, repo, sha, doc.Path)
			if readErr != nil {
				h.skipped++
				log.Printf("[ingest-body] appendix doc archive read failed, skipped %s: %v", doc.Path, readErr)
				continue
			}
			if strings.TrimSpace(raw) == "" {
				h.skipped++
				log.Printf("[ingest-body] appendix doc empty in archive, skipped %s", doc.Path)
				continue
			}
			h.results[i] = raw
		}
	}()
	return h
}

// wait join 预取（nil/空句柄立即返回空结果）。
func (h appendixPrefetchHandle) wait() []string {
	if h.done != nil {
		<-h.done
	}
	return h.results
}

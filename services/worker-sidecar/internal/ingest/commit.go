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

const directGraphSyncWorkers = 4

type ChapterPlan struct {
	Chapters      []ChapterInput
	NavTree       []*NavNode
	Draft         OutlineDraft
	InlineContent map[string]string
	Profile       map[string]any
	ProfilePatch  map[string]any
	AppendixDocs  []GitNode
	ScopePrefix   string
	BestUsedFor   []string
	RawNodes      []GitNode
}

// Single-writer persistence tail: repo upsert, docs, snapshot, outline, settle; CAS-restores gitSha on failure.
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

	appendixPrefetch := prefetchAppendixDocs(deps.ArchiveRoot, job.Owner, job.Repo, sha, plan.AppendixDocs)

	created, codeAssets, err := deps.Store.CreateDocsForChapters(ctx, repoId, docOwnerId,
		strings.ToLower(job.Owner), strings.ToLower(job.Repo), branch, shaPtr, plan.Chapters,
		deps.ArchiveRoot, deps.Patterns)
	if err != nil {
		log.Printf("[ingest-body] create docs for chapters failed for %s/%s: %v", job.Owner, job.Repo, err)
		if wasExisting {
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

	appendixRaw := appendixPrefetch.wait()
	appendixSkipped := appendixPrefetch.skipped
	type appendixGraphSync struct {
		docId, path, raw string
	}
	var appendixSyncs []appendixGraphSync
	for i, doc := range plan.AppendixDocs {
		raw := appendixRaw[i]
		if raw == "" {
			continue
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

	deps.emit("log", map[string]any{"message": "[5/5] 同步知识大纲快照与终态结算 (Sync Outline & Settle Job)..."})
	if _, err := deps.Store.RegisterImportSnapshot(ctx, RegisterSnapshotParams{
		UserId: userId, RepositoryId: repoId,
		Owner: strings.ToLower(job.Owner), Repo: strings.ToLower(job.Repo),
		Branch: branch, Sha: sha, DocOwnerId: docOwnerId, Prefix: scopePrefixPtr(plan.ScopePrefix),
	}); err != nil {
		log.Printf("[ingest-body] register snapshot failed for %s/%s: %v", job.Owner, job.Repo, err)
		if wasExisting {
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

	if _, err := deps.Store.StoreOutlineDraft(ctx, repoId, plan.Draft, true); err != nil {
		log.Printf("[ingest-body] outline store failed for %s/%s: %v", job.Owner, job.Repo, err)
	}

	if err := deps.settle(ctx, job.Id, ImportSettleResult{
		RepositoryId:         repoId,
		QueuedDocumentsCount: created,
		GitSha:               sha,
	}); err != nil {
		log.Printf("[ingest-body] settle failed for job %s: %v", job.Id, err)
		if wasExisting {
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

	if deps.Web != nil {
		if revalidator, ok := deps.Web.(interface {
			RevalidateRepository(ctx context.Context, repoId string) error
		}); ok {
			if err := revalidator.RevalidateRepository(ctx, repoId); err != nil {
				log.Printf("[ingest-body] web l1 projection revalidate warning for %s: %v", repoId, err)
			}
		}
	}

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

func rollbackFirstImport(ctx context.Context, deps IngestBodyDeps, job JobRow, envelope ImportJobEnvelope, repoId string, wasExisting bool) {
	if repoId == "" || wasExisting {
		return
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

func (h appendixPrefetchHandle) wait() []string {
	if h.done != nil {
		<-h.done
	}
	return h.results
}

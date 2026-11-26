package transcription

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"strings"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/pipeline"
)

const DefaultAiModel = "qwen3.6-flash"

type FinalizeStore interface {
	UpsertContentLayer(ctx context.Context, contentHash, requestFingerprint, content, lang, model string) (string, error)
	AttachContentChunks(ctx context.Context, contentId, documentId string) error
	DeleteLegacyChunks(ctx context.Context, documentId string) error
	StampProcessed(ctx context.Context, documentId, content string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error)
	RecordTranscriptionModel(ctx context.Context, repositoryId, model string) error
	RecordTranscriptionTokens(ctx context.Context, repositoryId string, tokens int) error
}

type TitleSyncStore interface {
	SyncChapterTitleFromContent(ctx context.Context, documentId, title string) error
}

type TranscriptionFinalizeStore = FinalizeStore

// Matches TS computeContentHash: sha256(CRLF->LF + trim + "\0" + lang).
func normalizeContentHash(content, lang string) string {
	normalized := strings.TrimSpace(strings.ReplaceAll(content, "\r\n", "\n"))
	h := sha256.Sum256([]byte(normalized + "\x00" + lang))
	return hex.EncodeToString(h[:])
}

func Finalize(ctx context.Context, cfg Config, store FinalizeStore, prep *doc.PrepareResult, finalContent, userId, model string) error {
	manifest := concept.ExtractConceptManifest(finalContent, prep.Doc.Path)
	finalContent = manifest.CleanContent

	// Rejects empty or raw-JSON final outputs fail-closed so broken outputs are never marked PROCESSED.
	if strings.TrimSpace(finalContent) == "" {
		return fmt.Errorf("generated content is empty; refusing to mark PROCESSED: %s", prep.Doc.Path)
	}

	if pipeline.HasUnpeeledJSONShell(finalContent) {
		return fmt.Errorf("generated content contains unpeeled JSON container; refusing to mark PROCESSED: %s", prep.Doc.Path)
	}

	chunks := chunkInProcess(cfg, prep, finalContent)

	metaStore, hasMS := store.(TranscriptionMetadataStore)
	chunkStore, hasCS := store.(ChunkWriteStore)
	hasContent := strings.TrimSpace(finalContent) != ""
	if !hasMS || (hasContent && !hasCS) {
		return fmt.Errorf("finalize store lacks direct-write capability (metadata=%v, chunks=%v)", hasMS, hasCS)
	}
	if len(chunks) == 0 && hasContent {
		return fmt.Errorf("in-process chunking produced no chunks for non-empty content: %s", prep.Doc.Path)
	}
	if len(chunks) > 0 {
		if _, err := chunkStore.ReplaceDocumentChunks(ctx, prep.Doc.ID, chunks, ReplaceChunksOpts{
			DocPath:       prep.Doc.Path,
			DefaultBranch: cfg.DefaultBranch,
			BlueprintRole: chunker.DeriveDocumentRole(finalContent),
		}); err != nil {
			return fmt.Errorf("direct ReplaceDocumentChunks failed for %s: %w", prep.Doc.Path, err)
		}
	}
	summary := strings.TrimSpace(manifest.Summary)
	if summary == "" && len(manifest.Takeaways) > 0 {
		summary = strings.TrimSpace(strings.Join(manifest.Takeaways, " "))
	}
	if err := metaStore.StoreDocumentMetadata(ctx, repoIdOf(prep), prep.Doc.ID, prep.Doc.Path, finalContent, manifest, summary); err != nil {
		return fmt.Errorf("direct StoreDocumentMetadata failed for %s: %w", prep.Doc.Path, err)
	}

	if model == "" && !isZeroLlmOriginalPassThrough(prep) {
		model = DefaultAiModel
	}

	lang := derefStrPtr(prep.Effective.TargetLanguage)
	contentHash := normalizeContentHash(finalContent, lang)

	var contentId string
	// Degraded outputs skip the shared content layer so fallback content is never pinned and reused by fingerprint.
	if !prep.ContentDegraded {
		for attempt := 0; attempt < 2; attempt++ {
			id, err := store.UpsertContentLayer(ctx, contentHash, prep.Fingerprint, finalContent, lang, model)
			if err != nil {
				log.Printf("[transcription-finalize] content layer skipped for %s: %v", prep.Doc.Path, err)
				contentId = ""
				break
			}
			if err := store.AttachContentChunks(ctx, id, prep.Doc.ID); err != nil {
				if attempt == 0 && isForeignKeyViolation(err) {
					continue
				}
				log.Printf("[transcription-finalize] attach skipped for %s: %v", prep.Doc.Path, err)
				contentId = ""
				break
			}
			contentId = id
			break
		}
	} else {
		log.Printf("[transcription-finalize] degraded content skips content layer for %s (fingerprint pinning suppressed)", prep.Doc.Path)
	}

	if !cfg.ContentDualWrite && contentId != "" {
		_ = store.DeleteLegacyChunks(ctx, prep.Doc.ID)
	}

	var cidPtr *string
	if contentId != "" {
		cidPtr = &contentId
	}
	// Never clear legacy chunks when contentId is empty; CAS miss discards output instead of overwriting swaps.
	stamped, err := store.StampProcessed(ctx, prep.Doc.ID, finalContent, cidPtr, prep.Doc.Repository.GitSha, model, prep.GenerationLevel, cfg.ContentDualWrite)
	if err != nil {
		return fmt.Errorf("stamp: %w", err)
	}
	if !stamped {
		log.Printf("[transcription-finalize] stamp CAS miss, concurrent swap won for %s", prep.Doc.Path)
	}

	if stamped {
		if syncStore, ok := store.(TitleSyncStore); ok {
			lang := derefStrPtr(prep.Effective.TargetLanguage)
			if h1 := mdpat.FirstAtxHeading(finalContent); mdpat.UsableChapterH1(h1, mdpat.RequireCJKTitle(lang)) {
				if err := syncStore.SyncChapterTitleFromContent(ctx, prep.Doc.ID, h1); err != nil {
					log.Printf("[transcription-finalize] title sync skipped for %s: %v", prep.Doc.Path, err)
				}
			}
		}
	}

	_ = store.RecordTranscriptionModel(ctx, repoIdOf(prep), model)
	tokens := prep.TokensUsed
	if tokens <= 0 && prep.Usage.TotalTokens > 0 {
		tokens = prep.Usage.TotalTokens
	}
	if tokens > 0 {
		_ = store.RecordTranscriptionTokens(ctx, repoIdOf(prep), tokens)
	}
	return nil
}

func finalizeTranscription(ctx context.Context, cfg Config, store FinalizeStore, prep *doc.PrepareResult, finalContent, userId, model string) error {
	return Finalize(ctx, cfg, store, prep, finalContent, userId, model)
}

func isForeignKeyViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23503")
}

func chunkInProcess(cfg Config, prep *doc.PrepareResult, finalContent string) (chunks []chunker.MarkdownChunk) {
	if strings.TrimSpace(finalContent) == "" {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[transcription-finalize] in-process chunking panicked for %s: %v", prep.Doc.Path, r)
			chunks = nil
		}
	}()
	if prep.Doc.VirtualChapter {
		codeChunks := chunker.ChunkCodeModule(chunker.CodeModuleChunkRequest{
			ModuleName:  prep.Doc.Title,
			MdxContent:  finalContent,
			SourceFiles: prep.Doc.SourceFiles,
			MaxChars:    chunker.DefaultMaxChunkChars,
		})
		res := make([]chunker.MarkdownChunk, len(codeChunks))
		for i, cc := range codeChunks {
			var hp *string
			if cc.HeadingPath != "" {
				hpVal := cc.HeadingPath
				hp = &hpVal
			}
			res[i] = chunker.MarkdownChunk{
				Heading:     cc.Heading,
				HeadingPath: hp,
				Content:     cc.Content,
				ContentType: cc.ContentType,
			}
		}
		return res
	}
	req := chunker.MarkdownChunkRequest{
		Content:     finalContent,
		DocPath:     prep.Doc.Path,
		ParentTitle: prep.Chunker.ParentTitle,
	}
	if prep.Chunker.MaxTokens > 0 {
		req.MaxTokens = prep.Chunker.MaxTokens
	}
	if prep.Chunker.Overlap > 0 {
		req.Overlap = prep.Chunker.Overlap
	}
	result := chunker.ChunkMarkdown(req)
	if len(result) == 0 {
		return nil
	}
	return result
}

func repoIdOf(prep *doc.PrepareResult) string { return prep.Doc.RepositoryID }

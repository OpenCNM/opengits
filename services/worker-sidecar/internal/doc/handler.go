package doc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/concept"
	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

const defaultAiModel = "qwen3.6-flash"

type DocStoreChunksRequest struct {
	DocID        string                  `json:"docId"`
	Content      string                  `json:"content"`
	Chunks       []chunker.MarkdownChunk `json:"chunks,omitempty"`
	ChunksStored bool                    `json:"chunksStored,omitempty"`
	Options      map[string]any          `json:"options,omitempty"`
	ModuleName   string                  `json:"moduleName,omitempty"`
	SourceFiles  []string                `json:"sourceFiles,omitempty"`
}

type DocStoreChunksResponse struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

type Handler struct {
	cfg          Config
	store        Store
	prepareStore PrepareStore
	llmsStore    LlmsTxtStore
	patternsFunc func() Patterns
	// Optional post-finalize hook to sync LLM concept edges consistently across all ingestion paths.
	llmEdgeSync func(ctx context.Context, repositoryId, docId, content, userId string) int
}

func NewHandler(cfg Config, store Store, patternsFunc func() Patterns) *Handler {
	h := &Handler{
		cfg:          cfg,
		store:        store,
		patternsFunc: patternsFunc,
	}
	if store != nil {
		h.prepareStore = store
		h.llmsStore = store
	}
	return h
}

func (h *Handler) WithLlmsStore(ls LlmsTxtStore) *Handler {
	h.llmsStore = ls
	return h
}

func (h *Handler) SetLlmEdgeSync(fn func(ctx context.Context, repositoryId, docId, content, userId string) int) {
	h.llmEdgeSync = fn
}

func (h *Handler) getPatterns() Patterns {
	if h.patternsFunc != nil {
		return h.patternsFunc()
	}
	return nil
}

func (h *Handler) isVirtualChapter(docPath string) bool {
	p := h.getPatterns()
	if p != nil && p.IsVirtualChapterPath(docPath) {
		return true
	}
	return strings.HasPrefix(docPath, "chapters/")
}

func (h *Handler) resolveChunksToStore(docPath, cleanContent string, chunks []chunker.MarkdownChunk, moduleName string, sourceFiles []string, opts map[string]any) []chunker.MarkdownChunk {
	if len(chunks) > 0 || strings.TrimSpace(cleanContent) == "" {
		return chunks
	}
	if h.isVirtualChapter(docPath) {
		mName := extractModuleName(opts, moduleName)
		sFiles := extractSourceFiles(opts, sourceFiles)
		codeChunks := chunker.ChunkCodeModule(chunker.CodeModuleChunkRequest{
			ModuleName:  mName,
			MdxContent:  cleanContent,
			SourceFiles: sFiles,
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
	return chunker.ChunkMarkdown(chunker.MarkdownChunkRequest{
		Content: cleanContent,
		DocPath: docPath,
	})
}

func (h *Handler) HandleStoreChunks(w http.ResponseWriter, r *http.Request) {
	var req DocStoreChunksRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	req.DocID = strings.TrimSpace(req.DocID)
	if req.DocID == "" {
		httpx.Error(w, http.StatusBadRequest, "docId is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "doc store is not configured")
		return
	}

	ctx := r.Context()
	repoID, docPath, _, err := h.store.GetDocumentRepositoryInfo(ctx, req.DocID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, fmt.Sprintf("document not found: %v", err))
		return
	}

	manifest := concept.ExtractConceptManifest(req.Content, docPath)
	cleanContent := manifest.CleanContent
	if cleanContent == "" {
		cleanContent = req.Content
	}

	if !req.ChunksStored {
		chunksToStore := h.resolveChunksToStore(docPath, cleanContent, req.Chunks, req.ModuleName, req.SourceFiles, req.Options)
		if len(chunksToStore) > 0 {
			opts := ReplaceChunksOpts{
				DocPath:       docPath,
				DefaultBranch: h.cfg.DefaultBranch,
				BlueprintRole: chunker.DeriveDocumentRole(cleanContent),
			}
			_, err := h.store.ReplaceDocumentChunks(ctx, req.DocID, chunksToStore, opts)
			if err != nil {
				httpx.Error(w, http.StatusInternalServerError, fmt.Sprintf("replace chunks failed: %v", err))
				return
			}
		}
	}

	summary := strings.TrimSpace(manifest.Summary)
	if summary == "" && len(manifest.Takeaways) > 0 {
		summary = strings.TrimSpace(strings.Join(manifest.Takeaways, " "))
	}

	if err := h.store.StoreDocumentMetadata(ctx, repoID, req.DocID, docPath, cleanContent, manifest, summary); err != nil {
		httpx.Error(w, http.StatusInternalServerError, fmt.Sprintf("store document metadata failed: %v", err))
		return
	}

	if h.llmEdgeSync != nil && req.Options["skipLlmEdges"] != true {
		userId := ""
		if uid, ok := req.Options["userId"].(string); ok {
			userId = uid
		}
		sync, docId, content := h.llmEdgeSync, req.DocID, cleanContent
		repoId := repoID
		go func() {
			sctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			sync(sctx, repoId, docId, content, userId)
		}()
	}

	httpx.WriteJSON(w, http.StatusOK, DocStoreChunksResponse{OK: true})
}

func (h *Handler) HandleLlmsTxtGenerate(w http.ResponseWriter, r *http.Request) {
	var req LlmsTxtRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.RepositoryID == "" || req.Owner == "" || req.Repo == "" {
		httpx.Error(w, http.StatusBadRequest, "missing repositoryId, owner, or repo")
		return
	}

	store := h.llmsStore
	if store == nil && h.store != nil {
		store = h.store
	}
	if store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "llms.txt store unavailable")
		return
	}

	repoInfo, docs, err := store.GetLlmsTxtData(r.Context(), req.RepositoryID, req.UserID)
	if err != nil {
		log.Printf("[worker-sidecar] llms-txt get data failed: %v", err)
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		}
		httpx.Error(w, status, err.Error())
		return
	}

	resp, err := GenerateLlmsTxt(req, repoInfo, docs)
	if err != nil {
		log.Printf("[worker-sidecar] llms-txt generate failed: %v", err)
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, resp)
}

func normalizeContentHash(content, lang string) string {
	normalized := strings.TrimSpace(strings.ReplaceAll(content, "\r\n", "\n"))
	h := sha256.Sum256([]byte(normalized + "\x00" + lang))
	return hex.EncodeToString(h[:])
}

func isForeignKeyViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23503"
	}
	return strings.Contains(err.Error(), "23503")
}

func extractModuleName(opts map[string]any, fallback string) string {
	if trimmed := strings.TrimSpace(fallback); trimmed != "" {
		return trimmed
	}
	if mn, ok := opts["moduleName"].(string); ok && strings.TrimSpace(mn) != "" {
		return strings.TrimSpace(mn)
	}
	if bp, ok := opts["blueprint"].(map[string]any); ok {
		if mn, ok := bp["moduleName"].(string); ok && strings.TrimSpace(mn) != "" {
			return strings.TrimSpace(mn)
		}
		if t, ok := bp["title"].(string); ok && strings.TrimSpace(t) != "" {
			return strings.TrimSpace(t)
		}
	}
	return ""
}

func extractSourceFiles(opts map[string]any, existing []string) []string {
	if len(existing) > 0 {
		return existing
	}
	if sf := parseStringSlice(opts["sourceFiles"]); len(sf) > 0 {
		return sf
	}
	if bp, ok := opts["blueprint"].(map[string]any); ok {
		if sf := parseStringSlice(bp["sourceFiles"]); len(sf) > 0 {
			return sf
		}
	}
	return nil
}

func parseStringSlice(val any) []string {
	if sf, ok := val.([]string); ok && len(sf) > 0 {
		return sf
	}
	if sfI, ok := val.([]any); ok && len(sfI) > 0 {
		var out []string
		for _, item := range sfI {
			if str, ok := item.(string); ok && str != "" {
				out = append(out, str)
			}
		}
		return out
	}
	return nil
}

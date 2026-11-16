package transcription

import (
	"sync"

	"context"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

type fakeDocStore struct {
	mu sync.Mutex // 并发转录体同时回调：fake 状态写必须持锁（-race 门禁）

	repoId                 string
	docPath                string
	branch                 string
	getDocErr              error
	replaceChunksErr       error
	replaceChunksCalled    bool
	storedChunks           []chunker.MarkdownChunk
	storedChunksOpts       ReplaceChunksOpts
	storeMetadataErr       error
	storeMetadataCalled    bool
	storeMetadataSummary   string
	storeMetadataCleanText string
	upsertContentId        string
	upsertContentErr       error
	attachErr              error
	deleteLegacyErr        error
	deleteLegacyCalled     bool
	stampErr               error
	recordModelErr         error
	recordTokensErr        error
	recordedModel          string
	recordedTokens         int
	stampedDocId           string
	stampedContent         string
	stampedContentId       *string
	stampedGitSha          *string
	stampedModel           string
	stampedLevel           string
	stampedDualWrite       bool
}

func (f *fakeDocStore) ReplaceDocumentChunks(_ context.Context, _ string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replaceChunksCalled = true
	f.storedChunks = chunks
	f.storedChunksOpts = opts
	if f.replaceChunksErr != nil {
		return 0, f.replaceChunksErr
	}
	return len(chunks), nil
}

func (f *fakeDocStore) UpdateDocumentSummary(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeDocStore) SaveDocumentConcepts(_ context.Context, _, _, _, _ string, _ ExtractedManifestResult) ([]SavedConceptNode, error) {
	return []SavedConceptNode{}, nil
}

func (f *fakeDocStore) SyncDocumentCooccurrenceEdges(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeDocStore) SyncDocumentCurriculumEdge(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeDocStore) SaveDocumentQuizzes(_ context.Context, _, _ string, _ []CompanionQuiz) error {
	return nil
}

func (f *fakeDocStore) StoreDocumentMetadata(_ context.Context, _, _, _, content string, _ ExtractedManifestResult, summary string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.storeMetadataCalled = true
	f.storeMetadataSummary = summary
	f.storeMetadataCleanText = content
	return f.storeMetadataErr
}

func (f *fakeDocStore) GetDocumentRepositoryInfo(_ context.Context, _ string) (repoId, docPath, branch string, err error) {
	return f.repoId, f.docPath, f.branch, f.getDocErr
}

func (f *fakeDocStore) UpsertContentLayer(_ context.Context, _, _, _, _, _ string) (string, error) {
	if f.upsertContentErr != nil {
		return "", f.upsertContentErr
	}
	if f.upsertContentId != "" {
		return f.upsertContentId, nil
	}
	return "content-layer-uuid-1", nil
}

func (f *fakeDocStore) AttachContentChunks(_ context.Context, _, _ string) error {
	return f.attachErr
}

func (f *fakeDocStore) DeleteLegacyChunks(_ context.Context, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleteLegacyCalled = true
	return f.deleteLegacyErr
}

func (f *fakeDocStore) StampProcessed(_ context.Context, docId, content string, contentId *string, gitSha *string, model, generationLevel string, dualWrite bool) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stampedDocId = docId
	f.stampedContent = content
	f.stampedContentId = contentId
	f.stampedGitSha = gitSha
	f.stampedModel = model
	f.stampedLevel = generationLevel
	f.stampedDualWrite = dualWrite
	if f.stampErr != nil {
		return false, f.stampErr
	}
	return true, nil
}

func (f *fakeDocStore) RecordTranscriptionModel(_ context.Context, _, model string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recordedModel = model
	return f.recordModelErr
}

func (f *fakeDocStore) RecordTranscriptionTokens(_ context.Context, _ string, tokens int) error {
	f.recordedTokens += tokens
	return f.recordTokensErr
}

func (f *fakeDocStore) RecordTranscriptionDeadLetter(_ context.Context, _, _, _ string) error {
	return nil
}

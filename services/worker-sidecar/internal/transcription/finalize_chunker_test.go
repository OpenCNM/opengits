package transcription

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

type chunkerFakeStore struct {
	replaceErr  error
	replaceN    int
	replaceOpts ReplaceChunksOpts
	replaceArgs []chunker.MarkdownChunk
	metadataErr error
}

func (f *chunkerFakeStore) UpsertContentLayer(_ context.Context, _, _, content, _, _ string) (string, error) {
	return "content-id-1", nil
}
func (f *chunkerFakeStore) AttachContentChunks(context.Context, string, string) error { return nil }
func (f *chunkerFakeStore) DeleteLegacyChunks(context.Context, string) error          { return nil }
func (f *chunkerFakeStore) StampProcessed(_ context.Context, _ string, content string, _ *string, _ *string, _, _ string, _ bool) (bool, error) {
	return true, nil
}
func (f *chunkerFakeStore) RecordTranscriptionModel(context.Context, string, string) error {
	return nil
}
func (f *chunkerFakeStore) RecordTranscriptionTokens(context.Context, string, int) error { return nil }
func (f *chunkerFakeStore) SaveDocumentQuizzes(_ context.Context, _, _ string, _ []CompanionQuiz) error {
	return nil
}

func (f *chunkerFakeStore) StoreDocumentMetadata(_ context.Context, _, _, _, _ string, _ ExtractedManifestResult, _ string) error {
	return f.metadataErr
}
func (f *chunkerFakeStore) UpdateDocumentSummary(context.Context, string, string) error { return nil }
func (f *chunkerFakeStore) SaveDocumentConcepts(_ context.Context, _, _, _, _ string, _ ExtractedManifestResult) ([]SavedConceptNode, error) {
	return []SavedConceptNode{}, nil
}
func (f *chunkerFakeStore) SyncDocumentCooccurrenceEdges(context.Context, string, string) error {
	return nil
}
func (f *chunkerFakeStore) SyncDocumentCurriculumEdge(context.Context, string, string) error {
	return nil
}
func (f *chunkerFakeStore) ReplaceDocumentChunks(_ context.Context, _ string, chunks []chunker.MarkdownChunk, opts ReplaceChunksOpts) (int, error) {
	if f.replaceErr != nil {
		return 0, f.replaceErr
	}
	f.replaceArgs = chunks
	f.replaceOpts = opts
	f.replaceN = len(chunks)
	return len(chunks), nil
}

func chunkerTestPrep() *PrepareResult {
	p := &PrepareResult{}
	p.Doc.ID = "doc-1"
	p.Doc.Path = "docs/guide.md"
	p.Doc.RepositoryID = "repo-1"
	p.Chunker.MaxTokens = 2000
	p.Chunker.Overlap = 100
	return p
}

type titleSyncFakeStore struct {
	chunkerFakeStore
	syncedTitles []string
	syncErr      error
}

func (f *titleSyncFakeStore) SyncChapterTitleFromContent(_ context.Context, _, title string) error {
	f.syncedTitles = append(f.syncedTitles, title)
	return f.syncErr
}

const splitContent = "# 第一章：快速入门\n入门正文。\n\n# 第二章：进阶\n进阶正文。"

func TestFinalizeInProcessChunking(t *testing.T) {
	t.Run("直写成功：chunk 行经 ReplaceDocumentChunks 落库且零 web 兜底", func(t *testing.T) {
		p := chunkerTestPrep()
		p.Chunker.MaxTokens = 10
		p.Chunker.Overlap = 5
		store := &chunkerFakeStore{}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			p,
			splitContent,
			"user-1",
			"test-model",
		)
		require.NoError(t, err)
		require.NotEmpty(t, store.replaceArgs, "Go 必须直写 chunk 行")
		assert.Equal(t, "docs/guide.md", store.replaceOpts.DocPath)
	})

	t.Run("Go 直写失败：显式报错（Fail-Closed，不退 Node）", func(t *testing.T) {
		store := &chunkerFakeStore{replaceErr: errors.New("pg down")}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			chunkerTestPrep(),
			splitContent,
			"user-1",
			"test-model",
		)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "ReplaceDocumentChunks")
	})

	t.Run("元数据写入失败：显式报错（Fail-Closed）", func(t *testing.T) {
		store := &chunkerFakeStore{metadataErr: errors.New("meta down")}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			chunkerTestPrep(),
			"# Intro\nIntro text.",
			"user-1",
			"test-model",
		)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "StoreDocumentMetadata")
	})

	t.Run("空正文拒绝盖章（对齐 Node：绝不给空内容标 PROCESSED）", func(t *testing.T) {
		store := &chunkerFakeStore{}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			chunkerTestPrep(),
			"   ",
			"user-1",
			"test-model",
		)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "refusing to mark PROCESSED")
		assert.Empty(t, store.replaceArgs, "空正文不得触发 chunk 直写")
	})
}

func TestFinalizeUnpeeledJSONGateFailsClosed(t *testing.T) {
	tests := []struct {
		name    string
		content string
	}{
		{
			name:    "历史事故签名：尾部转义引号残缺的 lessonMarkdown 外壳",
			content: "{\n  \"lessonMarkdown\": \"---\\nsummary: 优化器对比\\n---\\n\\n# 第一章 优化器对比\\n\\n正文段落。\\\"\\n}",
		},
		{
			name:    "完整 JSON 外壳穿透上游（纵深防御：末道闸门兜住）",
			content: `{"lessonMarkdown": "# 第二章 进阶\n\nBody text."}`,
		},
		{
			name:    "嵌套 data 容器外壳",
			content: `{"data": {"markdown": "# 第三章 实战\n\nContent."}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &chunkerFakeStore{}
			err := finalizeTranscription(
				context.Background(),
				Config{DefaultBranch: "main"},
				store,
				chunkerTestPrep(),
				tt.content,
				"user-1",
				"test-model",
			)
			require.Error(t, err, "未解包 JSON 外壳必须拒绝盖章（Fail-Closed）")
			assert.Contains(t, err.Error(), "unpeeled JSON container")
			assert.Empty(t, store.replaceArgs, "脏 JSON 不得触发 chunk 直写")
		})
	}
}

func TestFinalizeTitleSyncFromContent(t *testing.T) {
	newPrep := func(lang string) *PrepareResult {
		p := chunkerTestPrep()
		p.Effective.TargetLanguage = &lang
		return p
	}

	t.Run("中文讲法下合格 H1 同步节点标题", func(t *testing.T) {
		store := &titleSyncFakeStore{}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			newPrep("zh-CN"),
			"# NanoGPT 速通优化器对比\n\n正文。",
			"user-1",
			"test-model",
		)
		require.NoError(t, err)
		require.Len(t, store.syncedTitles, 1, "合格 H1 必须触发标题同步")
		assert.Equal(t, "NanoGPT 速通优化器对比", store.syncedTitles[0])
	})

	t.Run("统计行 H1 不同步", func(t *testing.T) {
		store := &titleSyncFakeStore{}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			newPrep("zh-CN"),
			"# p=0.0049\n\n正文。",
			"user-1",
			"test-model",
		)
		require.NoError(t, err)
		assert.Empty(t, store.syncedTitles, "p=0.0049 噪声 H1 不得触发同步")
	})

	t.Run("中文讲法下英文 H1 不同步", func(t *testing.T) {
		store := &titleSyncFakeStore{}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			newPrep("zh-CN"),
			"# Record #360 FA3 build notes\n\n正文。",
			"user-1",
			"test-model",
		)
		require.NoError(t, err)
		assert.Empty(t, store.syncedTitles, "目标语言脚本不符的 H1 不得触发同步")
	})

	t.Run("英文讲法下英文 H1 正常同步", func(t *testing.T) {
		store := &titleSyncFakeStore{}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			newPrep("en"),
			"# Training Data Pipeline\n\nBody.",
			"user-1",
			"test-model",
		)
		require.NoError(t, err)
		require.Len(t, store.syncedTitles, 1)
		assert.Equal(t, "Training Data Pipeline", store.syncedTitles[0])
	})

	t.Run("同步失败吞错不回滚 PROCESSED", func(t *testing.T) {
		store := &titleSyncFakeStore{syncErr: errors.New("db down")}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			newPrep("zh-CN"),
			"# 合格中文标题\n\n正文。",
			"user-1",
			"test-model",
		)
		require.NoError(t, err, "标题同步失败不得使转录任务失败")
	})

	t.Run("store 无 TitleSyncStore 能力零 panic", func(t *testing.T) {
		store := &chunkerFakeStore{}
		err := finalizeTranscription(
			context.Background(),
			Config{DefaultBranch: "main"},
			store,
			newPrep("zh-CN"),
			"# 合格中文标题\n\n正文。",
			"user-1",
			"test-model",
		)
		require.NoError(t, err)
	})
}

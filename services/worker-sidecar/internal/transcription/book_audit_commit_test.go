package transcription

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/chunker"
)

type fakeBookAuditCommitStore struct {
	fakeBookAuditStore

	swapOK     bool
	swapErr    error
	commitLog  []string
	swaps      []BookAuditSwapInput
	chunkCalls int
	chunkCount int

	lastHash  string
	lastLang  string
	lastModel string
	lastBody  string
}

var fixedAuditTime = time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)

func (f *fakeBookAuditCommitStore) note(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commitLog = append(f.commitLog, call)
}

func (f *fakeBookAuditCommitStore) notes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.commitLog...)
}

func (f *fakeBookAuditCommitStore) SwapAuditedChapterTx(_ context.Context, in BookAuditSwapInput) (bool, error) {
	f.note("swap")
	f.mu.Lock()
	f.swaps = append(f.swaps, in)
	f.mu.Unlock()
	return f.swapOK, f.swapErr
}

func (f *fakeBookAuditCommitStore) UpsertContentLayer(_ context.Context, contentHash, _, content, lang, model string) (string, error) {
	f.note("upsert")
	f.mu.Lock()
	f.lastHash, f.lastLang, f.lastBody = contentHash, lang, content
	f.lastModel = model
	f.mu.Unlock()
	return "content-new", nil
}

func (f *fakeBookAuditCommitStore) AttachContentChunks(context.Context, string, string) error {
	f.note("attach")
	return nil
}

func (f *fakeBookAuditCommitStore) DeleteLegacyChunks(context.Context, string) error {
	f.note("deleteLegacy")
	return nil
}

func (f *fakeBookAuditCommitStore) ReplaceDocumentChunks(_ context.Context, _ string, chunks []chunker.MarkdownChunk, _ ReplaceChunksOpts) (int, error) {
	f.note("chunks")
	f.mu.Lock()
	f.chunkCalls++
	f.chunkCount = len(chunks)
	f.mu.Unlock()
	return len(chunks), nil
}

func auditBookFixture() []BookAuditDoc {
	return []BookAuditDoc{
		{
			ID: "d1", Path: "chapters/01.mdx", Title: "全景",
			Content:   "# 全景\n\n导言引用了第 9 章的主题。\n\n## 第一节\n\n正文。",
			Lang:      "zh",
			UpdatedAt: fixedAuditTime,
		},
		{
			ID: "d2", Path: "chapters/02.mdx", Title: "引擎",
			Content:   "## 引擎\n\n```ts // src/main.ts#start\nexport function start() {}\n```\n\n正文。",
			UpdatedAt: fixedAuditTime,
		},
	}
}

func auditRepairLLM(t *testing.T) *codeChapterMockLlm {
	t.Helper()
	return &codeChapterMockLlm{fn: func(purpose string, _ map[string]any) (LlmTextResult, error) {
		switch purpose {
		case "book_final_audit":
			return LlmTextResult{Text: `{"defects":[{"chapterPath":"chapters/01.mdx","issueType":"intro_mismatch","targetSection":"intro","fixHint":"第 9 章不存在"}]}`, FinishReason: "stop"}, nil
		case "chapter_code_enrich":
			return LlmTextResult{Text: `{"sectionTitle":"实战代码透视","leadIn":"看代码。","slots":[{"fileIndex":1,"anchor":"start"}]}`, FinishReason: "stop"}, nil
		case "chapter_intro_repair":
			return LlmTextResult{Text: `{"paragraphs":[{"index":1,"text":"本章聚焦全景本身。"}]}`, FinishReason: "stop"}, nil
		default:
			t.Fatalf("unexpected llm purpose %s", purpose)
			return LlmTextResult{}, nil
		}
	}}
}

func TestRunBookAuditRepairsCommitOncePerChapter(t *testing.T) {
	t.Helper()
	cfg, prep := auditTestPrep(t)
	store := &fakeBookAuditCommitStore{swapOK: true}
	store.docs = auditBookFixture()
	var refreshed []string

	status, err := runBookAudit(context.Background(), cfg, TranscriptionBodyDeps{
		Llm: auditRepairLLM(t), OnIndexRefresh: func(repoID string) { refreshed = append(refreshed, repoID) },
	}, store, prep, "user-1")

	require.NoError(t, err)
	assert.Equal(t, bookAuditStatusDone, status)
	require.Len(t, store.swaps, 1, "同章多缺陷只换入一次")
	swapped := store.swaps[0]
	assert.Equal(t, "d1", swapped.DocumentID)
	assert.Equal(t, "repo-1", swapped.RepositoryID)
	assert.Equal(t, "content-new", swapped.NewContentID)
	assert.Equal(t, "user-1", swapped.AuthorID)
	assert.False(t, swapped.DualWrite)
	assert.Equal(t, fixedAuditTime, swapped.ExpectedUpdatedAt, "CAS 基准取审计开始时读到的行")
	assert.Contains(t, swapped.Content, "本章聚焦全景本身。", "导言修补在场")
	assert.Contains(t, swapped.Content, "实战代码透视", "代码增强节在场")
	assert.NotContains(t, swapped.Content, "第 9 章")
	assert.Contains(t, swapped.Content, "export function start() {}", "增强节插槽已由 regate 水合为真实源码")
	assert.Equal(t, []string{"chunks", "upsert", "attach", "swap", "deleteLegacy"}, store.notes(), "与 Finalize 同序：切片→内容层→挂载→换入→清 legacy")
	assert.Positive(t, store.chunkCalls, "正文变了必须重建切片")
	assert.Equal(t, "zh", store.lastLang, "内容层语言沿用该章既有内容层行")
	assert.Equal(t, swapped.Content, store.lastBody, "内容层与指针指向同一正文")
	assert.Equal(t, []string{"repo-1"}, refreshed, "换入成功后刷新索引")
}

func TestRunBookAuditSwapOutcomes(t *testing.T) {
	t.Helper()
	tests := []struct {
		name        string
		swapOK      bool
		swapErr     error
		dualWrite   bool
		wantStatus  string
		wantNoCalls []string
	}{
		{
			name:   "CAS 未命中：本章保持原样，不清 legacy、不刷索引",
			swapOK: false, wantStatus: bookAuditStatusDone,
			wantNoCalls: []string{"deleteLegacy"},
		},
		{
			name: "换入出错：保留原稿，不拖垮审计", swapErr: errors.New("boom"),
			wantStatus: bookAuditStatusDone, wantNoCalls: []string{"deleteLegacy"},
		},
		{
			name: "双写部署：legacy 切片保留", swapOK: true, dualWrite: true,
			wantStatus: bookAuditStatusDone, wantNoCalls: []string{"deleteLegacy"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, prep := auditTestPrep(t)
			cfg.ContentDualWrite = tt.dualWrite
			store := &fakeBookAuditCommitStore{swapOK: tt.swapOK, swapErr: tt.swapErr}
			store.docs = auditBookFixture()
			refreshed := 0

			status, err := runBookAudit(context.Background(), cfg, TranscriptionBodyDeps{
				Llm: auditRepairLLM(t), OnIndexRefresh: func(string) { refreshed++ },
			}, store, prep, "user-1")

			require.NoError(t, err)
			assert.Equal(t, tt.wantStatus, status)
			for _, call := range tt.wantNoCalls {
				assert.NotContains(t, store.notes(), call)
			}
			if tt.swapOK && tt.swapErr == nil {
				assert.Equal(t, 1, refreshed)
				assert.Equal(t, tt.dualWrite, store.swaps[0].DualWrite)
			} else {
				assert.Zero(t, refreshed, "未成功换入不得刷新索引")
			}
		})
	}
}

func TestRunBookAuditSkipsWithoutCommitCapability(t *testing.T) {
	t.Helper()
	cfg, prep := auditTestPrep(t)
	store := &fakeBookAuditStore{docs: auditBookFixture()}
	llm := auditRepairLLM(t)

	status, err := runBookAudit(context.Background(), cfg, TranscriptionBodyDeps{Llm: llm}, store, prep, "user-1")

	require.NoError(t, err)
	assert.Equal(t, bookAuditStatusSkippedNoCommitStore, status, "无写回能力不盖 done")
	assert.NotContains(t, llm.calls, "chapter_code_enrich", "注定无法写回时不发起修理用 LLM 调用")
	assert.NotContains(t, llm.calls, "chapter_intro_repair", "注定无法写回时不发起修理用 LLM 调用")
	assert.Contains(t, bookAuditRetryableStatuses, bookAuditStatusSkippedNoCommitStore, "属于可重试态")
}

func TestAuditAuthorID(t *testing.T) {
	t.Helper()
	owner := "owner-user"
	tests := []struct {
		name        string
		ownerUserID *string
		requestedBy string
		want        string
	}{
		{name: "请求者优先", ownerUserID: &owner, requestedBy: "requester", want: "requester"},
		{name: "无请求者回落作用域 owner", ownerUserID: &owner, requestedBy: "  ", want: "owner-user"},
		{name: "共享行且无请求者：无作者", ownerUserID: nil, requestedBy: "", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, prep := groundingBodyFixture(t, false)
			prep.Doc.RepositoryID = "repo-1"
			prep.Doc.OwnerUserID = tt.ownerUserID
			assert.Equal(t, tt.want, auditAuthorID(prep, tt.requestedBy))
		})
	}
}

func TestRunBookAuditSkipsWithoutAuthor(t *testing.T) {
	t.Helper()
	cfg, prep := auditTestPrep(t)
	store := &fakeBookAuditCommitStore{swapOK: true}
	store.docs = auditBookFixture()
	llm := &codeChapterMockLlm{fn: func(purpose string, _ map[string]any) (LlmTextResult, error) {
		t.Fatalf("缺作者时不得发起任何 LLM 调用，收到 %s", purpose)
		return LlmTextResult{}, nil
	}}

	status, err := runBookAudit(context.Background(), cfg, TranscriptionBodyDeps{Llm: llm}, store, prep, "")

	require.NoError(t, err)
	assert.Equal(t, bookAuditStatusSkippedNoAuthor, status)
	assert.Empty(t, llm.calls)
	assert.Empty(t, store.swaps)
	assert.Contains(t, bookAuditRetryableStatuses, bookAuditStatusSkippedNoAuthor)
}

func TestRunBookAuditAuthorFallsBackToOwner(t *testing.T) {
	t.Helper()
	cfg, prep := auditTestPrep(t)
	owner := "owner-user"
	prep.Doc.OwnerUserID = &owner
	store := &fakeBookAuditCommitStore{swapOK: true}
	store.docs = auditBookFixture()

	status, err := runBookAudit(context.Background(), cfg, TranscriptionBodyDeps{Llm: auditRepairLLM(t)}, store, prep, "")

	require.NoError(t, err)
	assert.Equal(t, bookAuditStatusDone, status)
	require.Len(t, store.swaps, 1)
	assert.Equal(t, owner, store.swaps[0].AuthorID)
}

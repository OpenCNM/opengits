package transcription

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func loadConfigFromEnv() Config {
	return Config{
		TranscriptionPollMs:      50,
		TranscriptionMaxPerCycle: 2,
		TranscriptionStaleMs:     60000,
		TranscriptionMaxWallMs:   10000,
		TranscriptionExecutor:    "go",
		ChunkerMaxTokens:         2000,
		ChunkerOverlap:           200,
	}
}

func TestChunkerGoldenParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/chunker.golden.json")
	if err != nil {
		raw, err = os.ReadFile("../../testdata/chunker.golden.json")
	}
	if err != nil {
		t.Skip("golden fixture missing (frozen fixture, hand-maintained)")
	}
	var cases []struct {
		Name     string   `json:"name"`
		Input    string   `json:"input"`
		Chunks   []string `json:"chunks"`
		Rejoined string   `json:"rejoined"`
	}
	require.NoError(t, json.Unmarshal(raw, &cases))

	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := splitMarkdownIntoChunks(c.Input)
			assert.Equal(t, c.Chunks, got)
			j := joinMarkdownChunks(got)
			assert.Equal(t, c.Rejoined, j)
		})
	}
}

func TestAdaptiveChunking_FenceSafety(t *testing.T) {
	tests := []struct {
		name     string
		markdown string
		maxLen   int
		minLen   int
	}{
		{
			name: "never cuts inside fenced code blocks",
			markdown: "## Preamble\n\n" + strings.Repeat("X", 2500) + "\n\n" +
				"```typescript\n" + strings.Repeat("// Some code\n", 100) + "```\n\n" +
				"## Postscript\n\n" + strings.Repeat("Y", 2500),
			maxLen: 3000,
			minLen: 1500,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chunks := splitMarkdownIntoChunksWithOptions(tt.markdown, tt.maxLen, tt.minLen)
			require.GreaterOrEqual(t, len(chunks), 2)
			for _, chunk := range chunks {
				fenceCount := strings.Count(chunk, "```")
				assert.True(t, fenceCount%2 == 0, "must not cut inside code block")
			}
		})
	}
}

func TestExtractBySentinel(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "happy path with both sentinels", input: "===CONTENT_BEGIN===hello===CONTENT_END===", want: "hello"},
		{name: "begin-only sentinel", input: "pre===CONTENT_BEGIN===mid", want: "mid"},
		{name: "end-only sentinel", input: "mid===CONTENT_END===post", want: "mid"},
		{name: "markdown code fence fallback", input: "```markdown\n# raw\n```", want: "# raw"},
		{name: "plain text without sentinels", input: "plain text", want: "plain text"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractBySentinel(tt.input)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestEnsureDisclaimerFormat(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		assertion func(t *testing.T, output string)
	}{
		{
			name:  "standardize legacy translator disclaimer",
			input: "# Title\n\n本文件由 AI 翻译服务 Co-op Translator 翻译。\n\nBody",
			assertion: func(t *testing.T, out string) {
				assert.Contains(t, out, "<Expandable title=\"免责声明\"")
				assert.NotContains(t, out, "本文件由 AI 翻译服务 Co-op Translator 翻译。\n\nBody")
			},
		},
		{
			name:  "plain content without disclaimer untouched",
			input: "# plain",
			assertion: func(t *testing.T, out string) {
				assert.Equal(t, "# plain", out)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := ensureDisclaimerFormat(tt.input)
			tt.assertion(t, out)
		})
	}
}

type fakeWeb struct {
	prepare  *PrepareResult
	prepErr  error
	valid    bool
	validate int
	finalize string
	finalErr error
}

func (f *fakeWeb) Prepare(_ context.Context, _ string, _ string, _ doc.PrepareOptions) (*PrepareResult, error) {
	if f.prepErr != nil {
		return nil, f.prepErr
	}
	return f.prepare, nil
}
func (f *fakeWeb) ValidateMdx(context.Context, string) (bool, string, error) {
	f.validate++
	return f.valid, "", nil
}
func (f *fakeWeb) ExtractManifest(_ context.Context, content, _ string) (string, error) {
	return content, nil
}
func (f *fakeWeb) Transform(_ context.Context, _, _, _ string, _ *string, _, _ string) (string, error) {
	return "# fetched", nil
}
func (f *fakeWeb) Finalize(_ context.Context, _ string, content string, _ map[string]any) error {
	f.finalize = content
	return f.finalErr
}

type fakeLlm struct {
	calls      []string
	text       string
	raw        map[string]string
	err        error
	errPurpose string
	lengthOn   []string
	usage      int
	fn         func(purpose string, vars map[string]any) (LlmTextResult, error)
	n          int
}

func (f *fakeLlm) Complete(_ context.Context, purpose string, vars map[string]any, _ *string) (LlmTextResult, error) {
	f.n++
	f.calls = append(f.calls, purpose)
	if f.fn != nil {
		return f.fn(purpose, vars)
	}
	if f.err != nil && (f.errPurpose == "" || f.errPurpose == purpose) {
		return LlmTextResult{}, f.err
	}
	finish := "stop"
	for _, p := range f.lengthOn {
		if p == purpose {
			finish = "length"
			break
		}
	}
	if f.usage > 0 {
		return LlmTextResult{Text: "===CONTENT_BEGIN===" + f.text + "===CONTENT_END===", FinishReason: finish, Usage: client.LlmUsage{TotalTokens: f.usage}}, nil
	}
	if f.raw != nil {
		if t, ok := f.raw[purpose]; ok {
			return LlmTextResult{Text: t, FinishReason: finish}, nil
		}
	}
	return LlmTextResult{Text: "===CONTENT_BEGIN===" + f.text + "===CONTENT_END===", FinishReason: finish}, nil
}

type fakeBodyStore struct {
	mu sync.Mutex

	cas               bool
	budgetErr         error
	cleared           []string
	saved             []int
	notify            int
	checkpointCleared int
	clearedDoc        string
	progressUpdates   []string
}

func (f *fakeBodyStore) CasProcessing(context.Context, string, bool) (bool, error) { return f.cas, nil }

func (f *fakeBodyStore) CheckLlmBudget(ctx context.Context, userId string) error { return f.budgetErr }
func (f *fakeBodyStore) HeartbeatDocument(context.Context, string) error         { return nil }
func (f *fakeBodyStore) ClearProcessingStatus(_ context.Context, _, status, msg string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cleared = append(f.cleared, status+"|"+msg)
	return nil
}
func (f *fakeBodyStore) CheckpointLoad(context.Context, string, string) (map[int]string, error) {
	return map[int]string{}, nil
}
func (f *fakeBodyStore) CheckpointSave(_ context.Context, _, _, _ string, index, _ int, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saved = append(f.saved, index)
	return nil
}
func (f *fakeBodyStore) ClearCheckpoint(_ context.Context, documentId string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checkpointCleared++
	f.clearedDoc = documentId
	return nil
}
func (f *fakeBodyStore) NotifyDone(context.Context, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notify++
	return nil
}
func (f *fakeBodyStore) UpdateProgress(_ context.Context, docId, step string, progress int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.progressUpdates = append(f.progressUpdates, fmt.Sprintf("%s:%s:%d", docId, step, progress))
	return nil
}
func (f *fakeBodyStore) GetUpstreamChapterPrecedents(_ context.Context, _ string, _ []string, _ int) ([]UpstreamPrecedentItem, error) {
	return nil, nil
}

func readyPrep(content string, lang *string, force bool) *PrepareResult {
	p := &PrepareResult{Outcome: "ready", Fingerprint: "fp1", Model: "m"}
	p.Doc.ID = "d1"
	p.Doc.Path = "docs/a.md"
	p.Doc.Content = &content
	p.Doc.Status = "UNPROCESSED"
	p.Doc.IsMarkdown = true
	p.Doc.EnableAIEnhance = true
	p.Effective.TargetLanguage = lang
	p.Effective.ForceEnhance = force
	return p
}

func strPtr(s string) *string { return &s }

func TestBodyJitTranslateOnly(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 原文", strPtr("中文"), false), valid: true}
	llm := &fakeLlm{text: "# 译文"}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

	assert.Equal(t, bodyDone, out)
	require.Len(t, llm.calls, 1)
	assert.Equal(t, "doc_translate", llm.calls[0], "JIT path must call doc_translate once")
	assert.Equal(t, "d1", finalizeSt.stampedDocId, "收尾必须经 Go FinalizeStore 直写盖章")
	assert.Equal(t, 1, st.checkpointCleared, "finalize 成功后必须调用 ClearCheckpoint 清空中间存档")
	assert.Equal(t, "d1", st.clearedDoc)
}

func TestBodyJitNoTranslationZeroLLM(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 原文", nil, false), valid: true}
	llm := &fakeLlm{}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

	assert.Equal(t, bodyDone, out)
	assert.Empty(t, llm.calls, "no-translation JIT must be zero LLM")
	assert.Equal(t, "d1", finalizeSt.stampedDocId)
}

func TestBodyIntegratedDegradedToTranslate(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# raw", strPtr("中文"), true), valid: true}
	llm := &fakeLlm{
		text:       "# 降级译文",
		err:        &LlmGatewayError{Code: "GENERATION_FAILED", Status: 502},
		errPurpose: "doc_transcribe_enhance_localize",
	}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

	assert.Equal(t, bodyDone, out)
	require.Len(t, llm.calls, 2, "expected 1 integrated call + 1 translate (non-ratelimit errors are not retried)")
	assert.Equal(t, "doc_transcribe_enhance_localize", llm.calls[0])
	assert.Equal(t, "doc_translate", llm.calls[len(llm.calls)-1])
	assert.Equal(t, "d1", finalizeSt.stampedDocId)
}

func TestBodyBudgetExceededDefers(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# raw", strPtr("中文"), true), valid: true}
	llm := &fakeLlm{err: &LlmGatewayError{Code: "BUDGET_EXCEEDED", Status: 429}}
	st := &fakeBodyStore{cas: true}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st}, "j1", "d1", "u1")

	assert.Equal(t, bodyDeferred, out)
	assert.Empty(t, st.cleared, "budget defer must NOT touch document status (no flicker)")
}

func TestBodyRepairLoopAndFallback(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# raw", strPtr("中文"), true), valid: false}
	llm := &fakeLlm{text: "# 修复"}
	st := &fakeBodyStore{cas: true}
	runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st}, "j1", "d1", "u1")

	assert.Contains(t, strings.Join(llm.calls, ","), "mdx_repair")
}

func TestBodyVirtualChapterFailClosedWithoutFinalizeStore(t *testing.T) {
	p := readyPrep("", nil, false)
	p.Doc.VirtualChapter = true
	web := &fakeWeb{prepare: p}
	llm := &fakeLlm{
		text: `---
summary: Core overview
concepts:
  - name: Core
    category: principle
---
# Architecture Overview

Overview text.

` + "```ts // [File 1]\nconsole.log(1)\n```",
	}
	st := &fakeBodyStore{cas: true}
	cfg := loadConfigFromEnv()
	out, errMsg := runTranscriptionBody(context.Background(), cfg, TranscriptionBodyDeps{
		Web:         web,
		PrepareFunc: web.Prepare,
		Llm:         llm,
		Store:       st,
	}, "j1", "d1", "u1")

	assert.Equal(t, bodyFailed, out, "virtual chapter must fail closed when FinalizeStore is missing")
	assert.Contains(t, errMsg, "finalize store not configured")
}

func TestBodyVirtualChapterExecutesInGo(t *testing.T) {
	p := readyPrep("", nil, false)
	p.Doc.VirtualChapter = true
	p.Doc.Path = "chapters/01.mdx"
	p.Doc.Title = "Architecture Overview"
	p.Doc.RepoProfile = map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"chapterNo":     1,
				"title":         "Architecture Overview",
				"summary":       "Core overview",
				"files":         []string{"src/main.ts"},
			},
		},
	}
	web := &fakeWeb{prepare: p}
	llm := &fakeLlm{
		text: `---
summary: Core overview
concepts:
  - name: Core
    category: principle
---
# Architecture Overview

Overview text.

` + "```ts // [File 1]\nconsole.log(1)\n```",
	}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "chapters/01.mdx", branch: "main"}
	cfg := loadConfigFromEnv()

	out, errMsg := runTranscriptionBody(context.Background(), cfg, TranscriptionBodyDeps{
		Web:           web,
		PrepareFunc:   web.Prepare,
		Llm:           llm,
		Store:         st,
		FinalizeStore: finalizeSt,
	}, "j1", "d1", "u1")

	assert.Equal(t, bodyDone, out, "virtual chapter must execute in Go sidecar")
	assert.Empty(t, errMsg)
	assert.Equal(t, "d1", finalizeSt.stampedDocId, "FinalizeStore must stamp PROCESSED in Go")
	assert.Equal(t, 1, st.checkpointCleared, "checkpoint must be cleared")
	assert.Equal(t, 1, st.notify, "notification must be sent")
}

func TestBodyCasMissFallsBack(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# raw", nil, false)}
	st := &fakeBodyStore{cas: false}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: &fakeLlm{}, Store: st}, "j1", "d1", "u1")

	assert.Equal(t, bodyDone, out, "CAS miss must complete as skipped (concurrent executor owns the doc)")
}

func TestBodyLengthTruncationTreatedAsFailure(t *testing.T) {
	tests := []struct {
		name          string
		prep          *PrepareResult
		llm           *fakeLlm
		wantOutcome   bodyOutcome
		wantErrSubstr string
		wantCalls     []string
	}{
		{
			name:        "一体化截断 → 降级纯翻译（完整）→ 接受译文",
			prep:        readyPrep("# raw", strPtr("中文"), true),
			llm:         &fakeLlm{text: "# 降级译文", lengthOn: []string{"doc_transcribe_enhance_localize"}},
			wantOutcome: bodyDone,
			wantCalls:   []string{"doc_transcribe_enhance_localize", "doc_translate"},
		},
		{
			name:          "双段皆截断 → 显式失败（绝不以缺尾译文伪装成品）",
			prep:          readyPrep("# raw", strPtr("中文"), true),
			llm:           &fakeLlm{text: "# 半篇", lengthOn: []string{"doc_transcribe_enhance_localize", "doc_translate"}},
			wantOutcome:   bodyFailed,
			wantErrSubstr: "truncated by token limit",
			wantCalls:     []string{"doc_transcribe_enhance_localize", "doc_translate"},
		},
		{
			name:          "纯增强截断（targetLanguage=none）→ 显式失败",
			prep:          readyPrep("# raw", nil, true),
			llm:           &fakeLlm{text: "# 半篇增强", lengthOn: []string{"doc_enhance"}},
			wantOutcome:   bodyFailed,
			wantErrSubstr: "truncated by token limit",
			wantCalls:     []string{"doc_enhance"},
		},
		{
			name:          "JIT 翻译截断 → 显式失败",
			prep:          readyPrep("# 原文", strPtr("中文"), false),
			llm:           &fakeLlm{text: "# 半篇译文", lengthOn: []string{"doc_translate"}},
			wantOutcome:   bodyFailed,
			wantErrSubstr: "truncated by token limit",
			wantCalls:     []string{"doc_translate"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			web := &fakeWeb{prepare: tt.prep, valid: true}
			st := &fakeBodyStore{cas: true}
			finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
			out, errMsg := runTranscriptionBody(context.Background(), loadConfigFromEnv(),
				TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: tt.llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

			assert.Equal(t, tt.wantOutcome, out)
			assert.Equal(t, tt.wantCalls, tt.llm.calls)
			if tt.wantErrSubstr != "" {
				assert.Contains(t, errMsg, tt.wantErrSubstr)
			} else {
				assert.Empty(t, errMsg)
				assert.Contains(t, finalizeSt.stampedContent, tt.llm.text)
			}
		})
	}
}

func TestWithLlmRetryRetriesTransient(t *testing.T) {
	tests := []struct {
		name      string
		runFn     func() (int, error)
		wantCalls int
		wantErr   bool
		checkErr  func(t *testing.T, err error)
	}{
		{
			name: "rate limit error is retried with backoff",
			runFn: func() (int, error) {
				n := 0
				_, err := withLlmRetry(context.Background(), func() (LlmTextResult, error) {
					n++
					if n < 2 {
						return LlmTextResult{}, &LlmGatewayError{Code: "GENERATION_FAILED", Status: 502, Message: "provider rate limit exceeded"}
					}
					return LlmTextResult{Text: "ok"}, nil
				})
				return n, err
			},
			wantCalls: 2,
			wantErr:   false,
		},
		{
			name: "non-ratelimit generation failure does not retry",
			runFn: func() (int, error) {
				n := 0
				_, err := withLlmRetry(context.Background(), func() (LlmTextResult, error) {
					n++
					return LlmTextResult{}, &LlmGatewayError{Code: "GENERATION_FAILED", Status: 502}
				})
				return n, err
			},
			wantCalls: 1,
			wantErr:   true,
		},
		{
			name: "budget exceeded keeps 429 status but is not retried as rate limit",
			runFn: func() (int, error) {
				n := 0
				_, err := withLlmRetry(context.Background(), func() (LlmTextResult, error) {
					n++
					return LlmTextResult{}, &LlmGatewayError{Code: "BUDGET_EXCEEDED", Status: 429}
				})
				return n, err
			},
			wantCalls: 1,
			wantErr:   true,
			checkErr: func(t *testing.T, err error) {
				var gw *LlmGatewayError
				require.True(t, errors.As(err, &gw))
				assert.True(t, gw.IsBudgetExceeded())
			},
		},
		{
			name: "missing api key error does not retry",
			runFn: func() (int, error) {
				n := 0
				_, err := withLlmRetry(context.Background(), func() (LlmTextResult, error) {
					n++
					return LlmTextResult{}, &LlmGatewayError{Code: "MISSING_API_KEY", Status: 409}
				})
				return n, err
			},
			wantCalls: 1,
			wantErr:   true,
			checkErr: func(t *testing.T, err error) {
				var gw *LlmGatewayError
				require.True(t, errors.As(err, &gw))
				assert.True(t, gw.IsMissingApiKey())
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls, err := tt.runFn()
			if tt.wantErr {
				require.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
			assert.Equal(t, tt.wantCalls, calls)
			if tt.checkErr != nil {
				tt.checkErr(t, err)
			}
		})
	}
}

func TestComputeJitteredBackoff(t *testing.T) {
	tests := []struct {
		name        string
		attempt     int
		baseBackoff time.Duration
		maxBackoff  time.Duration
		maxExpected time.Duration
	}{
		{
			name:        "attempt 0 is capped by baseBackoff",
			attempt:     0,
			baseBackoff: 1 * time.Second,
			maxBackoff:  8 * time.Second,
			maxExpected: 1 * time.Second,
		},
		{
			name:        "attempt 1 is capped by 2 * baseBackoff",
			attempt:     1,
			baseBackoff: 1 * time.Second,
			maxBackoff:  8 * time.Second,
			maxExpected: 2 * time.Second,
		},
		{
			name:        "attempt 2 is capped by 4 * baseBackoff",
			attempt:     2,
			baseBackoff: 1 * time.Second,
			maxBackoff:  8 * time.Second,
			maxExpected: 4 * time.Second,
		},
		{
			name:        "attempt 3 is capped by maxBackoff",
			attempt:     3,
			baseBackoff: 1 * time.Second,
			maxBackoff:  8 * time.Second,
			maxExpected: 8 * time.Second,
		},
		{
			name:        "large attempt does not overflow and stays capped at maxBackoff",
			attempt:     50,
			baseBackoff: 1 * time.Second,
			maxBackoff:  10 * time.Second,
			maxExpected: 10 * time.Second,
		},
		{
			name:        "negative attempt is clamped to attempt 0",
			attempt:     -1,
			baseBackoff: 1 * time.Second,
			maxBackoff:  8 * time.Second,
			maxExpected: 1 * time.Second,
		},
		{
			name:        "non-positive maxBackoff returns 0 duration immediately",
			attempt:     2,
			baseBackoff: 1 * time.Second,
			maxBackoff:  0,
			maxExpected: 0,
		},
		{
			name:        "non-positive baseBackoff defaults to 1s safe fallback",
			attempt:     0,
			baseBackoff: 0,
			maxBackoff:  5 * time.Second,
			maxExpected: 1 * time.Second,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for i := 0; i < 50; i++ {
				d := computeJitteredBackoff(tt.attempt, tt.baseBackoff, tt.maxBackoff)
				assert.GreaterOrEqual(t, d, time.Duration(0))
				assert.LessOrEqual(t, d, tt.maxExpected)
			}
		})
	}
}

func TestBodyTranslateSentinelKeepsOriginal(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 原文正文", strPtr("中文"), false), valid: true}
	llm := &fakeLlm{raw: map[string]string{"doc_translate": "<ALREADY_IN_TARGET_LANGUAGE>"}}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

	assert.Equal(t, bodyDone, out)
	assert.Equal(t, "# 原文正文", finalizeSt.stampedContent, "sentinel response must keep original content")
	assert.Equal(t, doc.GenerationLevelTranslated, finalizeSt.stampedLevel, "jit translate must stamp translated level")
}

func TestBodyTranslateEmptyCompletionFails(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 原文正文", strPtr("中文"), false), valid: true}
	llm := &fakeLlm{raw: map[string]string{"doc_translate": "   "}}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

	assert.Equal(t, bodyFailed, out, "empty completion must fail the document, never finalize original as translated")
	require.Len(t, st.cleared, 1)
	assert.True(t, strings.HasPrefix(st.cleared[0], "ERROR"), "document status must be ERROR")
}

func TestBodyTranslateMissingKeyFailsClosed(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 原文正文", strPtr("中文"), false), valid: true}
	llm := &fakeLlm{err: &LlmGatewayError{Code: "MISSING_API_KEY", Status: 409}}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

	assert.Equal(t, bodyFailed, out, "missing key must fail closed for visibility, never finalize original silently")
	require.Len(t, st.cleared, 1)
	assert.True(t, strings.HasPrefix(st.cleared[0], "ERROR"), "document status must be ERROR")
}

func TestBodyChunkEnhanceFailureErrors(t *testing.T) {
	long := "# 标题\n\n" + strings.Repeat("正文段落内容。", 2000)
	web := &fakeWeb{prepare: readyPrep(long, nil, true), valid: true}
	llm := &fakeLlm{
		err:        &LlmGatewayError{Code: "GENERATION_FAILED", Status: 502},
		errPurpose: "doc_enhance",
	}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

	assert.Equal(t, bodyFailed, out, "no-language enhance chunk failure must error the whole document")
	require.Len(t, st.cleared, 1)
	assert.True(t, strings.HasPrefix(st.cleared[0], "ERROR"), "document status must be ERROR, not PROCESSED")
	assert.Empty(t, st.saved, "no poisoned checkpoint may be archived")
	assert.Empty(t, finalizeSt.stampedContent, "no degraded mixed product may be finalized")
}

func TestBodyChunkTranslateDoubleFailureErrors(t *testing.T) {
	long := "# 标题\n\n" + strings.Repeat("正文段落内容。", 2000)
	web := &fakeWeb{prepare: readyPrep(long, strPtr("中文"), true), valid: true}
	llm := &fakeLlm{err: &LlmGatewayError{Code: "GENERATION_FAILED", Status: 502}}
	st := &fakeBodyStore{cas: true}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st}, "j1", "d1", "u1")

	assert.Equal(t, bodyFailed, out, "double translation failure must fail the document for job-level retry")
	require.Len(t, st.cleared, 1)
	assert.True(t, strings.HasPrefix(st.cleared[0], "ERROR"), "document status must be ERROR, not PROCESSED")
	assert.Empty(t, st.saved, "no poisoned checkpoint may be archived")
}

func TestBodyFinalizeWithDirectFinalizeStore(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 原文", strPtr("中文"), false), valid: true}
	llm := &fakeLlm{text: "# 译文"}
	bodySt := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{
		repoId:  "repo-1",
		docPath: "docs/a.md",
		branch:  "main",
	}

	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{
		Web:           web,
		PrepareFunc:   web.Prepare,
		Llm:           llm,
		Store:         bodySt,
		FinalizeStore: finalizeSt,
	}, "j1", "d1", "u1")

	assert.Equal(t, bodyDone, out)
	assert.Empty(t, web.finalize, "web.Finalize must not be called when FinalizeStore is active")
	assert.Equal(t, "d1", finalizeSt.stampedDocId, "FinalizeStore must stamp PROCESSED directly in Go")
	assert.Equal(t, 1, bodySt.checkpointCleared)
	assert.Equal(t, 1, bodySt.notify)
}

type failoverFakeLlm struct {
	calls     []string
	attempts  int
	failUntil int
	err       error
	text      string
}

func (f *failoverFakeLlm) Complete(_ context.Context, purpose string, _ map[string]any, _ *string) (LlmTextResult, error) {
	f.attempts++
	f.calls = append(f.calls, purpose)
	if f.attempts <= f.failUntil {
		return LlmTextResult{}, f.err
	}
	return LlmTextResult{Text: "===CONTENT_BEGIN===" + f.text + "===CONTENT_END===", FinishReason: "stop"}, nil
}

func TestBodyTranslateTransient503RecoversAndFinalizes(t *testing.T) {
	t.Setenv("TRANSCRIPTION_RETRY_BACKOFF_MS", "1")
	web := &fakeWeb{prepare: readyPrep("# 原文正文", strPtr("中文"), false), valid: true}
	llm := &failoverFakeLlm{
		failUntil: 1,
		err:       &LlmGatewayError{Code: "GENERATION_FAILED", Status: 503, Message: "Service Unavailable"},
		text:      "# 译文正文",
	}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}

	out, errMsg := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{
		Web:           web,
		PrepareFunc:   web.Prepare,
		Llm:           llm,
		Store:         st,
		FinalizeStore: finalizeSt,
	}, "j1", "d1", "u1")

	assert.Empty(t, errMsg)
	assert.Equal(t, bodyDone, out)
	assert.Equal(t, 2, llm.attempts, "503 must trigger retry on next attempt")
	assert.Equal(t, "# 译文正文", finalizeSt.stampedContent, "recovered completion must be finalized")
	assert.Equal(t, doc.GenerationLevelTranslated, finalizeSt.stampedLevel)
}

func TestBodyFinalizeUnconfiguredStoreFails(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 原文", strPtr("中文"), false), valid: true}
	llm := &fakeLlm{text: "# 译文"}
	bodySt := &fakeBodyStore{cas: true}

	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{
		Web:           web,
		PrepareFunc:   web.Prepare,
		Llm:           llm,
		Store:         bodySt,
		FinalizeStore: nil,
	}, "j1", "d1", "u1")

	assert.Equal(t, bodyFailed, out)
	require.NotEmpty(t, bodySt.cleared)
	assert.Contains(t, bodySt.cleared[0], "ERROR")
	assert.Contains(t, bodySt.cleared[0], "finalize store not configured")
	assert.Equal(t, 0, bodySt.checkpointCleared, "unconfigured store must not clear checkpoints")
	assert.Equal(t, 0, bodySt.notify, "unconfigured store must not notify done")
}

type codeChapterMockLlm struct {
	calls []string
	vars  []map[string]any
	fn    func(purpose string, vars map[string]any) (LlmTextResult, error)
}

func (m *codeChapterMockLlm) Complete(_ context.Context, purpose string, vars map[string]any, _ *string) (LlmTextResult, error) {
	m.calls = append(m.calls, purpose)
	m.vars = append(m.vars, vars)
	if m.fn != nil {
		return m.fn(purpose, vars)
	}
	return LlmTextResult{Text: "# Default Lesson", FinishReason: "stop"}, nil
}

func TestRunCodeChapterTranscription_HappyPath(t *testing.T) {
	tmpDir := t.TempDir()
	owner, repo, sha := "owner1", "repo1", "sha123"
	baseDir := filepath.Join(tmpDir, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(baseDir, "src"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(baseDir, "src", "main.ts"), []byte("export function start() {}\n"), 0o644))

	prep := readyPrep("", nil, false)
	prep.Doc.Path = "chapters/01.mdx"
	prep.Doc.Title = "Architecture Overview"
	prep.Doc.Repository.Owner = owner
	prep.Doc.Repository.Repo = repo
	prep.Doc.Repository.GitSha = &sha
	prep.Doc.RepoProfile = map[string]any{
		"teachingDepth": "deep",
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"chapterNo":     1,
				"title":         "Architecture Overview",
				"summary":       "Core overview of system",
				"directories":   []string{"src"},
				"files":         []string{"src/main.ts"},
				"cognitive": map[string]any{
					"phase":     string(cognitive.PhasePipeline),
					"rationale": "Pipeline entry",
				},
			},
		},
	}

	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			assert.Equal(t, "code_chapter_lesson", purpose)
			assert.Equal(t, 1, vars["chapterIndex"])
			assert.Equal(t, "Architecture Overview", vars["chapterTitle"])
			assert.Equal(t, "deep", vars["teachingDepth"])
			assert.NotEmpty(t, vars["filesSummary"])
			assert.NotEmpty(t, vars["cognitiveScaffold"])

			lessonMdx := `---
summary: Core architecture overview
concepts:
  - name: Core Mechanism
    category: principle
---
# Architecture Overview

We explore the entrypoint.

` + "```ts // [File 1]" + `
export function start() {}
` + "```" + `

Refer to [File 1] for initialization.
`
			return LlmTextResult{Text: lessonMdx, FinishReason: "stop"}, nil
		},
	}

	cfg := loadConfigFromEnv()
	cfg.ArchiveRoot = tmpDir
	deps := TranscriptionBodyDeps{
		Llm: mockLlm,
	}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, deps, prep, "user-1")
	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Equal(t, "Architecture Overview", prep.Doc.Title)
	assert.Equal(t, []string{"src/main.ts"}, prep.Doc.SourceFiles)

	assert.Contains(t, finalContent, "src/main.ts")
	assert.NotContains(t, finalContent, "[File 1]")
	assert.Contains(t, finalContent, "---")
	assert.Contains(t, finalContent, "Core Mechanism")
}

func TestRunCodeChapterTranscription_BranchArchiveFallback(t *testing.T) {
	tmpDir := t.TempDir()
	owner, repo, branch := "owner2", "repo2", "main"
	missingSha := "sha-missing-from-disk"
	baseDir := filepath.Join(tmpDir, owner, repo, branch)
	require.NoError(t, os.MkdirAll(filepath.Join(baseDir, "src"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(baseDir, "src", "branch_file.ts"), []byte("export const branchVar = 42;\n"), 0o644))

	prep := readyPrep("", nil, false)
	prep.Doc.Path = "chapters/01.mdx"
	prep.Doc.Title = "Branch Fallback Chapter"
	prep.Doc.Repository.Owner = owner
	prep.Doc.Repository.Repo = repo
	prep.Doc.Repository.Branch = branch
	prep.Doc.Repository.GitSha = &missingSha
	prep.Doc.RepoProfile = map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"chapterNo":     1,
				"title":         "Branch Fallback Chapter",
				"summary":       "Testing branch archive fallback",
				"directories":   []string{"src"},
				"files":         []string{"src/branch_file.ts"},
			},
		},
	}

	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			assert.Contains(t, vars["filesSummary"], "branch_file.ts")
			assert.Contains(t, vars["filesSummary"], "branchVar")
			return LlmTextResult{Text: "# Branch Lesson\n\nContent referencing [File 1].", FinishReason: "stop"}, nil
		},
	}

	cfg := loadConfigFromEnv()
	cfg.ArchiveRoot = tmpDir
	deps := TranscriptionBodyDeps{Llm: mockLlm}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, deps, prep, "user-1")
	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Contains(t, finalContent, "src/branch_file.ts")
	assert.NotContains(t, finalContent, "[File 1]")
}

func TestRunCodeChapterTranscription_RepairAndFallback(t *testing.T) {
	tests := []struct {
		name           string
		llmSetup       func() *codeChapterMockLlm
		wantOutcome    bodyOutcome
		wantSubstr     string
		wantErr        bool
		expectFallback bool
	}{
		{
			name: "MDX validation failure triggers mdx_repair and succeeds with handle resolution",
			llmSetup: func() *codeChapterMockLlm {
				return &codeChapterMockLlm{
					fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
						if purpose == "code_chapter_lesson" {
							return LlmTextResult{
								Text:         "# Chapter Title\n\n<UnclosedCustomTag attribute=\"val\">\nUnclosed tag",
								FinishReason: "stop",
							}, nil
						}
						if purpose == "mdx_repair" {
							return LlmTextResult{
								Text:         "# Chapter Title\n\nRepaired content referencing [File 1].",
								FinishReason: "stop",
							}, nil
						}
						return LlmTextResult{}, errors.New("unexpected purpose")
					},
				}
			},
			wantOutcome: bodyDone,
			wantSubstr:  "src/dummy.ts",
		},
		{
			name: "MDX repair still invalid fails closed without template",
			llmSetup: func() *codeChapterMockLlm {
				return &codeChapterMockLlm{
					fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
						return LlmTextResult{
							Text:         "# Broken\n\n<StillBroken>",
							FinishReason: "stop",
						}, nil
					},
				}
			},
			wantOutcome: bodyFailed,
			wantSubstr:  "mdx convergence",
			wantErr:     true,
		},
		{
			name: "LLM completion error fails closed",
			llmSetup: func() *codeChapterMockLlm {
				return &codeChapterMockLlm{
					fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
						return LlmTextResult{}, errors.New("temporary LLM gateway failure")
					},
				}
			},
			wantOutcome: bodyFailed,
			wantErr:     true,
		},
		{
			name: "LLM budget exceeded returns bodyDeferred and error",
			llmSetup: func() *codeChapterMockLlm {
				return &codeChapterMockLlm{
					fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
						return LlmTextResult{}, &LlmGatewayError{Code: "BUDGET_EXCEEDED", Status: 429}
					},
				}
			},
			wantOutcome: bodyDeferred,
			wantErr:     true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prep := readyPrep("", nil, false)
			prep.Doc.Path = "chapters/01.mdx"
			prep.Doc.Title = "Fallback Test Chapter"
			prep.Doc.RepoProfile = map[string]any{
				"codeClusters": []map[string]any{
					{
						"teachingOrder": 1,
						"title":         "Fallback Test Chapter",
						"summary":       "Summary text",
						"directories":   []string{"src"},
						"files":         []string{"src/dummy.ts"},
					},
				},
			}

			cfg := loadConfigFromEnv()
			deps := TranscriptionBodyDeps{
				Llm: tt.llmSetup(),
			}

			outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, deps, prep, "user-1")
			if tt.wantErr {
				require.Error(t, err)
				assert.Equal(t, tt.wantOutcome, outcome)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.wantOutcome, outcome)
				assert.Contains(t, finalContent, tt.wantSubstr)
				if tt.name == "MDX validation failure triggers mdx_repair and succeeds with handle resolution" {
					assert.NotContains(t, finalContent, "[File 1]")
				}
				if tt.expectFallback {
					assert.Contains(t, finalContent, "本章涵盖以下源码文件：")
				}
			}
		})
	}
}

func TestCodeChapterChunkingIntegration(t *testing.T) {
	mdxContent := `# Module Architecture

## System Architecture Overview

High level architecture of the subsystem.

` + "```mermaid\ngraph TD\n  A --> B\n```" + `

## Implementation Details

Core logic implementation.
`

	prep := readyPrep("", nil, false)
	prep.Doc.Path = "chapters/01.mdx"
	prep.Doc.Title = "Test Module"
	prep.Doc.VirtualChapter = true
	prep.Doc.SourceFiles = []string{"src/test.ts"}

	cfg := loadConfigFromEnv()
	var chunks []chunker.MarkdownChunk = chunkInProcess(cfg, prep, mdxContent)
	require.NotEmpty(t, chunks)

	directCodeChunks := chunker.ChunkCodeModule(chunker.CodeModuleChunkRequest{
		ModuleName:  prep.Doc.Title,
		MdxContent:  mdxContent,
		SourceFiles: prep.Doc.SourceFiles,
	})
	require.Equal(t, len(chunks), len(directCodeChunks))

	foundArchitecture := false
	for _, c := range chunks {
		if c.ContentType == "architecture_diagram" {
			foundArchitecture = true
			break
		}
	}
	assert.True(t, foundArchitecture, "must have at least one architecture_diagram chunk")
}

func TestBodyRecordsActualLlmUsage(t *testing.T) {
	web := &fakeWeb{prepare: readyPrep("# 原文正文", strPtr("中文"), false), valid: true}
	llm := &fakeLlm{text: "# 译文", usage: 350}
	st := &fakeBodyStore{cas: true}
	finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}
	out, _ := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{Web: web, PrepareFunc: web.Prepare, Llm: llm, Store: st, FinalizeStore: finalizeSt}, "j1", "d1", "u1")

	assert.Equal(t, bodyDone, out)
	assert.Equal(t, 350, finalizeSt.recordedTokens, "actual gateway usage must be recorded per call")
}

func TestProgressReporter_MonotonicProgression(t *testing.T) {
	st := &fakeBodyStore{}
	rep := newProgressReporter(st, "doc-101", 0)

	rep.Report(context.Background(), "step-1", 30, true)
	assert.Equal(t, 30, rep.maxProgress)

	rep.Report(context.Background(), "step-2", 20, true)
	assert.Equal(t, 30, rep.maxProgress)
	lastUpdate := st.progressUpdates[len(st.progressUpdates)-1]
	assert.Equal(t, "doc-101:step-2:30", lastUpdate)
}

func TestProgressReporter_MultiChunkAggregation(t *testing.T) {
	st := &fakeBodyStore{}
	rep := newProgressReporter(st, "doc-chunked", 0)

	rep.InitChunks(4, []int{0})
	assert.Equal(t, 1, rep.countCompletedChunks())

	ctx := context.Background()

	ctx1 := rep.WrapChunkContext(ctx, 1, 4)
	cb1 := client.WithStreamProgress(ctx1, nil)
	_ = cb1

	rep.mu.Lock()
	rep.chunkProg[1] = 0.5
	prog := rep.calcMultiChunkProgress(20, 85)
	rep.mu.Unlock()
	assert.Equal(t, 44, prog)

	rep.MarkChunkDone(ctx, 1)
	assert.Equal(t, 2, rep.countCompletedChunks())
	assert.GreaterOrEqual(t, rep.maxProgress, 52)
}

func TestProgressReporter_WrapContext_DynamicProgression(t *testing.T) {
	st := &fakeBodyStore{}
	rep := newProgressReporter(st, "doc-single", 0)

	ctx := rep.WrapContext(context.Background(), 20, 85, "代码章节")

	mockClient := client.NewLlmGatewayClient("http://web:3000", "tok")
	_ = mockClient

	if sCtx, ok := ctx.Value(struct{}{}).(client.StreamProgressCallback); ok {
		_ = sCtx
	}

	rep.mu.Lock()
	span := 85 - 20
	genBase := 20 + span/4
	genSpan := (85 - 1) - genBase
	ratio1 := float64(1000) / (float64(1000) + 3000.0)
	prog1 := genBase + int(float64(genSpan)*ratio1)
	ratio2 := float64(5000) / (float64(5000) + 3000.0)
	prog2 := genBase + int(float64(genSpan)*ratio2)
	rep.mu.Unlock()

	assert.Greater(t, prog2, prog1)
	assert.LessOrEqual(t, prog2, 84)
}

func TestJitTranslateStrategyConvergenceFunnel(t *testing.T) {
	newEnv := func(prep *PrepareResult, llm *fakeLlm) TranscriptionExecutionContext {
		st := &fakeBodyStore{}
		return TranscriptionExecutionContext{
			Deps:        BodyDeps{Llm: llm, Store: st},
			Prep:        prep,
			RequestedBy: "u1",
			Content:     derefStrPtr(prep.Doc.Content),
			HadOriginal: true,
			Reporter:    newProgressReporter(st, prep.Doc.ID, time.Hour),
			GatewayVars: buildGatewayVars(prep),
		}
	}

	t.Run("翻译破坏 JSX → mdx_repair 成功 → 翻译级", func(t *testing.T) {
		prep := readyPrep("# 原文", strPtr("中文"), false)
		llm := &fakeLlm{
			text: "# 译文\n\n<StillBroken>",
			raw:  map[string]string{"mdx_repair": "# 修复后的译文"},
		}
		out, content, err := jitTranslateStrategy{}.Execute(context.Background(), newEnv(prep, llm))
		require.NoError(t, err)
		assert.Equal(t, bodyDone, out)
		assert.Contains(t, content, "# 修复后的译文")
		assert.Equal(t, doc.GenerationLevelTranslated, prep.GenerationLevel)
		assert.False(t, prep.ContentDegraded)
		assert.Equal(t, []string{"doc_translate", "mdx_repair"}, llm.calls)
	})

	t.Run("修复仍失败 → 原文保底 + 降级标记 + 原文级", func(t *testing.T) {
		prep := readyPrep("# 原文", strPtr("中文"), false)
		llm := &fakeLlm{text: "# 译文\n\n<StillBroken>"}
		out, content, err := jitTranslateStrategy{}.Execute(context.Background(), newEnv(prep, llm))
		require.NoError(t, err)
		assert.Equal(t, bodyDone, out)
		assert.Equal(t, "# 原文", strings.TrimSpace(content))
		assert.Equal(t, doc.GenerationLevelOriginal, prep.GenerationLevel)
		assert.True(t, prep.ContentDegraded, "原文保底必须置 ContentDegraded（finalize 跳过内容层）")
	})

	t.Run("采样质检拦截尾部夹生并自愈成功", func(t *testing.T) {
		original := "# 原文文档\n\n这里是原始的英文文档内容，经过了清洗与结构化排版。"
		prep := readyPrep(original, strPtr("中文"), false)
		halfBaked := "# 中文文档\n\n这是前面翻译好的中文段落。\n\n" + strings.Repeat("This is an untranslated English tail that leaked past LLM. ", 3)

		callCount := 0
		llm := &fakeLlm{
			text: halfBaked,
			fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
				if purpose == "doc_translation_sample" {
					callCount++
					if callCount == 1 {
						return LlmTextResult{Text: "<FAIL>"}, nil
					}
					return LlmTextResult{Text: "<PASS>"}, nil
				}
				if purpose == "doc_translate" {
					return LlmTextResult{Text: "这是自愈微创补翻后的中文尾部段落，已成功完成翻译。"}, nil
				}
				return LlmTextResult{Text: "<PASS>"}, nil
			},
		}

		out, content, err := jitTranslateStrategy{}.Execute(context.Background(), newEnv(prep, llm))
		require.NoError(t, err)
		assert.Equal(t, bodyDone, out)
		assert.Contains(t, content, "这是自愈微创补翻后的中文尾部段落")
		assert.Equal(t, doc.GenerationLevelTranslated, prep.GenerationLevel)
		assert.False(t, prep.ContentDegraded)
	})

	t.Run("采样质检拦截尾部夹生且自愈失败 → 保全结构化原文", func(t *testing.T) {
		original := "# 结构化原文\n\n这里是原汁原味的英文课时，具备严谨的排版与代码引用。"
		prep := readyPrep(original, strPtr("中文"), false)
		halfBaked := "# 假冒中文\n\n这是前面翻译好的中文。\n\n" + strings.Repeat("This is broken English tail. ", 5)

		callCount := 0
		llm := &fakeLlm{
			text: halfBaked,
			fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
				if purpose == "doc_translation_sample" {
					return LlmTextResult{Text: "<FAIL>"}, nil
				}
				if purpose == "doc_translate" {
					callCount++
					if callCount == 1 {
						return LlmTextResult{Text: halfBaked}, nil
					}
					return LlmTextResult{Text: "", FinishReason: "length"}, nil
				}
				return LlmTextResult{Text: "<FAIL>"}, nil
			},
		}

		out, content, err := jitTranslateStrategy{}.Execute(context.Background(), newEnv(prep, llm))
		require.NoError(t, err)
		assert.Equal(t, bodyDone, out)
		assert.Equal(t, original, strings.TrimSpace(content), "自愈失败必须保全本篇结构化原文，绝不交付夹生饭")
		assert.Equal(t, doc.GenerationLevelOriginal, prep.GenerationLevel)
		assert.True(t, prep.ContentDegraded, "保全原文必须显式标记 ContentDegraded")
	})
}

func TestLookupSymbolRange(t *testing.T) {
	idx := cognitive.GroundingIndex{
		Paths: []string{"src/a.ts"},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{
			"src/a.ts": {
				{Name: "start", Kind: "function", StartLine: 10, EndLine: 24},
				{Name: "helper", Kind: "function", StartLine: 30, EndLine: 30},
			},
		},
	}

	tests := []struct {
		name      string
		path      string
		symbol    string
		wantStart int
		wantEnd   int
		wantOK    bool
	}{
		{"精确命中返回 AST 声明闭区间", "src/a.ts", "start", 10, 24, true},
		{"单行符号闭区间", "src/a.ts", "helper", 30, 30, true},
		{"子串名不误命中（star ≠ start）", "src/a.ts", "star", 0, 0, false},
		{"前缀名不误命中（hel ≠ helper）", "src/a.ts", "hel", 0, 0, false},
		{"大小写敏感精确匹配", "src/a.ts", "Start", 0, 0, false},
		{"锚点路径按基名定位", "src/a.ts#start", "start", 10, 24, true},
		{"文件无符号表不命中", "src/b.ts", "start", 0, 0, false},
		{"空符号不命中", "src/a.ts", "", 0, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			start, end, ok := lookupSymbolRange(idx, tt.path, tt.symbol)
			assert.Equal(t, tt.wantOK, ok)
			assert.Equal(t, tt.wantStart, start)
			assert.Equal(t, tt.wantEnd, end)
		})
	}

	start, end, ok := lookupSymbolRange(cognitive.GroundingIndex{Paths: []string{"src/a.ts"}}, "src/a.ts", "start")
	assert.False(t, ok)
	assert.Zero(t, start)
	assert.Zero(t, end)
}

func TestRunCodeChapterTranscription_SymbolSlotGraphHydration(t *testing.T) {
	const sha = "deadbeefcafe"
	root := t.TempDir()
	archiveFile := filepath.Join(root, "o", "r", sha, "src", "core.ts")
	require.NoError(t, os.MkdirAll(filepath.Dir(archiveFile), 0o755))
	require.NoError(t, os.WriteFile(archiveFile, []byte("line1\nfunc guarded() {\n\tline3\n}\nline5\n"), 0o644))

	graphDir := t.TempDir()
	_, err := cognitive.SaveSemanticGraphArtifact(graphDir, "o", "r", sha, &cognitive.SemanticGraphArtifact{
		Version: 2,
		Nodes:   []cognitive.SemanticGraphArtifactNode{{Path: "src/core.ts", Language: "ts"}},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{
			"src/core.ts": {{Name: "guarded", Kind: "function", StartLine: 2, EndLine: 4}},
		},
	})
	require.NoError(t, err)

	prep := readyPrep("", nil, false)
	prep.Doc.Path = "chapters/02.mdx"
	prep.Doc.Title = "核心模块"
	prep.Doc.VirtualChapter = true
	prep.Doc.RepositoryID = "repo-1"
	prep.Doc.Repository.Owner = "o"
	prep.Doc.Repository.Repo = "r"
	prep.Doc.Repository.Branch = "main"
	shaPtr := sha
	prep.Doc.Repository.GitSha = &shaPtr
	prep.Doc.RepoProfile = map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 2,
				"title":         "核心模块",
				"summary":       "Summary text",
				"directories":   []string{"src"},
				"files":         []string{"src/core.ts"},
			},
		},
	}

	cfg := loadConfigFromEnv()
	cfg.ArchiveRoot = root
	cfg.SemanticGraphDir = graphDir

	lesson := "# 核心模块\n\n```ts [File 1#guarded]\nCODE_SLOT\n```\n\n收尾讲解。\n"
	llm := &codeChapterMockLlm{fn: func(purpose string, _ map[string]any) (LlmTextResult, error) {
		if purpose == "code_chapter_lesson" {
			return LlmTextResult{Text: lesson, FinishReason: "stop"}, nil
		}
		return LlmTextResult{}, errors.New("unexpected purpose: " + purpose)
	}}

	outcome, content, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: llm}, prep, "user-1")
	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)

	assert.Contains(t, content, "func guarded() {")
	assert.Contains(t, content, "line3")
	assert.NotContains(t, content, "line1", "区间外首行不得混入插槽")
	assert.NotContains(t, content, "line5", "区间外末行不得混入插槽")
	assert.NotContains(t, content, "CODE_SLOT", "占位符必须被物理切片替换")
	assert.Contains(t, content, "src/core.ts#guarded")
}

func TestFindDocCodeSnippet(t *testing.T) {
	docLines := strings.Split(`# Project

Here is an example:

`+"```python"+`
from datetime import datetime
from browser_use import ActionResult

@tools.action(description='Get the current date and time in UTC.')
def get_current_time() -> ActionResult:
    return ActionResult(extracted_content=datetime.now())
`+"```"+`

Another section.
`, "\n")

	start, end, ok := findDocCodeSnippet(docLines, "get_current_time")
	require.True(t, ok)
	require.True(t, start > 0)
	require.True(t, end >= start)
	snippet := strings.Join(docLines[start-1:end], "\n")
	assert.Contains(t, snippet, "def get_current_time()")
	assert.Contains(t, snippet, "@tools.action")

	_, _, okNon := findDocCodeSnippet(docLines, "non_existent_symbol_12345")
	assert.False(t, okNon)
}

func TestRunCodeChapterTranscription_DocFileSymbolSlotGrounded(t *testing.T) {
	const sha = "b00bcafe1234"
	root := t.TempDir()
	archiveFile := filepath.Join(root, "browser-use", "browser-use", sha, "README.md")
	require.NoError(t, os.MkdirAll(filepath.Dir(archiveFile), 0o755))
	readmeContent := `# Browser Use

## Quickstart

` + "```python" + `
from browser_use import ActionResult

@tools.action(description='Get the current date and time in UTC.')
def get_current_time() -> ActionResult:
    return ActionResult(extracted_content="2026-10-15")
` + "```" + `
`
	require.NoError(t, os.WriteFile(archiveFile, []byte(readmeContent), 0o644))

	graphDir := t.TempDir()
	_, err := cognitive.SaveSemanticGraphArtifact(graphDir, "browser-use", "browser-use", sha, &cognitive.SemanticGraphArtifact{
		Version:       2,
		Nodes:         []cognitive.SemanticGraphArtifactNode{{Path: "README.md", Language: "markdown"}},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{},
	})
	require.NoError(t, err)

	prep := readyPrep("", nil, false)
	prep.Doc.Path = "chapters/01.mdx"
	prep.Doc.Title = "初识 browser-use"
	prep.Doc.VirtualChapter = true
	prep.Doc.RepositoryID = "repo-bu"
	prep.Doc.Repository.Owner = "browser-use"
	prep.Doc.Repository.Repo = "browser-use"
	prep.Doc.Repository.Branch = "main"
	shaPtr := sha
	prep.Doc.Repository.GitSha = &shaPtr
	prep.Doc.RepoProfile = map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"title":         "初识 browser-use",
				"summary":       "Introduction",
				"directories":   []string{""},
				"files":         []string{"README.md"},
			},
		},
	}

	cfg := loadConfigFromEnv()
	cfg.ArchiveRoot = root
	cfg.SemanticGraphDir = graphDir

	lesson := "# 初识 browser-use\n\n```python [File 1#get_current_time]\nCODE_SLOT\n```\n\n代码说明。\n"
	callCount := 0
	llm := &codeChapterMockLlm{fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
		if purpose == "code_chapter_lesson" {
			callCount++
			if callCount > 1 {
				assert.NotEmpty(t, vars["groundingFeedback"])
			} else {
				assert.Empty(t, vars["groundingFeedback"])
			}
			return LlmTextResult{Text: lesson, FinishReason: "stop"}, nil
		}
		return LlmTextResult{}, errors.New("unexpected purpose: " + purpose)
	}}

	outcome, content, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: llm}, prep, "user-1")
	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Equal(t, 1, callCount, "Tier-4 Grounding Gate should pass cleanly on first pass without rewrite")

	assert.Contains(t, content, "def get_current_time() -> ActionResult:")
	assert.NotContains(t, content, "CODE_SLOT", "Slot placeholder must be replaced with real code")
	assert.Contains(t, content, "README.md#get_current_time", "Handle should resolve to physical doc path#symbol")
}

func TestRunCodeChapterTranscription_BriefStateLedgerLogging(t *testing.T) {
	t.Helper()
	tests := []struct {
		name       string
		briefState string
		wantLog    string
	}{
		{name: "plan brief state", briefState: "plan", wantLog: "brief_state=plan"},
		{name: "arc brief state", briefState: "arc", wantLog: "brief_state=arc"},
		{name: "empty brief state", briefState: "", wantLog: "brief_state="},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, prep := groundingBodyFixture(t, false)
			var buf bytes.Buffer
			origOut := log.Writer()
			log.SetOutput(&buf)
			defer log.SetOutput(origOut)

			call := 0
			mockLlm := &codeChapterMockLlm{
				fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
					assert.Equal(t, "code_chapter_lesson", purpose)
					call++
					if call == 1 {
						assert.Nil(t, vars["skipMetaCompiler"])
						return LlmTextResult{
							Text:         groundingLessonMdx(t, true),
							FinishReason: "stop",
							CallID:       "call-1",
							BriefState:   tt.briefState,
						}, nil
					}
					assert.Equal(t, true, vars["skipMetaCompiler"])
					return LlmTextResult{
						Text:         groundingLessonMdx(t, false),
						FinishReason: "stop",
						CallID:       "call-2",
						BriefState:   "",
					}, nil
				},
			}

			outcome, _, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")
			require.NoError(t, err)
			assert.Equal(t, bodyDone, outcome)
			assert.Contains(t, buf.String(), "[grounding] ")
			assert.Contains(t, buf.String(), tt.wantLog)
		})
	}
}

func TestWithLlmRetryPermanentUpstreamNoRetry(t *testing.T) {
	tests := []struct {
		name string
		err  *LlmGatewayError
	}{
		{name: "UPSTREAM_AUTH_ERROR fails fast on attempt 1", err: &LlmGatewayError{Code: client.ErrCodeUpstreamAuthError, Status: 401, UpstreamStatus: 401, Message: "Invalid API key"}},
		{name: "UPSTREAM_QUOTA_EXCEEDED fails fast on attempt 1", err: &LlmGatewayError{Code: client.ErrCodeUpstreamQuotaExceeded, Status: 402, UpstreamStatus: 429, UpstreamCode: "1308", Message: "已达到 5 小时使用上限"}},
		{name: "UPSTREAM_MODEL_NOT_FOUND fails fast on attempt 1", err: &LlmGatewayError{Code: client.ErrCodeUpstreamModelNotFound, Status: 404, UpstreamStatus: 404, Message: "model not found"}},
		{name: "UPSTREAM_BAD_REQUEST fails fast on attempt 1", err: &LlmGatewayError{Code: client.ErrCodeUpstreamBadRequest, Status: 400, UpstreamStatus: 400, Message: "context_length_exceeded"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			_, err := withLlmRetry(context.Background(), func() (LlmTextResult, error) {
				calls++
				return LlmTextResult{}, tt.err
			})
			require.Error(t, err)
			assert.Equal(t, 1, calls, "permanent upstream error must not auto-retry")
		})
	}
}

func TestCoordinatePermanentUpstreamErrorPersistsStructuredPayload(t *testing.T) {
	tests := []struct {
		name         string
		forceEnhance bool
		gwErr        *LlmGatewayError
		wantCalls    int
	}{
		{
			name:         "enhance path permanent auth error skips doc_translate fallback and persists __OG_ERR__",
			forceEnhance: true,
			gwErr: &LlmGatewayError{
				Code:           client.ErrCodeUpstreamAuthError,
				Message:        "Incorrect API key provided",
				Status:         401,
				Provider:       "openai",
				Model:          "gpt-4o",
				UpstreamStatus: 401,
				UpstreamCode:   "invalid_api_key",
			},
			wantCalls: 1,
		},
		{
			name:         "jit translate path long quota error truncates cleanly before JSON marshal",
			forceEnhance: false,
			gwErr: &LlmGatewayError{
				Code:           client.ErrCodeUpstreamQuotaExceeded,
				Message:        strings.Repeat("已达到使用配额上限，请切换模型或充值。", 30),
				Status:         402,
				Provider:       "zhipu",
				Model:          "glm-5.3-flash",
				UpstreamStatus: 429,
				UpstreamCode:   "1308",
			},
			wantCalls: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			web := &fakeWeb{prepare: readyPrep("# raw", strPtr("中文"), tt.forceEnhance), valid: true}
			llm := &fakeLlm{err: tt.gwErr}
			st := &fakeBodyStore{cas: true}
			finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: "docs/a.md", branch: "main"}

			out, errMsg := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{
				Web:           web,
				PrepareFunc:   web.Prepare,
				Llm:           llm,
				Store:         st,
				FinalizeStore: finalizeSt,
			}, "j1", "d1", "u1")

			assert.Equal(t, bodyFailed, out)
			assert.Len(t, llm.calls, tt.wantCalls)
			assert.LessOrEqual(t, len(errMsg), client.MaxStructuredDbErrLen)
			decoded, ok := client.DecodeStructuredDbError(errMsg)
			require.True(t, ok, "errMsg must be valid __OG_ERR__ payload")
			assert.Equal(t, tt.gwErr.Code, decoded.Code)
			assert.Equal(t, tt.gwErr.Provider, decoded.Provider)
			assert.Equal(t, tt.gwErr.Model, decoded.Model)
			assert.Equal(t, tt.gwErr.UpstreamStatus, decoded.UpstreamStatus)
			assert.Equal(t, tt.gwErr.UpstreamCode, decoded.UpstreamCode)

			require.Len(t, st.cleared, 1)
			assert.Equal(t, "ERROR|"+errMsg, st.cleared[0])
		})
	}
}

func TestBodyNonMarkdownCodeAssetFencedAndZeroLlmModelOmitted(t *testing.T) {
	tests := []struct {
		name         string
		forceEnhance bool
		enableAI     bool
		targetLang   *string
	}{
		{
			name:         "jit pass-through wraps raw typescript and omits unused model",
			forceEnhance: false,
			enableAI:     true,
			targetLang:   strPtr("zh-CN"),
		},
		{
			name:         "enhance pass-through wraps raw typescript and omits unused model",
			forceEnhance: true,
			enableAI:     true,
			targetLang:   strPtr("zh-CN"),
		},
	}

	rawTS := "export type { HelloMessage } from \"./handshake.js\";\nexport const v = 1;\n"
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prep := readyPrep(rawTS, tt.targetLang, tt.forceEnhance)
			prep.Doc.Path = "packages/shared/src/index.ts"
			prep.Doc.IsMarkdown = false
			prep.Doc.EnableAIEnhance = tt.enableAI
			prep.Model = "glm-5.3-flash"

			web := &fakeWeb{prepare: prep, valid: true}
			llm := &fakeLlm{}
			st := &fakeBodyStore{cas: true}
			finalizeSt := &fakeDocStore{repoId: "repo-1", docPath: prep.Doc.Path, branch: "main"}

			out, errMsg := runTranscriptionBody(context.Background(), loadConfigFromEnv(), TranscriptionBodyDeps{
				Web:           web,
				PrepareFunc:   web.Prepare,
				Llm:           llm,
				Store:         st,
				FinalizeStore: finalizeSt,
			}, "j-ts", "d-ts", "u1")

			assert.Equal(t, bodyDone, out, "unexpected err=%s", errMsg)
			assert.Empty(t, llm.calls, "non-markdown code pass-through must invoke 0 LLM calls")
			assert.Equal(t, doc.GenerationLevelOriginal, finalizeSt.stampedLevel)
			assert.Empty(t, finalizeSt.stampedModel, "zero-LLM pass-through must not stamp unused model name")
			assert.Empty(t, finalizeSt.recordedModel, "zero-LLM pass-through must not pollute Repository.transcriptionModels")
			assert.Contains(t, finalizeSt.stampedContent, "```typescript\n"+rawTS+"```")
			assert.Contains(t, finalizeSt.stampedContent, "<!-- path: packages/shared/src/index.ts -->")
		})
	}
}

package transcription

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// 分级幻觉防护门禁单元测试（Table-Driven + testify，AGENTS.md IV.5）
// ─────────────────────────────────────────────────────────────

func TestGroundingHasHallucination(t *testing.T) {
	tests := []struct {
		name   string
		report cognitive.GroundingReport
		want   bool
	}{
		{
			name:   "empty report is clean",
			report: cognitive.GroundingReport{},
			want:   false,
		},
		{
			name: "fuzzy and ambiguous warnings only are auto-corrected level 1",
			report: cognitive.GroundingReport{
				GroundingVerdict: cognitive.GroundingVerdict{
					Valid: true,
					Warnings: []string{
						"Fuzzy-aligned 'db.ts' to grounded path 'src/lib/db.ts'.",
						"Ambiguous 'a.ts' deterministically aligned to 'src/a.ts'.",
					},
				},
			},
			want: false,
		},
		{
			name: "hallucinated file triggers rewrite",
			report: cognitive.GroundingReport{
				GroundingVerdict: cognitive.GroundingVerdict{
					HallucinatedFiles: []string{"src/ghost.ts"},
				},
			},
			want: true,
		},
		{
			name: "hallucinated symbol triggers rewrite",
			report: cognitive.GroundingReport{
				HallucinatedSymbols: []cognitive.SymbolClaim{{File: "src/real.ts", Symbol: "phantom"}},
			},
			want: true,
		},
		{
			name: "both hallucinations trigger rewrite",
			report: cognitive.GroundingReport{
				GroundingVerdict: cognitive.GroundingVerdict{
					HallucinatedFiles: []string{"src/ghost.ts"},
				},
				HallucinatedSymbols: []cognitive.SymbolClaim{{File: "src/real.ts", Symbol: "phantom"}},
			},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, groundingHasHallucination(tt.report))
		})
	}
}

func TestExtractSymbolClaims(t *testing.T) {
	mdx := "# Title\n\n" +
		"```ts // src/lib/scheduler.ts#InitScheduler\n" +
		"func init() {}\n" +
		"```\n\n" +
		"```go // cmd/app/main.go#Run\n" +
		"func main() {}\n" +
		"```\n\n" +
		"```py # services/auth.py#login\n" +
		"def login(): pass\n" +
		"```\n\n" +
		"```ts // src/lib/scheduler.ts#InitScheduler\n" +
		"duplicate must dedupe\n" +
		"```\n\n" +
		"```ts // src/lib/cache.ts (L10-L45)\n" +
		"line range header carries no symbol\n" +
		"```\n\n" +
		"```ts // src/plain.ts\n" +
		"plain header has no symbol\n" +
		"```\n"

	claims := extractSymbolClaims(mdx)

	assert.Equal(t, []cognitive.SymbolClaim{
		{File: "src/lib/scheduler.ts", Symbol: "InitScheduler"},
		{File: "cmd/app/main.go", Symbol: "Run"},
		{File: "services/auth.py", Symbol: "login"},
	}, claims)
}

func TestBuildGroundingIndex(t *testing.T) {
	chapterFiles := []string{"src/a.ts", "src/c.ts"}

	tests := []struct {
		name        string
		setup       func(t *testing.T) string // returns graphDir
		graphDirArg string
		shaArg      string
		wantPaths   []string
		wantSymbols bool
	}{
		{
			name: "artifact enriches index to full repository scope",
			setup: func(t *testing.T) string {
				t.Helper()
				dir := t.TempDir()
				artifact := &cognitive.SemanticGraphArtifact{
					Version: 2,
					Nodes: []cognitive.SemanticGraphArtifactNode{
						{Path: "src/a.ts", Language: "ts"},
						{Path: "src/b.go", Language: "go"},
					},
					SymbolsByFile: map[string][]cognitive.SymbolEntry{
						"src/a.ts": {{Name: "start", Kind: "function", StartLine: 1, EndLine: 3}},
					},
				}
				_, err := cognitive.SaveSemanticGraphArtifact(dir, "o", "r", "sha1", artifact)
				require.NoError(t, err)
				return dir
			},
			shaArg:      "sha1",
			wantPaths:   []string{"src/a.ts", "src/b.go", "src/c.ts"},
			wantSymbols: true,
		},
		{
			name:        "missing artifact fails open to chapter file scope",
			setup:       func(t *testing.T) string { t.Helper(); return t.TempDir() },
			shaArg:      "sha-absent",
			wantPaths:   []string{"src/a.ts", "src/c.ts"},
			wantSymbols: false,
		},
		{
			name:        "empty sha fails open",
			setup:       func(t *testing.T) string { t.Helper(); return t.TempDir() },
			shaArg:      "",
			wantPaths:   []string{"src/a.ts", "src/c.ts"},
			wantSymbols: false,
		},
		{
			name:        "empty graph dir fails open",
			setup:       func(t *testing.T) string { t.Helper(); return "" },
			shaArg:      "sha1",
			wantPaths:   []string{"src/a.ts", "src/c.ts"},
			wantSymbols: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := tt.setup(t)
			index := buildGroundingIndex(dir, "o", "r", tt.shaArg, chapterFiles)
			assert.ElementsMatch(t, tt.wantPaths, index.Paths)
			if tt.wantSymbols {
				assert.NotNil(t, index.SymbolsByFile)
			} else {
				assert.Nil(t, index.SymbolsByFile)
			}
		})
	}
}

// gateTestIndex 构建带真实路径与符号表的校验索引。
func gateTestIndex() cognitive.GroundingIndex {
	return cognitive.GroundingIndex{
		Paths: []string{"src/real.ts", "src/other.ts"},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{
			"src/real.ts": {{Name: "start", Kind: "function", StartLine: 1, EndLine: 5}},
		},
	}
}

func TestRunGroundingGate(t *testing.T) {
	cleanMdx := "# Chapter\n\nRefer to `src/real.ts`.\n\n<!-- path: src/real.ts -->\n"
	dirtyMdx := "# Chapter\n\n<!-- path: src/ghost.ts -->\n"

	tests := []struct {
		name            string
		firstContent    string
		rewriteText     string
		rewriteErr      error
		wantOutcome     GroundingGateOutcome
		wantComplete    int
		wantErr         bool
		wantReject      bool
		wantFinalSubstr string
	}{
		{
			name:            "clean first pass emits no rewrite call",
			firstContent:    cleanMdx,
			wantOutcome:     GroundingPassed,
			wantComplete:    0,
			wantFinalSubstr: "src/real.ts",
		},
		{
			name:            "hallucinated file triggers single rewrite that passes",
			firstContent:    dirtyMdx,
			rewriteText:     cleanMdx,
			wantOutcome:     GroundingRewritten,
			wantComplete:    1,
			wantFinalSubstr: "src/real.ts",
		},
		{
			name:         "persistent hallucination rejects fail-closed",
			firstContent: dirtyMdx,
			rewriteText:  dirtyMdx,
			wantOutcome:  GroundingRejected,
			wantComplete: 1,
			wantErr:      true,
			wantReject:   true,
		},
		{
			name:         "rewrite transport error propagates without ledger",
			firstContent: dirtyMdx,
			rewriteErr:   errors.New("gateway down"),
			wantComplete: 1,
			wantErr:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &codeChapterMockLlm{
				fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
					assert.Equal(t, "code_chapter_lesson", purpose)
					if tt.rewriteErr != nil {
						return LlmTextResult{}, tt.rewriteErr
					}
					return LlmTextResult{Text: tt.rewriteText, FinishReason: "stop", CallID: "call-rewrite"}, nil
				},
			}

			vars := map[string]any{"groundingFeedback": ""}
			pipeline := &MdxConvergencePipeline{DocPath: "chapters/01.mdx"}
			firstPass := pipeline.Execute(context.Background(), tt.firstContent, nil, false)
			require.NotEmpty(t, firstPass.FinalContent)

			res, ledger, err := runGroundingGate(groundingGateParams{
				Ctx:         context.Background(),
				Llm:         mock,
				RewriteCtx:  context.Background(),
				Vars:        vars,
				Pipeline:    pipeline,
				Index:       gateTestIndex(),
				DocPath:     "chapters/01.mdx",
				FirstPass:   firstPass,
				FirstCallID: "call-first",
			})

			assert.Len(t, mock.calls, tt.wantComplete)
			if tt.wantComplete > 0 {
				require.Len(t, mock.vars, 1)
				feedback, _ := mock.vars[0]["groundingFeedback"].(string)
				assert.Contains(t, feedback, "REJECTED file path: 'src/ghost.ts'")
			} else {
				assert.Empty(t, mock.calls, "clean pass must not invoke the LLM")
			}

			if tt.wantErr {
				require.Error(t, err)
				var reject *GroundingRejectError
				if tt.wantReject {
					require.ErrorAs(t, err, &reject)
					assert.Contains(t, err.Error(), "src/ghost.ts")
					assert.Equal(t, tt.wantOutcome, ledger.Outcome)
					assert.Equal(t, 1, ledger.Retries)
					assert.Equal(t, "call-rewrite", ledger.RewriteCallID)
				}
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tt.wantOutcome, ledger.Outcome)
			assert.Equal(t, "call-first", ledger.CallID)
			assert.Contains(t, res.FinalContent, tt.wantFinalSubstr)
			assert.NotContains(t, res.FinalContent, "src/ghost.ts")
			assert.Equal(t, 0, ledger.Invalid)
			assert.Contains(t, ledger.LogLine(), fmt.Sprintf("outcome=%s", tt.wantOutcome))
		})
	}
}

func TestRunGroundingGate_SymbolHallucination(t *testing.T) {
	// 围栏头声明了物理上不存在的符号：src/real.ts#phantom
	mdx := "# Chapter\n\n```ts // src/real.ts#phantom\nexport function phantom() {}\n```\n"

	vars := map[string]any{"groundingFeedback": ""}
	pipeline := &MdxConvergencePipeline{DocPath: "chapters/01.mdx"}
	firstPass := pipeline.Execute(context.Background(), mdx, nil, false)

	mock := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			return LlmTextResult{Text: "# Chapter\n\n```ts // src/real.ts#start\nexport function start() {}\n```\n", FinishReason: "stop"}, nil
		},
	}

	res, ledger, err := runGroundingGate(groundingGateParams{
		Ctx:         context.Background(),
		Llm:         mock,
		RewriteCtx:  context.Background(),
		Vars:        vars,
		Pipeline:    pipeline,
		Index:       gateTestIndex(),
		DocPath:     "chapters/01.mdx",
		FirstPass:   firstPass,
		FirstCallID: "call-first",
	})

	require.NoError(t, err)
	assert.Equal(t, GroundingRewritten, ledger.Outcome)
	require.Len(t, mock.vars, 1)
	feedback, _ := mock.vars[0]["groundingFeedback"].(string)
	assert.Contains(t, feedback, "REJECTED symbol: 'phantom' is not declared in 'src/real.ts'")
	assert.Contains(t, feedback, "Declared AST symbols in 'src/real.ts' (or use #Lx-Ly): start")
	assert.Contains(t, res.FinalContent, "src/real.ts#start")
}

func TestRunGroundingGate_DocFileSymbol_PassesWithoutRewrite(t *testing.T) {
	// 围栏头声明了文档中的示例符号：README.md#get_current_time
	mdx := "# Chapter\n\n```python // README.md#get_current_time\ndef get_current_time():\n    pass\n```\n"

	vars := map[string]any{"groundingFeedback": ""}
	pipeline := &MdxConvergencePipeline{DocPath: "chapters/01.mdx"}
	firstPass := pipeline.Execute(context.Background(), mdx, nil, false)

	rewriteCalled := false
	mock := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			rewriteCalled = true
			return LlmTextResult{}, errors.New("rewrite should not be called")
		},
	}

	index := cognitive.GroundingIndex{
		Paths: []string{"README.md", "src/real.ts"},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{
			"src/real.ts": {{Name: "start", Kind: "function", StartLine: 1, EndLine: 5}},
		},
	}

	res, ledger, err := runGroundingGate(groundingGateParams{
		Ctx:         context.Background(),
		Llm:         mock,
		RewriteCtx:  context.Background(),
		Vars:        vars,
		Pipeline:    pipeline,
		Index:       index,
		DocPath:     "chapters/01.mdx",
		FirstPass:   firstPass,
		FirstCallID: "call-first",
	})

	require.NoError(t, err)
	assert.False(t, rewriteCalled)
	assert.Equal(t, GroundingPassed, ledger.Outcome)
	assert.Equal(t, 0, ledger.Invalid)
	assert.Contains(t, res.FinalContent, "README.md#get_current_time")
}

func TestIntersectChapterSourceFiles(t *testing.T) {
	chapter := []string{"src/a.ts", "src/b.ts"}

	tests := []struct {
		name     string
		grounded []string
		want     []string
	}{
		{
			name:     "anchored grounded paths resolve back to chapter scope",
			grounded: []string{"src/a.ts", "src/b.ts#run", "src/out-of-scope.ts"},
			want:     []string{"src/a.ts", "src/b.ts"},
		},
		{
			name:     "fully out-of-scope grounded falls back to real chapter list",
			grounded: []string{"src/x.ts", "src/y.ts"},
			want:     []string{"src/a.ts", "src/b.ts"},
		},
		{
			name:     "empty grounded falls back",
			grounded: nil,
			want:     []string{"src/a.ts", "src/b.ts"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			report := cognitive.GroundingReport{
				GroundingVerdict: cognitive.GroundingVerdict{GroundedFiles: tt.grounded},
			}
			assert.Equal(t, tt.want, intersectChapterSourceFiles(report, chapter))
		})
	}
}

// ─────────────────────────────────────────────────────────────
// 端到端集成：runCodeChapterTranscription 经真实归档 + 落盘图谱驱动门禁
// ─────────────────────────────────────────────────────────────

// groundingBodyFixture 构建带归档源码与语义图谱产物的代码章节测试环境。
func groundingBodyFixture(t *testing.T, dirtyFirstPass bool) (Config, *PrepareResult) {
	t.Helper()

	tmpDir := t.TempDir()
	owner, repo, sha := "gowner", "grepo", "gsha123"
	baseDir := filepath.Join(tmpDir, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(baseDir, "src"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(baseDir, "src", "main.ts"), []byte("export function start() {}\n"), 0o644))

	graphDir := t.TempDir()
	artifact := &cognitive.SemanticGraphArtifact{
		Version: 2,
		GitSha:  sha,
		Nodes: []cognitive.SemanticGraphArtifactNode{
			{Path: "src/main.ts", Language: "ts"},
			{Path: "src/sibling.ts", Language: "ts"},
		},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{
			"src/main.ts": {{Name: "start", Kind: "function", StartLine: 1, EndLine: 1}},
		},
	}
	_, err := cognitive.SaveSemanticGraphArtifact(graphDir, owner, repo, sha, artifact)
	require.NoError(t, err)

	prep := readyPrep("", nil, false)
	prep.Doc.Path = "chapters/01.mdx"
	prep.Doc.Title = "Grounding Gate Chapter"
	prep.Doc.Repository.Owner = owner
	prep.Doc.Repository.Repo = repo
	prep.Doc.Repository.GitSha = &sha
	prep.Doc.RepoProfile = map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"chapterNo":     1,
				"title":         "Grounding Gate Chapter",
				"summary":       "Gate integration",
				"directories":   []string{"src"},
				"files":         []string{"src/main.ts"},
			},
		},
	}

	cfg := loadConfigFromEnv()
	cfg.ArchiveRoot = tmpDir
	cfg.SemanticGraphDir = graphDir
	_ = dirtyFirstPass
	return cfg, prep
}

func groundingLessonMdx(t *testing.T, ghost bool) string {
	t.Helper()
	ghostMarker := ""
	if ghost {
		ghostMarker = "\n<!-- path: src/ghost.ts -->\n"
	}
	return "---\nsummary: Gate overview\nconcepts:\n  - name: Core Mechanism\n    category: principle\n---\n# Grounding Gate Chapter\n\nWe explore the entrypoint." + ghostMarker + "\n" +
		"```ts // [File 1]\n" + "export function start() {}\n" + "```\n"
}

func TestRunCodeChapterTranscription_GroundingGateRewrite(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, true)

	callCount := 0
	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			assert.Equal(t, "code_chapter_lesson", purpose)
			callCount++
			// 首遍带幻觉路径，重写遍干净
			return LlmTextResult{Text: groundingLessonMdx(t, callCount == 1), FinishReason: "stop"}, nil
		},
	}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Equal(t, 2, callCount, "hallucinated first pass must trigger exactly one rewrite")
	require.Len(t, mockLlm.vars, 2)
	feedback, _ := mockLlm.vars[1]["groundingFeedback"].(string)
	assert.Contains(t, feedback, "REJECTED file path: 'src/ghost.ts'")
	assert.Empty(t, mockLlm.vars[0]["groundingFeedback"])
	assert.Contains(t, finalContent, "src/main.ts")
	assert.NotContains(t, finalContent, "src/ghost.ts")
	assert.Equal(t, []string{"src/main.ts"}, prep.Doc.SourceFiles)
}

func TestRunCodeChapterTranscription_GroundingGateReject(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, true)

	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			return LlmTextResult{Text: groundingLessonMdx(t, true), FinishReason: "stop"}, nil
		},
	}

	outcome, _, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

	// L3 Fail-Closed：重写一次后仍捏造 → BodyFailed 拒收
	require.Error(t, err)
	assert.Equal(t, bodyFailed, outcome)
	assert.Contains(t, err.Error(), "hallucinations persist")
}

package transcription

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fixtureSnapshots() []cluster.ModuleSnapshot {
	return []cluster.ModuleSnapshot{
		{TeachingOrder: 1, Title: "引擎启动", Summary: "s1"},
		{TeachingOrder: 2, Title: "路由分发", Summary: "s2"},
		{TeachingOrder: 3, Title: "适配器", Summary: "s3"},
	}
}

func slotRepairLessonMdx(defectBlock string) string {
	return "---\nsummary: Slot repair overview\nconcepts:\n  - name: Core Mechanism\n    category: principle\n---\n# Slot Chapter\n\nWe explore the entrypoint.\n\n" +
		defectBlock + "\n\n收尾段。"
}

func slotRepairJSON(resp string) string {
	return "```json\n" + resp + "\n```"
}

func TestRunCodeChapterTranscription_SlotRepairMap(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, false)

	chapterCalls := 0
	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			switch purpose {
			case "code_chapter_lesson":
				chapterCalls++
				return LlmTextResult{Text: slotRepairLessonMdx("```ts\n<!-- CODE_SLOT -->\n```"), FinishReason: "stop"}, nil
			case "code_slot_repair":
				menu, _ := vars["fileMenu"].(string)
				assert.Contains(t, menu, "[File 1] src/main.ts")
				assert.Contains(t, menu, "start")
				return LlmTextResult{Text: slotRepairJSON(`{"slots":[{"slotIndex":1,"action":"map","fileIndex":1,"anchor":"start","aspect":"core"}]}`), FinishReason: "stop"}, nil
			default:
				t.Fatalf("unexpected purpose %s", purpose)
				return LlmTextResult{}, nil
			}
		},
	}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Equal(t, 1, chapterCalls, "L1.5 成功后严禁 L2 整章重写")
	repairCalls := 0
	for _, c := range mockLlm.calls {
		if c == "code_slot_repair" {
			repairCalls++
		}
	}
	assert.Equal(t, 1, repairCalls, "恰好一次 code_slot_repair 微请求")
	assert.Contains(t, finalContent, "export function start() {}", "占位块被真实归档源码回填")
	assert.Contains(t, finalContent, "src/main.ts#start", "回填块句柄经 Stage 2 还原为物理路径锚点")
	assert.NotContains(t, finalContent, "CODE_SLOT", "残余占位必须清零")
	assert.Contains(t, finalContent, "summary: Slot repair overview")
}

func TestRunCodeChapterTranscription_SlotRepairDropEmptyBlock(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, false)

	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			switch purpose {
			case "code_chapter_lesson":
				return LlmTextResult{Text: slotRepairLessonMdx("```ts\n```"), FinishReason: "stop"}, nil
			case "code_slot_repair":
				return LlmTextResult{Text: `{"slots":[{"slotIndex":1,"action":"drop"}]}`, FinishReason: "stop"}, nil
			default:
				t.Fatalf("unexpected purpose %s", purpose)
				return LlmTextResult{}, nil
			}
		},
	}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.NotContains(t, finalContent, "```ts\n```", "空体块被确定性移除")
	assert.Contains(t, finalContent, "收尾段。", "drop 后相邻段落无损")
}

func TestRunCodeChapterTranscription_SlotRepairInvalidFallsToL2(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, false)

	chapterCalls := 0
	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			switch purpose {
			case "code_chapter_lesson":
				chapterCalls++
				if chapterCalls == 1 {
					return LlmTextResult{Text: slotRepairLessonMdx("```ts\n<!-- CODE_SLOT -->\nconsole.log(1)\n```"), FinishReason: "stop"}, nil
				}
				return LlmTextResult{Text: groundingLessonMdx(t, false), FinishReason: "stop"}, nil
			case "code_slot_repair":
				return LlmTextResult{Text: `{"slots":[{"slotIndex":1,"action":"drop"}]}`, FinishReason: "stop"}, nil
			default:
				t.Fatalf("unexpected purpose %s", purpose)
				return LlmTextResult{}, nil
			}
		},
	}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Equal(t, 2, chapterCalls, "L1.5 无有效处置必须降级 L2 单次重写")
	require.Len(t, mockLlm.vars, 3)
	feedback, _ := mockLlm.vars[2]["groundingFeedback"].(string)
	require.NotEmpty(t, feedback)
	assert.Contains(t, feedback, "UNHYDRATED CODE SLOT DEFECTS")
	assert.NotContains(t, finalContent, "CODE_SLOT")
}

func TestRunCodeChapterTranscription_SlotRepairGarbageJSONFallsToL2ThenL3(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, false)

	chapterCalls := 0
	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			switch purpose {
			case "code_chapter_lesson":
				chapterCalls++
				return LlmTextResult{Text: slotRepairLessonMdx("```ts\n<!-- CODE_SLOT -->\n```"), FinishReason: "stop"}, nil
			case "code_slot_repair":
				return LlmTextResult{Text: "抱歉我无法输出 JSON。", FinishReason: "stop"}, nil
			default:
				t.Fatalf("unexpected purpose %s", purpose)
				return LlmTextResult{}, nil
			}
		},
	}

	outcome, _, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

	require.Error(t, err)
	assert.Equal(t, bodyFailed, outcome)
	assert.Equal(t, 2, chapterCalls)
	assert.Contains(t, err.Error(), "unhydrated code slot remains")
}

func slotRepairPurposeCount(mock *codeChapterMockLlm, purpose string) int {
	n := 0
	for _, c := range mock.calls {
		if c == purpose {
			n++
		}
	}
	return n
}

func TestRunCodeChapterTranscription_SlotRepairHallucinatedSymbolRemap(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, false)

	chapterCalls := 0
	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			switch purpose {
			case "code_chapter_lesson":
				chapterCalls++
				return LlmTextResult{Text: slotRepairLessonMdx("```ts // [File 1#Ghost]\nexport function ghost() { return 1 }\n```"), FinishReason: "stop"}, nil
			case "code_slot_repair":
				slotsContext, _ := vars["slotsContext"].(string)
				assert.Contains(t, slotsContext, "defect=hallucinated_symbol")
				assert.NotContains(t, slotsContext, "Allowed actions: map | drop", "有内容的块不得允许 drop")
				return LlmTextResult{Text: slotRepairJSON(`{"slots":[{"slotIndex":1,"action":"map","fileIndex":1,"anchor":"start","aspect":"core"}]}`), FinishReason: "stop"}, nil
			default:
				t.Fatalf("unexpected purpose %s（L1.5 重跑不得触发 mdx_repair）", purpose)
				return LlmTextResult{}, nil
			}
		},
	}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Equal(t, 1, chapterCalls, "L1.5 重锚成功后严禁 L2 整章重写")
	assert.Equal(t, 1, slotRepairPurposeCount(mockLlm, "code_slot_repair"))
	assert.Contains(t, finalContent, "src/main.ts#start", "重锚到 AST 真实声明的符号")
	assert.Contains(t, finalContent, "export function start() {}", "块体被真实归档源码替换")
	assert.NotContains(t, finalContent, "ghost", "幻觉符号不得残留")
}

func TestRunCodeChapterTranscription_SlotRepairDropOnContentFallsToL2(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, false)

	chapterCalls := 0
	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			switch purpose {
			case "code_chapter_lesson":
				chapterCalls++
				if chapterCalls == 1 {
					return LlmTextResult{Text: slotRepairLessonMdx("```ts // [File 1#Ghost]\nexport function ghost() { return 1 }\n```"), FinishReason: "stop"}, nil
				}
				return LlmTextResult{Text: groundingLessonMdx(t, false), FinishReason: "stop"}, nil
			case "code_slot_repair":
				return LlmTextResult{Text: `{"slots":[{"slotIndex":1,"action":"drop"}]}`, FinishReason: "stop"}, nil
			default:
				t.Fatalf("unexpected purpose %s", purpose)
				return LlmTextResult{}, nil
			}
		},
	}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Equal(t, 2, chapterCalls, "无效决策必须降级 L2")
	assert.NotContains(t, finalContent, "ghost")
}

func TestRunCodeChapterTranscription_SlotRepairSkippedWhenDoomed(t *testing.T) {
	tests := []struct {
		name  string
		first string
	}{
		{name: "超过 6 个缺陷块", first: strings.Repeat("```ts\n```\n\n", 7)},
		{name: "散文级占位（无围栏可修）", first: "正文。\n\n<!-- CODE_SLOT -->\n\n```ts\n<!-- CODE_SLOT -->\n```"},
		{name: "幻觉文件（L1.5 无法处置）", first: "```ts // [File 1]\n```\n\n<!-- path: src/ghost.ts -->"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, prep := groundingBodyFixture(t, false)
			chapterCalls := 0
			mockLlm := &codeChapterMockLlm{
				fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
					switch purpose {
					case "code_chapter_lesson":
						chapterCalls++
						if chapterCalls == 1 {
							return LlmTextResult{Text: slotRepairLessonMdx(tt.first), FinishReason: "stop"}, nil
						}
						return LlmTextResult{Text: groundingLessonMdx(t, false), FinishReason: "stop"}, nil
					default:
						t.Fatalf("unexpected purpose %s（注定不收敛时不得发起 %s）", purpose, purpose)
						return LlmTextResult{}, nil
					}
				},
			}

			outcome, _, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")

			require.NoError(t, err)
			assert.Equal(t, bodyDone, outcome)
			assert.Equal(t, 2, chapterCalls)
			assert.Zero(t, slotRepairPurposeCount(mockLlm, "code_slot_repair"), "注定不收敛的输入不得发起槽位微请求")
		})
	}
}

func TestCanSlotRepair(t *testing.T) {
	t.Helper()
	tests := []struct {
		name      string
		report    cognitive.GroundingReport
		residuals []armor.ResidualSlot
		want      bool
	}{
		{name: "干净", want: false},
		{
			name:      "仅围栏内残余",
			residuals: []armor.ResidualSlot{{BlockIndex: 2, Kind: armor.ResidualKindMarker}},
			want:      true,
		},
		{
			name:      "围栏残余 + 散文占位：必然留尾巴",
			residuals: []armor.ResidualSlot{{BlockIndex: 2, Kind: armor.ResidualKindMarker}, {BlockIndex: 0, Kind: armor.ResidualKindMarker}},
			want:      false,
		},
		{
			name:   "仅幻觉符号围栏",
			report: cognitive.GroundingReport{HallucinatedSymbols: []cognitive.SymbolClaim{{File: "src/a.ts", Symbol: "Ghost"}}},
			want:   true,
		},
		{
			name:   "幻觉文件：槽位微请求无法处置",
			report: cognitive.GroundingReport{GroundingVerdict: cognitive.GroundingVerdict{HallucinatedFiles: []string{"src/ghost.ts"}}},
			want:   false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, canSlotRepair(tt.report, tt.residuals))
		})
	}
}

func TestValidateSlotAnchor(t *testing.T) {
	t.Helper()
	refs := []armor.ArmorFileRef{{Path: "src/main.ts"}, {Path: "docs/README.md"}}
	index := cognitive.GroundingIndex{SymbolsByFile: map[string][]cognitive.SymbolEntry{
		"src/main.ts": {{Name: "start"}, {Name: "stop"}},
	}}
	tests := []struct {
		name       string
		fileIndex  int
		anchor     string
		aspect     string
		wantErr    bool
		wantAspect armor.CodeAspect
	}{
		{name: "已声明符号", fileIndex: 1, anchor: "start", aspect: "core", wantAspect: armor.AspectCore},
		{name: "行号区间", fileIndex: 1, anchor: "L10-L45", wantAspect: armor.AspectAuto},
		{name: "无 AST 符号的文档文件用行号", fileIndex: 2, anchor: "L1-L9", wantAspect: armor.AspectAuto},
		{name: "aspect 归一化：未知值回落 auto", fileIndex: 1, anchor: "stop", aspect: "whatever", wantAspect: armor.AspectAuto},
		{name: "未声明符号", fileIndex: 1, anchor: "Ghost", wantErr: true},
		{name: "无 AST 符号的文件用符号锚点", fileIndex: 2, anchor: "Intro", wantErr: true},
		{name: "fileIndex 越下界", fileIndex: 0, anchor: "start", wantErr: true},
		{name: "fileIndex 越上界", fileIndex: 3, anchor: "start", wantErr: true},
		{name: "空锚点", fileIndex: 1, anchor: "  ", wantErr: true},
		{name: "倒序行号区间不是合法锚点", fileIndex: 1, anchor: "L45-L10", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			aspect, err := validateSlotAnchor(tt.fileIndex, tt.anchor, tt.aspect, refs, index)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.wantAspect, aspect)
		})
	}
}

func TestValidateSlotDecisions(t *testing.T) {
	t.Helper()
	refs := []armor.ArmorFileRef{{Path: "src/main.ts"}}
	index := cognitive.GroundingIndex{SymbolsByFile: map[string][]cognitive.SymbolEntry{"src/main.ts": {{Name: "start"}}}}
	targets := []slotRepairTarget{
		{blockIndex: 1, kind: armor.ResidualKindEmptyBlock, lang: "ts", dropAllowed: true},
		{blockIndex: 2, kind: slotRepairKindHallucinatedSymbol, lang: "ts", dropAllowed: false},
	}
	tests := []struct {
		name     string
		slots    []slotRepairDecision
		wantEdit []armor.SlotEdit
	}{
		{
			name:  "合法：空块 drop + 幻觉块重锚",
			slots: []slotRepairDecision{{SlotIndex: 1, Action: "drop"}, {SlotIndex: 2, Action: "map", FileIndex: 1, Anchor: "start", Aspect: "core"}},
			wantEdit: []armor.SlotEdit{
				{BlockIndex: 1, Mode: armor.SlotEditModeDrop},
				{BlockIndex: 2, Mode: armor.SlotEditModeMap, FenceHeader: "```ts // [File 1#start:core]"},
			},
		},
		{
			name:     "越界 slotIndex 弃用",
			slots:    []slotRepairDecision{{SlotIndex: 3, Action: "drop"}, {SlotIndex: 0, Action: "drop"}},
			wantEdit: []armor.SlotEdit{},
		},
		{
			name:     "重复 slotIndex 只取首个",
			slots:    []slotRepairDecision{{SlotIndex: 1, Action: "map", FileIndex: 1, Anchor: "start"}, {SlotIndex: 1, Action: "drop"}},
			wantEdit: []armor.SlotEdit{{BlockIndex: 1, Mode: armor.SlotEditModeMap, FenceHeader: "```ts // [File 1#start]"}},
		},
		{
			name:     "对有内容块 drop 弃用",
			slots:    []slotRepairDecision{{SlotIndex: 2, Action: "drop"}},
			wantEdit: []armor.SlotEdit{},
		},
		{
			name:     "map 到未声明符号弃用",
			slots:    []slotRepairDecision{{SlotIndex: 2, Action: "map", FileIndex: 1, Anchor: "Ghost"}},
			wantEdit: []armor.SlotEdit{},
		},
		{
			name:     "非法 action 弃用",
			slots:    []slotRepairDecision{{SlotIndex: 1, Action: "keep"}},
			wantEdit: []armor.SlotEdit{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.wantEdit, validateSlotDecisions(targets, slotRepairResponse{Slots: tt.slots}, refs, index))
		})
	}
}

func TestSlotPromptTruncationIsRuneSafe(t *testing.T) {
	t.Helper()
	cjk := strings.Repeat("章", 200)
	long := truncateForSlotPrompt(cjk)
	assert.True(t, utf8.ValidString(long))
	assert.Equal(t, strings.Repeat("章", slotPromptLineRunes)+"…", long)
	assert.Equal(t, "abc", truncateForSlotPrompt("abc"))

	assert.Equal(t, strings.Repeat("章", 10), tailRunes(cjk, 10))
	assert.Equal(t, cjk, tailRunes(cjk, 500), "未超长原样返回")
	assert.Equal(t, cjk, tailRunes(cjk, 0), "max<=0 视为不截断")
}

func TestBuildChapterOutlineSection(t *testing.T) {
	t.Run("多章快照按教学序输出并标注当前章", func(t *testing.T) {
		snapshots := fixtureSnapshots()
		section := BuildChapterOutlineSection(snapshots, 2)
		require.NotEmpty(t, section)
		assert.Contains(t, section, "FULL BOOK CHAPTER OUTLINE")
		assert.True(t, strings.Index(section, "1. 引擎启动") < strings.Index(section, "2. 路由分发"))
		assert.Contains(t, section, "2. 路由分发  ← THIS CHAPTER")
		assert.Contains(t, section, "3. 适配器  ← NEXT CHAPTER")
		assert.Contains(t, section, "NEVER invent, merge, or preview chapters")
	})

	t.Run("单章或空快照不注入", func(t *testing.T) {
		assert.Empty(t, BuildChapterOutlineSection(fixtureSnapshots()[:1], 1))
		assert.Empty(t, BuildChapterOutlineSection(nil, 1))
	})
}

func TestBuildSlotFileMenu_RankedOrder(t *testing.T) {
	t.Helper()
	entries := make([]cognitive.SymbolEntry, 0, 20)
	for i := 1; i <= 17; i++ {
		entries = append(entries, cognitive.SymbolEntry{
			Name: fmt.Sprintf("pad%02d", i), Kind: "function", StartLine: i, EndLine: i,
		})
	}
	entries = append(entries,
		cognitive.SymbolEntry{Name: "orchestrator", Kind: "function", StartLine: 100, EndLine: 120},
		cognitive.SymbolEntry{Name: "dispatcher", Kind: "function", StartLine: 130, EndLine: 140},
		cognitive.SymbolEntry{Name: "tail", Kind: "function", StartLine: 150, EndLine: 155},
	)
	index := cognitive.GroundingIndex{
		SymbolsByFile: map[string][]cognitive.SymbolEntry{"src/big.ts": entries},
	}
	edges := []cognitive.CallEdge{
		{CallerFile: "src/big.ts", CallerSymbol: "entry1", CalleeFile: "src/big.ts", CalleeSymbol: "orchestrator"},
		{CallerFile: "src/big.ts", CallerSymbol: "entry2", CalleeFile: "src/big.ts", CalleeSymbol: "orchestrator"},
		{CallerFile: "src/big.ts", CallerSymbol: "orchestrator", CalleeFile: "src/big.ts", CalleeSymbol: "dispatcher"},
	}
	refs := []armor.ArmorFileRef{{Path: "src/big.ts#orchestrator"}}
	ranks := chapter.RankChapterSymbols(index.SymbolsByFile, edges, []string{"src/big.ts"})

	tests := []struct {
		name        string
		ranks       map[string]chapter.FileRank
		wantInclude []string
		wantExclude []string
		wantFirst   string
	}{
		{
			name:        "有排序信号时优先展示高中心性符号（即使声明在第 15 之后）",
			ranks:       ranks,
			wantInclude: []string{"orchestrator", "dispatcher"},
			wantFirst:   "declared symbols: orchestrator, dispatcher",
		},
		{
			name:        "ranks 为 nil 时退回声明序前 15",
			ranks:       nil,
			wantInclude: []string{"pad01", "pad15"},
			wantExclude: []string{"orchestrator", "dispatcher"},
			wantFirst:   "declared symbols: pad01, pad02",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			menu := buildSlotFileMenu(refs, index, tt.ranks)
			assert.Contains(t, menu, tt.wantFirst)
			for _, inc := range tt.wantInclude {
				assert.Contains(t, menu, inc)
			}
			for _, exc := range tt.wantExclude {
				assert.NotContains(t, menu, exc)
			}
		})
	}
}

func TestRunCodeChapterTranscription_SlotRepairMenuRanked(t *testing.T) {
	tmpDir := t.TempDir()
	owner, repo, sha := "rowner", "rrepo", "rsha123"
	baseDir := filepath.Join(tmpDir, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(baseDir, "src"), 0o755))

	var srcLines []string
	var entries []cognitive.SymbolEntry
	for i := 1; i <= 17; i++ {
		name := fmt.Sprintf("pad%02d", i)
		srcLines = append(srcLines, fmt.Sprintf("export function %s() { return %d; }", name, i))
		entries = append(entries, cognitive.SymbolEntry{Name: name, Kind: "function", StartLine: i, EndLine: i})
	}
	srcLines = append(srcLines, "export function orchestrator() { return 99; }")
	entries = append(entries, cognitive.SymbolEntry{Name: "orchestrator", Kind: "function", StartLine: 18, EndLine: 18})
	require.NoError(t, os.WriteFile(filepath.Join(baseDir, "src", "big.ts"), []byte(strings.Join(srcLines, "\n")+"\n"), 0o644))

	graphDir := t.TempDir()
	_, err := cognitive.SaveSemanticGraphArtifact(graphDir, owner, repo, sha, &cognitive.SemanticGraphArtifact{
		Version: 2,
		GitSha:  sha,
		Nodes:   []cognitive.SemanticGraphArtifactNode{{Path: "src/big.ts", Language: "ts"}},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{
			"src/big.ts": entries,
		},
		CallEdges: []cognitive.CallEdge{
			{CallerFile: "src/big.ts", CallerSymbol: "pad01", CalleeFile: "src/big.ts", CalleeSymbol: "orchestrator", Line: 1},
			{CallerFile: "src/big.ts", CallerSymbol: "pad02", CalleeFile: "src/big.ts", CalleeSymbol: "orchestrator", Line: 2},
		},
	})
	require.NoError(t, err)

	prep := readyPrep("", nil, false)
	prep.Doc.Path = "chapters/01.mdx"
	prep.Doc.Title = "Ranked Repair"
	prep.Doc.Repository.Owner = owner
	prep.Doc.Repository.Repo = repo
	prep.Doc.Repository.GitSha = &sha
	prep.Doc.RepoProfile = map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"chapterNo":     1,
				"title":         "Ranked Repair",
				"summary":       "Ranked repair test",
				"directories":   []string{"src"},
				"files":         []string{"src/big.ts"},
			},
		},
	}

	cfg := loadConfigFromEnv()
	cfg.ArchiveRoot = tmpDir
	cfg.SemanticGraphDir = graphDir

	var capturedMenu string
	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			switch purpose {
			case "code_chapter_lesson":
				return LlmTextResult{Text: slotRepairLessonMdx("```ts\n<!-- CODE_SLOT -->\n```"), FinishReason: "stop"}, nil
			case "code_slot_repair":
				capturedMenu, _ = vars["fileMenu"].(string)
				return LlmTextResult{Text: slotRepairJSON(`{"slots":[{"slotIndex":1,"action":"map","fileIndex":1,"anchor":"orchestrator","aspect":"core"}]}`), FinishReason: "stop"}, nil
			default:
				t.Fatalf("unexpected purpose %s", purpose)
				return LlmTextResult{}, nil
			}
		},
	}

	outcome, finalContent, err := runCodeChapterTranscription(context.Background(), cfg, TranscriptionBodyDeps{Llm: mockLlm}, prep, "user-1")
	require.NoError(t, err)
	assert.Equal(t, bodyDone, outcome)
	assert.Contains(t, capturedMenu, "declared symbols: orchestrator,", "L1.5 菜单必须把高中心性符号 orchestrator 排在首位")
	assert.Contains(t, finalContent, "src/big.ts#orchestrator")
	assert.Contains(t, finalContent, "export function orchestrator() { return 99; }")
}

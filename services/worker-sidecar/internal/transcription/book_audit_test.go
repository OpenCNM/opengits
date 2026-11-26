package transcription

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBookAuditHealthCheck(t *testing.T) {
	t.Helper()
	docs := []BookAuditDoc{
		{
			ID: "d1", Path: "chapters/01.mdx", Title: "全景",
			Content: "# 全景\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n收尾。",
		},
		{
			ID: "d2", Path: "chapters/02.mdx", Title: "引擎",
			Content: "## 引擎\n\n```ts // src/main.ts#start\nexport function start() {}\n```\n\n如第 9 章所述的架构。",
		},
		{
			ID: "d3", Path: "chapters/03.mdx", Title: "工具",
			Content: "## 工具\n\n```ts\nconsole.log(1)\n```\n\n```bash\necho hi\n```\n",
		},
	}
	filesByPath := map[string][]string{
		"chapters/01.mdx": {"src/main.ts"},
		"chapters/02.mdx": {"src/main.ts"},
		"chapters/03.mdx": {"src/util.ts"},
	}

	digests, forced, candidates := bookAuditHealthCheck(docs, filesByPath, 3)

	require.Len(t, forced, 1)
	assert.Equal(t, "chapters/01.mdx", forced[0].ChapterPath)
	assert.Equal(t, bookDefectThinCode, forced[0].IssueType)

	candKeys := map[string]string{}
	for _, c := range candidates {
		candKeys[c.ChapterPath+"#"+c.IssueType] = c.FixHint
	}
	assert.Contains(t, candKeys, "chapters/02.mdx#"+bookDefectThinCode, "1 代码块仅候选")
	assert.Contains(t, candKeys, "chapters/02.mdx#"+bookDefectIntroMismatch, "第9章越界候选")
	assert.Contains(t, candKeys, "chapters/03.mdx#"+bookDefectPeripheralOnly, "低锚点占比候选")

	require.Len(t, digests, 3)
	assert.Equal(t, 0, digests[0].CodeBlocks, "mermaid 不计入代码块")
	assert.Equal(t, 1, digests[1].CodeBlocks)
	assert.Equal(t, 1, digests[1].AnchoredCount)
	assert.True(t, digests[0].HasSourceFiles)
}

func TestSplitIntroBlocks(t *testing.T) {
	t.Helper()
	t.Run("常规：保留标题/围栏/提示框/列表/表格/JSX，仅散文进可编辑列表", func(t *testing.T) {
		content := "---\nsummary: s\n---\n" +
			"# 第一章：架构\n\n" +
			"<Callout type=\"info\">\n\n保留的提示框内部段落\n\n</Callout>\n\n" +
			"> 引用提示\n\n" +
			":::note\n\n保留容器内容\n\n:::\n\n" +
			"- 列表一\n- 列表二\n\n" +
			"| 列1 | 列2 |\n| --- | --- |\n| a | b |\n\n" +
			"```ts\nconst x = 1\n```\n\n" +
			"第一段散文引用了第 9 章。\n\n" +
			"第二段散文。\n\n" +
			"## 第一节\n\n正文。\n"
		start, end, blocks, trailing := splitIntroBlocks(content)
		require.NotEmpty(t, blocks)
		assert.NotContains(t, content[start:end], "## 第一节")

		var editable []introBlock
		var rebuilt strings.Builder
		for _, b := range blocks {
			rebuilt.WriteString(b.Sep)
			rebuilt.WriteString(b.Raw)
			if b.Kind == introBlockProse {
				editable = append(editable, b)
			}
		}
		rebuilt.WriteString(trailing)
		assert.Equal(t, content[start:end], rebuilt.String(), "切分块重组字节级保真")
		require.Len(t, editable, 2)
		assert.Equal(t, 1, editable[0].Index)
		assert.Equal(t, "第一段散文引用了第 9 章。", editable[0].Raw)
		assert.Equal(t, 2, editable[1].Index)
		assert.Equal(t, "第二段散文。", editable[1].Raw)
	})

	t.Run("导言为空：取首个 ## 节，保留 ## 标题，仅后续散文可编辑", func(t *testing.T) {
		content := "---\nsummary: s\n---\n## 架构叙事：为什么以示例项目收官\n\n本节引用了不存在的章节主题。\n\n## 下一节\n\n正文。"
		start, end, blocks, _ := splitIntroBlocks(content)
		span := content[start:end]
		assert.Contains(t, span, "## 架构叙事：为什么以示例项目收官")
		assert.NotContains(t, span, "## 下一节")
		require.Len(t, blocks, 2)
		assert.Equal(t, introBlockPreserved, blocks[0].Kind)
		assert.Equal(t, "## 架构叙事：为什么以示例项目收官", blocks[0].Raw)
		assert.Equal(t, introBlockProse, blocks[1].Kind)
		assert.Equal(t, 1, blocks[1].Index)
		assert.Equal(t, "本节引用了不存在的章节主题。", blocks[1].Raw)
	})

	t.Run("围栏内 ## 不误判为章节边界", func(t *testing.T) {
		content := "---\nsummary: s\n---\n导言散文。\n\n```md\n## 伪标题\n```\n\n## 真实第一节\n\n正文。"
		start, end, blocks, _ := splitIntroBlocks(content)
		span := content[start:end]
		assert.Contains(t, span, "## 伪标题")
		assert.NotContains(t, span, "## 真实第一节")
		var editable int
		for _, b := range blocks {
			if b.Kind == introBlockProse {
				editable++
			}
		}
		assert.Equal(t, 1, editable)
	})

	t.Run("无散文段（仅标题/列表/代码块）时可编辑数为 0", func(t *testing.T) {
		content := "---\nsummary: s\n---\n# 标题\n\n- 仅列表\n\n## 第一节\n\n正文。"
		_, _, blocks, _ := splitIntroBlocks(content)
		for _, b := range blocks {
			assert.NotEqual(t, introBlockProse, b.Kind)
		}
	})
}

func TestMergeBookAuditDefects(t *testing.T) {
	forced := []bookAuditDefect{{ChapterPath: "chapters/01.mdx", IssueType: bookDefectThinCode, forced: true}}
	ai := []bookAuditDefect{
		{ChapterPath: "chapters/01.mdx", IssueType: bookDefectThinCode},
		{ChapterPath: "chapters/09.mdx", IssueType: bookDefectIntroMismatch},
		{ChapterPath: "chapters/02.mdx", IssueType: bookDefectPeripheralOnly},
	}
	merged := mergeBookAuditDefects(forced, ai)
	require.Len(t, merged, 3)
	assert.True(t, merged[0].forced || merged[2].forced, "强制项保留")
}

func TestBookAuditAIReviewHardValidation(t *testing.T) {
	t.Helper()
	docs := []BookAuditDoc{{ID: "d1", Path: "chapters/01.mdx", Title: "甲", Content: "x"}}
	digests := []bookAuditChapterDigest{{
		Path: "chapters/01.mdx", Title: "甲", CharCount: 10, CodeBlocks: 1,
		Candidates: []string{"[thin_code] only one code block"},
	}}

	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			assert.Equal(t, "book_final_audit", purpose)
			digestStr, _ := vars["chaptersDigest"].(string)
			assert.Contains(t, digestStr, "[thin_code] only one code block", "确定性候选信号必须进入 AI 摘要")
			return LlmTextResult{Text: "```json\n{\"defects\":[" +
				"{\"chapterPath\":\"chapters/01.mdx\",\"issueType\":\"intro_mismatch\",\"fixHint\":\"h1\"}," +
				"{\"chapterPath\":\"chapters/99.mdx\",\"issueType\":\"intro_mismatch\",\"fixHint\":\"幻觉路径\"}," +
				"{\"chapterPath\":\"chapters/01.mdx\",\"issueType\":\"alien_type\",\"fixHint\":\"非法枚举\"}" +
				"]}\n```", FinishReason: "stop"}, nil
		},
	}

	defects, err := bookAuditAIReview(context.Background(), mockLlm, docs, digests, "u1")
	require.NoError(t, err)
	require.Len(t, defects, 1)
	assert.Equal(t, "chapters/01.mdx", defects[0].ChapterPath)
}

func TestBookAuditHealthCheckChapterRefsAndDigest(t *testing.T) {
	t.Helper()
	docs := []BookAuditDoc{
		{
			ID: "d1", Path: "chapters/01.mdx", Title: "英文越界",
			Content: "# Ch1\n\nSee Chapter 12 for details.\n\n```ts // src/main.ts#start\nexport function start() {}\n```\n",
		},
		{
			ID: "d2", Path: "chapters/02.mdx", Title: "围栏内不误报",
			Content: "# Ch2\n\n```ts // src/main.ts#start\n// Chapter 99 and 第 88 章 inside code\n```\n",
		},
	}
	filesByPath := map[string][]string{
		"chapters/01.mdx": {"src/main.ts"},
		"chapters/02.mdx": {"src/main.ts"},
	}
	digests, _, candidates := bookAuditHealthCheck(docs, filesByPath, 2)
	require.Len(t, digests, 2)
	assert.Equal(t, 1, digests[0].AnchoredCount)
	assert.Contains(t, digests[0].Candidates, "[intro_mismatch] references chapter 12 beyond the 2-chapter outline")
	assert.NotContains(t, strings.Join(digests[1].Candidates, ","), "intro_mismatch", "围栏内 Chapter 99 不得误报越界")

	hasEnRef := false
	for _, c := range candidates {
		if c.ChapterPath == "chapters/01.mdx" && c.IssueType == bookDefectIntroMismatch {
			hasEnRef = true
		}
		if c.ChapterPath == "chapters/02.mdx" && c.IssueType == bookDefectIntroMismatch {
			t.Fatalf("unexpected intro_mismatch candidate for fenced ref")
		}
	}
	assert.True(t, hasEnRef)
}

func TestRegateChapterContent(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, false)

	t.Run("合法修补内容过门禁并水合源码", func(t *testing.T) {
		content := "---\nsummary: s\n---\n## 修复章\n\n```ts // [File 1#start:core]\n```\n"
		out, err := regateChapterContent(context.Background(), cfg, TranscriptionBodyDeps{}, prep, "chapters/01.mdx", nil, content)
		require.NoError(t, err)
		assert.Contains(t, out, "export function start() {}", "插槽水合为真实归档源码")
		assert.Contains(t, out, "src/main.ts#start")
		assert.NotContains(t, out, "CODE_SLOT")
	})

	t.Run("残余占位不过门禁", func(t *testing.T) {
		content := "---\nsummary: s\n---\n## 修复章\n\n```ts\n<!-- CODE_SLOT -->\n```\n"
		_, err := regateChapterContent(context.Background(), cfg, TranscriptionBodyDeps{}, prep, "chapters/01.mdx", nil, content)
		require.Error(t, err, "残余插槽必须 Fail-Closed 拒绝写回")
		assert.Contains(t, err.Error(), "residual")
	})
}

func TestRepairChapterIntroSplice(t *testing.T) {
	_, prep := groundingBodyFixture(t, false)
	langEn := "en"
	prep.Effective.TargetLanguage = &langEn
	doc := BookAuditDoc{
		ID: "d1", Path: "chapters/01.mdx", Title: "Grounding Gate Chapter",
		Content: "---\nsummary: s\n---\n## 架构叙事\n\n<Callout type=\"info\">\n保留的提示\n</Callout>\n\n导言引用了第 9 章的主题。\n\n## 后续\n\n正文。",
	}
	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
			assert.Equal(t, "chapter_intro_repair", purpose)
			assert.Equal(t, "en", vars["targetLanguage"], "A14：目标语言取触发章快照")
			intro, _ := vars["introSection"].(string)
			assert.Contains(t, intro, "[1]\n导言引用了第 9 章的主题。")
			assert.NotContains(t, intro, "## 架构叙事", "标题不得暴露给 LLM")
			assert.NotContains(t, intro, "<Callout", "JSX 提示框不得暴露给 LLM")
			return LlmTextResult{Text: `{"paragraphs":[{"index":1,"text":"This chapter focuses on the architecture itself."}]}`, FinishReason: "stop"}, nil
		},
	}
	patched, err := repairChapterIntro(context.Background(), mockLlm, prep, doc, bookAuditDefect{ChapterPath: doc.Path, IssueType: bookDefectIntroMismatch, FixHint: "intro mismatch"}, "u1")
	require.NoError(t, err)
	assert.Contains(t, patched, "## 架构叙事\n\n<Callout type=\"info\">\n保留的提示\n</Callout>")
	assert.Contains(t, patched, "This chapter focuses on the architecture itself.")
	assert.NotContains(t, patched, "第 9 章")
	assert.True(t, strings.Count(patched, "## 后续") == 1, "其余章节不受影响")
}

func TestRepairChapterIntroGuards(t *testing.T) {
	t.Helper()
	tests := []struct {
		name    string
		content string
		llmResp string
		wantLLM bool
	}{
		{
			name:    "无散文可编辑段：直接跳过不调 LLM",
			content: "---\nsummary: s\n---\n# 仅标题\n\n- 仅列表\n\n## 第一节\n\n正文。",
			wantLLM: false,
		},
		{
			name:    "越界下标：Fail-Closed 拒绝",
			content: "---\nsummary: s\n---\n导言段。\n\n## 第一节\n\n正文。",
			llmResp: `{"paragraphs":[{"index":2,"text":"越界"}]}`,
			wantLLM: true,
		},
		{
			name:    "重复下标：Fail-Closed 拒绝",
			content: "---\nsummary: s\n---\n导言段。\n\n## 第一节\n\n正文。",
			llmResp: `{"paragraphs":[{"index":1,"text":"A"},{"index":1,"text":"B"}]}`,
			wantLLM: true,
		},
		{
			name:    "返回含代码围栏：Fail-Closed 拒绝",
			content: "---\nsummary: s\n---\n导言段。\n\n## 第一节\n\n正文。",
			llmResp: "{\"paragraphs\":[{\"index\":1,\"text\":\"```ts\\ncode\\n```\"}]}",
			wantLLM: true,
		},
		{
			name:    "返回含标题行：Fail-Closed 拒绝",
			content: "---\nsummary: s\n---\n导言段。\n\n## 第一节\n\n正文。",
			llmResp: `{"paragraphs":[{"index":1,"text":"## 擅自改标题\n\n正文"}]}`,
			wantLLM: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, prep := groundingBodyFixture(t, false)
			called := false
			mockLlm := &codeChapterMockLlm{
				fn: func(string, map[string]any) (LlmTextResult, error) {
					called = true
					return LlmTextResult{Text: tt.llmResp, FinishReason: "stop"}, nil
				},
			}
			_, err := repairChapterIntro(context.Background(), mockLlm, prep, BookAuditDoc{
				ID: "d1", Path: "chapters/01.mdx", Title: "T", Content: tt.content,
			}, bookAuditDefect{ChapterPath: "chapters/01.mdx", IssueType: bookDefectIntroMismatch}, "u1")
			assert.Error(t, err)
			assert.Equal(t, tt.wantLLM, called)
		})
	}
}

func TestEnrichChapterCodePlacementAndGitSha(t *testing.T) {
	cfg, prep := groundingBodyFixture(t, false)
	chapSha := "chapter-sha-old"
	chapSrcDir := filepath.Join(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, chapSha, "src")
	require.NoError(t, os.MkdirAll(chapSrcDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(chapSrcDir, "main.ts"), []byte("export function chapterVersionFn() {}\n"), 0o644))
	_, err := cognitive.SaveSemanticGraphArtifact(cfg.SemanticGraphDir, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, chapSha, &cognitive.SemanticGraphArtifact{
		Version: 2, GitSha: chapSha,
		Nodes: []cognitive.SemanticGraphArtifactNode{{Path: "src/main.ts", Language: "ts"}},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{
			"src/main.ts": {{Name: "chapterVersionFn", Kind: "function", StartLine: 1, EndLine: 1}},
		},
	})
	require.NoError(t, err)

	mockLlm := &codeChapterMockLlm{
		fn: func(purpose string, _ map[string]any) (LlmTextResult, error) {
			assert.Equal(t, "chapter_code_enrich", purpose)
			return LlmTextResult{Text: `{"sectionTitle":"实战代码透视","leadIn":"结合旧版源码。","slots":[{"fileIndex":1,"anchor":"chapterVersionFn"}]}`, FinishReason: "stop"}, nil
		},
	}

	t.Run("插到最后一个真实 ## 之前（忽略围栏内 ##）并按章 gitSha 校对", func(t *testing.T) {
		doc := BookAuditDoc{
			ID: "d1", Path: "chapters/01.mdx", Title: "Grounding Gate Chapter", GitSha: &chapSha,
			Content: "---\nsummary: s\n---\n# 第一章\n\n## 核心机制\n\n正文。\n\n## 小结\n\n总结。\n\n```md\n## 围栏内伪标题\n```\n",
		}
		out, err := enrichChapterCode(context.Background(), cfg, BodyDeps{Llm: mockLlm}, prep, doc, bookAuditDefect{ChapterPath: doc.Path, IssueType: bookDefectThinCode}, "u1")
		require.NoError(t, err)
		enrichIdx := strings.Index(out, "## 实战代码透视")
		summaryIdx := strings.Index(out, "## 小结")
		require.Greater(t, enrichIdx, 0)
		require.Greater(t, summaryIdx, enrichIdx, "增强节必须插在最后一个 ## 小结之前")

		regated, err := regateChapterContent(context.Background(), cfg, BodyDeps{}, prep, doc.Path, doc.GitSha, out)
		require.NoError(t, err)
		assert.Contains(t, regated, "export function chapterVersionFn() {}")
	})

	t.Run("全篇无 ## 时追加到文末", func(t *testing.T) {
		doc := BookAuditDoc{
			ID: "d1", Path: "chapters/01.mdx", Title: "Grounding Gate Chapter", GitSha: &chapSha,
			Content: "# 第一章\n\n只有散文。",
		}
		out, err := enrichChapterCode(context.Background(), cfg, BodyDeps{Llm: mockLlm}, prep, doc, bookAuditDefect{ChapterPath: doc.Path, IssueType: bookDefectThinCode}, "u1")
		require.NoError(t, err)
		assert.True(t, strings.HasPrefix(out, "# 第一章\n\n只有散文。\n\n## 实战代码透视"))
	})
}

func TestEnrichChapterCode_CappedSlotsRankedMenuAndExplanations(t *testing.T) {
	t.Helper()
	tmpDir := t.TempDir()
	owner, repo, sha := "eowner", "erepo", "esha123"
	baseDir := filepath.Join(tmpDir, owner, repo, sha)
	require.NoError(t, os.MkdirAll(filepath.Join(baseDir, "src"), 0o755))

	var srcLines []string
	var entries []cognitive.SymbolEntry
	for i := 1; i <= 16; i++ {
		name := fmt.Sprintf("pad%02d", i)
		srcLines = append(srcLines, fmt.Sprintf("export function %s() {}", name))
		entries = append(entries, cognitive.SymbolEntry{Name: name, Kind: "function", StartLine: i, EndLine: i})
	}
	srcLines = append(srcLines,
		"export function coreA() {}",
		"export function coreB() {}",
		"export function coreC() {}",
	)
	entries = append(entries,
		cognitive.SymbolEntry{Name: "coreA", Kind: "function", StartLine: 17, EndLine: 17},
		cognitive.SymbolEntry{Name: "coreB", Kind: "function", StartLine: 18, EndLine: 18},
		cognitive.SymbolEntry{Name: "coreC", Kind: "function", StartLine: 19, EndLine: 19},
	)
	require.NoError(t, os.WriteFile(filepath.Join(baseDir, "src", "main.ts"), []byte(strings.Join(srcLines, "\n")+"\n"), 0o644))

	graphDir := t.TempDir()
	_, err := cognitive.SaveSemanticGraphArtifact(graphDir, owner, repo, sha, &cognitive.SemanticGraphArtifact{
		Version: 2,
		GitSha:  sha,
		Nodes:   []cognitive.SemanticGraphArtifactNode{{Path: "src/main.ts", Language: "ts"}},
		SymbolsByFile: map[string][]cognitive.SymbolEntry{
			"src/main.ts": entries,
		},
		CallEdges: []cognitive.CallEdge{
			{CallerFile: "src/main.ts", CallerSymbol: "pad01", CalleeFile: "src/main.ts", CalleeSymbol: "coreA", Line: 1},
			{CallerFile: "src/main.ts", CallerSymbol: "pad02", CalleeFile: "src/main.ts", CalleeSymbol: "coreA", Line: 2},
			{CallerFile: "src/main.ts", CallerSymbol: "coreA", CalleeFile: "src/main.ts", CalleeSymbol: "coreB", Line: 17},
			{CallerFile: "src/main.ts", CallerSymbol: "pad03", CalleeFile: "src/main.ts", CalleeSymbol: "coreB", Line: 3},
		},
	})
	require.NoError(t, err)

	prep := readyPrep("", nil, false)
	prep.Doc.Path = "chapters/01.mdx"
	prep.Doc.Title = "Enrich Ranked"
	prep.Doc.Repository.Owner = owner
	prep.Doc.Repository.Repo = repo
	prep.Doc.Repository.GitSha = &sha
	prep.Doc.RepoProfile = map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"chapterNo":     1,
				"title":         "Enrich Ranked",
				"summary":       "Enrich test",
				"directories":   []string{"src"},
				"files":         []string{"src/main.ts"},
			},
		},
	}

	cfg := loadConfigFromEnv()
	cfg.ArchiveRoot = tmpDir
	cfg.SemanticGraphDir = graphDir
	doc := BookAuditDoc{
		ID: "d1", Path: "chapters/01.mdx", Title: "Enrich Ranked", GitSha: &sha,
		Content: "## 核心机制\n\n正文。\n\n## 小结\n\n总结。\n",
	}

	tests := []struct {
		name        string
		llmResp     string
		wantErr     bool
		wantSub     []string
		wantNotSub  []string
		wantOrdered [][2]string
	}{
		{
			name: "3 个槽位截断为 2 个，并为每个槽位输出独立机制导读",
			llmResp: `{"sectionTitle":"机制源码验证","leadIn":"结合主干实现看两处关键路径。","slots":[` +
				`{"fileIndex":1,"anchor":"coreA","aspect":"core","explanation":"coreA 负责入口调度与状态校验。"},` +
				`{"fileIndex":1,"anchor":"coreB","aspect":"core","explanation":"coreB 负责落地写入并保证幂等。"},` +
				`{"fileIndex":1,"anchor":"coreC","aspect":"core","explanation":"coreC 超出上限应被截断。"}` +
				`]}`,
			wantSub: []string{
				"## 机制源码验证",
				"结合主干实现看两处关键路径。",
				"coreA 负责入口调度与状态校验。",
				"```typescript // [File 1#coreA:core]",
				"coreB 负责落地写入并保证幂等。",
				"```typescript // [File 1#coreB:core]",
			},
			wantNotSub: []string{"coreC"},
			wantOrdered: [][2]string{
				{"coreA 负责入口调度与状态校验。", "```typescript // [File 1#coreA:core]"},
				{"```typescript // [File 1#coreA:core]", "coreB 负责落地写入并保证幂等。"},
				{"coreB 负责落地写入并保证幂等。", "```typescript // [File 1#coreB:core]"},
			},
		},
		{
			name: "重复槽位去重后仍可补足第 2 个不同槽位",
			llmResp: `{"sectionTitle":"机制源码验证","leadIn":"导读。","slots":[` +
				`{"fileIndex":1,"anchor":"coreA","explanation":"第一段解释。"},` +
				`{"fileIndex":1,"anchor":"coreA","explanation":"重复槽跳过。"},` +
				`{"fileIndex":1,"anchor":"coreB","explanation":"第二段解释。"}` +
				`]}`,
			wantSub:    []string{"[File 1#coreA]", "[File 1#coreB]", "第一段解释。", "第二段解释。"},
			wantNotSub: []string{"重复槽跳过。"},
		},
		{
			name:    "explanation 含代码围栏：Fail-Closed 拒绝",
			llmResp: `{"sectionTitle":"机制源码验证","leadIn":"导读。","slots":[{"fileIndex":1,"anchor":"coreA","explanation":"非法\n` + "```" + `ts\ncode\n` + "```" + `"}]}`,
			wantErr: true,
		},
		{
			name:    "幻觉符号：Fail-Closed 拒绝",
			llmResp: `{"sectionTitle":"机制源码验证","leadIn":"导读。","slots":[{"fileIndex":1,"anchor":"phantomSym","explanation":"不存在。"}]}`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var capturedMenu string
			mockLlm := &codeChapterMockLlm{
				fn: func(_ string, vars map[string]any) (LlmTextResult, error) {
					capturedMenu, _ = vars["fileMenu"].(string)
					return LlmTextResult{Text: tt.llmResp, FinishReason: "stop"}, nil
				},
			}
			out, err := enrichChapterCode(context.Background(), cfg, BodyDeps{Llm: mockLlm}, prep, doc, bookAuditDefect{ChapterPath: doc.Path, IssueType: bookDefectThinCode}, "u1")
			assert.Contains(t, capturedMenu, "declared symbols: coreA, coreB", "enrichChapterCode 菜单必须按度中心性排序")
			if tt.wantErr {
				assert.Error(t, err)
				return
			}
			require.NoError(t, err)
			for _, sub := range tt.wantSub {
				assert.Contains(t, out, sub)
			}
			for _, notSub := range tt.wantNotSub {
				assert.NotContains(t, out, notSub)
			}
			for _, pair := range tt.wantOrdered {
				assert.Less(t, strings.Index(out, pair[0]), strings.Index(out, pair[1]))
			}
		})
	}
}

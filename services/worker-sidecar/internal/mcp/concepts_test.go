package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// seedConceptRich details 渲染所需富概念。
func seedConceptRich(t *testing.T, store *readFakeStore) {
	t.Helper()
	store.conceptRich = []ConceptRichNode{
		{
			ID: "cc1", ConceptName: "事件循环", Category: "architecture", Slug: "event-loop",
			Summary: str("单线程事件循环的核心机制"), PrinciplesText: str("原理第一行\n原理第二行"),
			AuthorReflections: str("思考一\n思考二"), SopSteps: []string{"识别调用栈", "追踪任务队列"},
			SubTopics: []string{"宏任务", "微任务"}, Tags: []string{"nodejs", "async"},
			CanonicalKey: str("event-loop"), CanonicalName: str("事件循环"),
			DocumentPath: str("README.md"), HeadingPath: str("README.md#事件循环"),
		},
	}
}

func TestConceptDetailsFullTemplate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedConceptRich(t, store)
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "get_concept_details", `{"concept":"event-loop"}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	require.False(t, isError, "unexpected isError: %s", text)

	want := "🧠 概念详情 (Concept Details): 事件循环 (architecture)\n" +
		"- 来源: README.md [Address: README.md#事件循环]\n" +
		"- 设计摘要: 单线程事件循环的核心机制\n" +
		"- 核心原理 (Principles):\n  原理第一行\n  原理第二行\n" +
		"- 作者思考与 Trade-off 权衡:\n  > 思考一\n  > 思考二\n" +
		"- 核心 SOP 开发步骤:\n  1. 识别调用栈\n  2. 追踪任务队列\n" +
		"- 关联主题 (Sub Topics): 宏任务、微任务\n" +
		"- 标签 (Tags): nodejs、async\n" +
		"\n(Use read_document with \"section\" set to the Address above to read the source section in full.)"
	assert.True(t, strings.HasPrefix(text, want), "details template mismatch:\n got: %q\nwant prefix:\n%q", text, want)
}

func TestConceptDetailsMergeAnnotation(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedConceptRich(t, store)
	// 第二个同组成员 → memberCount=2 触发归并标注
	store.conceptRich = append(store.conceptRich, ConceptRichNode{
		ID: "cc2", ConceptName: "事件循环（下）", Category: "architecture",
		CanonicalKey: str("event-loop"), CanonicalName: str("事件循环"),
	})
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "explore_concept", `{"concept":"事件循环","action":"details"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "- 归并: 事件循环 · 同义 2 处\n")
}

func TestConceptDetailsErrorVariants(t *testing.T) {
	tests := []struct {
		name      string
		arguments string
		wantError string
	}{
		{
			name:      "unknown concept not found",
			arguments: `{"concept":"nope"}`,
			wantError: `Error: Concept "nope" not found in octo/kit. Use read_document (no arguments; see Knowledge Graph Concepts section) to see available concepts, or search to locate related content.`,
		},
		{
			name:      "missing concept parameter guard",
			arguments: `{}`,
			wantError: `Error: "concept" parameter is required for details, neighbors, or learning path exploration.`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newReadFakeStore()
			seedAuth(t, store)
			ts := readTestServer(t, store, nil)
			resp, body := callRead(t, ts, "/api/mcp/octo/kit", "explore_concept", tt.arguments)
			defer resp.Body.Close()
			text, isError := parseResultText(t, body)
			assert.True(t, isError)
			assert.Equal(t, tt.wantError, text)
		})
	}
}

func TestConceptNeighborsTemplate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedConceptRich(t, store)
	store.memberIDs["cc1"] = []string{"cc1"}
	store.edges = []EdgeRef{
		{SourceID: "n1", TargetID: "cc1", Type: "prerequisite", Weight: 0.8, Source: "curriculum_order"},
		{SourceID: "cc1", TargetID: "n2", Type: "successor", Weight: 0.6, Source: "cooccurrence"},
	}
	store.nodesByID["n1"] = ConceptNodeLite{ID: "n1", ConceptName: "基础概念", Category: "principle", DocumentPath: str("README.md"), HeadingPath: str("README.md#basics"), CanonicalName: str("基础")}
	store.nodesByID["n2"] = ConceptNodeLite{ID: "n2", ConceptName: "异步模式", Category: "workflow"}
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "concept_neighbors", `{"concept":"event-loop","action":"neighbors"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.True(t, strings.HasPrefix(text, "🧭 概念邻居（Concept Neighbors）— 事件循环\n\n"))
	// 入边：⇠[前置]；来源标签 + 权重；归并标注；Address 行
	assert.Contains(t, text, "- 基础概念 (principle) ⇠[前置] [prerequisite · 来源:教学顺序(确定) · w0.80] (归并: 基础) — README.md\n  [Address: README.md#basics]")
	// 出边：⇢[后继]
	assert.Contains(t, text, "- 异步模式 (workflow) ⇢[后继] [successor · 来源:共现(确定) · w0.60]\n")
	assert.True(t, strings.HasSuffix(text, "(可对任一邻居调用 explore_concept / read 深入；学习顺序见 explore_concept(action=\"path\"))\n(证据来源：共现/教学顺序/代码依赖=确定；LLM推断=可能幻觉，权重越高关系越强)"))
}

func TestConceptNeighborsEmpty(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedConceptRich(t, store)
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "concept_neighbors", `{"concept":"event-loop","action":"neighbors"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	want := "🧭 「事件循环」暂无直接邻居概念（图谱边尚未构建）。可尝试 list_documents 查看概念拓扑清单。"
	assert.Equal(t, want, text)
}

// 🧪 [7.13.3.1] 图遍历上界与逆序渲染：BFS 稳定拓扑与双封顶，环形与空边防御
func TestLearningPathChainAndTemplate(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedConceptRich(t, store)
	// 链：cc1 ← p1 ← p2（p2 最深）
	store.prereqEdgesAll = []EdgeRef{
		{SourceID: "p1", TargetID: "cc1", Type: "prerequisite", Weight: 0.9, Source: "curriculum_order"},
		{SourceID: "p2", TargetID: "p1", Type: "prerequisite", Weight: 0.7, Source: "curriculum_order"},
	}
	store.nodesByID["p1"] = ConceptNodeLite{ID: "p1", ConceptName: "回调函数", Category: "principle", DocumentPath: str("README.md")}
	store.nodesByID["p2"] = ConceptNodeLite{ID: "p2", ConceptName: "函数基础", Category: "principle", DocumentPath: str("basics.md")}
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "learning_path", `{"concept":"event-loop","action":"path"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	want := "🧭 学习路径（Learning Path） — 目标: 事件循环\n\n" +
		"1. 函数基础 (principle) — basics.md\n" +
		"2. 回调函数 (principle) — README.md\n" +
		"3. 🎯 事件循环（目标概念）\n" +
		"\n(按顺序阅读即可递进掌握；每个概念可用 read 精读，explore_concept 深钻)"
	assert.Equal(t, want, text)
}

func TestLearningPathEmpty(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedConceptRich(t, store)
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "learning_path", `{"concept":"event-loop","action":"path"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	want := "🧭 尚未发现「事件循环」的前置知识链（图谱中暂无 prerequisite / successor 边）。学习路径将随图谱边构建后可用。"
	assert.Equal(t, want, text)
}

// 🧪 [7.13.2.1] mermaid 标题转义安全：label 内引号折叠防结构注入
func TestCourseMapSuperTopicsMermaid(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	res := store.resolved["octo/kit"]
	profile := map[string]any{
		"conceptSuperTopics": map[string]any{
			"topics": []map[string]any{
				{"title": "基础", "summary": "语言基础", "memberKeys": []string{"k1", "k2"}},
				{"title": "进阶", "memberKeys": []string{"k3"}},
			},
			"generatedAt": "2026-09-01T00:00:00Z",
			"model":       "platform",
		},
	}
	profileJSON, err := json.Marshal(profile)
	require.NoError(t, err)
	res.Repository.RepoProfile = profileJSON
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "course_map", `{"action":"course_map"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.True(t, strings.HasPrefix(text, "🗺️ Course Map（知识超主题骨架，2 个主题域）\n\n```mermaid\nflowchart TD\n"))
	assert.Contains(t, text, `  T01["基础（2 概念组）"]`)
	assert.Contains(t, text, "  T01 --> T02\n")
	assert.Contains(t, text, "主题域清单（用 explore_concept(action=\"details\") 深入任一概念，或 explore_concept(action=\"neighbors\") 查邻居）：\n- 基础 — 语言基础\n- 进阶\n")
	assert.Contains(t, text, "(超主题由图谱凝聚生成于 2026-09-01；覆盖 3 个概念组)\n")
}

func TestCourseMapCodeClusters(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	res := store.resolved["octo/kit"]
	profile := map[string]any{
		"codeClusters": []map[string]any{
			{"teachingOrder": 2, "title": "进阶", "files": []string{"b.ts", "c.ts"}},
			{"teachingOrder": 1, "title": "入门", "files": []string{"a.ts"}},
		},
	}
	profileJSON, err := json.Marshal(profile)
	require.NoError(t, err)
	res.Repository.RepoProfile = profileJSON
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "explore_concept", `{"action":"course_map"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.True(t, strings.HasPrefix(text, "🗺️ Course Map — 2 章 / 3 文件（按教学顺序）\n\n```mermaid\nflowchart TD\n"))
	assert.Contains(t, text, `  Ch01["1. 入门（1 文件）"]`)
	assert.Contains(t, text, "  Ch01 --> Ch02\n")
	assert.Contains(t, text, "章节清单（可对任一章用 read / explore_concept 深入）：\n- 1. 入门 — 1 文件\n- 2. 进阶 — 2 文件\n")
}

// 🧪 [7.14.2.1] TestCourseMapCognitiveDAGAndPhases 验证带认知梯度元数据的代码仓渲染真实 DAG 与阶段分层子图
func TestCourseMapCognitiveDAGAndPhases(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	res := store.resolved["octo/kit"]
	profile := map[string]any{
		"codeClusters": []map[string]any{
			{
				"teachingOrder": 1,
				"title":         "基础核心",
				"directories":   []string{"src/core"},
				"files":         []string{"src/core/base.ts"},
				"cognitive": map[string]any{
					"phase":           "phase1_perception",
					"upstreamModules": []string{},
				},
			},
			{
				"teachingOrder": 2,
				"title":         "流水线调度",
				"directories":   []string{"src/pipeline"},
				"files":         []string{"src/pipeline/runner.ts"},
				"cognitive": map[string]any{
					"phase":           "phase3_pipeline",
					"upstreamModules": []string{"src/core"},
				},
			},
		},
	}
	profileJSON, err := json.Marshal(profile)
	require.NoError(t, err)
	res.Repository.RepoProfile = profileJSON
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "explore_concept", `{"action":"course_map"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.True(t, strings.HasPrefix(text, "🗺️ Course Map — 2 章 / 2 文件（按教学顺序）\n\n```mermaid\nflowchart TD\n"))
	assert.Contains(t, text, `subgraph Phase_Foundation["🌱 基础层 (Foundation)"]`)
	assert.Contains(t, text, `Ch01["1. 基础核心（1 文件）"]`)
	assert.Contains(t, text, `subgraph Phase_Interface["🔌 接口层 (Interface & Delivery)"]`)
	assert.Contains(t, text, `Ch02["2. 流水线调度（1 文件）"]`)
	assert.Contains(t, text, "  Ch01 --> Ch02\n")
}


func TestCourseMapNavTreeFallbackAndEmpty(t *testing.T) {
	tests := []struct {
		name        string
		setupStore  func(store *readFakeStore)
		checkOutput func(t *testing.T, text string)
	}{
		{
			name: "nav tree fallback with shortTitle priority",
			setupStore: func(store *readFakeStore) {
				seedAuth(t, store)
				res := store.resolved["octo/kit"]
				res.Repository.NavTree = json.RawMessage(`[{"type":"file","title":"Guide","shortTitle":"G","path":"docs/guide.md"}]`)
			},
			checkOutput: func(t *testing.T, text string) {
				assert.True(t, strings.HasPrefix(text, "🗺️ Course Map（文档大纲兜底，1 篇）\n\n1. G [Path: docs/guide.md]\n"))
			},
		},
		{
			name: "empty codeClusters and empty navTree returns message",
			setupStore: func(store *readFakeStore) {
				seedAuth(t, store)
			},
			checkOutput: func(t *testing.T, text string) {
				want := "🗺️ Course Map：该仓库无 codeClusters（非代码教学仓），且 navTree 为空，无法生成课程图。可用 read_document（无参数）查看文档清单。"
				assert.Equal(t, want, text)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newReadFakeStore()
			tt.setupStore(store)
			ts := readTestServer(t, store, nil)
			resp, body := callRead(t, ts, "/api/mcp/octo/kit", "explore_concept", `{"action":"course_map"}`)
			defer resp.Body.Close()
			text, _ := parseResultText(t, body)
			tt.checkOutput(t, text)
		})
	}
}

func TestConceptDetailsCodeChapterContext(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	store.conceptRich = []ConceptRichNode{
		{ID: "cc1", ConceptName: "调度器", Category: "architecture", DocumentPath: str("chapters/02.md")},
	}
	res := store.resolved["octo/kit"]
	profile := map[string]any{
		"codeClusters": []map[string]any{
			{"teachingOrder": 2, "title": "调度模块", "directories": []string{"src/sched"}, "files": []string{"a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts"}},
		},
	}
	profileJSON, err := json.Marshal(profile)
	require.NoError(t, err)
	res.Repository.RepoProfile = profileJSON
	ts := readTestServer(t, store, nil)

	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "explore_concept", `{"concept":"调度器"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	assert.Contains(t, text, "- 所属模块: 调度模块 (src/sched)\n")
	assert.Contains(t, text, "- 关联源码 (Code Files, 9): a.ts, b.ts, c.ts, d.ts, e.ts, f.ts, g.ts, h.ts …\n")
}

func TestConceptDetailsRSGGroundingNoPRScore(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedConceptRich(t, store)
	dir := t.TempDir()
	t.Setenv("STORAGE_ROOT", filepath.ToSlash(dir))
	sha := strings.Repeat("b", 40)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "octo", "kit"), 0o755))

	artifact := map[string]any{
		"nodes": []map[string]any{
			{"path": "src/loop.ts", "role": "core_contract", "pageRank": 0.8, "isBackbone": true},
		},
		"goldenSymbols": []map[string]any{
			{"name": "runLoop", "kind": "function", "file": "src/loop.ts", "score": 0.9},
		},
	}
	data, err := json.Marshal(artifact)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "octo", "kit", sha+".json"), data, 0o644))
	store.repoGitSha.owner, store.repoGitSha.repo, store.repoGitSha.sha, store.repoGitSha.ok = "octo", "kit", sha, true

	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "explore_concept", `{"concept":"event-loop"}`)
	defer resp.Body.Close()
	text, _ := parseResultText(t, body)
	// details 变体：无 [PR:] 分数
	assert.Contains(t, text, "- 核心代码符号 (AST Golden Symbols):\n  - `runLoop` (function) in `src/loop.ts`\n")
	assert.NotContains(t, text, "[PR:")
	assert.Contains(t, text, "- 主干实现文件 (Backbone Files):\n  - `src/loop.ts` (core_contract)\n")
}

// 🧪 [7.13.4.1] 门面语义：分派层仅名改写；单测固化 skill_coverage 无 action → details 的 not-found 语义
func TestConceptAliasSkillCoverageWithoutActionFallsToDetails(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	ts := readTestServer(t, store, nil)
	resp, body := callRead(t, ts, "/api/mcp/octo/kit", "skill_coverage", `{"concept":"nonexistent"}`)
	defer resp.Body.Close()
	text, isError := parseResultText(t, body)
	assert.True(t, isError)
	assert.Contains(t, text, "not found in octo/kit")
}

// 🧪 [7.13.5.1] 遥测边界：静态提示路径 0 条 McpCallLog（对齐 Node 分支表）
func TestRecommendStaticMessageAndGuard(t *testing.T) {
	tests := []struct {
		name        string
		toolName    string
		arguments   string
		wantIsError bool
		wantText    string
	}{
		{
			name:        "missing concept description returns error",
			toolName:    "recommend_tutorial",
			arguments:   `{"action":"recommend"}`,
			wantIsError: true,
			wantText:    `Error: pass a short project description as "concept" for recommendation (e.g. "Next.js 15 + Drizzle + auth 全栈项目").`,
		},
		{
			name:        "concept provided returns static hub recommendation hint",
			toolName:    "explore_concept",
			arguments:   `{"concept":"Next.js 全栈","action":"recommend"}`,
			wantIsError: false,
			wantText:    `Tutorial recommendation is available on Hub mode (omit "repository" to rank your whole bookshelf).`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newReadFakeStore()
			seedAuth(t, store)
			ts := readTestServer(t, store, nil)
			resp, body := callRead(t, ts, "/api/mcp/octo/kit", tt.toolName, tt.arguments)
			defer resp.Body.Close()
			text, isError := parseResultText(t, body)
			assert.Equal(t, tt.wantIsError, isError)
			assert.Equal(t, tt.wantText, text)
			assert.Empty(t, store.callLogs, "static hint/guard must write 0 McpCallLog")
		})
	}
}

func TestExploreConceptDisabledPolicyFallsBackToProxy(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)
	seedConceptRich(t, store)
	store.policies["explore_concept"] = ToolPolicy{IsEnabled: false, TokenBudget: 4000, TierRequirement: "FREE"}
	upstreamHit := false
	ts := readTestServer(t, store, &upstreamHit)
	resp, _ := callRead(t, ts, "/api/mcp/octo/kit", "explore_concept", `{"concept":"event-loop"}`)
	defer resp.Body.Close()
	assert.True(t, upstreamHit, "disabled explore_concept policy must fall back to proxy")
}

func TestNormalizeHeadingKey(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "strip leading digits and underscore", in: "01_架构", want: "架构"},
		{name: "hyphen replaced with space and lowercased", in: "Event-Loop", want: "event loop"},
		{name: "markdown bold and numbered prefix stripped", in: "**1.2.3 标题**", want: "标题"},
		{name: "multiple whitespace collapsed and trimmed", in: "  多  空白 ", want: "多 空白"},
		{name: "product-style 3D title keeps its digit", in: "3D 打印入门", want: "3d 打印入门"},
		{name: "year-prefixed title keeps its digits", in: "2024 年度总结", want: "2024 年度总结"},
		{name: "separated numeric prefix still stripped", in: "1.2 快速开始", want: "快速开始"},
		{name: "fullwidth paren prefix stripped", in: "（3）列表推导", want: "列表推导"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeHeadingKey(tt.in)
			assert.Equal(t, tt.want, got)
		})
	}
}

// 🧪 [7.13.1.1] 两阶段概念解析防误中：exact-insensitive OR 优先，前缀兜底；宽泛 contains 不匹配，归一化键空值不入 OR
func TestResolveConceptNodeTwoStage(t *testing.T) {
	store := newReadFakeStore()
	seedAuth(t, store)

	// 注入两组概念：
	// cc-prefix: "Event Loop Advanced" (排在前面，若无阶段优先则会被贪婪命中)
	// cc-exact: "Event Loop" (slug: "event-loop")
	store.conceptRich = []ConceptRichNode{
		{
			ID: "cc-prefix", ConceptName: "Event Loop Advanced", Category: "architecture", Slug: "event-loop-advanced",
			CanonicalKey: str("event-loop-advanced"), CanonicalName: str("Event Loop Advanced"),
		},
		{
			ID: "cc-exact", ConceptName: "Event Loop", Category: "architecture", Slug: "event-loop",
			CanonicalKey: str("event-loop"), CanonicalName: str("Event Loop"),
		},
	}

	tests := []struct {
		name         string
		query        string
		wantID       string
		wantNotFound bool
	}{
		{
			name:   "exact match takes precedence over prefix candidate",
			query:  "event-loop",
			wantID: "cc-exact",
		},
		{
			name:   "exact insensitive name match takes precedence",
			query:  "Event Loop",
			wantID: "cc-exact",
		},
		{
			name:   "prefix match fallback succeeds when no exact match exists",
			query:  "Event Loop Adv",
			wantID: "cc-prefix",
		},
		{
			name:         "broad contains query does not match (fails closed against fuzzy contains)",
			query:        "Loop",
			wantNotFound: true,
		},
		{
			name:         "empty or whitespace query fails closed",
			query:        "   ",
			wantNotFound: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			node, err := store.ResolveConceptNode(t.Context(), "repo-1", tt.query)
			require.NoError(t, err)
			if tt.wantNotFound {
				assert.Nil(t, node)
			} else {
				require.NotNil(t, node)
				assert.Equal(t, tt.wantID, node.ID)
			}
		})
	}
}

package market

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/treesitter"
)

func TestEvaluatePhysicalPipelineScore(t *testing.T) {
	richChineseProse := strings.Repeat("深入解析分布式系统架构设计动机、状态机流转、核心模块契约与工程权衡，帮助开发者构建完整认知。", 3)
	codeOnlyAnchoredDoc := PipelineScoreDoc{
		Path:   "chapters/01.mdx",
		Status: "PROCESSED",
		Content: "# 第 1 章：语料编码与词表\n\n" +
			"```mermaid\nflowchart TD\n  Raw[\"Raw Text\"] --> Tok[\"Token IDs\"]\n```\n\n" +
			"## 设计动机\n\n" + richChineseProse + "\n\n" +
			"```python // data/shakespeare_char/prepare.py#chars\nchars = sorted(list(set(data)))\nvocab_size = len(chars)\n```\n\n" +
			"```bash\npython data/shakespeare_char/prepare.py\n```\n",
	}
	webDocZh := PipelineScoreDoc{
		Path:    "chapters/01.mdx",
		Status:  "PROCESSED",
		Content: "# 第 1 章：可靠、可扩展与可维护的应用\n\n## 可靠性核心概念\n\n" + richChineseProse + "\n\n## 可扩展性权衡\n\n" + richChineseProse + "\n",
	}

	dimMap := func(dims []PipelineDimensionItem) map[string]int {
		t.Helper()
		m := make(map[string]int, len(dims))
		for _, d := range dims {
			m[d.Key] = d.Score
		}
		return m
	}

	tests := []struct {
		name         string
		chapterCount int
		meta         RepoAuditMeta
		docs         []PipelineScoreDoc
		minTotal     int
		maxTotal     int
		checkDims    func(t *testing.T, dims map[string]int)
	}{
		{
			name:         "空仓库归零",
			chapterCount: 0,
			meta:         RepoAuditMeta{},
			docs:         nil,
			minTotal:     0,
			maxTotal:     0,
		},
		{
			name:         "symbol-slice 代码仓即使无 import/try-catch 且仅 5 章也应高分",
			chapterCount: 5,
			meta:         RepoAuditMeta{IngestMode: "code_only", TargetLanguage: "zh-CN"},
			docs:         []PipelineScoreDoc{codeOnlyAnchoredDoc, codeOnlyAnchoredDoc, codeOnlyAnchoredDoc, codeOnlyAnchoredDoc, codeOnlyAnchoredDoc},
			minTotal:     95,
			maxTotal:     100,
			checkDims: func(t *testing.T, dims map[string]int) {
				assert.Equal(t, 100, dims["completeness"])
				assert.Equal(t, 100, dims["syntaxHealth"])
				assert.Equal(t, 100, dims["grounding"])
				assert.Equal(t, 100, dims["structure"])
			},
		},
		{
			name:         "web_doc 纯文字中文书无代码块仍高分",
			chapterCount: 4,
			meta:         RepoAuditMeta{Owner: "web-doc", SourceType: "web", IngestMode: "text_only", TargetLanguage: "zh-CN"},
			docs:         []PipelineScoreDoc{webDocZh, webDocZh, webDocZh, webDocZh},
			minTotal:     95,
			maxTotal:     100,
			checkDims: func(t *testing.T, dims map[string]int) {
				assert.Equal(t, 100, dims["grounding"])
				assert.Equal(t, 100, dims["completeness"])
			},
		},
		{
			name:         "未闭合围栏与残余占位槽拉低 syntaxHealth",
			chapterCount: 1,
			meta:         RepoAuditMeta{IngestMode: "code_only"},
			docs: []PipelineScoreDoc{
				{
					Path:   "chapters/01.mdx",
					Status: "PROCESSED",
					Content: "# Broken\n\n## 核心机制\n\n" + richChineseProse + "\n\n" +
						"```go\n<!-- CODE_SLOT:file=1 symbol=\"Run\" -->\n```\n\n" +
						"```mermaid\n\n```\n\n" +
						"===CONTENT_BEGIN===\n\n" +
						"```ts // src/a.ts#fn\nunclosed fence",
				},
			},
			minTotal: 0,
			maxTotal: 59,
			checkDims: func(t *testing.T, dims map[string]int) {
				assert.LessOrEqual(t, dims["syntaxHealth"], 30)
			},
		},
		{
			name:         "code_only 无锚点纯编造代码块大幅拉低 grounding",
			chapterCount: 2,
			meta:         RepoAuditMeta{IngestMode: "code_only"},
			docs: []PipelineScoreDoc{
				{
					Path:    "chapters/01.mdx",
					Status:  "PROCESSED",
					Content: "# Ch1\n\n## Core\n\n" + richChineseProse + "\n\n```python\ndef fake_example():\n    pass\n```\n",
				},
			},
			minTotal: 50,
			maxTotal: 85,
			checkDims: func(t *testing.T, dims map[string]int) {
				assert.Equal(t, 40, dims["grounding"])
			},
		},
		{
			name:         "越界章节引用扣减 structure 分数",
			chapterCount: 2,
			meta:         RepoAuditMeta{IngestMode: "text_only", TargetLanguage: "zh-CN"},
			docs: []PipelineScoreDoc{
				{
					Path:    "chapters/01.mdx",
					Status:  "PROCESSED",
					Content: "# 第 1 章\n\n## 引言\n\n" + richChineseProse + "\n\n更多细节请见第 99 章和第 100 章与第 88 章。\n",
				},
			},
			minTotal: 75,
			maxTotal: 96,
			checkDims: func(t *testing.T, dims map[string]int) {
				assert.Equal(t, 85, dims["structure"])
			},
		},
		{
			name:         "要求中文但整章未翻译仍为英文 → grounding 扣分",
			chapterCount: 1,
			meta:         RepoAuditMeta{Owner: "web-doc", SourceType: "web", IngestMode: "text_only", TargetLanguage: "zh-CN"},
			docs: []PipelineScoreDoc{
				{
					Path:    "chapters/01.mdx",
					Status:  "PROCESSED",
					Content: "# Chapter 1\n\n## Overview\n\n" + strings.Repeat("This chapter discusses distributed consensus protocols and fault tolerance without translation into Chinese. ", 3),
				},
			},
			minTotal: 50,
			maxTotal: 80,
			checkDims: func(t *testing.T, dims map[string]int) {
				assert.Equal(t, 0, dims["grounding"])
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			total, dims, _ := EvaluatePhysicalPipelineScore(tc.chapterCount, tc.meta, tc.docs)
			assert.GreaterOrEqual(t, total, tc.minTotal)
			assert.LessOrEqual(t, total, tc.maxTotal)
			if tc.checkDims != nil {
				tc.checkDims(t, dimMap(dims))
			}
		})
	}
}

func TestAssessCodeBlockAstQuality(t *testing.T) {
	ctx := context.Background()
	engine, err := treesitter.NewEngine(ctx)
	require.NoError(t, err)
	defer engine.Close()

	mdx := `# Guide
Here is some TypeScript code:
` + "```ts" + `
import { service } from './service';
export async function runTask(): Promise<void> {
    try {
        await service.execute();
    } catch (err) {
        console.error(err);
    }
}
` + "```" + `

And some Python:
` + "```python" + `
from math import sqrt
def compute():
    try:
        return sqrt(16)
    except Exception as e:
        pass
` + "```" + `

And some comment that would fool regex:
Notice: try { not in code } catch (e)
`

	report := AssessCodeBlockAstQuality(ctx, engine, mdx)
	assert.Equal(t, 2, report.TotalBlocks)
	assert.Equal(t, 2, report.ValidAstBlocks)
	assert.Equal(t, 0, report.AstErrors)
	assert.Equal(t, 2, report.ProductionNodes)
	assert.Equal(t, 2, report.ModernNodes)
}

type fakeMarketSettleStore struct {
	mu            sync.Mutex
	trials        []TrialRow
	casLosers     map[string]bool
	swapped       []string
	rejected      []string
	events        []string
	postSwapErr   error
	swapCounts    map[string]int
	qualityHold   []string
	chunked       []string
	metadata      []string
	scoreInputs   map[string]int
	stagedContent string
	stagedLoadErr error
}

func newFakeMarketSettleStore(t *testing.T) *fakeMarketSettleStore {
	t.Helper()
	return &fakeMarketSettleStore{
		casLosers:     map[string]bool{},
		swapCounts:    map[string]int{},
		scoreInputs:   map[string]int{},
		stagedContent: "# 暂存正文",
	}
}

func (f *fakeMarketSettleStore) ListExpiredMarketTrials(_ context.Context, _ time.Time, excludeIDs []string, take int) ([]TrialRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	excl := map[string]bool{}
	for _, id := range excludeIDs {
		excl[id] = true
	}
	var out []TrialRow
	for _, tr := range f.trials {
		if excl[tr.ID] {
			continue
		}
		out = append(out, tr)
		if len(out) >= take {
			break
		}
	}
	return out, nil
}

func (f *fakeMarketSettleStore) LoadStagedContent(_ context.Context, _ string) (string, error) {
	if f.stagedLoadErr != nil {
		return "", f.stagedLoadErr
	}
	return f.stagedContent, nil
}

func (f *fakeMarketSettleStore) SettleSwapTx(_ context.Context, job TrialRow, _ string, _ bool) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.casLosers[job.ID] {
		return false, nil
	}
	for _, id := range f.swapped {
		if id == job.ID {
			return false, nil
		}
	}
	f.swapped = append(f.swapped, job.ID)
	return true, nil
}

func (f *fakeMarketSettleStore) ReleaseExpiredClaims(_ context.Context) (int64, error) {
	return 0, nil
}

func (f *fakeMarketSettleStore) FailTrialsWithoutStaging(_ context.Context) (int64, error) {
	return 0, nil
}

func (f *fakeMarketSettleStore) RecordMarketSettledEvent(_ context.Context, _ *string, jobID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, jobID)
}

func (f *fakeMarketSettleStore) IncrementAutoSwapCount(_ context.Context, repoID string) (int, error) {
	f.swapCounts[repoID]++
	return f.swapCounts[repoID], nil
}

func (f *fakeMarketSettleStore) SetQualityHold(_ context.Context, repoID string) error {
	f.qualityHold = append(f.qualityHold, repoID)
	return nil
}

func (f *fakeMarketSettleStore) PostSwapDocument(_ context.Context, _, docID, _ string) error {
	f.chunked = append(f.chunked, docID)
	f.metadata = append(f.metadata, docID)
	return f.postSwapErr
}

func (f *fakeMarketSettleStore) LoadPipelineScoreInputs(_ context.Context, repoID string) (int, RepoAuditMeta, []PipelineScoreDoc, error) {
	if f.scoreInputs[repoID] < 70 {
		return 0, RepoAuditMeta{}, nil, nil
	}
	prose := "## 核心机制\n\n深入解析系统入口请求处理、通道隔离、状态转换与持久层一致性约束，并结合源码切片说明设计动机与工程权衡取舍，确保全章图文与代码证据完整闭环。\n\n"
	codey := func(body string) PipelineScoreDoc {
		return PipelineScoreDoc{
			Status:  "PROCESSED",
			Content: "# 章节\n\n" + prose + "```ts // src/service.ts#run\n" + body + "\n```\n",
		}
	}
	return 8, RepoAuditMeta{IngestMode: "code_only"}, []PipelineScoreDoc{
		codey("import x from 'y';\ntry { await x(); } catch (e) {}"),
		codey("export const run = async () => { await retry(); };"),
	}, nil
}

func (f *fakeMarketSettleStore) ListActiveJobs(_ context.Context, _ string) ([]ActiveJobView, error) {
	return nil, nil
}
func (f *fakeMarketSettleStore) ClaimJob(_ context.Context, _, _ string, _ int) (*ClaimResult, error) {
	return &ClaimResult{FrozenCredits: 0}, nil
}
func (f *fakeMarketSettleStore) ReleaseClaim(_ context.Context, _, _ string) error {
	return nil
}
func (f *fakeMarketSettleStore) ExtendClaim(_ context.Context, _, _ string, _ int) (bool, error) {
	return true, nil
}
func (f *fakeMarketSettleStore) SettleRelayTx(_ context.Context, _ RelaySettleInput) error {
	return nil
}
func (f *fakeMarketSettleStore) MarkJobFailed(_ context.Context, _, _, _ string) error {
	return nil
}
func (f *fakeMarketSettleStore) EnsureRelayJob(_ context.Context, _ string) (*RelayJobView, error) {
	return &RelayJobView{ID: "job-relay-1", RepositoryID: "repo-1", Kind: "RELAY", Status: "PENDING"}, nil
}
func (f *fakeMarketSettleStore) CreateRetranslateJob(_ context.Context, _ RetranslateJobInput) error {
	return nil
}
func (f *fakeMarketSettleStore) CreateStaleJobs(_ context.Context, _ CreateStaleJobsInput) (int, error) {
	return 0, nil
}
func (f *fakeMarketSettleStore) GetJobAuthInfo(_ context.Context, id string) (*JobAuthInfo, error) {
	return &JobAuthInfo{ID: id, RepositoryID: "repo-1", Kind: "UPDATE", Status: "PENDING", IsPublic: true}, nil
}

func TestSettleExpiredMarketTrials(t *testing.T) {
	tests := []struct {
		name                             string
		count                            int
		loseLast, lowScore, rebuildFails bool
		wantSwapped, wantRejected        int
	}{
		{name: "default swap with CAS loser on last", count: 3, loseLast: true, wantSwapped: 2},
		{name: "low re-audit score holds quality", count: 1, lowScore: true, wantSwapped: 1},
		{name: "multiple batches drain without duplicates", count: BatchSize + 3, wantSwapped: BatchSize + 3},
		{name: "post-swap failure does not block promotion", count: 1, rebuildFails: true, wantSwapped: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("UPDATE_AUDIT_EVERY_N_SWAPS", "10")
			t.Setenv("UPDATE_QUALITY_FLOOR", "70")
			store := newFakeMarketSettleStore(t)
			for i := 0; i < tt.count; i++ {
				id := fmt.Sprintf("job-%d", i)
				store.trials = append(store.trials, TrialRow{ID: id, RepositoryID: "repo-1", DocumentID: "doc-" + id, StagedContentID: "content-" + id})
			}
			if tt.loseLast {
				store.casLosers[store.trials[tt.count-1].ID] = true
			}
			store.swapCounts["repo-1"] = 9
			if !tt.lowScore {
				store.scoreInputs["repo-1"] = 95
			}
			if tt.rebuildFails {
				store.postSwapErr = errors.New("rebuild unavailable")
			}
			var refreshed []string
			swapped, rejected := SettleExpiredMarketTrials(t.Context(), Config{}, store, func(id string) { refreshed = append(refreshed, id) })
			assert.Equal(t, tt.wantSwapped, swapped)
			assert.Equal(t, tt.wantRejected, rejected)
			assert.Len(t, store.swapped, swapped)
			assert.Len(t, store.rejected, rejected)
			assert.Len(t, store.chunked, swapped)
			assert.Len(t, store.metadata, swapped)
			assert.Len(t, refreshed, swapped)
			assert.Len(t, store.events, tt.count-rejected)
			assert.Equal(t, 9+swapped, store.swapCounts["repo-1"])
			if tt.lowScore {
				assert.Equal(t, []string{"repo-1"}, store.qualityHold)
			} else {
				assert.Empty(t, store.qualityHold)
			}
		})
	}
}

func TestHistoricalBaseDoesNotEnterSettlement(t *testing.T) {
	tests := []struct {
		name      string
		base      int
		actual    *int
		immediate bool
	}{
		{name: "zero base immediate", immediate: true},
		{name: "historical odd positive base immediate", base: 7, immediate: true},
		{name: "historical positive base timeout", base: 20},
		{name: "existing historical reward immediate", base: 20, actual: new(10), immediate: true},
		{name: "existing historical reward timeout", base: 20, actual: new(10)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("UPDATE_SUCCESS_BONUS_RATE", "100")
			raw, err := json.Marshal(struct {
				TrialRow
				BaseCredits                int
				ActualCredits              *int
				TranscriptionCreditsEarned int
			}{TrialRow: TrialRow{ID: "legacy", RepositoryID: "repo", DocumentID: "doc", StagedContentID: "staged"}, BaseCredits: tt.base, ActualCredits: tt.actual, TranscriptionCreditsEarned: 123})
			require.NoError(t, err)
			var job TrialRow
			require.NoError(t, json.Unmarshal(raw, &job))
			projected, err := json.Marshal(job)
			require.NoError(t, err)
			assert.NotContains(t, string(projected), "Credits")
			store := newFakeMarketSettleStore(t)
			store.trials = []TrialRow{job}
			if tt.immediate {
				ok := swapInJob(t.Context(), Config{}, store, job, nil)
				require.True(t, ok)
			} else {
				swapped, rejected := SettleExpiredMarketTrials(t.Context(), Config{}, store, nil)
				assert.Equal(t, 1, swapped)
				assert.Zero(t, rejected)
			}
			assert.Equal(t, []string{job.ID}, store.swapped)
			assert.Equal(t, []string{job.DocumentID}, store.chunked)
		})
	}
}

func TestRetiredRewardPathsAbsent(t *testing.T) {
	tests := []struct{ name string }{{name: "settle.go"}, {name: "pgx_store.go"}, {name: "pgx_store_jobs.go"}}
	retired := []string{"BaseCredits", "baseCredits", "transcriptionCreditsEarned", "creditBalance", "BonusRate", "SuccessBonusRate", "IncrementTranscriptionLedger", "bonus", "UPDATE_SUCCESS_BONUS_RATE"}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			file, err := parser.ParseFile(token.NewFileSet(), tt.name, nil, 0)
			require.NoError(t, err)
			ast.Inspect(file, func(node ast.Node) bool {
				var text string
				switch n := node.(type) {
				case *ast.Ident:
					text = n.Name
				case *ast.BasicLit:
					if n.Kind == token.STRING {
						text, err = strconv.Unquote(n.Value)
						require.NoError(t, err)
					}
				}
				for _, symbol := range retired {
					assert.NotContains(t, text, symbol)
				}
				return true
			})
		})
	}
}

func TestSwapInBlocksOnUnreadableStagedContent(t *testing.T) {
	tests := []struct {
		name        string
		stagedErr   error
		stagedValue string
		wantSwapped bool
	}{
		{name: "读取正常且有正文 → 换入", stagedValue: "# 暂存正文", wantSwapped: true},
		{name: "读取失败（悬垂指针）→ 阻断", stagedErr: errors.New("no rows in result set"), wantSwapped: false},
		{name: "读取成功但正文为空 → 阻断", stagedValue: "", wantSwapped: false},
		{name: "读取成功但正文纯空白 → 阻断", stagedValue: "   \n\t ", wantSwapped: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeMarketSettleStore(t)
			store.stagedLoadErr = tt.stagedErr
			store.stagedContent = tt.stagedValue
			job := TrialRow{ID: "job-1", RepositoryID: "repo", DocumentID: "doc-1", StagedContentID: "staged-1"}
			store.trials = []TrialRow{job}

			ok := swapInJob(t.Context(), Config{}, store, job, nil)
			assert.Equal(t, tt.wantSwapped, ok)
			if tt.wantSwapped {
				assert.Equal(t, []string{job.ID}, store.swapped)
			} else {
				assert.Empty(t, store.swapped, "阻断路径不得触发换入事务")
				assert.Empty(t, store.chunked, "阻断路径不得触发 postSwap 重建")
			}
		})
	}
}

func TestParseRepoAuditMeta(t *testing.T) {
	tests := []struct {
		name     string
		owner    string
		profile  string
		expected RepoAuditMeta
	}{
		{
			name:     "完整配置抽取",
			owner:    "karpathy",
			profile:  `{"ingestMode":"code_only","sourceType":"github","transcriptionPreset":"deep","targetLanguage":"zh-CN"}`,
			expected: RepoAuditMeta{Owner: "karpathy", IngestMode: "code_only", SourceType: "github", Preset: "deep", TargetLanguage: "zh-CN"},
		},
		{
			name:     "editionPreset 兜底回退与非法 JSON 容错",
			owner:    "web-doc",
			profile:  `{"sourceType":"web","editionPreset":"cheatsheet"}`,
			expected: RepoAuditMeta{Owner: "web-doc", SourceType: "web", Preset: "cheatsheet"},
		},
		{
			name:     "坏 JSON 仅保留 owner",
			owner:    "web-doc",
			profile:  `{broken`,
			expected: RepoAuditMeta{Owner: "web-doc"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.expected, ParseRepoAuditMeta(tc.owner, tc.profile))
		})
	}
}

func TestAssessCodeBlockAstQualityBareFence(t *testing.T) {
	eng := getAstScoreEngine()
	if eng == nil {
		t.Skip("engine unavailable")
	}
	md := "# 标题\n\n```\nplain code block without language\nimport x from 'y'\n```\n\n正文。\n"
	res := AssessCodeBlockAstQuality(context.Background(), eng, md)
	assert.Equal(t, 1, res.TotalBlocks, "裸围栏必须被计入块数")
}

func TestAssessCodeBlockAstQualityMultiLanguage(t *testing.T) {
	eng := getAstScoreEngine()
	if eng == nil {
		t.Skip("engine unavailable")
	}

	tests := []struct {
		name           string
		fenceLang      string
		code           string
		wantProduction bool
		wantModern     bool
	}{
		{
			name:           "Go 惯用错误检查 (if err != nil)",
			fenceLang:      "go",
			code:           "func Handle() error {\n\tif err != nil {\n\t\treturn err\n\t}\n\treturn nil\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Go 并发现代特性 (go + channel)",
			fenceLang:      "golang",
			code:           "func Start(ch chan int) {\n\tgo func() {\n\t\tch <- 1\n\t}()\n}",
			wantProduction: false,
			wantModern:     true,
		},
		{
			name:           "Rust 错误传递 (? try_expression)",
			fenceLang:      "rust",
			code:           "fn fetch() -> Result<Data, Err> {\n\tlet res = call()?;\n\tOk(res)\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Rust Err 分支模式匹配",
			fenceLang:      "rs",
			code:           "fn parse(res: Result<T, E>) {\n\tmatch res {\n\t\tOk(v) => v,\n\t\tErr(e) => panic!(\"error\"),\n\t}\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Python 主动抛出异常 (raise)",
			fenceLang:      "python",
			code:           "def validate(cfg):\n\tif not cfg:\n\t\traise ValueError(\"missing config\")",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Python 前置输入防御 (assert)",
			fenceLang:      "py",
			code:           "def calc(x):\n\tassert len(x) > 0\n\treturn x[0]",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "TypeScript 主动抛出错误 (throw new Error)",
			fenceLang:      "ts",
			code:           "export function verify(token: string) {\n\tif (!token) throw new Error(\"unauthorized\");\n}",
			wantProduction: true,
			wantModern:     true,
		},
		{
			name:           "Swift 防御性守卫 (guard let ... else)",
			fenceLang:      "swift",
			code:           "func process(url: URL?) {\n\tguard let u = url else { return }\n\tload(u)\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Zig 错误捕获表达式 (try + catch)",
			fenceLang:      "zig",
			code:           "fn read() !void {\n\ttry step();\n\tres catch |err| return err;\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Solidity 契约防御 (require + revert)",
			fenceLang:      "solidity",
			code:           "contract SafeToken {\n\tfunction mint(uint256 amt) public {\n\t\trequire(amt > 0, \"zero\");\n\t\trevert(\"denied\");\n\t}\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Ruby 异常拯救 (rescue)",
			fenceLang:      "ruby",
			code:           "def run\n\tfetch_remote\nrescue StandardError => e\n\tlogger.error(e)\nend",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "C++ 空指针防御与断言 (nullptr + assert)",
			fenceLang:      "cpp",
			code:           "#include <cassert>\nvoid process(int* ptr) {\n\tassert(ptr != nullptr);\n\tif (ptr == nullptr) return;\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Java 资源防御与主动抛出 (try-with-resources + throw)",
			fenceLang:      "java",
			code:           "public void readFile() throws Exception {\n\ttry (var in = new FileInputStream(\"f\")) {\n\t\tthrow new IOException();\n\t}\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "C# 资源作用域防御 (using declaration + throw)",
			fenceLang:      "csharp",
			code:           "public void Open(string path) {\n\tif (path == null) throw new ArgumentNullException();\n\tusing var stream = File.OpenRead(path);\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Kotlin 前置约束与非空校验 (require + checkNotNull)",
			fenceLang:      "kotlin",
			code:           "fun handle(id: String?) {\n\tval validId = checkNotNull(id)\n\trequire(validId.isNotEmpty()) { \"id is empty\" }\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Dart 针对性异常捕获 (on Exception catch + rethrow)",
			fenceLang:      "dart",
			code:           "void exec() {\n\ttry {\n\t\trun();\n\t} on FormatException catch (e) {\n\t\trethrow;\n\t}\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Bash 信号捕获与严谨退出 (trap + set -e + exit 1)",
			fenceLang:      "bash",
			code:           "set -euo pipefail\ntrap 'echo error' ERR\nif [ ! -f config.env ]; then\n  exit 1\nfi",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Elixir 容错链路匹配 (with {:ok, ...} else)",
			fenceLang:      "elixir",
			code:           "def run(id) do\n\twith {:ok, user} <- get_user(id),\n\t\t {:ok, token} <- auth(user) do\n\t\t{:ok, token}\n\telse\n\t\t{:error, reason} -> {:error, reason}\n\tend\nend",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "PHP 严谨异常体系 (try / catch Throwable)",
			fenceLang:      "php",
			code:           "<?php\ntry {\n\tthrow new RuntimeException(\"error\");\n} catch (Throwable $e) {\n\tlogError($e);\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Lua 安全调用保护 (pcall + error)",
			fenceLang:      "lua",
			code:           "local ok, res = pcall(fetch_data)\nif not ok then\n\terror(\"failed: \" .. tostring(res))\nend",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Go 资源安全释放 (defer Close)",
			fenceLang:      "go",
			code:           "func Query() error {\n\tresp, err := http.Get(\"url\")\n\tif err != nil { return err }\n\tdefer resp.Body.Close()\n\treturn nil\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Python 资源上下文管理器 (with open)",
			fenceLang:      "python",
			code:           "def read_file(name):\n\twith open(name, 'r') as f:\n\t\treturn f.read()",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Scala 异常与防御抛出 (try / catch / throw)",
			fenceLang:      "scala",
			code:           "def parse(s: String): Int = {\n\ttry {\n\t\ts.toInt\n\t} catch {\n\t\tcase e: NumberFormatException => throw new IllegalArgumentException(e)\n\t}\n}",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Clojure 异常捕获 (try / catch / throw)",
			fenceLang:      "clojure",
			code:           "(defn divide [a b]\n  (try\n    (/ a b)\n    (catch ArithmeticException e\n      (throw (Exception. \"divide by zero\")))))",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Julia 断言与异常处理 (throw / @assert)",
			fenceLang:      "julia",
			code:           "function process(x)\n\ttry\n\t\tif x < 0\n\t\t\tthrow(DomainError(x, \"negative\"))\n\t\tend\n\tcatch e\n\t\trethrow(e)\n\tend\nend",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "OCaml 异常与主动防御 (try ... with / raise)",
			fenceLang:      "ocaml",
			code:           "let safe_div a b =\n  try a / b with\n  | Division_by_zero -> raise (Failure \"div zero\")",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "Perl 错误捕获与终止 (eval / die)",
			fenceLang:      "perl",
			code:           "eval {\n\topen(my $fh, '<', 'missing.txt') or die(\"cannot open: $!\");\n};",
			wantProduction: true,
			wantModern:     false,
		},
		{
			name:           "R 语言防御性错误终止 (stop)",
			fenceLang:      "r",
			code:           "calc <- function(val) {\n  if (val <= 0) {\n    stop(\"value must be positive\")\n  }\n  return(sqrt(val))\n}",
			wantProduction: true,
			wantModern:     false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			md := "# 章节\n\n```" + tc.fenceLang + "\n" + tc.code + "\n```\n"
			report := AssessCodeBlockAstQuality(context.Background(), eng, md)
			assert.Equal(t, 1, report.TotalBlocks, "应识别 1 个代码块")
			assert.Equal(t, 1, report.ValidAstBlocks, "应成功被 Tree-sitter 编译为 AST")
			if tc.wantProduction {
				if report.ProductionNodes == 0 {
					astStr, _ := eng.DebugAST(normalizeCodeBlockLang(tc.fenceLang), []byte(tc.code))
					t.Logf("[DEBUG AST] %s:\n%s", tc.name, astStr)
				}
				assert.Greater(t, report.ProductionNodes, 0, "应检测到工程健壮性 AST 节点")
			} else {
				assert.Equal(t, 0, report.ProductionNodes, "不应误检工程健壮性节点")
			}
			if tc.wantModern {
				assert.Greater(t, report.ModernNodes, 0, "应检测到现代语法 AST 节点")
			}
		})
	}
}

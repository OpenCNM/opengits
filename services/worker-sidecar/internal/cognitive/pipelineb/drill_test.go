package pipelineb

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakePlanner struct {
	first, second string
	feedbackPlan  string
	calls         int
	lastFeedback  string
}

func (f *fakePlanner) Plan(_ context.Context, _ string, rollups map[string]string, feedback string, _ string) (string, error) {
	f.calls++
	f.lastFeedback = feedback
	if feedback != "" && f.feedbackPlan != "" {
		return f.feedbackPlan, nil
	}
	if f.calls == 1 && f.second != "" {
		return f.first, nil
	}
	if rollups != nil && f.second != "" {
		return f.second, nil
	}
	return f.first, nil
}

type subModel struct{}

func (subModel) Complete(_ context.Context, req ModelRequest) (string, error) {
	var files []string
	for i, f := range req.RepoMap.Files {
		if i >= 3 {
			break
		}
		files = append(files, f.Path)
	}
	var sb strings.Builder
	sb.WriteString(`{"chapters":[{"name":"` + req.RepoMap.RepoName + ` 章","summary":"s","files":[`)
	for i, p := range files {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`"` + p + `"`)
	}
	sb.WriteString(`],"phase":"实战"}]}`)
	return sb.String(), nil
}

func buildDrillRepo() *RepoMap {
	files := []FileMap{
		{Path: "README.md", LOC: 50, IsDoc: true},
		{Path: "core/a.go", LOC: 100, Exports: []string{"A"}, Hotness: 80},
		{Path: "core/b.go", LOC: 90, Hotness: 30},
		{Path: "net/x.go", LOC: 80, Hotness: 10},
		{Path: "net/y.go", LOC: 70},
		{Path: "util/u.go", LOC: 20},
	}
	m := &RepoMap{RepoName: "demo", Files: files}
	m.Tree = BuildRepoTree(files, "demo")
	return m
}

func TestRunDrillAssemblesAcrossSubtrees(t *testing.T) {
	patterns := loadPatterns(t)
	m := buildDrillRepo()
	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:起步","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:核心","summary":"s","targetPaths":["core"],"phase":"实战"},
		{"name":"第 3 章:网络","summary":"s","targetPaths":["net"],"phase":"实战"}
	]}`}
	res, err := RunDrill(context.Background(), m, planner, subModel{}, patterns, "zh-CN", "", 0)
	if err != nil {
		t.Fatalf("RunDrill: %v", err)
	}
	if len(res.SkippedTrees) != 0 {
		t.Errorf("不应有跳过子树: %v", res.SkippedTrees)
	}
	if len(res.Chapters) != 3 {
		t.Fatalf("章数 %d ≠ 3: %+v", len(res.Chapters), res.Chapters)
	}
	if len(res.Chapters[1].Files) == 0 || len(res.Chapters[2].Files) == 0 {
		t.Errorf("core/net 章文件为空")
	}
	if res.Replanned {
		t.Error("无 needRollup 不应修订")
	}
}

func TestRunDrillSkipsFailedTree(t *testing.T) {
	patterns := loadPatterns(t)
	m := buildDrillRepo()
	planner := &fakePlanner{first: `{"chapters":[
		{"name":"章 A","summary":"s","targetPaths":["core"],"phase":"实战"},
		{"name":"章 B","summary":"s","targetPaths":["net"],"phase":"实战"},
		{"name":"章 C","summary":"s","targetPaths":["util"],"phase":"实战"},
		{"name":"章 G","summary":"s","targetPaths":["ghost/nope"],"phase":"实战"}
	]}`}
	res, err := RunDrill(context.Background(), m, planner, subModel{}, patterns, "zh-CN", "", 0)
	if err != nil {
		t.Fatalf("RunDrill: %v", err)
	}
	if len(res.SkippedTrees) != 0 {
		t.Errorf("幽灵目标预验证后不应产生跳过下钻: %v", res.SkippedTrees)
	}
	if len(res.DroppedPlan) != 1 || res.DroppedPlan[0] != "章 G" {
		t.Errorf("幽灵目标章应进 DroppedPlan: %v", res.DroppedPlan)
	}
	if len(res.Chapters) != 3 {
		t.Errorf("幸存章数 %d ≠ 3", len(res.Chapters))
	}
}

func TestRunDrillBoundedReplan(t *testing.T) {
	patterns := loadPatterns(t)
	m := buildDrillRepo()
	planner := &fakePlanner{
		first: `{"chapters":[{"name":"首发","summary":"s","targetPaths":["core"],"phase":"实战"}],"needRollup":["net"]}`,
		second: `{"chapters":[
			{"name":"修订后·核心","summary":"s","targetPaths":["core"],"phase":"实战"},
			{"name":"修订后·网络","summary":"s","targetPaths":["net"],"phase":"实战"},
			{"name":"修订后·工具","summary":"s","targetPaths":["util"],"phase":"实战"}
		]}`,
	}
	res, err := RunDrill(context.Background(), m, planner, subModel{}, patterns, "zh-CN", "", 0)
	if err != nil {
		t.Fatalf("RunDrill: %v", err)
	}
	if !res.Replanned {
		t.Error("A5 有界修订未触发")
	}
	if planner.calls != 2 {
		t.Errorf("规划调用 %d ≠ 2(有界封顶)", planner.calls)
	}
	if res.Chapters[0].Name != "修订后·核心" {
		t.Errorf("应采用修订规划: %s", res.Chapters[0].Name)
	}
}

func TestParsePlanRejectsInvalid(t *testing.T) {
	cases := []string{
		`{"chapters":[]}`,
		`{"chapters":[{"name":"","summary":"s","targetPaths":["a"]}]}`,
		`{"chapters":[{"name":"n","summary":"s","targetPaths":[]}]}`,
		`not json`,
	}
	for i, raw := range cases {
		if _, err := parsePlan(raw); err == nil {
			t.Errorf("case %d 应拒收", i)
		}
	}
}

func TestDrillSubtreeFileCapDynamic(t *testing.T) {
	if cap := DrillSubtreeFileCap(); cap != DefaultDrillSubtreeFileCap {
		t.Errorf("默认下钻上限 %d ≠ %d", cap, DefaultDrillSubtreeFileCap)
	}

	t.Setenv("DRILL_SUBTREE_FILE_CAP", "800")
	if cap := DrillSubtreeFileCap(); cap != 800 {
		t.Errorf("动态环境变量下钻上限 %d ≠ 800", cap)
	}

	if cap := DrillSubtreeFileCap(1200); cap != 1200 {
		t.Errorf("覆盖值下钻上限 %d ≠ 1200", cap)
	}
}

func TestRunDrillBoundedDepthCapping(t *testing.T) {
	patterns := loadPatterns(t)
	t.Setenv("DRILL_SUBTREE_FILE_CAP", "5")

	files := []FileMap{
		{Path: "README.md", LOC: 20, IsDoc: true},
		{Path: "heavy/sub1/f1.go", LOC: 30},
		{Path: "heavy/sub1/f2.go", LOC: 30},
		{Path: "heavy/sub1/f3.go", LOC: 30},
		{Path: "heavy/sub1/f4.go", LOC: 30},
		{Path: "heavy/sub2/f5.go", LOC: 30},
		{Path: "heavy/sub2/f6.go", LOC: 30},
		{Path: "heavy/sub2/f7.go", LOC: 30},
		{Path: "heavy/sub2/f8.go", LOC: 30},
		{Path: "light/util.go", LOC: 10},
	}
	m := &RepoMap{RepoName: "nested", Files: files}
	m.Tree = BuildRepoTree(files, "nested")

	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:全景","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:heavy 模块","summary":"s","targetPaths":["heavy"],"phase":"实战"},
		{"name":"第 3 章:light 模块","summary":"s","targetPaths":["light"],"phase":"实战"}
	]}`}

	res, err := RunDrill(context.Background(), m, planner, subModel{}, patterns, "zh-CN", "", 0)
	if err != nil {
		t.Fatalf("RunDrill 有界深度 2 下钻失败: %v", err)
	}
	if len(res.Chapters) != 3 {
		t.Fatalf("应当产出 3 个章节，实际产出 %d", len(res.Chapters))
	}
}

func TestDrillSingleModeFallbackToMatrix(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "README.md", LOC: 20, IsDoc: true},
		{Path: "util/u.go", LOC: 10},
	}
	for i := 0; i < 850; i++ {
		files = append(files, FileMap{Path: fmt.Sprintf("core/f%d.go", i), LOC: 10})
	}
	m := &RepoMap{RepoName: "huge", Files: files}
	m.Tree = BuildRepoTree(files, "huge")

	planner := &fakePlanner{first: `{"curriculumMode":"single", "chapters":[
		{"name":"第 1 章:全景","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:core","summary":"s","targetPaths":["core"],"phase":"实战"},
		{"name":"第 3 章:util","summary":"s","targetPaths":["util"],"phase":"实战"}
	]}`}

	res, err := RunDrill(context.Background(), m, planner, subModel{}, patterns, "zh-CN", "", 0)
	if err != nil {
		t.Fatalf("RunDrill: %v", err)
	}
	if res.CurriculumMode != "matrix" {
		t.Fatalf("Expected CurriculumMode to be overridden to matrix, got: %s", res.CurriculumMode)
	}
}

type recordingModel struct {
	mu    sync.Mutex
	calls []string
}

func (r *recordingModel) Complete(_ context.Context, req ModelRequest) (string, error) {
	r.mu.Lock()
	r.calls = append(r.calls, req.RepoMap.RepoName)
	r.mu.Unlock()

	var files []string
	for i, f := range req.RepoMap.Files {
		if i >= 12 {
			break
		}
		files = append(files, f.Path)
	}
	var sb strings.Builder
	sb.WriteString(`{"chapters":[{"name":"` + req.RepoMap.RepoName + ` 精选","summary":"s","files":[`)
	for i, p := range files {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`"` + p + `"`)
	}
	sb.WriteString(`],"phase":"实战"}]}`)
	return sb.String(), nil
}

func TestRunDrillFirstPrinciplesCognitiveBudgetAndLLMCuration(t *testing.T) {
	patterns := loadPatterns(t)
	t.Setenv("DRILL_LLM_SUBTREE", "1")
	files := []FileMap{
		{Path: "README.md", LOC: 20, IsDoc: true},
		{Path: "pkg/config/app.go", LOC: 40},
		{Path: "pkg/config/env.go", LOC: 30},
		{Path: "pkg/config/flag.go", LOC: 25},
	}
	for i := 0; i < 150; i++ {
		files = append(files, FileMap{
			Path:    fmt.Sprintf("transport/conn_%03d.go", i),
			LOC:     50,
			Hotness: 100 - i,
		})
	}

	m := &RepoMap{RepoName: "xray-like", Files: files}
	m.Tree = BuildRepoTree(files, "xray-like")

	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:全景起步","summary":"概览","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:配置与启动","summary":"配置","targetPaths":["pkg/config"],"phase":"入门"},
		{"name":"第 3 章:网络传输层","summary":"传输核心","targetPaths":["transport"],"phase":"实战"}
	]}`}

	recModel := &recordingModel{}
	res, err := RunDrill(context.Background(), m, planner, recModel, patterns, "zh-CN", "", 0)
	if err != nil {
		t.Fatalf("RunDrill failed: %v", err)
	}

	if len(recModel.calls) < 3 {
		t.Fatalf("预期 3 个目标全部经过 LLM 模型调用，实际仅调用 %d 次: %v", len(recModel.calls), recModel.calls)
	}

	if len(res.Chapters) != 3 {
		t.Fatalf("预期产出 3 章，实际产出 %d 章", len(res.Chapters))
	}

	for i, ch := range res.Chapters {
		if len(ch.Files) == 0 {
			t.Errorf("第 %d 章 (%s) 课时为空", i+1, ch.Name)
		}
		if len(ch.Files) > drillChapterFileCap {
			t.Errorf("第 %d 章 (%s) 课时数 %d 超出单章认知预算上限 %d", i+1, ch.Name, len(ch.Files), drillChapterFileCap)
		}
	}

	transportChap := res.Chapters[2]
	if len(transportChap.Files) > 8 {
		t.Errorf("transport 章课时数严重膨胀: %d 节 (必须 <= 8)", len(transportChap.Files))
	}
	if len(transportChap.Files) < 3 {
		t.Errorf("transport 章课时数过少: %d 节", len(transportChap.Files))
	}

	hasCompanions := false
	for _, f := range transportChap.Files {
		if len(f.CompanionFiles) > 0 {
			hasCompanions = true
			if len(f.CompanionFiles) > MaxCompanionsPerLesson {
				t.Errorf("主课时 %s 关联协同文件数 %d 超出单课时上限 %d", f.Path, len(f.CompanionFiles), MaxCompanionsPerLesson)
			}
			for _, comp := range f.CompanionFiles {
				if !strings.HasPrefix(comp, "transport/") {
					t.Errorf("协同文件 %s 不属于 transport 子系统目录", comp)
				}
			}
		}
	}
	if !hasCompanions {
		t.Errorf("预期 transport 章的主课时具有协同文件，实际全部为空")
	}
}

func TestRunDrillPlanADeterministicZeroLLMSubtree(t *testing.T) {
	patterns := loadPatterns(t)

	files := []FileMap{
		{Path: "README.md", LOC: 20, IsDoc: true},
		{Path: "pkg/config/app.go", LOC: 40, Exports: []string{"NewApp"}, Layer: LayerFoundation},
		{Path: "pkg/config/env.go", LOC: 30, Hotness: 50},
		{Path: "transport/conn.go", LOC: 100, Exports: []string{"Dial", "Listen"}, Hotness: 80, Layer: LayerPipeline},
		{Path: "transport/pool.go", LOC: 60, Hotness: 30},
	}

	m := &RepoMap{RepoName: "plan-a-repo", Files: files}
	m.Tree = BuildRepoTree(files, "plan-a-repo")

	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:全景起步","summary":"概览","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:配置体系","summary":"配置","targetPaths":["pkg/config"],"phase":"入门"},
		{"name":"第 3 章:网络通信","summary":"传输核心","targetPaths":["transport"],"phase":"实战"}
	]}`}

	recModel := &recordingModel{}
	res, err := RunDrill(context.Background(), m, planner, recModel, patterns, "zh-CN", "", 0)
	require.NoError(t, err)

	assert.Equal(t, 0, len(recModel.calls), "方案 A 默认模式下子树 LLM 调用次数必须严格为 0")

	assert.Len(t, res.Chapters, 3)
	for i, ch := range res.Chapters {
		assert.NotEmpty(t, ch.Files, "第 %d 章 (%s) 必须挂载代码文件", i+1, ch.Name)
		assert.LessOrEqual(t, len(ch.Files), drillChapterFileCap)
	}

	assert.Equal(t, "README.md", res.Chapters[0].Files[0].Path)
	assert.True(t, strings.HasPrefix(res.Chapters[1].Files[0].Path, "pkg/config/"))
	assert.True(t, strings.HasPrefix(res.Chapters[2].Files[0].Path, "transport/"))
}

func TestNormalizeTargetPath_TableDriven(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "repo name prefix stripped", in: "xray-core/transport", want: "transport"},
		{name: "nested prefix stripped", in: "xray-core/transport/internet", want: "transport/internet"},
		{name: "backticks and spaces", in: " `xray-core/transport` ", want: "transport"},
		{name: "leading slash and dot slash", in: "/./transport", want: "transport"},
		{name: "bare path untouched", in: "transport", want: "transport"},
		{name: "root name kept (whole-repo semantics)", in: "xray-core", want: "xray-core"},
		{name: "file target untouched", in: "core/a.go", want: "core/a.go"},
		{name: "unrelated prefix untouched", in: "other/transport", want: "other/transport"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, normalizeTargetPath("xray-core", tt.in))
		})
	}
}

func TestFindSubtreeResolvesPrefixedTargets(t *testing.T) {
	m := buildDrillRepo()
	root := m.Tree

	bare := findSubtree(root, "core")
	require.NotNil(t, bare, "裸名 core 应命中")
	prefixed := findSubtree(root, "demo/core")
	require.NotNil(t, prefixed, "带根名前缀 demo/core 应命中(归一化装甲)")
	assert.Equal(t, bare.Path, prefixed.Path, "两种写法应解析到同一子树")
	assert.Nil(t, findSubtree(root, "demo/ghost"), "真实不存在的路径仍应拒绝(不掩盖幻觉)")
}

func TestPlanDegenerateAliasesCountOnce(t *testing.T) {
	m := buildDrillRepo()
	root := m.Tree

	plan := []PlanChapter{
		{Name: "章 A", TargetPaths: []string{"core"}},
		{Name: "章 B", TargetPaths: []string{"demo/core"}},
		{Name: "章 C", TargetPaths: []string{"net"}},
	}
	assert.True(t, planDegenerate(plan, root, false), "2 个真实分区 + 1 个别名写法应判退化")
}

func TestObtainPlanDegenerateFailClosed_TableDriven(t *testing.T) {
	m := buildDrillRepo()

	goodPlan := `{"chapters":[
		{"name":"第 1 章:起步","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:核心","summary":"s","targetPaths":["core"],"phase":"实战"},
		{"name":"第 3 章:网络","summary":"s","targetPaths":["net"],"phase":"实战"}
	]}`
	degeneratePlan := `{"chapters":[
		{"name":"孤章","summary":"s","targetPaths":["core"],"phase":"实战"}
	]}`
	prefixedGoodPlan := `{"chapters":[
		{"name":"第 1 章:起步","summary":"s","targetPaths":["demo/README.md"],"phase":"入门"},
		{"name":"第 2 章:核心","summary":"s","targetPaths":["demo/core"],"phase":"实战"},
		{"name":"第 3 章:网络","summary":"s","targetPaths":["demo/net"],"phase":"实战"}
	]}`

	tests := []struct {
		name          string
		planner       *fakePlanner
		wantErr       bool
		wantReplanned bool
	}{
		{name: "healthy plan passes", planner: &fakePlanner{first: goodPlan}},
		{
			name:          "prefixed targets rescued by armor without replan",
			planner:       &fakePlanner{first: prefixedGoodPlan},
			wantReplanned: false,
		},
		{
			name:          "degenerate recovered by feedback replan",
			planner:       &fakePlanner{first: degeneratePlan, feedbackPlan: goodPlan},
			wantReplanned: true,
		},
		{name: "persistent degenerate fails closed", planner: &fakePlanner{first: degeneratePlan}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, replanned, _, err := obtainPlan(context.Background(), tt.planner, m.Tree, "zh-CN", 3, 1)
			if tt.wantErr {
				require.Error(t, err, "持续退化应 fail-closed 报错")
				assert.Contains(t, err.Error(), "degenerated")
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.wantReplanned, replanned)
			require.Len(t, resp.Chapters, 3)
			assert.Equal(t, "matrix", resp.CurriculumMode)
			if tt.name == "prefixed targets rescued by armor without replan" {
				assert.Equal(t, []string{"core"}, resp.Chapters[1].TargetPaths, "归一化后目标应为规范键")
			}
		})
	}
}

func TestRootIsolationInDrillLevel(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "README.md", LOC: 50, IsDoc: true},
		{Path: "main.go", LOC: 80},
		{Path: "core/a.go", LOC: 100, Exports: []string{"A"}},
		{Path: "net/x.go", LOC: 90},
	}
	m := &RepoMap{RepoName: "demo", Files: files}
	m.Tree = BuildRepoTree(files, "demo")

	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:全景起步","summary":"s","targetPaths":["."],"phase":"入门"},
		{"name":"第 2 章:核心实现","summary":"s","targetPaths":["core"],"phase":"实战"},
		{"name":"第 3 章:网络通信","summary":"s","targetPaths":["net"],"phase":"实战"}
	]}`}

	res, err := RunDrill(context.Background(), m, planner, subModel{}, patterns, "zh-CN", "", 0)
	require.NoError(t, err)
	require.Len(t, res.Chapters, 3, "所有 3 章均应保留，第 2/3 章不被第 1 章掏空")

	for _, f := range res.Chapters[0].Files {
		assert.False(t, strings.HasPrefix(f.Path, "core/"), "第 1 章不得包含 core/ 文件: %s", f.Path)
		assert.False(t, strings.HasPrefix(f.Path, "net/"), "第 1 章不得包含 net/ 文件: %s", f.Path)
	}

	require.NotEmpty(t, res.Chapters[1].Files, "core 章文件不应为空")
	assert.Equal(t, "core/a.go", res.Chapters[1].Files[0].Path)

	require.NotEmpty(t, res.Chapters[2].Files, "net 章文件不应为空")
	assert.Equal(t, "net/x.go", res.Chapters[2].Files[0].Path)
}

func TestPlanDegenerateFlatRepo_TableDriven(t *testing.T) {
	tests := []struct {
		name       string
		files      []FileMap
		plan       []PlanChapter
		degenerate bool
	}{
		{
			name: "flat repo with 1 child covering that child is not degenerate",
			files: []FileMap{
				{Path: "README.md", LOC: 10},
				{Path: "main.go", LOC: 20},
				{Path: "cmd/run.go", LOC: 30},
				{Path: "cmd/app.go", LOC: 40},
			},
			plan: []PlanChapter{
				{Name: "章 1", TargetPaths: []string{"README.md"}},
				{Name: "章 2", TargetPaths: []string{"cmd"}},
				{Name: "章 3", TargetPaths: []string{"cmd"}},
			},
			degenerate: false,
		},
		{
			name: "flat repo with 2 children covering both is not degenerate",
			files: []FileMap{
				{Path: "README.md", LOC: 10},
				{Path: "cmd/run.go", LOC: 20},
				{Path: "pkg/lib.go", LOC: 30},
				{Path: "pkg/api.go", LOC: 40},
			},
			plan: []PlanChapter{
				{Name: "章 1", TargetPaths: []string{"README.md"}},
				{Name: "章 2", TargetPaths: []string{"cmd"}},
				{Name: "章 3", TargetPaths: []string{"pkg"}},
			},
			degenerate: false,
		},
		{
			name: "normal repo with 4 children covering only 2 is degenerate",
			files: []FileMap{
				{Path: "a/f.go", LOC: 10},
				{Path: "b/f.go", LOC: 10},
				{Path: "c/f.go", LOC: 10},
				{Path: "d/f.go", LOC: 10},
				{Path: "README.md", LOC: 10},
			},
			plan: []PlanChapter{
				{Name: "章 1", TargetPaths: []string{"a"}},
				{Name: "章 2", TargetPaths: []string{"b"}},
				{Name: "章 3", TargetPaths: []string{"a"}},
			},
			degenerate: true,
		},
		{
			name: "lazy model with >50% root hits is degenerate",
			files: []FileMap{
				{Path: "cmd/run.go", LOC: 10},
				{Path: "pkg/lib.go", LOC: 10},
				{Path: "README.md", LOC: 10},
				{Path: "main.go", LOC: 10},
			},
			plan: []PlanChapter{
				{Name: "章 1", TargetPaths: []string{"."}},
				{Name: "章 2", TargetPaths: []string{"."}},
				{Name: "章 3", TargetPaths: []string{"."}},
				{Name: "章 4", TargetPaths: []string{"cmd"}},
			},
			degenerate: true,
		},
		{
			name: "completely flat repo with 0 children covering valid root files is not degenerate",
			files: []FileMap{
				{Path: "README.md", LOC: 10},
				{Path: "main.go", LOC: 20},
				{Path: "calc.go", LOC: 30},
				{Path: "util.go", LOC: 40},
			},
			plan: []PlanChapter{
				{Name: "章 1", TargetPaths: []string{"README.md"}},
				{Name: "章 2", TargetPaths: []string{"main.go"}},
				{Name: "章 3", TargetPaths: []string{"calc.go"}},
			},
			degenerate: false,
		},
		{
			name: "completely flat repo with 0 children covering 0 valid targets is degenerate",
			files: []FileMap{
				{Path: "README.md", LOC: 10},
				{Path: "main.go", LOC: 20},
				{Path: "calc.go", LOC: 30},
				{Path: "util.go", LOC: 40},
			},
			plan: []PlanChapter{
				{Name: "章 1", TargetPaths: []string{"ghost1"}},
				{Name: "章 2", TargetPaths: []string{"ghost2"}},
				{Name: "章 3", TargetPaths: []string{"ghost3"}},
			},
			degenerate: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := BuildRepoTree(tt.files, "repo")
			assert.Equal(t, tt.degenerate, planDegenerate(tt.plan, root, false))
		})
	}
}

type trackingSubModel struct {
	mu             sync.Mutex
	currentActive  int
	maxConcurrency int
}

func (m *trackingSubModel) Complete(_ context.Context, req ModelRequest) (string, error) {
	m.mu.Lock()
	m.currentActive++
	if m.currentActive > m.maxConcurrency {
		m.maxConcurrency = m.currentActive
	}
	m.mu.Unlock()

	time.Sleep(10 * time.Millisecond)

	m.mu.Lock()
	m.currentActive--
	m.mu.Unlock()

	return `{"chapters":[{"name":"chapter","summary":"s","files":["` + req.RepoMap.Files[0].Path + `"],"phase":"实战"}]}`, nil
}

func TestRunDrillBoundedConcurrency(t *testing.T) {
	patterns := loadPatterns(t)
	t.Setenv("DRILL_LLM_SUBTREE", "1")

	var files []FileMap
	var planChapters []string
	for i := 0; i < 10; i++ {
		subName := fmt.Sprintf("sub%d", i)
		files = append(files, FileMap{Path: fmt.Sprintf("%s/file.go", subName), LOC: 100})
		planChapters = append(planChapters, fmt.Sprintf(`{"name":"第 %d 章","summary":"s","targetPaths":["%s"],"phase":"实战"}`, i+1, subName))
	}

	m := &RepoMap{RepoName: "giant-repo", Files: files}
	m.Tree = BuildRepoTree(files, "giant-repo")

	planJSON := `{"chapters":[` + strings.Join(planChapters, ",") + `]}`
	planner := &fakePlanner{first: planJSON}
	tracker := &trackingSubModel{}

	res, err := RunDrill(context.Background(), m, planner, tracker, patterns, "zh-CN", "", 0)
	require.NoError(t, err)
	assert.Len(t, res.Chapters, 10)

	tracker.mu.Lock()
	maxObserved := tracker.maxConcurrency
	tracker.mu.Unlock()

	assert.LessOrEqual(t, maxObserved, 2, "任意时刻子树并发下钻数必须严格 <= 2，防止压垮外部通道")
}

func TestFindSubtreeCollapsedChains(t *testing.T) {
	files := []FileMap{
		{Path: "README.md", LOC: 50, IsDoc: true},
		{Path: "src/peft/tuners/lora.py", LOC: 200},
		{Path: "src/peft/optimizers/adam.py", LOC: 150},
		{Path: "src/peft/utils/save.py", LOC: 100},
		{Path: "docs/quickstart.md", LOC: 80, IsDoc: true},
	}
	m := &RepoMap{RepoName: "peft", Files: files}
	m.Tree = BuildRepoTree(files, "peft")

	srcPeft := m.Tree.findChild("src/peft")
	require.NotNil(t, srcPeft, "src/peft 应该作为单链折叠节点存在")

	tunersExact := findSubtree(m.Tree, "src/peft/tuners")
	assert.NotNil(t, tunersExact, "findSubtree 应能通过全路径 src/peft/tuners 找到 tuners 子树")

	tunersShort := findSubtree(m.Tree, "tuners")
	assert.NotNil(t, tunersShort, "findSubtree 应能通过短名 tuners 找到 tuners 子树")

	tunersRel := findSubtree(m.Tree, "peft/tuners")
	assert.NotNil(t, tunersRel, "findSubtree 应能通过相对路径 peft/tuners 找到 tuners 子树")

	srcCollapsed := findSubtree(m.Tree, "src")
	assert.Equal(t, srcPeft, srcCollapsed, "findSubtree 应能通过被折叠前驱路径 src 解析到 src/peft 子树")

	readmeExact := findSubtree(m.Tree, "README.md")
	assert.NotNil(t, readmeExact, "findSubtree 应能匹配根目录精确文件 README.md")
	assert.Equal(t, 1, readmeExact.FileCount)

	loraSuffix := findSubtree(m.Tree, "lora.py")
	assert.NotNil(t, loraSuffix, "findSubtree 应能通过文件名后缀 lora.py 找到单文件合成节点")
	assert.Equal(t, "src/peft/tuners/lora.py", loraSuffix.Path)

	utilsDir := findSubtree(m.Tree, "utils")
	assert.NotNil(t, utilsDir, "findSubtree 应能匹配 utils 目录")
	assert.GreaterOrEqual(t, utilsDir.FileCount, 1)
}

func TestRunDrillProgressCallback(t *testing.T) {
	patterns := loadPatterns(t)

	files := []FileMap{
		{Path: "README.md", LOC: 50, IsDoc: true},
		{Path: "pkg/agent/run.go", LOC: 100},
		{Path: "pkg/gateway/route.go", LOC: 120},
	}
	m := &RepoMap{RepoName: "drill-repo", Files: files}
	m.Tree = BuildRepoTree(files, "drill-repo")

	planner := &fakePlanner{first: `{"chapters":[
		{"name":"第 1 章:概述","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:智能体","summary":"s","targetPaths":["pkg/agent"],"phase":"实战","drillDown":true},
		{"name":"第 3 章:网关","summary":"s","targetPaths":["pkg/gateway"],"phase":"实战","drillDown":true}
	]}`}

	var steps []ProgressStep
	var mu sync.Mutex
	cb := func(step ProgressStep) {
		mu.Lock()
		defer mu.Unlock()
		steps = append(steps, step)
	}

	res, err := RunDrill(context.Background(), m, planner, subModel{}, patterns, "zh-CN", "", 0, cb)
	require.NoError(t, err)
	assert.NotEmpty(t, res.Chapters)

	mu.Lock()
	defer mu.Unlock()
	require.NotEmpty(t, steps, "ProgressCallback 应收到至少 1 个步骤")

	var planFound, drillFound bool
	for _, s := range steps {
		if s.Stage == "plan" {
			planFound = true
			assert.Contains(t, s.Title, "宏观课程划分")
		}
		if s.Stage == "drill" {
			drillFound = true
			assert.Contains(t, s.Title, "子课程下钻")
		}
	}
	assert.True(t, planFound, "必须包含 plan 阶段步进")
	assert.True(t, drillFound, "必须包含 drill 阶段步进")
}

func TestRunDrillContextCancellation(t *testing.T) {
	patterns := loadPatterns(t)

	files := []FileMap{
		{Path: "README.md", LOC: 50, IsDoc: true},
		{Path: "pkg/a/run.go", LOC: 100},
	}
	m := &RepoMap{RepoName: "drill-repo", Files: files}
	m.Tree = BuildRepoTree(files, "drill-repo")

	planner := &fakePlanner{first: `{"chapters":[{"name":"c1","targetPaths":["pkg/a"]}]}`}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := RunDrill(ctx, m, planner, subModel{}, patterns, "zh-CN", "", 0)
	require.Error(t, err)
	assert.Equal(t, context.Canceled, err)
}

func TestObtainPlanTransientRetryRecovery(t *testing.T) {
	root := &RepoTreeNode{
		Name:      "demo",
		FileCount: 3,
		Children: []*RepoTreeNode{
			{Name: "pkg/a", FileCount: 1},
			{Name: "pkg/b", FileCount: 1},
			{Name: "pkg/c", FileCount: 1},
		},
	}
	goodPlan := `{"curriculumMode":"matrix","chapters":[{"name":"第 1 章","targetPaths":["pkg/a"]},{"name":"第 2 章","targetPaths":["pkg/b"]},{"name":"第 3 章","targetPaths":["pkg/c"]}]}`

	t.Run("GENERATION_FAILED transient error recovers on retry", func(t *testing.T) {
		planner := &retryableFakePlanner{
			failCount: 1,
			failErr:   &client.LlmGatewayError{Code: client.ErrCodeGenerationFailed, Status: 502, Message: "streamed output contains no complete JSON object (len=358)"},
			success:   goodPlan,
		}
		resp, replanned, _, err := obtainPlan(context.Background(), planner, root, "zh-CN", 3, 1)
		require.NoError(t, err)
		assert.False(t, replanned)
		require.NotNil(t, resp)
		assert.Equal(t, 2, planner.calls, "应当在第 2 次重试成功")
		assert.Len(t, resp.Chapters, 3)
	})

	t.Run("MISSING_API_KEY permanent error fails immediately without retry", func(t *testing.T) {
		planner := &retryableFakePlanner{
			failCount: 2,
			failErr:   &client.LlmGatewayError{Code: client.ErrCodeMissingApiKey, Status: 409, Message: "missing api key"},
			success:   goodPlan,
		}
		_, _, _, err := obtainPlan(context.Background(), planner, root, "zh-CN", 3, 1)
		require.Error(t, err)
		assert.Equal(t, 1, planner.calls, "致命配置错误应立即 fail-fast，严禁空耗重试")
	})

	t.Run("KEY_DECRYPT_FAILED permanent error fails immediately without retry", func(t *testing.T) {
		planner := &retryableFakePlanner{
			failCount: 2,
			failErr:   &client.LlmGatewayError{Code: client.ErrCodeKeyDecryptFailed, Status: 409, Message: "云端已保存的 AI 密钥无法解密"},
			success:   goodPlan,
		}
		_, _, _, err := obtainPlan(context.Background(), planner, root, "zh-CN", 3, 1)
		require.Error(t, err)
		assert.Equal(t, 1, planner.calls, "解密失败应立即 fail-fast 并保留可区分错误码")
	})
}

type retryableFakePlanner struct {
	failCount int
	failErr   error
	success   string
	calls     int
}

func (r *retryableFakePlanner) Plan(_ context.Context, _ string, _ map[string]string, _ string, _ string) (string, error) {
	r.calls++
	if r.calls <= r.failCount {
		return "", r.failErr
	}
	return r.success, nil
}

func companionPaths(chapters []cognitive.OutlineChapter) map[string]bool {
	out := map[string]bool{}
	for _, ch := range chapters {
		for _, f := range ch.Files {
			for _, c := range f.CompanionFiles {
				out[c] = true
			}
		}
	}
	return out
}

func TestAttachCompanionsNoCrossSubsystem_TableDriven(t *testing.T) {
	patterns := loadPatterns(t)
	tests := []struct {
		name      string
		callEdges []ASTCallEdge
		companion string
	}{
		{
			name:      "无 AST 边的跨子系统文件即便 depth==1 也不挂载",
			companion: "packages/compiler-core/src/parse.ts",
			callEdges: nil,
		},
		{
			name:      "有直接 AST 边但跨子系统的文件同样不挂载（同子系统为第一轮硬前提）",
			companion: "packages/compiler-core/src/parse.ts",
			callEdges: []ASTCallEdge{{Caller: "packages/compiler-core/src/parse.ts", Callee: "packages/react-dom/src/index.ts", Symbol: "parse"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := []FileMap{
				{Path: "packages/react-dom/src/index.ts", LOC: 500, Exports: []string{"render"}, Imports: []string{"@vue/runtime-core"}},
				{Path: "packages/compiler-core/src/parse.ts", LOC: 400, Exports: []string{"parse"}},
			}
			m := &RepoMap{RepoName: "monorepo", Files: files, CallEdges: tt.callEdges}
			root := BuildRepoTree(files, "monorepo")
			subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
			require.Len(t, subsystems, 2, "monorepo 夹具应识别出两个子系统")

			chapters := []cognitive.OutlineChapter{
				{Files: []cognitive.ChapterFile{{Path: "packages/react-dom/src/index.ts"}}},
			}
			AttachSubtreeCompanionsWithMap(chapters, root, m, subsystems)

			comps := companionPaths(chapters)
			assert.NotContains(t, comps, tt.companion, "严禁仅因共享 packages/（depth==1）跨子包错挂")
			assert.NotContains(t, comps, "packages/react-dom/src/index.ts", "主课时自身不应出现在协同集")
		})
	}
}

func TestAttachCompanionsAstEdgeWinsOverSameDir_TableDriven(t *testing.T) {
	files := []FileMap{
		{Path: "packages/react-dom/src/index.ts", LOC: 500, Exports: []string{"render"}},
		{Path: "packages/react-dom/src/adapters/connect.ts", LOC: 300, Exports: []string{"connect"}},
	}
	for i := 0; i < 12; i++ {
		files = append(files, FileMap{Path: fmt.Sprintf("packages/react-dom/src/inner_%02d.ts", i), LOC: 100 - i})
	}
	edges := []ASTCallEdge{{Caller: "packages/react-dom/src/adapters/connect.ts", Callee: "packages/react-dom/src/index.ts", Symbol: "render"}}
	m := &RepoMap{RepoName: "monorepo", Files: files, CallEdges: edges}
	root := BuildRepoTree(files, "monorepo")
	subsystems := []SubsystemSpec{{Name: "react-dom", Prefix: "packages/react-dom"}}

	chapters := []cognitive.OutlineChapter{
		{Files: []cognitive.ChapterFile{{Path: "packages/react-dom/src/index.ts"}}},
	}
	AttachSubtreeCompanionsWithMap(chapters, root, m, subsystems)

	require.Len(t, chapters[0].Files, 1)
	comps := chapters[0].Files[0].CompanionFiles
	assert.Len(t, comps, MaxCompanionsPerLesson, "协同挂载必须保持单课时上限 10")
	assert.Contains(t, comps, "packages/react-dom/src/adapters/connect.ts",
		"同子系统 AST 边文件必须优先于同目录无 AST 边文件挤进协同集")
	assert.NotContains(t, comps, "packages/react-dom/src/inner_11.ts",
		"容量受限时最低分同目录文件应被挤出（AST 边第一轮先挂满）")
	for _, c := range comps {
		assert.True(t, strings.HasPrefix(c, "packages/react-dom/"), "协同文件 %s 越出子系统边界", c)
	}
}

func TestAttachCompanionsNilMapDegradesToDirTopology(t *testing.T) {
	files := []FileMap{
		{Path: "packages/react-dom/src/index.ts", LOC: 500},
		{Path: "packages/compiler-core/src/parse.ts", LOC: 400},
	}
	root := BuildRepoTree(files, "monorepo")
	chapters := []cognitive.OutlineChapter{
		{Files: []cognitive.ChapterFile{{Path: "packages/react-dom/src/index.ts"}}},
	}
	AttachSubtreeCompanionsWithMap(chapters, root, nil, nil)

	comps := companionPaths(chapters)
	assert.Contains(t, comps, "packages/compiler-core/src/parse.ts", "无子系统清单时应保持历史 depth==1 挂载行为")
}

func TestScoreSubtreeFileTeachingDepth_TableDriven(t *testing.T) {
	doc := FileMap{Path: "docs/guide.md", LOC: 120, IsDoc: true}
	deepInternal := FileMap{Path: "packages/core/src/internal/transforms/impl.ts", LOC: 500, Hotness: 90, Layer: LayerPipeline}
	entry := FileMap{Path: "packages/core/src/index.ts", LOC: 60}
	plain := FileMap{Path: "packages/core/src/plain.ts", LOC: 60, Hotness: 5}
	hotEngine := FileMap{Path: "engine.go", LOC: 400, Hotness: 85, Layer: LayerFoundation}
	specFile := FileMap{Path: "parser_spec.go", LOC: 150, Hotness: 5}

	tests := []struct {
		name      string
		depth     string
		files     []FileMap
		wantFirst string
	}{
		{
			name:      "overview 文档优先于高热深层内部实现",
			depth:     TeachingDepthOverview,
			files:     []FileMap{deepInternal, doc},
			wantFirst: "docs/guide.md",
		},
		{
			name:      "overview 入口文件加权胜过更高基线的平文件",
			depth:     TeachingDepthOverview,
			files:     []FileMap{plain, entry},
			wantFirst: "packages/core/src/index.ts",
		},
		{
			name:      "deep spec 契约文件加权胜过同基线平文件",
			depth:     TeachingDepthDeep,
			files:     []FileMap{plain, specFile},
			wantFirst: "parser_spec.go",
		},
		{
			name:      "overview 平文件与 spec 平局时按路径字典序（确定性）",
			depth:     TeachingDepthOverview,
			files:     []FileMap{specFile, plain},
			wantFirst: "packages/core/src/plain.ts",
		},
		{
			name:      "deep 高热核心胜过低基线平文件",
			depth:     TeachingDepthDeep,
			files:     []FileMap{plain, hotEngine},
			wantFirst: "engine.go",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sorted := sortSubtreeFilesByRelevance(tt.files, tt.depth, false)
			require.NotEmpty(t, sorted)
			assert.Equal(t, tt.wantFirst, sorted[0].Path)
		})
	}

	t.Run("深度项做加法而非重写基线", func(t *testing.T) {
		for _, f := range []FileMap{doc, deepInternal, entry, hotEngine} {
			assert.Equal(t, scoreSubtreeFile(f, "", false), scoreSubtreeFile(f, TeachingDepthStandard, false),
				"standard 深度应与基线权重完全一致: %s", f.Path)
		}
		assert.Greater(t, scoreSubtreeFile(doc, TeachingDepthOverview, false), scoreSubtreeFile(doc, "", false))
		assert.Less(t, scoreSubtreeFile(deepInternal, TeachingDepthOverview, false), scoreSubtreeFile(deepInternal, "", false))
		assert.Greater(t, scoreSubtreeFile(hotEngine, TeachingDepthDeep, false), scoreSubtreeFile(hotEngine, "", false))
		assert.Greater(t, scoreSubtreeFile(specFile, TeachingDepthDeep, false), scoreSubtreeFile(specFile, "", false))
	})
}

type fakeContextPlanner struct {
	fakePlanner
	customPrompt   string
	skeletons      []string
	rollupsHistory []map[string]string
	feedbacks      []string
}

func (f *fakeContextPlanner) TeachingContext() (string, string) { return "", f.customPrompt }

func (f *fakeContextPlanner) Plan(ctx context.Context, skeleton string, rollups map[string]string, feedback string, lang string) (string, error) {
	f.skeletons = append(f.skeletons, skeleton)
	f.rollupsHistory = append(f.rollupsHistory, rollups)
	f.feedbacks = append(f.feedbacks, feedback)
	return f.fakePlanner.Plan(ctx, skeleton, rollups, feedback, lang)
}

func TestParsePlanFocusFilesOnlyChapter(t *testing.T) {
	resp, err := parsePlan(`{"intentMode":"thematic_slice","chapters":[
		{"name":"专题章","summary":"聚焦","focusFiles":["core/a.go"]}
	]}`)
	require.NoError(t, err)
	require.Len(t, resp.Chapters, 1)
	assert.Empty(t, resp.Chapters[0].TargetPaths, "focusFiles-only 章 targetPaths 可为空")
	assert.Equal(t, []string{"core/a.go"}, resp.Chapters[0].FocusFiles)
	assert.Equal(t, "thematic_slice", resp.IntentMode)

	_, err = parsePlan(`{"chapters":[{"name":"双空章","summary":"s"}]}`)
	require.Error(t, err, "targetPaths 与 focusFiles 双空的章必须拒收")
	assert.Contains(t, err.Error(), "focusFiles")
}

func TestPlanDegenerateThematicFloor_TableDriven(t *testing.T) {
	files := []FileMap{
		{Path: "a/f.go", LOC: 10},
		{Path: "b/f.go", LOC: 10},
		{Path: "c/f.go", LOC: 10},
		{Path: "README.md", LOC: 10},
	}
	root := BuildRepoTree(files, "repo")
	tests := []struct {
		name       string
		plan       []PlanChapter
		thematic   bool
		degenerate bool
	}{
		{
			name:       "thematic 单章 focusFiles 不退化",
			plan:       []PlanChapter{{Name: "专题章", FocusFiles: []string{"a/f.go"}}},
			thematic:   true,
			degenerate: false,
		},
		{
			name:       "thematic 单章指向根也不退化（真实性由预验证求交裁决）",
			plan:       []PlanChapter{{Name: "专题章", TargetPaths: []string{"."}}},
			thematic:   true,
			degenerate: false,
		},
		{
			name:       "legacy 单章仍退化",
			plan:       []PlanChapter{{Name: "孤章", TargetPaths: []string{"a"}}},
			thematic:   false,
			degenerate: true,
		},
		{
			name: "legacy 过半根指向仍退化",
			plan: []PlanChapter{
				{Name: "章 1", TargetPaths: []string{"."}},
				{Name: "章 2", TargetPaths: []string{"."}},
				{Name: "章 3", TargetPaths: []string{"a"}},
			},
			thematic:   false,
			degenerate: true,
		},
		{
			name: "legacy 2 章单分区仍退化",
			plan: []PlanChapter{
				{Name: "章 1", TargetPaths: []string{"a"}},
				{Name: "章 2", TargetPaths: []string{"a"}},
			},
			thematic:   false,
			degenerate: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.degenerate, planDegenerate(tt.plan, root, tt.thematic))
		})
	}
}

func TestObtainPlanThematicIntentConvergence(t *testing.T) {
	goodPlan := `{"chapters":[
		{"name":"第 1 章:起步","summary":"s","targetPaths":["README.md"],"phase":"入门"},
		{"name":"第 2 章:核心","summary":"s","targetPaths":["core"],"phase":"实战"},
		{"name":"第 3 章:网络","summary":"s","targetPaths":["net"],"phase":"实战"}
	]}`

	t.Run("customPrompt 非空切换专题骨架通道（定向符号索引段在场）", func(t *testing.T) {
		m := buildDrillRepo()
		p := &fakeContextPlanner{
			customPrompt: "聚焦 core 状态机",
			fakePlanner:  fakePlanner{first: `{"intentMode":"thematic_slice","chapters":[{"name":"专题章","summary":"s","targetPaths":["core"]}]}`},
		}
		resp, _, _, err := obtainPlan(context.Background(), p, m.Tree, "zh-CN", 3, 1)
		require.NoError(t, err)
		require.NotEmpty(t, p.skeletons)
		assert.Contains(t, p.skeletons[0], "定向符号索引", "专题任务应携带符号索引段")
		assert.Equal(t, "thematic_slice", resp.IntentMode)
	})

	t.Run("customPrompt 空 skeleton 与现状逐字节一致", func(t *testing.T) {
		m := buildDrillRepo()
		p := &fakeContextPlanner{fakePlanner: fakePlanner{first: goodPlan}}
		resp, _, _, err := obtainPlan(context.Background(), p, m.Tree, "zh-CN", 3, 1)
		require.NoError(t, err)
		require.NotEmpty(t, p.skeletons)
		assert.Equal(t, RenderSkeleton(m.Tree), p.skeletons[0], "全仓通道骨架渲染零漂移")
		assert.NotContains(t, p.skeletons[0], "定向符号索引")
		assert.Equal(t, "full_repo", resp.IntentMode)
	})

	t.Run("customPrompt 空时模型越权 intentMode 被强制 full_repo（fail-closed）", func(t *testing.T) {
		m := buildDrillRepo()
		p := &fakeContextPlanner{fakePlanner: fakePlanner{first: `{"intentMode":"thematic_slice","chapters":[
			{"name":"章 A","summary":"s","targetPaths":["core"]},
			{"name":"章 B","summary":"s","targetPaths":["net"]},
			{"name":"章 C","summary":"s","targetPaths":["util"]}
		]}`}}
		resp, _, diag, err := obtainPlan(context.Background(), p, m.Tree, "zh-CN", 3, 1)
		require.NoError(t, err)
		assert.Equal(t, "full_repo", resp.IntentMode, "customPrompt 为空时模型越权声明无效")
		assert.Equal(t, "full_repo", diag.IntentMode)
	})

	t.Run("A5 修订响应漏报 intentMode 继承首发 thematic 判定", func(t *testing.T) {
		m := buildDrillRepo()
		p := &fakeContextPlanner{
			customPrompt: "聚焦传输层",
			fakePlanner: fakePlanner{
				first: `{"intentMode":"thematic_slice","chapters":[{"name":"首发","summary":"s","targetPaths":["core"]}],"needRollup":["net"]}`,
				second: `{"chapters":[
					{"name":"修订·核心","summary":"s","targetPaths":["core"]},
					{"name":"修订·网络","summary":"s","targetPaths":["net"]},
					{"name":"修订·工具","summary":"s","targetPaths":["util"]}
				]}`,
			},
		}
		resp, replanned, diag, err := obtainPlan(context.Background(), p, m.Tree, "zh-CN", 3, 1)
		require.NoError(t, err)
		assert.True(t, replanned)
		assert.Equal(t, "thematic_slice", resp.IntentMode, "p2 漏报 intentMode 应继承首发留档")
		assert.Equal(t, "thematic_slice", diag.IntentMode)
		require.Len(t, p.rollupsHistory, 2)
		sub := findSubtree(m.Tree, "net")
		require.NotNil(t, sub)
		assert.Equal(t, RenderSubtreeSkeletonWithFiles(sub, 1, thematicRollupFileBudget),
			p.rollupsHistory[1]["net"], "专题补料应携直属文件行")
		assert.Contains(t, p.rollupsHistory[1]["net"], "| loc:", "文件行口径")
	})

	t.Run("反馈重规划携带 lastRollups 补料视野", func(t *testing.T) {
		m := buildDrillRepo()
		p := &fakeContextPlanner{
			customPrompt: "聚焦核心",
			fakePlanner: fakePlanner{
				first:  `{"chapters":[{"name":"首发孤章","summary":"s","targetPaths":["core"]}],"needRollup":["net"]}`,
				second: `{"chapters":[{"name":"修订孤章","summary":"s","targetPaths":["core"]}]}`,
				feedbackPlan: `{"chapters":[
					{"name":"救回·核心","summary":"s","targetPaths":["core"]},
					{"name":"救回·网络","summary":"s","targetPaths":["net"]},
					{"name":"救回·工具","summary":"s","targetPaths":["util"]}
				]}`,
			},
		}
		resp, replanned, _, err := obtainPlan(context.Background(), p, m.Tree, "zh-CN", 3, 1)
		require.NoError(t, err)
		assert.True(t, replanned)
		require.NotEmpty(t, resp.Chapters)
		assert.Equal(t, "救回·核心", resp.Chapters[0].Name, "应采用反馈重规划救回结果")
		require.Len(t, p.skeletons, 3, "首发+A5 修订+反馈重规划共 3 次调用")
		require.NotNil(t, p.rollupsHistory[2], "反馈重规划必须携带 lastRollups（补料视野不丢失）")
		assert.Contains(t, p.rollupsHistory[2], "net")
		require.Len(t, p.feedbacks, 3)
		assert.Contains(t, p.feedbacks[2], "物理校验", "反馈文本应携带退化物理事实")
	})
}

func TestRunDrillThematicFocusFilesDirect(t *testing.T) {
	patterns := loadPatterns(t)
	m := buildDrillRepo()
	p := &fakeContextPlanner{
		customPrompt: "聚焦 core 状态机",
		fakePlanner: fakePlanner{first: `{"intentMode":"thematic_slice","chapters":[
			{"name":"专题章","summary":"s","focusFiles":["core/a.go","ghost/nope.go","demo/core/b.go","core/a.go#Engine"]}
		]}`},
	}
	res, err := RunDrill(context.Background(), m, p, subModel{}, patterns, "zh-CN", "", 0)
	require.NoError(t, err)
	assert.True(t, res.Thematic, "DrillResult.Thematic 必须标注专题模式")
	require.Len(t, res.Chapters, 1)
	var got []string
	for _, f := range res.Chapters[0].Files {
		got = append(got, f.Path)
	}
	assert.Equal(t, []string{"core/a.go", "core/b.go"}, got, "焦点直出 = 求交后真实路径")
	assert.NotContains(t, got, "ghost/nope.go", "幻觉 focusFile 必须被预验证剔除")
	assert.Empty(t, res.DroppedPlan, "混合章（部分焦点有效）不整体弃章")
}

func TestRunDrillThematicSingleLargeRepoKeepsFocusAssembly(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "core/engine.go", LOC: 120, Exports: []string{"Engine"}, Hotness: 90},
		{Path: "core/state.go", LOC: 80, Exports: []string{"State"}, Hotness: 40},
	}
	for i := 0; i < 850; i++ {
		files = append(files, FileMap{Path: fmt.Sprintf("bulk/f%04d.go", i), LOC: 10})
	}
	m := &RepoMap{RepoName: "huge", Files: files}
	m.Tree = BuildRepoTree(files, "huge")
	require.Greater(t, m.Tree.FileCount, 800, "夹具必须越过 single 容量护栏")

	p := &fakeContextPlanner{
		customPrompt: "聚焦 core 引擎",
		fakePlanner: fakePlanner{first: `{"curriculumMode":"single","intentMode":"thematic_slice","chapters":[
			{"name":"引擎章","summary":"s","focusFiles":["core/engine.go","core/state.go","bulk/ghost.go"]}
		]}`},
	}
	res, err := RunDrill(context.Background(), m, p, subModel{}, patterns, "zh-CN", "", 0)
	require.NoError(t, err)
	assert.Equal(t, "single", res.CurriculumMode, "thematic+focusFiles 必须保持 single，绝不因 >800 覆写 matrix")
	assert.True(t, res.Thematic)
	require.Len(t, res.Chapters, 1)
	require.Len(t, res.Chapters[0].Files, 2, "章文件 = 求交后 focusFiles（bulk/ghost.go 幻觉剔除）")
	assert.Equal(t, "core/engine.go", res.Chapters[0].Files[0].Path)
	assert.Equal(t, "core/state.go", res.Chapters[0].Files[1].Path)
}

func TestRunDrillThematicNoReadmeHegemony(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "README.md", LOC: 300, IsDoc: true},
		{Path: "core/README.md", LOC: 200, IsDoc: true},
		{Path: "core/engine.go", LOC: 150, Exports: []string{"Engine"}, Hotness: 90},
	}
	for i := 0; i < 9; i++ {
		files = append(files, FileMap{
			Path:    fmt.Sprintf("core/impl_%02d.go", i),
			LOC:     100 + i,
			Exports: []string{fmt.Sprintf("Sym%d", i)},
			Hotness: 50 - i,
		})
	}
	m := &RepoMap{RepoName: "slice", Files: files}
	m.Tree = BuildRepoTree(files, "slice")

	p := &fakeContextPlanner{
		customPrompt: "聚焦 core 引擎实现",
		fakePlanner: fakePlanner{first: `{"intentMode":"thematic_slice","chapters":[
			{"name":"引擎章","summary":"s","targetPaths":["core"]}
		]}`},
	}
	res, err := RunDrill(context.Background(), m, p, subModel{}, patterns, "zh-CN", "", 0)
	require.NoError(t, err)
	require.NotEmpty(t, res.Chapters)
	require.NotEmpty(t, res.Chapters[0].Files)
	assert.Equal(t, "core/engine.go", res.Chapters[0].Files[0].Path,
		"thematic 评分首课时必须是高信噪比代码文件，绝不允许 README 霸占")
	for _, ch := range res.Chapters {
		for _, f := range ch.Files {
			assert.NotEqual(t, "core/README.md", f.Path, "低分专题外文档不得挤进单章预算")
			assert.NotEqual(t, "README.md", f.Path, "装甲 WithoutReadmeBackfill 后 README 不得保底回流")
		}
	}
}

func TestAttachCompanionsThematicSkipsDirectoryPass(t *testing.T) {
	files := []FileMap{
		{Path: "pkg/core/index.ts", LOC: 500, Exports: []string{"core"}},
		{Path: "pkg/core/helper.ts", LOC: 300},
	}
	m := &RepoMap{RepoName: "mono", Files: files}
	root := BuildRepoTree(files, "mono")
	subsystems := []SubsystemSpec{{Name: "core", Prefix: "pkg/core"}}
	chapters := []cognitive.OutlineChapter{
		{Files: []cognitive.ChapterFile{{Path: "pkg/core/index.ts"}}},
	}

	AttachSubtreeCompanionsWithMap(chapters, root, m, subsystems, false)
	assert.NotEmpty(t, companionPaths(chapters), "非 thematic 应保持 Pass 1 目录补位现状")

	chapters[0].Files[0].CompanionFiles = nil
	AttachSubtreeCompanionsWithMap(chapters, root, m, subsystems, true)
	assert.Empty(t, companionPaths(chapters), "thematic 无 AST 边的文件不得经 Pass 1 挂载")
}

func TestRunDrillScopedFocusFilesAndGlobSurvival(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "apps/README.md", LOC: 30, IsDoc: true},
		{Path: "apps/cli/src/entry.ts", LOC: 100, Exports: []string{"runCli"}, Hotness: 70},
		{Path: "apps/cli/src/args.ts", LOC: 60, Exports: []string{"parseArgs"}, Hotness: 40},
		{Path: "apps/examples/cli-agent/src/index.ts", LOC: 150, TopSymbols: []string{"runAgent", "dispatchTool"}, Hotness: 50},
		{Path: "apps/examples/multi-agent/src/index.ts", LOC: 180, TopSymbols: []string{"orchestrate", "routeMessage"}, Hotness: 60},
		{Path: "apps/examples/code-review/src/index.ts", LOC: 140, TopSymbols: []string{"reviewPr", "postComment"}, Hotness: 45},
		{Path: "apps/desktop/src/window.ts", LOC: 200, Exports: []string{"openWindow"}, Hotness: 20},
		{Path: "packages/core/src/core.ts", LOC: 300, Exports: []string{"Core"}, Hotness: 90},
	}
	full := &RepoMap{RepoName: "cline", Files: files}
	full.Tree = BuildRepoTree(files, "cline")
	scoped := scopeMapToPrefix(full, "apps/")

	p := &fakeContextPlanner{
		customPrompt: "围绕apps/examples/*/src/index.ts深入剖析Agent的底层设计、任务编排、工具调用与消息流转逻辑，并结合CLI入口说明启动链路",
		fakePlanner: fakePlanner{first: `{
			"curriculumMode":"matrix",
			"intentMode":"thematic_slice",
			"chapters":[
				{"moduleTitle":"模块 1: CLI 入口与启动链路","name":"第 1 章: CLI 命令解析与运行时初始化","summary":"CLI 入口链路","targetPaths":["apps/cli"],"phase":"入门"},
				{"moduleTitle":"模块 1: CLI 入口与启动链路","name":"第 2 章: CLI Agent 底层核心循环","summary":"Agent 底层抽象","targetPaths":[],"focusFiles":["apps/examples/cli-agent/src/index.ts"],"phase":"进阶"},
				{"moduleTitle":"模块 2: 多智能体编排与工具流转","name":"第 3 章: 多智能体任务编排与协作","summary":"多 Agent 编排","targetPaths":[],"focusFiles":["examples/multi-agent/src/index.ts"],"phase":"进阶"},
				{"moduleTitle":"模块 2: 多智能体编排与工具流转","name":"第 4 章: 工具调用与消息流转闭环","summary":"通配符入口聚合","targetPaths":[],"focusFiles":["apps/examples/*/src/index.ts"],"phase":"进阶"},
				{"moduleTitle":"模块 2: 多智能体编排与工具流转","name":"第 5 章: 代码审查机器人实战剖析","summary":"目录误填救援","targetPaths":[],"focusFiles":["apps/examples/code-review"],"phase":"实战"},
				{"moduleTitle":"模块 2: 多智能体编排与工具流转","name":"第 6 章: 符号级消息调度深潜","summary":"同文件按符号拆分保活","targetPaths":[],"focusFiles":["apps/examples/cli-agent/src/index.ts"],"phase":"实战"}
			]
		}`},
	}

	res, err := RunDrill(context.Background(), scoped, p, subModel{}, patterns, "zh-CN", "standard", 0)
	require.NoError(t, err)
	assert.True(t, res.Thematic)
	assert.Empty(t, res.DroppedPlan, "scoped focusFiles/glob/目录救援/同文件共享章均不应被静默丢弃")
	require.Len(t, res.Chapters, 6, "6 个规划章节必须全部存活")
	assert.Contains(t, p.skeletons[0], "用户点名路径与同包核心源码", "骨架应展开用户点名的通配符真实路径")
	assert.Contains(t, p.skeletons[0], "apps/examples/multi-agent/src/index.ts")
	assert.Contains(t, p.skeletons[0], "runAgent", "无导出入口脚本的 TopSymbols 应进入符号视角")
}

func TestRunDrillSharedSubtreeMultiChapterPartition(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "apps/examples/agent/orchestrator.ts", LOC: 120, Exports: []string{"Orchestrator", "scheduleTask"}, Hotness: 60},
		{Path: "apps/examples/agent/tools.ts", LOC: 110, Exports: []string{"ToolRegistry", "invokeTool"}, Hotness: 55},
		{Path: "apps/examples/agent/messages.ts", LOC: 100, Exports: []string{"MessageBus", "streamEvents"}, Hotness: 50},
	}
	m := &RepoMap{RepoName: "demo", Files: files}
	m.Tree = BuildRepoTree(files, "demo")

	p := &fakeContextPlanner{
		customPrompt: "从编排、工具、消息、异常恢复四方面拆解 apps/examples/agent",
		fakePlanner: fakePlanner{first: `{
			"curriculumMode":"matrix",
			"intentMode":"thematic_slice",
			"chapters":[
				{"moduleTitle":"模块 1: Agent 内核","name":"第 1 章: 任务编排 orchestrator","summary":"scheduleTask","targetPaths":["apps/examples/agent"],"phase":"进阶"},
				{"moduleTitle":"模块 1: Agent 内核","name":"第 2 章: 工具调用 tools","summary":"invokeTool","targetPaths":["apps/examples/agent"],"phase":"进阶"},
				{"moduleTitle":"模块 1: Agent 内核","name":"第 3 章: 消息流转 messages","summary":"streamEvents","targetPaths":["apps/examples/agent"],"phase":"进阶"},
				{"moduleTitle":"模块 1: Agent 内核","name":"第 4 章: 符号深潜扩展机制","summary":"按符号切分","targetPaths":["apps/examples/agent"],"phase":"实战"}
			]
		}`},
	}

	res, err := RunDrill(context.Background(), m, p, subModel{}, patterns, "zh-CN", "", 0)
	require.NoError(t, err)
	require.Len(t, res.Chapters, 4, "3 个文件拆出 4 章时不得因池耗尽丢掉第 4 章")
	for i, ch := range res.Chapters {
		assert.NotEmpty(t, ch.Files, "第 %d 章文件不能为空", i+1)
	}
	assert.Equal(t, "apps/examples/agent/orchestrator.ts", res.Chapters[0].Files[0].Path)
	assert.Equal(t, "apps/examples/agent/tools.ts", res.Chapters[1].Files[0].Path)
	assert.Equal(t, "apps/examples/agent/messages.ts", res.Chapters[2].Files[0].Path)
	assert.NotEmpty(t, res.Chapters[3].Files[0].Anchor, "第 4 章应通过 AST 符号锚点保留")
}

func TestPlanDegenerateThematicUnresolvableTriggersReplan(t *testing.T) {
	m := buildDrillRepo()
	p := &fakeContextPlanner{
		customPrompt: "聚焦 core 模块",
		fakePlanner: fakePlanner{
			first: `{"intentMode":"thematic_slice","chapters":[
				{"name":"第 1 章: 核心","summary":"s","focusFiles":["core/a.go"]},
				{"name":"第 2 章: 幻觉","summary":"s","focusFiles":["nonexistent/ghost.go"]}
			]}`,
			feedbackPlan: `{"intentMode":"thematic_slice","chapters":[
				{"name":"第 1 章: 核心","summary":"s","focusFiles":["core/a.go"]},
				{"name":"第 2 章: 扩展","summary":"s","focusFiles":["core/b.go"]}
			]}`,
		},
	}

	resp, replanned, diag, err := obtainPlan(context.Background(), p, m.Tree, "zh-CN", 3, 1)
	require.NoError(t, err)
	assert.True(t, replanned)
	assert.True(t, diag.PlanDegenerateTriggered)
	assert.True(t, diag.PlanDegenerateRecovered)
	require.Len(t, resp.Chapters, 2)
}

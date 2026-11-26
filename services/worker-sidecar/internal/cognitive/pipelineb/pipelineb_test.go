package pipelineb

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func loadPatterns(t *testing.T) cognitive.Patterns {
	t.Helper()
	return cognitive.DefaultPatterns()
}

func loadLangDefs(t *testing.T) *rsg.LanguageDefinitions {
	t.Helper()
	return rsg.DefaultLanguageDefinitions()
}

type fakeModel struct{ resp string }

func (f fakeModel) Complete(_ context.Context, _ ModelRequest) (string, error) {
	return f.resp, nil
}

const validResp = `{"chapters":[
  {"name":"第 1 章：起步","summary":"安装与基本用法","files":["readme.md","main.go"],"phase":"入门"},
  {"name":"第 2 章：核心实现","summary":"调度与执行","files":["runner.go","runner_test.go"],"phase":"实战"}
]}`

func TestRunValidOutlineKeepsRealPaths(t *testing.T) {
	patterns := loadPatterns(t)
	m := &RepoMap{
		RepoName: "demo",
		Files: []FileMap{
			{Path: "readme.md", LOC: 40, IsDoc: true},
			{Path: "main.go", LOC: 100, Exports: []string{"main"}},
			{Path: "runner.go", LOC: 200, Exports: []string{"Run"}, Hotness: 7},
			{Path: "runner_test.go", LOC: 80, IsTest: true},
		},
	}
	res, err := Run(context.Background(), m, fakeModel{validResp}, patterns, "zh-CN")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.Chapters) == 0 {
		t.Fatal("章节为空")
	}
	joined := strings.Join(res.DroppedPaths, ",")
	if !strings.Contains(joined, "runner_test.go") {
		t.Errorf("测试文件应被装甲剔除: %v", res.DroppedPaths)
	}
	if len(res.Chapters) != 2 {
		t.Fatalf("章数 %d ≠ 2", len(res.Chapters))
	}
}

func TestRunHallucinatedPathsCutByArmor(t *testing.T) {
	patterns := loadPatterns(t)
	m := &RepoMap{RepoName: "demo", Files: []FileMap{{Path: "main.go", LOC: 10}}}
	resp := `{"chapters":[{"name":"第 1 章","summary":"s","files":["main.go","ghost/nope.go"],"phase":"入门"}]}`
	res, err := Run(context.Background(), m, fakeModel{resp}, patterns, "zh-CN")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	joined := strings.Join(res.DroppedPaths, ",")
	if !strings.Contains(joined, "ghost/nope.go") {
		t.Errorf("幻觉路径未被装甲砍除: dropped=%v", res.DroppedPaths)
	}
	found := false
	for _, f := range res.Chapters[0].Files {
		if f.Path == "main.go" {
			found = true
		}
	}
	if !found {
		t.Error("真实路径不应被误砍")
	}
}

func TestParseOutlineJSON(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    int
		wantErr bool
	}{
		{name: "裸 JSON", raw: validResp, want: 2},
		{name: "markdown 围栏包裹", raw: "```json\n" + validResp + "\n```", want: 2},
		{name: "前后噪声包裹", raw: "好的，以下是大纲：\n" + validResp + "\n希望有帮助", want: 2},
		{name: "畸形 JSON", raw: `{"chapters":[{broken`, wantErr: true},
		{name: "零章", raw: `{"chapters":[]}`, wantErr: true},
		{name: "全章无效（空名）", raw: `{"chapters":[{"name":"","summary":"s","files":["a"]}]}`, wantErr: true},
		{name: "无 files 章", raw: `{"chapters":[{"name":"n","summary":"s","files":[]}]}`, wantErr: true},
		{name: "单章无效不毁整纲", raw: `{"chapters":[{"name":"","summary":"","files":[]},{"name":"好章","summary":"s","files":["a.go"]}]}`, want: 1},
		{name: "modules 字段别名", raw: `{"modules":[{"title":"模块 1","description":"desc","paths":["pkg/a.go"]}]}`, want: 1},
		{name: "tableOfContents 字段别名", raw: `{"tableOfContents":[{"name":"TOC 1","summary":"desc","files":["b.go"]}]}`, want: 1},
		{name: "sections 字段别名", raw: `{"sections":[{"name":"Section 1","summary":"desc","files":["c.go"]}]}`, want: 1},
		{name: "嵌套在 data.plan 中", raw: `{"data":{"plan":{"chapters":[{"name":"Ch 1","summary":"desc","files":["d.go"]}]}}}`, want: 1},
		{name: "带有 think 思考标签与围栏", raw: "<think>思考过程</think>\n```json\n" + validResp + "\n```", want: 2},
		{name: "带有 think 内部包含花括号的思考标签", raw: "<think>思考中考虑数据结构: {\"temp\": 123}</think>\n```json\n" + validResp + "\n```", want: 2},
		{name: "顶层 JSON 数组形态", raw: `[{"name":"章节 1","summary":"desc 1","files":["a.go"]},{"name":"章节 2","summary":"desc 2","files":["b.go"]}]`, want: 2},
		{name: "前后寒暄包裹的 JSON 数组", raw: "这是大纲列表：\n```json\n[{\"name\":\"章节 1\",\"summary\":\"desc 1\",\"files\":[\"a.go\"]}]\n```\n希望满足要求", want: 1},
		{name: "无 JSON 对象", raw: "我无法完成该任务", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chs, err := ParseOutlineJSON(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("期望错误，得到 %d 章", len(chs))
				}
				return
			}
			if err != nil {
				t.Fatalf("意外错误: %v", err)
			}
			if len(chs) != tt.want {
				t.Fatalf("章数 %d ≠ %d", len(chs), tt.want)
			}
		})
	}
}

func TestFilterChaptersByRepoMap(t *testing.T) {
	m := &RepoMap{
		RepoName: "demo",
		Files: []FileMap{
			{Path: "src/real.go"},
			{Path: "src/kept.go"},
		},
	}

	chapters := []cognitive.OutlineChapter{
		{
			Name:    "Chapter 1",
			Summary: "Mixed paths",
			Files: []cognitive.ChapterFile{
				{Path: "src/real.go"},
				{Path: "src/hallucinated.go"},
			},
		},
		{
			Name:    "Chapter 2",
			Summary: "All hallucinated",
			Files: []cognitive.ChapterFile{
				{Path: "src/ghost1.go"},
				{Path: "src/ghost2.go"},
			},
		},
	}

	filtered, dropped := FilterChaptersByRepoMap(chapters, m)

	if len(filtered) != 1 {
		t.Fatalf("期望 1 章保留，实际得到 %d 章", len(filtered))
	}
	if len(filtered[0].Files) != 1 || filtered[0].Files[0].Path != "src/real.go" {
		t.Fatalf("期望仅保留 src/real.go，实际得到 %+v", filtered[0].Files)
	}
	if len(dropped) != 3 {
		t.Fatalf("期望剔除 3 个幻觉路径，实际剔除 %d: %v", len(dropped), dropped)
	}
}

func TestBuildRepoMapOnSyntheticRepo(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)
	dir := t.TempDir()
	files := map[string]string{
		"README.md":   "# Demo\nhello demo tool\n" + strings.Repeat("text\n", 30),
		"main.go":     "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(Run(1))\n}\n",
		"run.go":      "package main\n\n// Run adds one.\nfunc Run(x int) int {\n\treturn x + 1\n}\n",
		"run_test.go": "package main\n\nimport \"testing\"\n\nfunc TestRun(t *testing.T) {\n\tif Run(1) != 2 {\n\t\tt.Fatal()\n\t}\n}\n",
		"logo.png":    "\x89PNG binary",
	}
	for p, c := range files {
		full := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m, err := BuildRepoMap(dir, "demo", defs, patterns)
	if err != nil {
		t.Fatalf("BuildRepoMap: %v", err)
	}
	byPath := map[string]FileMap{}
	for _, f := range m.Files {
		byPath[f.Path] = f
	}
	if _, ok := byPath["logo.png"]; ok {
		t.Error("二进制文件不应入表")
	}
	if _, ok := byPath["main.go"]; !ok {
		t.Fatalf("main.go 缺失: %v", m.Files)
	}
	run, ok := byPath["run.go"]
	if !ok {
		t.Fatal("run.go 缺失")
	}
	foundRun := false
	for _, e := range run.Exports {
		if e == "Run" {
			foundRun = true
		}
	}
	if !foundRun {
		t.Errorf("run.go 导出符号 Run 未提取: %v", run.Exports)
	}
	if run.Hotness < 1 {
		t.Errorf("Run 被 main.go 调用，热度应 ≥1: %d", run.Hotness)
	}
}

func TestRenderMapTopologicalGrouping(t *testing.T) {
	m := &RepoMap{
		RepoName: "test-repo",
		TotalLOC: 300,
		Files: []FileMap{
			{Path: "cmd/main.go", LOC: 50, Layer: LayerInterface, Hotness: 0},
			{Path: "engine/service.go", LOC: 150, Layer: LayerPipeline, Hotness: 30},
			{Path: "models/user.go", LOC: 100, Layer: LayerFoundation, Hotness: 80},
		},
	}
	rendered := RenderMap(m)

	idxLayer0 := strings.Index(rendered, "Layer 0")
	idxLayer1 := strings.Index(rendered, "Layer 1")
	idxLayer2 := strings.Index(rendered, "Layer 2")

	if idxLayer0 < 0 || idxLayer1 < 0 || idxLayer2 < 0 {
		t.Fatalf("RenderMap 应包含 Layer 0, Layer 1, Layer 2 标题: %s", rendered)
	}

	if !(idxLayer0 < idxLayer1 && idxLayer1 < idxLayer2) {
		t.Fatalf("RenderMap 顺序应为 Layer 0 < Layer 1 < Layer 2, got idx0=%d, idx1=%d, idx2=%d",
			idxLayer0, idxLayer1, idxLayer2)
	}

	idxUser := strings.Index(rendered, "models/user.go")
	idxService := strings.Index(rendered, "engine/service.go")
	idxMain := strings.Index(rendered, "cmd/main.go")

	if !(idxLayer0 < idxUser && idxUser < idxLayer1) {
		t.Errorf("models/user.go 应该在 Layer 0 区块内")
	}
	if !(idxLayer1 < idxService && idxService < idxLayer2) {
		t.Errorf("engine/service.go 应该在 Layer 1 区块内")
	}
	if !(idxLayer2 < idxMain) {
		t.Errorf("cmd/main.go 应该在 Layer 2 区块内")
	}
}

func TestBuildRepoMapMicroRepoDetectionAndAnchors(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)
	dir := t.TempDir()

	readmeContent := `# Mitt
## Quick Start
Get up and running.
## Usage
import mitt from 'mitt'
## API
### mitt
Creates an event emitter.
`
	srcContent := `export type EventType = string | symbol;
export interface Emitter<Events extends Record<EventType, unknown>> {
	all: Map<any, any>;
	on(type: any, handler: any): void;
}
export default function mitt() {
	return {
		all: new Map(),
		on(type: any, handler: any) {},
		emit(type: any, event: any) {}
	};
}
`
	testContent := `import mitt from '../src';
describe('mitt', () => {
	it('should register handler with on', () => {
		const inst = mitt();
	});
});
`
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "test"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(readmeContent), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "src", "index.ts"), []byte(srcContent), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "test", "index.test.ts"), []byte(testContent), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"mitt"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	m, err := BuildRepoMap(dir, "mitt", defs, patterns)
	if err != nil {
		t.Fatalf("BuildRepoMap: %v", err)
	}

	if !m.IsMicroRepo {
		t.Fatal("期望自动识别为微型仓 IsMicroRepo = true")
	}
	if len(m.Anchors) == 0 {
		t.Fatal("期望提取出微型仓细粒度锚点，但 Anchors 为空")
	}

	hasFunc := false
	hasSpec := false
	hasHeading := false
	for _, a := range m.Anchors {
		if a.Path == "src/index.ts" && a.Kind == "function" {
			hasFunc = true
		}
		if a.Path == "test/index.test.ts" && a.Kind == "spec" {
			hasSpec = true
		}
		if a.Path == "README.md" && a.Kind == "heading" {
			hasHeading = true
		}
	}
	if !hasFunc {
		t.Errorf("微型仓锚点缺少 src/index.ts 的函数符号: %v", m.Anchors)
	}
	if !hasSpec {
		t.Errorf("微型仓锚点缺少 test/index.test.ts 的测试规格: %v", m.Anchors)
	}
	if !hasHeading {
		t.Errorf("微型仓锚点缺少 README.md 的标题锚点: %v", m.Anchors)
	}

	rendered := RenderMap(m)
	if !strings.Contains(rendered, "micro-repo mode: fine-grained anchors enabled") {
		t.Errorf("RenderMap 缺少微型仓模式标头: %s", rendered)
	}
	if !strings.Contains(rendered, "src/index.ts#") {
		t.Errorf("RenderMap 应该包含 src/index.ts 细粒度符号锚点: %s", rendered)
	}
	if !strings.Contains(rendered, "test/index.test.ts#") {
		t.Errorf("RenderMap 应该包含 test/index.test.ts 活体规格锚点: %s", rendered)
	}
	if !strings.Contains(rendered, "compact-core") {
		t.Errorf("RenderMap 紧凑微型文件应标记 compact-core: %s", rendered)
	}
	if !strings.Contains(rendered, "micro-component") {
		t.Errorf("RenderMap 小于等于 30 行的代码符号应标记 micro-component: %s", rendered)
	}
}

func TestRunMicroRepoOutlineWithAnchors(t *testing.T) {
	patterns := loadPatterns(t)
	m := &RepoMap{
		RepoName:    "mitt",
		IsMicroRepo: true,
		Files: []FileMap{
			{Path: "README.md", LOC: 30, IsDoc: true},
			{Path: "src/index.ts", LOC: 50, Exports: []string{"mitt"}},
			{Path: "test/index.test.ts", LOC: 40, IsTest: true},
		},
		Anchors: []cognitive.CandidateOutlineFile{
			{Path: "README.md", Anchor: "Usage", Kind: "heading", IsDoc: true},
			{Path: "src/index.ts", Anchor: "EventType", Kind: "type"},
			{Path: "src/index.ts", Anchor: "mitt", Kind: "function"},
			{Path: "test/index.test.ts", Anchor: "should register handler with on", Kind: "spec"},
		},
	}

	modelResp := `{"chapters":[
		{"name":"第 1 章：起步与安装","summary":"使用指南","files":["README.md#Usage"],"phase":"入门"},
		{"name":"第 2 章：类型系统","summary":"事件类型定义","files":["src/index.ts#EventType"],"phase":"进阶"},
		{"name":"第 3 章：核心实现","summary":"主分发器","files":["src/index.ts#mitt"],"phase":"实战"},
		{"name":"第 4 章：行为规格验证","summary":"单元测试验证","files":["test/index.test.ts#should register handler with on"],"phase":"实战"},
		{"name":"第 5 章：幻觉符号测试","summary":"测试编造符号","files":["src/index.ts#ghost_func"],"phase":"进阶"}
	]}`

	res, err := Run(context.Background(), m, fakeModel{modelResp}, patterns, "zh-CN")
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	if len(res.Chapters) < 4 {
		t.Fatalf("期望保留有效章节 >= 4，实际得到 %d 章", len(res.Chapters))
	}

	foundSpec := false
	for _, ch := range res.Chapters {
		for _, f := range ch.Files {
			if f.Path == "test/index.test.ts" {
				foundSpec = true
				if f.Anchor != "should register handler with on" {
					t.Errorf("测试规格锚点未正确对齐: got %s", f.Anchor)
				}
			}
		}
	}
	if !foundSpec {
		t.Errorf("带 spec 锚点的测试文件应被装甲放行，但未找到: chapters=%v, dropped=%v", res.Chapters, res.DroppedPaths)
	}

	for _, ch := range res.Chapters {
		if ch.Name == "第 5 章：幻觉符号测试" {
			for _, f := range ch.Files {
				if f.Anchor == "ghost_func" {
					t.Errorf("不存在的幻觉符号 ghost_func 不应被保留为 anchor: %v", f)
				}
			}
		}
	}
}

func TestDrillMicroRepoDegeneracyAdaption(t *testing.T) {
	root := &RepoTreeNode{
		Path:      "",
		Name:      "micro",
		FileCount: 2,
		Files: []FileMap{
			{Path: "README.md", LOC: 20, IsDoc: true},
			{Path: "src/index.ts", LOC: 80},
		},
	}

	plan := []PlanChapter{
		{Name: "第 1 章：起步", TargetPaths: []string{"micro"}},
		{Name: "第 2 章：实现", TargetPaths: []string{"src/index.ts"}},
	}

	if planDegenerate(plan, root, false) {
		t.Error("微型仓（FileCount <= 3）2 章规划不应判定为退化")
	}

	p := &fakePlanner{
		first: `{"chapters":[{"name":"第 1 章：起步","summary":"s","targetPaths":["micro"],"phase":"入门"}]}`,
		feedbackPlan: `{"chapters":[
			{"name":"第 1 章：起步","summary":"s","targetPaths":["micro"],"phase":"入门"},
			{"name":"第 2 章：实现","summary":"s","targetPaths":["src/index.ts"],"phase":"实战"}
		]}`,
	}
	resp, replanned, _, err := obtainPlan(context.Background(), p, root, "zh-CN", 3, 1)
	if err != nil {
		t.Fatalf("反馈重规划应救回微型仓规划: %v", err)
	}
	if len(resp.Chapters) != 2 || !replanned {
		t.Fatalf("应采用反馈重规划结果: chapters=%d replanned=%v", len(resp.Chapters), replanned)
	}

	p2 := &fakePlanner{first: `{"chapters":[{"name":"孤章","summary":"s","targetPaths":["micro"],"phase":"入门"}]}`}
	if _, _, _, err := obtainPlan(context.Background(), p2, root, "zh-CN", 3, 1); err == nil {
		t.Fatal("持续退化规划应 fail-closed 报错,而非模板兜底")
	}
}

func TestBuildScopedRepoMap_TableDriven(t *testing.T) {
	patterns := loadPatterns(t)
	defs := loadLangDefs(t)
	tmp := t.TempDir()

	filesToCreate := map[string]string{
		"packages/core/src/index.ts": "export function core() { return 1; }",
		"packages/core/src/utils.ts": "export function util() { return 2; }",
		"packages/cli/src/main.ts":   "import { core } from '../core';\nexport function run() {}",
		"README.md":                  "# Monorepo Root Documentation",
	}

	for p, content := range filesToCreate {
		full := filepath.Join(tmp, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	tests := []struct {
		name        string
		scope       string
		wantCount   int
		mustHave    []string
		mustNotHave []string
	}{
		{
			name:        "scoped to packages/core isolates to core only",
			scope:       "packages/core",
			wantCount:   2,
			mustHave:    []string{"packages/core/src/index.ts", "packages/core/src/utils.ts"},
			mustNotHave: []string{"packages/cli/src/main.ts", "README.md"},
		},
		{
			name:        "scoped to packages/cli isolates to cli only",
			scope:       "packages/cli",
			wantCount:   1,
			mustHave:    []string{"packages/cli/src/main.ts"},
			mustNotHave: []string{"packages/core/src/index.ts", "README.md"},
		},
		{
			name:        "empty scope includes all content files",
			scope:       "",
			wantCount:   4,
			mustHave:    []string{"packages/core/src/index.ts", "packages/cli/src/main.ts", "README.md"},
			mustNotHave: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, err := BuildScopedRepoMap(tmp, "test-monorepo", tt.scope, defs, patterns)
			if err != nil {
				t.Fatalf("BuildScopedRepoMap failed: %v", err)
			}
			if len(m.Files) != tt.wantCount {
				t.Errorf("expected %d files, got %d", tt.wantCount, len(m.Files))
			}
			paths := map[string]bool{}
			for _, f := range m.Files {
				paths[f.Path] = true
			}
			for _, h := range tt.mustHave {
				if !paths[h] {
					t.Errorf("expected file %s to be present", h)
				}
			}
			for _, nh := range tt.mustNotHave {
				if paths[nh] {
					t.Errorf("expected file %s to be excluded", nh)
				}
			}
		})
	}
}

func TestWalkContentFilesMaxDepth(t *testing.T) {
	patterns := loadPatterns(t)
	tmp := t.TempDir()

	deepSegments := []string{
		"d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8",
		"d9", "d10", "d11", "d12", "d13", "d14", "d15", "d16", "d17", "d18",
	}
	deepPath := filepath.Join(append([]string{tmp}, append(deepSegments, "deep.ts")...)...)
	if err := os.MkdirAll(filepath.Dir(deepPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(deepPath, []byte("export const deep = true;"), 0o644); err != nil {
		t.Fatal(err)
	}

	shallowPath := filepath.Join(tmp, "src", "shallow.ts")
	if err := os.MkdirAll(filepath.Dir(shallowPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shallowPath, []byte("export const shallow = true;"), 0o644); err != nil {
		t.Fatal(err)
	}

	walked, err := walkContentFiles(tmp, patterns)
	if err != nil {
		t.Fatalf("walkContentFiles failed: %v", err)
	}

	hasShallow := false
	hasDeep := false
	for _, f := range walked {
		if strings.Contains(f.rel, "shallow.ts") {
			hasShallow = true
		}
		if strings.Contains(f.rel, "deep.ts") {
			hasDeep = true
		}
	}

	if !hasShallow {
		t.Errorf("expected shallow file to be found")
	}
	if hasDeep {
		t.Errorf("expected deep file (>16 levels) to be cut off by maxDirectoryDepth guard")
	}
}

func TestRunPipelineB_Layer1Salvage(t *testing.T) {
	patterns := loadPatterns(t)
	m := &RepoMap{
		RepoName: "demo",
		Files: []FileMap{
			{Path: "main.go", LOC: 100, Exports: []string{"main"}},
			{Path: "runner.go", LOC: 200, Exports: []string{"Run"}},
		},
	}
	truncatedResp := `{"chapters":[
		{"name":"第 1 章：系统入口与门面调度","summary":"系统入口契约","files":["main.go"],"phase":"入门"},
		{"name":"第 2 章：执行引擎管道","summary":"核心运行逻辑","files":["runner.go"],"phase":"进阶"},
		{"name":"第 3 章：截断未完章","summary":"这里被切断`

	res, err := Run(context.Background(), m, fakeModel{truncatedResp}, patterns, "zh-CN")
	require.NoError(t, err, "Layer 1 抢救器应成功提取前 2 章完整章节")
	require.NotNil(t, res)
	assert.Len(t, res.Chapters, 2)
	assert.Equal(t, "第 1 章：系统入口与门面调度", res.Chapters[0].Name)
	assert.Equal(t, "第 2 章：执行引擎管道", res.Chapters[1].Name)
}

type continuationMockModel struct {
	firstCallDone bool
}

func (c *continuationMockModel) Complete(_ context.Context, req ModelRequest) (string, error) {
	if !c.firstCallDone {
		c.firstCallDone = true
		partial := `{"chapters":[{"name":"第 1 章：入口","summary":"主入口","files":["main.go"],"phase":"入门"}`
		return partial, client.ErrStreamPartial
	}
	if !strings.Contains(req.ContinuationPrompt, "第 1 章：入口") {
		return "", errors.New("missing continuation context in prompt")
	}
	cont := `[{"name":"第 2 章：引擎执行","summary":"运行循环","files":["runner.go"],"phase":"实战"}]`
	return cont, nil
}

func TestRunPipelineB_Layer2Continuation(t *testing.T) {
	patterns := loadPatterns(t)
	m := &RepoMap{
		RepoName: "demo",
		Files: []FileMap{
			{Path: "main.go", LOC: 100},
			{Path: "runner.go", LOC: 200},
		},
	}

	model := &continuationMockModel{}
	res, err := Run(context.Background(), m, model, patterns, "zh-CN")
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Len(t, res.Chapters, 2)
	assert.Equal(t, "第 1 章：入口", res.Chapters[0].Name)
	assert.Equal(t, "第 2 章：引擎执行", res.Chapters[1].Name)
}

func TestRunPipelineB_HallucinationArmorFailClosed(t *testing.T) {
	patterns := loadPatterns(t)
	m := &RepoMap{
		RepoName: "demo",
		Files: []FileMap{
			{Path: "main.go", LOC: 100},
		},
	}
	ghostResp := `{"chapters":[{"name":"第 1 章","summary":"s","files":["ghost/phantom.go"],"phase":"入门"}]}`
	res, err := Run(context.Background(), m, fakeModel{ghostResp}, patterns, "zh-CN")
	require.Error(t, err, "全幻觉路径应触发失效封闭")
	assert.Nil(t, res)
	assert.Contains(t, err.Error(), "hallucination armor rejected all candidate paths")
}

type mapCaptureGateway struct {
	purpose   string
	variables map[string]any
	resp      string
}

func (c *mapCaptureGateway) Complete(_ context.Context, purpose string, variables map[string]any, _ *string) (client.LlmTextResult, error) {
	c.purpose = purpose
	c.variables = variables
	return client.LlmTextResult{Text: c.resp}, nil
}

func (c *mapCaptureGateway) Generate(_ context.Context, purpose string, variables map[string]any, _ *string, out any) error {
	c.purpose = purpose
	c.variables = variables
	*out.(*map[string]any) = map[string]any{}
	return nil
}

func TestRunGatewayMultiScaleMapWiring(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "packages/reactivity/src/index.ts", LOC: 60, Exports: []string{"reactive", "effect"}, Layer: LayerInterface},
		{Path: "packages/reactivity/src/effect.ts", LOC: 320, Exports: []string{"track", "trigger"}, Hotness: 85, Layer: LayerPipeline},
		{Path: "packages/reactivity/src/deps.ts", LOC: 140, Exports: []string{"Dep"}, Layer: LayerFoundation},
		{Path: "packages/runtime-core/src/index.ts", LOC: 70, Exports: []string{"createApp"}, Layer: LayerInterface},
		{Path: "packages/runtime-core/src/vdom.ts", LOC: 500, Exports: []string{"render", "patch"}, Hotness: 95, Layer: LayerPipeline},
	}
	m := &RepoMap{RepoName: "wiring-demo", Files: files}
	for _, f := range files {
		m.TotalLOC += f.LOC
	}
	m.Tree = BuildRepoTree(m.Files, m.RepoName)

	gw := &mapCaptureGateway{resp: `{"chapters":[{"name":"第 1 章：响应式引擎","summary":"s","files":["packages/reactivity/src/effect.ts"],"phase":"入门"}]}`}
	gm := &GatewayModel{Client: gw, TeachingDepth: "deep"}

	res, err := Run(context.Background(), m, gm, patterns, "zh-CN")
	require.NoError(t, err)
	require.NotNil(t, res)
	assert.Equal(t, OutlinePurpose, gw.purpose, "LLM 路径必须仍走 outline_map_v1 purpose")

	mapText, ok := gw.variables["map"].(string)
	require.True(t, ok, "vars[\"map\"] 应为字符串地图文本")
	assert.Contains(t, mapText, "Subsystem Topology", "map 应为多尺度子系统地图头部")
	assert.Contains(t, mapText, "[子系统全景]")
	assert.Contains(t, mapText, "reactivity", "全景行必须含子系统名 reactivity")
	assert.Contains(t, mapText, "runtime-core", "全景行必须含子系统名 runtime-core")
	assert.Contains(t, mapText, "packages/reactivity/src/effect.ts", "锚点行必须含高热核心文件")

	assert.Equal(t, true, gw.variables["skipMetaCompiler"])
	assert.Equal(t, "deep", gw.variables["teachingDepth"])
}

func TestRunPromptTokEstimatesActualLlmInput_TableDriven(t *testing.T) {
	patterns := loadPatterns(t)
	files := []FileMap{
		{Path: "packages/reactivity/src/index.ts", LOC: 60, Exports: []string{"reactive", "effect"}, Layer: LayerInterface},
		{Path: "packages/reactivity/src/effect.ts", LOC: 320, Exports: []string{"track", "trigger"}, Hotness: 85, Layer: LayerPipeline},
		{Path: "packages/reactivity/src/deps.ts", LOC: 140, Exports: []string{"Dep"}, Hotness: 42, Layer: LayerFoundation},
		{Path: "packages/reactivity/src/ref.ts", LOC: 260, Exports: []string{"ref", "unref"}, Hotness: 51, Layer: LayerPipeline},
		{Path: "packages/reactivity/src/computed.ts", LOC: 180, Exports: []string{"computed"}, Hotness: 33, Layer: LayerPipeline},
		{Path: "packages/runtime-core/src/index.ts", LOC: 70, Exports: []string{"createApp"}, Layer: LayerInterface},
		{Path: "packages/runtime-core/src/vdom.ts", LOC: 500, Exports: []string{"render", "patch"}, Hotness: 95, Layer: LayerPipeline},
		{Path: "packages/runtime-core/src/h.ts", LOC: 210, Exports: []string{"h"}, Hotness: 66, Layer: LayerFoundation},
		{Path: "packages/runtime-core/src/component.ts", LOC: 380, Exports: []string{"defineComponent"}, Hotness: 74, Layer: LayerPipeline},
		{Path: "packages/runtime-core/src/scheduler.ts", LOC: 240, Exports: []string{"queueJob"}, Hotness: 58, Layer: LayerPipeline},
		{Path: "packages/runtime-core/src/patchProps.ts", LOC: 190, Exports: []string{"patchProps"}, Hotness: 29, Layer: LayerFoundation},
		{Path: "packages/runtime-core/src/apiCreateApp.ts", LOC: 160, Exports: []string{"createAppAPI"}, Hotness: 21, Layer: LayerInterface},
	}
	m := &RepoMap{RepoName: "tok-demo", Files: files}
	for _, f := range files {
		m.TotalLOC += f.LOC
	}
	m.Tree = BuildRepoTree(m.Files, m.RepoName)

	archEst := mdpat.EstimateTokens(RenderArchModel(BuildArchitecturalModel(m, patterns)))
	subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	topo := BuildMacroTopology(m, outlineMapScope, outlineMapScale, patterns)
	multiEst := func(depth string) int {
		return mdpat.EstimateTokens(RenderMultiScaleMap(m, subsystems, topo, depth, MultiScaleMapMaxTokens))
	}

	validChapter := `{"chapters":[{"name":"第 1 章：响应式引擎","summary":"s","files":["packages/reactivity/src/effect.ts"],"phase":"入门"}]}`

	tests := []struct {
		name       string
		model      OutlineModel
		wantTokens int
	}{
		{
			name:       "GatewayModel（teachingContextAware）按多尺度图估算",
			model:      &GatewayModel{Client: &mapCaptureGateway{resp: validChapter}, TeachingDepth: TeachingDepthDeep},
			wantTokens: multiEst(TeachingDepthDeep),
		},
		{
			name:       "非 aware 模型缺省 standard 深度",
			model:      fakeModel{resp: validChapter},
			wantTokens: multiEst(TeachingDepthStandard),
		},
		{
			name:       "确定性路径（model == nil）保留 arch 基线",
			model:      nil,
			wantTokens: archEst,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := Run(context.Background(), m, tt.model, patterns, "zh-CN")
			require.NoError(t, err)
			assert.Equal(t, tt.wantTokens, res.EstPromptTok, "EstPromptTok 必须按 LLM 实际收到的输入估算")
		})
	}

	assert.Greater(t, multiEst(TeachingDepthDeep), archEst,
		"多尺度子系统地图（LLM 实际输入）token 估算必须明显大于 arch 投影基线")
}

// pbtool：B 管线（LLM 当作者、AST 当目录）对拍 harness。
//
// 用法：
//
//	go run ./cmd/pbtool -repo /tmp/go-cmp -name go-cmp -mode fake   # 无网络冒烟
//	LLM_GATEWAY_URL=http://localhost:3000 INTERNAL_API_TOKEN=.. \
//	  go run ./cmd/pbtool -repo /tmp/demo -mode real                # 走网关(生产同路径)
//
// real 模式经 LLM 网关 purpose（outline_map_v1/outline_plan_v1）调用——
// prompt SSOT 在 registry.ts compile，本工具零 prompt 拼装；实验期直连
// DashScope 已随双源收敛删除。输出：JSON 报告（仓库统计 / 目录表 token /
// A 管线基线 / B 管线章节与装甲砍除）。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

func main() {
	repo := flag.String("repo", "", "本地仓库目录（单仓模式必填）")
	name := flag.String("name", "repo", "仓库名")
	mode := flag.String("mode", "fake", "fake | real")
	lang := flag.String("lang", "zh-CN", "目标语言")
	userID := flag.String("user-id", "", "BYOK 归属用户（real 模式必填；网关 keyOrigin=user fail-closed 契约，亦可经 PBTOOL_USER_ID 环境变量注入）")
	skeleton := flag.Bool("skeleton", false, "只打印顶级骨架图(不下模型)")
	depth2 := flag.Bool("depth2", false, "深度 2 下钻(规划→并行子树→汇编)")
	batch := flag.String("batch", "", "批量跑批清单 <manifest.json>（Phase 1.1 离线长尾压测）")
	genFixture := flag.String("gen-fixture", "", "合成 fixture 收敛漏斗 <draft.json>（Phase 1.2：校验通过的拓扑输出到 stdout）")
	flag.Parse()

	// -user-id 缺省回读环境变量（CI 批跑注入面）
	if *userID == "" {
		*userID = os.Getenv("PBTOOL_USER_ID")
	}

	// 早退分支置于 -repo 必填校验之前：batch/fixture 模式各自独立成径
	if *genFixture != "" {
		genFixtureFile(*genFixture)
		return
	}
	if *batch != "" {
		runBatch(*batch, *lang, *userID)
		return
	}
	if *repo == "" {
		fmt.Fprintln(os.Stderr, "usage: pbtool -repo <dir> [-name] [-mode fake|real] | -batch <manifest.json> | -gen-fixture <draft.json>")
		os.Exit(2)
	}

	patterns := ingest.DefaultPatterns()
	defs := rsg.DefaultLanguageDefinitions()

	abs, err := filepath.Abs(*repo)
	fatalIf(err)
	m, err := pipelineb.BuildRepoMap(abs, *name, defs, patterns)
	fatalIf(err)

	// A 管线基线（免费启发式）
	nodes := make([]cluster.GitNode, 0, len(m.Files))
	for _, f := range m.Files {
		nodes = append(nodes, cluster.GitNode{Path: f.Path, Type: "blob", Size: int64(f.LOC)})
	}
	a := cognitive.BuildRuleFallbackOutline(nodes, "", *lang, patterns)

	if *skeleton {
		fmt.Print(pipelineb.RenderSkeleton(m.Tree))
		return
	}

	// 深度 2:规划者(real=网关 outline_plan_v1;fake=确定性桩)+ 子树模型
	if *depth2 {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
		defer cancel()
		runDepth2(ctx, m, *mode, *lang, *userID, patterns)
		return
	}

	var modelRunner pipelineb.OutlineModel
	switch *mode {
	case "fake":
		modelRunner = fakeFromMap(m)
	case "real":
		uid := requireUserID(*userID)
		modelRunner = &pipelineb.GatewayModel{Client: newGatewayClient(), UserID: &uid}
	default:
		fmt.Fprintln(os.Stderr, "mode 必须是 fake|real")
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()
	b, err := pipelineb.Run(ctx, m, modelRunner, patterns, *lang)
	bStatus := "ok"
	if err != nil {
		bStatus = "error: " + err.Error()
	}

	report := map[string]any{
		"repo":            *name,
		"mode":            *mode,
		"model":           modelLabel(*mode),
		"files":           len(m.Files),
		"totalLoc":        m.TotalLOC,
		"mapEstTokens":    m.EstTokens,
		"mapTruncated":    m.Truncated,
		"pipelineA":       a,
		"pipelineBStatus": bStatus,
	}
	if b != nil {
		report["pipelineB"] = map[string]any{
			"chapters":      b.Chapters,
			"droppedPaths":  b.DroppedPaths,
			"promptTokens":  b.EstPromptTok,
			"modelRawChars": b.ModelRawLen,
			"durationMs":    b.Duration.Milliseconds(),
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(report)
}

// ── 模型实现 ────────────────────────────────────────────────

// newGatewayClient real 模式网关客户端（LLM_GATEWAY_URL/INTERNAL_API_TOKEN
// 未配置时快败——对应灰测"无配置快败"闸门）。
func newGatewayClient() *client.LlmGatewayClient {
	url := os.Getenv("LLM_GATEWAY_URL")
	token := os.Getenv("INTERNAL_API_TOKEN")
	if url == "" || token == "" {
		fmt.Fprintln(os.Stderr, "real 模式需要 LLM_GATEWAY_URL + INTERNAL_API_TOKEN（网关 purpose 路径）")
		os.Exit(2)
	}
	return client.NewLlmGatewayClient(url, token)
}

// requireUserID real 模式 BYOK 归属用户快败闸门：网关 19 个 purpose 均为
// keyOrigin='user'，userId 缺失会在首帧被 fail-closed 拒绝（2026-11 A 类收口）——
// 与其让整批仓跑成 MISSING_API_KEY 再写满 checkpoint，不如起跑前显式拦截。
func requireUserID(userID string) string {
	if userID == "" {
		fmt.Fprintln(os.Stderr, "real 模式需要 -user-id <userId>（或 PBTOOL_USER_ID 环境变量）——网关 BYOK fail-closed 契约")
		os.Exit(2)
	}
	return userID
}

// modelLabel 报告用模型标注：网关路由的模型由 web 侧决定，此处只记通道。
func modelLabel(mode string) string {
	if mode == "real" {
		return "gateway"
	}
	return "fake"
}

// fakeFromMap 无网络冒烟模型：从目录表确定性派生大纲（验证管线连通）。
type fakeOutline struct{ resp string }

func (f fakeOutline) Complete(_ context.Context, _ pipelineb.ModelRequest) (string, error) {
	return f.resp, nil
}

func fakeFromMap(m *pipelineb.RepoMap) pipelineb.OutlineModel {
	type ch struct {
		Name    string   `json:"name"`
		Summary string   `json:"summary"`
		Files   []string `json:"files"`
		Phase   string   `json:"phase"`
	}
	var chs []ch
	docs, codes := []string{}, []string{}
	for _, f := range m.Files {
		if f.IsDoc {
			docs = append(docs, f.Path)
		} else if !f.IsTest {
			codes = append(codes, f.Path)
		}
	}
	capList := func(l []string, n int) []string {
		if len(l) > n {
			return l[:n]
		}
		return l
	}
	if len(docs) > 0 {
		chs = append(chs, ch{Name: "第 1 章：起步与概览（桩）", Summary: "fake 模型确定性输出", Files: capList(docs, 5), Phase: "入门"})
	}
	if len(codes) > 0 {
		chs = append(chs, ch{Name: "第 2 章：核心实现（桩）", Summary: "fake 模型确定性输出", Files: capList(codes, 8), Phase: "实战"})
	}
	b, _ := json.Marshal(map[string]any{"chapters": chs})
	return fakeOutline{resp: string(b)}
}

// ── 工具 ────────────────────────────────────────────────────

func fatalIf(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(err.Error()))
		os.Exit(1)
	}
}

// fakePlannerStub 确定性规划:前 2 个最大子树 + README。
type fakePlannerStub struct{}

func (fakePlannerStub) Plan(_ context.Context, skeleton string, _ map[string]string, _ string, _ string) (string, error) {
	var targets []string
	for _, line := range strings.Split(skeleton, "\n") {
		if strings.Contains(line, "README") {
			continue
		}
		if i := strings.Index(line, " |"); i > 0 && !strings.HasPrefix(line, "  ") {
			// 顶层行:取名字段
			_ = i
		}
	}
	_ = targets
	// 简桩:从骨架第二行起取前三个顶层目录名
	var dirs []string
	for _, line := range strings.Split(skeleton, "\n")[1:] {
		if len(dirs) >= 3 {
			break
		}
		if name := strings.TrimSpace(strings.Split(line, " |")[0]); name != "" && !strings.Contains(name, "README") {
			dirs = append(dirs, name)
		}
	}
	b, _ := json.Marshal(map[string]any{
		"chapters": []map[string]any{
			{"name": "第 1 章:起步(桩)", "summary": "fake", "targetPaths": []string{"README.md"}, "phase": "入门"},
			{"name": "第 2 章:核心分区(桩)", "summary": "fake", "targetPaths": dirs, "phase": "实战"},
		},
		"needRollup": []string{},
	})
	return string(b), nil
}

func runDepth2(ctx context.Context, m *pipelineb.RepoMap, mode, lang, userID string, patterns cognitive.Patterns) {
	var planner pipelineb.PlannerModel
	var subModel pipelineb.OutlineModel
	switch mode {
	case "fake":
		planner = fakePlannerStub{}
		subModel = perReqFake{}
	case "real":
		gw := newGatewayClient()
		uid := requireUserID(userID)
		planner = &pipelineb.GatewayPlanner{Client: gw, UserID: &uid}
		subModel = &pipelineb.GatewayModel{Client: gw, UserID: &uid}
	default:
		fmt.Fprintln(os.Stderr, "mode 必须是 fake|real")
		os.Exit(2)
	}
	res, err := pipelineb.RunDrill(ctx, m, planner, subModel, patterns, lang, "")
	status := "ok"
	if err != nil {
		status = "error: " + err.Error()
	}
	report := map[string]any{"repo": m.RepoName, "mode": mode, "model": modelLabel(mode), "depth": 2, "status": status}
	if res != nil {
		report["chapters"] = res.Chapters
		report["plan"] = res.Plan
		report["skippedTrees"] = res.SkippedTrees
		report["replanned"] = res.Replanned
		report["droppedPaths"] = res.DroppedPaths
		report["durationMs"] = res.Duration.Milliseconds()
		report["diagnostics"] = res.Diagnostics
		covered := map[string]bool{}
		for _, c := range res.Chapters {
			for _, f := range c.Files {
				covered[f.Path] = true
			}
		}
		report["coverage"] = float64(len(covered)) / float64(len(m.Files))
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(report)
}

// perReqFake 按请求子树生成的确定性桩(每子树 1 章,取前 3 文件)。
type perReqFake struct{}

func (perReqFake) Complete(_ context.Context, req pipelineb.ModelRequest) (string, error) {
	var files []string
	for i, f := range req.RepoMap.Files {
		if i >= 3 {
			break
		}
		files = append(files, f.Path)
	}
	b, _ := json.Marshal(map[string]any{
		"chapters": []map[string]any{
			{"name": "桩章:" + req.RepoMap.RepoName, "summary": "fake", "files": files, "phase": "实战"},
		},
	})
	return string(b), nil
}

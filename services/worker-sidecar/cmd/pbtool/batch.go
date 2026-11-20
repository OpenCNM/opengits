// ─────────────────────────────────────────────────────────────
// Phase 1.1 离线长尾压测：manifest 驱动的批量跑批模式（-batch）。
//
// 硬预算契约（离线工具自身绝不成为无界执行面）：
//   - 总墙钟熔断（maxTotalWallMin，缺省 60min）：耗尽后剩余仓标记 skipped_budget；
//   - 逐仓超时（perRepoTimeoutSec，缺省 300s）：单仓卡死不拖垮整批；
//   - checkpoint（<manifest>.ckpt.json）：每仓完成即原子落盘，重跑跳过
//     已完成仓——真实仓跑批可能被网关限流/网络中断打断，必须可恢复。
//
// 摘要契约（认知预算：计数与状态，不内联全量章节正文）：
// repo/mode/depth2/files/totalLoc/truncated/pipelineA{chapters}/
// pipelineBStatus/depth2{chapters,droppedPaths,skippedTrees,replanned,
// degenerate,coverage,durationMs}。
// ─────────────────────────────────────────────────────────────
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
	"github.com/opengits/worker-sidecar/internal/ingest"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

// batchManifest 批跑清单（LLM 起草或人工维护；目录指向本地已 clone 的仓库）。
type batchManifest struct {
	Repos []batchRepo `json:"repos"`
	// PerRepoTimeoutSec 单仓墙钟上限（缺省 300s）。
	PerRepoTimeoutSec int `json:"perRepoTimeoutSec"`
	// MaxTotalWallMin 整批总墙钟熔断（缺省 60min）。
	MaxTotalWallMin int `json:"maxTotalWallMin"`
}

type batchRepo struct {
	Dir    string `json:"dir"`
	Name   string `json:"name"`
	Mode   string `json:"mode"` // fake | real
	Depth2 bool   `json:"depth2"`
}

const (
	batchDefaultPerRepoTimeoutSec = 300
	batchDefaultTotalWallMin      = 60
)

// runBatch 批跑主入口：manifest 加载 → 前置校验（fail-fast，不烧预算）→
// 逐仓执行（跳过 checkpoint 已完成仓）→ 汇总摘要到 stdout。
func runBatch(manifestPath, lang, userID string) {
	manifest, err := loadBatchManifest(manifestPath)
	fatalIf(err)

	// 前置校验：目录存在 + mode 合法 + real 仓的网关配置/BYOK userId +
	// 名称唯一（checkpoint 键与报告标识，重名会静默吞结果）——任何缺失在
	// 烧任何预算之前快败（公理 5：未知状态 fail-fast，不带病起跑）
	needGateway := false
	seenNames := map[string]bool{}
	for i := range manifest.Repos {
		r := &manifest.Repos[i]
		if r.Name == "" {
			r.Name = filepath.Base(strings.TrimRight(r.Dir, "/"))
		}
		if seenNames[r.Name] {
			fatalf("manifest 存在重名仓库 %q（-name 或目录末段）——checkpoint 与报告以名为键，禁止歧义", r.Name)
		}
		seenNames[r.Name] = true
		if r.Mode == "" {
			r.Mode = "fake"
		}
		if r.Mode != "fake" && r.Mode != "real" {
			fatalf("repo %s: mode 必须是 fake|real（got %q）", r.Name, r.Mode)
		}
		if st, err := os.Stat(r.Dir); err != nil || !st.IsDir() {
			fatalf("repo %s: 目录不存在或非目录 %q", r.Name, r.Dir)
		}
		if r.Mode == "real" {
			needGateway = true
		}
	}
	if needGateway && (os.Getenv("LLM_GATEWAY_URL") == "" || os.Getenv("INTERNAL_API_TOKEN") == "") {
		fatalf("manifest 含 real 仓：需要 LLM_GATEWAY_URL + INTERNAL_API_TOKEN（网关 purpose 路径）")
	}
	if needGateway && userID == "" {
		fatalf("manifest 含 real 仓：需要 -user-id <userId>（或 PBTOOL_USER_ID 环境变量）——网关 BYOK fail-closed 契约")
	}

	ckptPath := manifestPath + ".ckpt.json"
	done := loadBatchCheckpoint(ckptPath)

	totalBudget := time.Duration(manifest.MaxTotalWallMin) * time.Minute
	if totalBudget <= 0 {
		totalBudget = batchDefaultTotalWallMin * time.Minute
	}
	totalCtx, totalCancel := context.WithTimeout(context.Background(), totalBudget)
	defer totalCancel()
	batchStart := time.Now()

	patterns := ingest.DefaultPatterns()
	defs := rsg.DefaultLanguageDefinitions()

	results := make([]map[string]any, 0, len(manifest.Repos))
	for i := range manifest.Repos {
		r := manifest.Repos[i]
		ckptKey := batchCkptKey(r, lang)
		if prev, ok := done[ckptKey]; ok {
			fmt.Fprintf(os.Stderr, "[batch] %d/%d %s: checkpoint 命中，跳过（status=%v）\n", i+1, len(manifest.Repos), r.Name, prev["pipelineBStatus"])
			results = append(results, prev)
			continue
		}
		// 总墙钟耗尽：剩余仓显式标记（不静默吞掉——账面守恒）
		remaining := totalBudget - time.Since(batchStart)
		if remaining <= 0 {
			results = append(results, map[string]any{
				"repo": r.Name, "mode": r.Mode, "depth2": r.Depth2,
				"pipelineBStatus": "skipped_budget",
			})
			fmt.Fprintf(os.Stderr, "[batch] %s: 总墙钟耗尽（%s），标记 skipped_budget\n", r.Name, totalBudget)
			continue
		}
		perRepo := time.Duration(manifest.PerRepoTimeoutSec) * time.Second
		if perRepo <= 0 {
			perRepo = batchDefaultPerRepoTimeoutSec * time.Second
		}
		if perRepo > remaining {
			perRepo = remaining
		}
		fmt.Fprintf(os.Stderr, "[batch] %d/%d %s: 运行中 (mode=%s depth2=%v budget=%s)\n", i+1, len(manifest.Repos), r.Name, r.Mode, r.Depth2, perRepo)

		ctx, cancel := context.WithTimeout(totalCtx, perRepo)
		summary := runRepoReport(ctx, r, lang, userID, patterns, defs)
		cancel()
		summary["lang"] = lang
		if r.Mode == "real" {
			summary["userId"] = userID // 配额溯源：批跑结果可回答"这批数据是谁的配额跑的"
		}

		results = append(results, summary)
		done[ckptKey] = summary
		saveBatchCheckpoint(ckptPath, done)
		fmt.Fprintf(os.Stderr, "[batch] %s: 完成 (status=%v, %vms)\n", r.Name, summary["pipelineBStatus"], summary["durationMs"])
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(map[string]any{
		"manifest": filepath.Base(manifestPath),
		"repos":    len(manifest.Repos),
		"totalMs":  time.Since(batchStart).Milliseconds(),
		"results":  results,
	})
}

// runRepoReport 单仓执行：构建目录表 → A 基线 → B 管线（深度 1/2 按 flag）→
// 紧凑摘要。错误转为 status 字符串（单仓失败不中断整批——其余仓继续）。
func runRepoReport(ctx context.Context, r batchRepo, lang, userID string, patterns cognitive.Patterns, defs *rsg.LanguageDefinitions) map[string]any {
	abs, err := filepath.Abs(r.Dir)
	if err != nil {
		return batchErrSummary(r, "abs: "+err.Error())
	}
	m, err := pipelineb.BuildRepoMap(abs, r.Name, defs, patterns)
	if err != nil {
		return batchErrSummary(r, "build map: "+err.Error())
	}

	summary := map[string]any{
		"repo":      r.Name,
		"mode":      r.Mode,
		"depth2":    r.Depth2,
		"files":     len(m.Files),
		"allFiles":  m.Tree.FileCount,
		"totalLoc":  m.TotalLOC,
		"truncated": m.Truncated,
	}

	// A 管线免费基线（只记章数，认知预算）
	nodes := make([]cluster.GitNode, 0, len(m.Files))
	for _, f := range m.Files {
		nodes = append(nodes, cluster.GitNode{Path: f.Path, Type: "blob", Size: int64(f.LOC)})
	}
	a := cognitive.BuildRuleFallbackOutline(nodes, "", lang, patterns)
	summary["pipelineA"] = map[string]any{"chapters": len(a)}

	if !r.Depth2 {
		var modelRunner pipelineb.OutlineModel
		switch r.Mode {
		case "fake":
			modelRunner = fakeFromMap(m)
		case "real":
			uid := userID
			modelRunner = &pipelineb.GatewayModel{Client: newGatewayClient(), UserID: &uid}
		}
		start := time.Now()
		b, err := pipelineb.Run(ctx, m, modelRunner, patterns, lang)
		summary["durationMs"] = time.Since(start).Milliseconds()
		if err != nil {
			summary["pipelineBStatus"] = "error: " + err.Error()
			return summary
		}
		summary["pipelineBStatus"] = "ok"
		summary["pipelineB"] = map[string]any{
			"chapters":     len(b.Chapters),
			"droppedPaths": b.DroppedPaths,
			"promptTokens": b.EstPromptTok,
			"durationMs":   b.Duration.Milliseconds(),
		}
		return summary
	}

	var planner pipelineb.PlannerModel
	var subModel pipelineb.OutlineModel
	switch r.Mode {
	case "fake":
		planner = fakePlannerStub{}
		subModel = perReqFake{}
	case "real":
		gw := newGatewayClient()
		uid := userID
		planner = &pipelineb.GatewayPlanner{Client: gw, UserID: &uid}
		subModel = &pipelineb.GatewayModel{Client: gw, UserID: &uid}
	}
	start := time.Now()
	res, err := pipelineb.RunDrill(ctx, m, planner, subModel, patterns, lang, "")
	summary["durationMs"] = time.Since(start).Milliseconds()
	if err != nil {
		// 失败样本的诊断也进摘要（PlanErrorWithDiagnostics 携带时提取）——
		// 离线批跑统计退化率的分子不缺失败侧
		var planErr *pipelineb.PlanErrorWithDiagnostics
		if errors.As(err, &planErr) {
			summary["diagnostics"] = planErr.Diagnostics
		}
		summary["pipelineBStatus"] = "error: " + err.Error()
		var gwErr *client.LlmGatewayError
		summary["degenerate"] = !errors.As(err, &gwErr) && strings.Contains(err.Error(), "degenerated")
		return summary
	}
	summary["pipelineBStatus"] = "ok"
	summary["degenerate"] = false
	summary["diagnostics"] = res.Diagnostics
	covered := map[string]bool{}
	for _, c := range res.Chapters {
		for _, f := range c.Files {
			covered[f.Path] = true
		}
	}
	coverage := 0.0
	if len(m.Files) > 0 {
		coverage = float64(len(covered)) / float64(len(m.Files))
	}
	summary["pipelineB"] = map[string]any{
		"chapters":     len(res.Chapters),
		"droppedPaths": res.DroppedPaths,
		"skippedTrees": res.SkippedTrees,
		"droppedPlan":  res.DroppedPlan,
		"replanned":    res.Replanned,
		"coverage":     coverage,
	}
	return summary
}

func batchErrSummary(r batchRepo, msg string) map[string]any {
	return map[string]any{
		"repo": r.Name, "mode": r.Mode, "depth2": r.Depth2,
		"pipelineBStatus": "error: " + msg,
	}
}

func loadBatchManifest(path string) (*batchManifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 manifest: %w", err)
	}
	var m batchManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("解析 manifest: %w", err)
	}
	if len(m.Repos) == 0 {
		return nil, fmt.Errorf("manifest.repos 为空")
	}
	return &m, nil
}

// loadBatchCheckpoint 读取已完成仓摘要（损坏/缺失视为空——重跑该等仓，
// 绝不因 checkpoint 损坏静默丢弃整批结论）。
func loadBatchCheckpoint(path string) map[string]map[string]any {
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]map[string]any{}
	}
	var m map[string]map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		// 解析失败或合法 JSON null（Unmarshal 成功但 m 为 nil）一律视为空——
		// 绝不带病使用，否则后续写入 nil map 直接 panic
		fmt.Fprintf(os.Stderr, "[batch] checkpoint 损坏，忽略并全量重跑: %s\n", path)
		return map[string]map[string]any{}
	}
	return m
}

// batchCkptKey checkpoint 复合键：name|mode|depth2|lang——mode/depth2/lang
// 任一变更 = 不同的实验（换语言重跑绝不静默复用错语结果）。
func batchCkptKey(r batchRepo, lang string) string {
	return fmt.Sprintf("%s|%s|%v|%s", r.Name, r.Mode, r.Depth2, lang)
}

// saveBatchCheckpoint 原子落盘（tmp + rename：中断不产生半写文件）；
// 任何失败显式告警——checkpoint 丢失意味着重跑烧钱，静默吞掉是伪弹性。
func saveBatchCheckpoint(path string, done map[string]map[string]any) {
	// 稳定序列化：键排序（可复现的 checkpoint diff）
	names := make([]string, 0, len(done))
	for k := range done {
		names = append(names, k)
	}
	sort.Strings(names)
	ordered := make(map[string]map[string]any, len(done))
	for _, k := range names {
		ordered[k] = done[k]
	}
	raw, err := json.MarshalIndent(ordered, "", " ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[batch] checkpoint 序列化失败（续跑将从空开始）: %v\n", err)
		return
	}
	// 唯一临时名：固定 .tmp 路径在同 manifest 并发双进程下互相截断
	//（rename ENOENT / 半写互相覆盖），CreateTemp 消除该竞态面
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[batch] checkpoint 临时文件创建失败（续跑将从空开始）: %v\n", err)
		return
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		_ = os.Remove(tmpName)
		fmt.Fprintf(os.Stderr, "[batch] checkpoint 写入失败（续跑将从空开始）: %v\n", err)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		fmt.Fprintf(os.Stderr, "[batch] checkpoint 关闭失败（续跑将从空开始）: %v\n", err)
		return
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		fmt.Fprintf(os.Stderr, "[batch] checkpoint rename 失败（续跑将从空开始）: %v\n", err)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[pbtool] "+format+"\n", args...)
	os.Exit(2)
}

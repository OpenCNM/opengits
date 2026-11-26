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

type batchManifest struct {
	Repos             []batchRepo `json:"repos"`
	PerRepoTimeoutSec int         `json:"perRepoTimeoutSec"`
	MaxTotalWallMin   int         `json:"maxTotalWallMin"`
}

type batchRepo struct {
	Dir    string `json:"dir"`
	Name   string `json:"name"`
	Mode   string `json:"mode"`
	Depth2 bool   `json:"depth2"`
}

const (
	batchDefaultPerRepoTimeoutSec = 300
	batchDefaultTotalWallMin      = 60
)

func runBatch(manifestPath, lang, userID string) {
	manifest, err := loadBatchManifest(manifestPath)
	fatalIf(err)

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
			summary["userId"] = userID
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
	res, err := pipelineb.RunDrill(ctx, m, planner, subModel, patterns, lang, "", 0)
	summary["durationMs"] = time.Since(start).Milliseconds()
	if err != nil {
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

func loadBatchCheckpoint(path string) map[string]map[string]any {
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]map[string]any{}
	}
	var m map[string]map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		// Treat JSON null (Unmarshal succeeds with nil map) as empty to avoid nil-map assignment panic.
		fmt.Fprintf(os.Stderr, "[batch] checkpoint 损坏，忽略并全量重跑: %s\n", path)
		return map[string]map[string]any{}
	}
	return m
}

func batchCkptKey(r batchRepo, lang string) string {
	return fmt.Sprintf("%s|%s|%v|%s", r.Name, r.Mode, r.Depth2, lang)
}

func saveBatchCheckpoint(path string, done map[string]map[string]any) {
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
	// CreateTemp prevents concurrent processes on the same manifest from truncating a shared .tmp path.
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

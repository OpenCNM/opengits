package pipelineb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// ─────────────────────────────────────────────────────────────
// 深度 2 下钻(P2):骨架图 → 规划(章意图+目标子树)→ 并行子树
// 文件地图 → outline_map_v1 逐子树出章 → 汇编 → 全集路径装甲。
//
// 失败语义(每层独立,永不全废):
// - 规划失败 → 整体显式 error(调用方回落深度 1 或 A 管线);
// - 规划退化 → 携物理校验事实反馈重规划一次,仍退化按失败上抛
//   (fail-closed,2026-09 与 body 层产品定夺对齐:拒绝模板兜底冒充成品);
// - 单子树失败 → 该子树被跳过,其章由其余子树承担(章意图保留、
//   files 留空会在装配时丢弃空章);重试一次后放弃;
// - A5 有界修订:规划可请求额外一层子树上卷(needRollup,≤3 个路径),
//   携带补料重规划一次(封顶,不迭代)。
// ─────────────────────────────────────────────────────────────

// PlanChapter 规划章(意图层,无文件)。
type PlanChapter struct {
	ModuleTitle string   `json:"moduleTitle,omitempty"`
	Name        string   `json:"name"`
	Summary     string   `json:"summary"`
	TargetPaths []string `json:"targetPaths"`
	// FocusFiles 专题焦点文件(模型点名的文件级路径;thematic 意图下
	// targetPaths 可为空,章粒度由焦点文件直接定义)。规划层不做路径
	// 真实性判断——幻觉剔除统一交由预验证求交阶段(物理边界裁决)。
	FocusFiles []string `json:"focusFiles,omitempty"`
	Phase      string   `json:"phase"`
	DrillDown  bool     `json:"drillDown"`
}

type planResponse struct {
	Chapters       []PlanChapter `json:"chapters"`
	NeedRoll       []string      `json:"needRollup"`
	CurriculumMode string        `json:"curriculumMode"`
	// IntentMode 意图模式声明(模型输出,TS 侧 zod 放行后透传):
	// "full_repo"=全仓课程 / "thematic_slice"=专题切片。
	// 意图主权红线:thematic 判定只来自 customPrompt 非空 + 本字段,
	// 代码层绝不写任何关键词/正则意图猜测。
	IntentMode string `json:"intentMode,omitempty"`
}

// PlannerModel 规划调用抽象(outline_plan_v1)。
type PlannerModel interface {
	// Plan 返回 JSON 文本;skeleton 入,可含补料 rollups(A5 二次调用)。
	// feedback 非空 = 退化规划的反馈重规划(封顶一次,不迭代)。
	Plan(ctx context.Context, skeleton string, rollups map[string]string, feedback string, targetLanguage string) (string, error)
}

// DrillResult 深度 2 产物。
type DrillResult struct {
	Chapters       []cognitive.OutlineChapter
	Plan           []PlanChapter // 实际采用的规划(目标已验证)
	DroppedPlan    []string      // 目标全无效被弃的规划章
	SkippedTrees   []string      // 失败被跳过的子树
	Replanned      bool          // A5 补料修订是否发生
	DroppedPaths   []string      // 幻觉装甲砍除
	Duration       time.Duration
	CurriculumMode string
	// Thematic 专题切片模式标注(obtainPlan 已按 customPrompt 门控过):
	// handler 侧 ComputeExcludedFiles 据此把专题外文件与辅助文件区分标注。
	Thematic bool
	// Diagnostics 规划阶段确定性诊断（Phase 2 观测：随响应 stats 透传，
	// Node 侧单行结构化摘要消费——先量化后扩容，Phase 3 触发判据的数据源）。
	Diagnostics PipelineDiagnostics `json:"diagnostics,omitempty"`
}

// PlanErrorWithDiagnostics 携带规划诊断的错误包装（持续退化 fail-closed 上抛时
// 诊断随错误走——Phase 3 触发判据需要"救回失败"样本的分子，绝不丢弃；
// Unwrap 保真底层错误，sendPipelineError 的 errors.As 仍可提取网关码）。
type PlanErrorWithDiagnostics struct {
	Err         error
	Diagnostics PipelineDiagnostics
}

func (e *PlanErrorWithDiagnostics) Error() string { return e.Err.Error() }

func (e *PlanErrorWithDiagnostics) Unwrap() error { return e.Err }

// PipelineDiagnostics 规划与覆盖率门禁的确定性观测指标（零 LLM 判定）。
type PipelineDiagnostics struct {
	// NeedRollupRequested 模型原始上卷请求数（确定性截断为 3 之前——
	// 衡量巨仓上现有 3 路径封顶是否成为瓶颈的原始事实）。
	NeedRollupRequested int `json:"needRollupRequested,omitempty"`
	// NeedRollupCapped 原始请求超过封顶被截断（Phase 3.1 扩容触发判据）。
	NeedRollupCapped bool `json:"needRollupCapped,omitempty"`
	// PlanDegenerateTriggered 退化判定命中（触发反馈重规划）。
	PlanDegenerateTriggered bool `json:"planDegenerateTriggered,omitempty"`
	// PlanDegenerateRecovered 反馈重规划救回（Triggered=true 且 Recovered=false = fail-closed 上抛）。
	PlanDegenerateRecovered bool `json:"planDegenerateRecovered,omitempty"`
	// UncoveredSubsystemCount 深度 2 后置覆盖率门禁缺失核心子系统数
	//（仅观测；customPrompt/overview 豁免时为 0——语义见 coverage.go）。
	UncoveredSubsystemCount int `json:"uncoveredSubsystemCount,omitempty"`
	// NeedRollupQuota 本次请求生效的探查配额档位（路径数/下钻深度，Go↔TS
	// 契约回显——观测面直接关联档位与结果，用户反馈式扩容的证据字段）。
	NeedRollupQuota int `json:"needRollupQuota,omitempty"`
	NeedRollupDepth int `json:"needRollupDepth,omitempty"`
	// IntentMode 规划意图收敛结果(full_repo/thematic_slice)——观测面关联
	// 意图模式与退化率/救回率,专题切片质量分账的数据字段。
	IntentMode string `json:"intentMode,omitempty"`
}

// drillChapterFileCap 汇编单章文件上限(认知预算硬上限,防巨型章膨胀)。
const drillChapterFileCap = 8

// thematicRollupFileBudget 专题补料 rollup 的目录行直属文件预算(行数/目录):
// 聚焦视野只需"该分区有什么文件"的中性清单(专题排序 Hotness 主序),
// 12 行足以覆盖单目录高信噪比文件;全仓通道的采样偏置渲染不受影响。
const thematicRollupFileBudget = 12

// DefaultDrillConcurrency 默认下钻并发度（严格 <= 2，防止压垮外部通道）。
const DefaultDrillConcurrency = 2

// DrillConcurrency 获取下钻子课程的并行度（优先级: 环境变量 DRILL_CONCURRENCY > 默认值 2）。
func DrillConcurrency() int {
	if v := os.Getenv("DRILL_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return DefaultDrillConcurrency
}

// ProgressStep 阶段进度事件负载
type ProgressStep struct {
	Stage    string  `json:"stage"`
	Title    string  `json:"title"`
	Detail   string  `json:"detail"`
	Progress float64 `json:"progress,omitempty"`
}

// ProgressCallback 阶段推进回调函数
type ProgressCallback func(step ProgressStep)

// 教学深度契约值（与 registry.ts outline_* compile 侧约定一致；空串 = 未指定）。
const (
	TeachingDepthOverview = "overview"
	TeachingDepthStandard = "standard"
	TeachingDepthDeep     = "deep"
)

// ─────────────────────────────────────────────────────────────
// 探查配额档位（2026-11 用户反馈式 rollup 控制）。
//
// 大纲规划后由用户判断深浅：点「更深入」rollupLevel+1 重新规划，
// 判断权归用户、预算权归代码——每次点击即用户授权的一档固定增量。
// 默认档 = 现状（3 路径 × 1 层），零点击用户行为零变化。
// ─────────────────────────────────────────────────────────────

const (
	// RollupLevelMax 探查档位天花板（UI 到顶置灰，提示改用定制提示词）。
	RollupLevelMax = 3
	// rollup 路径配额与下钻深度的档位表值。
	rollupQuotaL0, rollupDepthL0 = 3, 1 // 默认：现状语义
	rollupQuotaL1, rollupDepthL1 = 4, 1 // 更深入一档
	rollupQuotaL2, rollupDepthL2 = 5, 2 // 更深 + 展开第二层
	rollupQuotaL3, rollupDepthL3 = 8, 2 // 天花板
)

// RollupBudgetForLevel 档位查表（唯一事实源）：返回该档位的
// needRollup 路径配额与单路径下钻深度。越界收敛到 [0, RollupLevelMax]。
func RollupBudgetForLevel(level int) (quota, depth int) {
	if level < 0 {
		level = 0
	}
	if level > RollupLevelMax {
		level = RollupLevelMax
	}
	switch level {
	case 1:
		return rollupQuotaL1, rollupDepthL1
	case 2:
		return rollupQuotaL2, rollupDepthL2
	case 3:
		return rollupQuotaL3, rollupDepthL3
	default:
		return rollupQuotaL0, rollupDepthL0
	}
}

// RunDrill 深度自适应下钻主编排。
// 契约 C8：teachingDepth 显式参数（overview/standard/deep，空串 = 未指定），
// 驱动确定性选材加权（scoreSubtreeFile）与覆盖率门禁的深度观测。
// rollupLevel：探查配额档位（0=默认 3 路径×1 层；用户「更深入」点击递增，
// 上限 RollupLevelMax——判断权归用户、预算权归代码）。
func RunDrill(ctx context.Context, m *RepoMap, planner PlannerModel, model OutlineModel, patterns cognitive.Patterns, targetLanguage string, teachingDepth string, rollupLevel int, progressFn ...ProgressCallback) (*DrillResult, error) {
	start := time.Now()
	var cb ProgressCallback
	if len(progressFn) > 0 && progressFn[0] != nil {
		cb = progressFn[0]
	}
	// 子系统清单入口算一次向下传（SSOT 契约 C1 复用；微秒级确定性计算，
	// 供 AST 边优先协同挂载与覆盖率门禁共用）
	subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	res, err := runDrillLevel(ctx, m, planner, model, patterns, targetLanguage, teachingDepth, subsystems, cb, rollupLevel)
	if err != nil {
		return nil, err
	}
	res.Duration = time.Since(start)
	return res, nil
}

func runDrillLevel(
	ctx context.Context,
	m *RepoMap,
	planner PlannerModel,
	model OutlineModel,
	patterns cognitive.Patterns,
	targetLanguage string,
	teachingDepth string,
	subsystems []SubsystemSpec,
	cb ProgressCallback,
	rollupLevel int,
) (*DrillResult, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	root := skipRootWrapper(m.Tree)

	quota, rollupDepth := RollupBudgetForLevel(rollupLevel)
	planResp, replanned, planDiag, err := obtainPlan(ctx, planner, root, targetLanguage, quota, rollupDepth)
	if err != nil {
		// 诊断随错误上抛（失败样本的退化率分子），不静默丢弃
		return nil, &PlanErrorWithDiagnostics{Err: fmt.Errorf("plan: %w", err), Diagnostics: planDiag}
	}

	// thematic 判定（obtainPlan 出口已按 customPrompt 门控归一：customPrompt
	// 为空时 IntentMode 恒为 full_repo，绝无越权专题通道；此处只读模型输出）。
	thematic := planResp.IntentMode == "thematic_slice"

	effectiveCap := DrillSubtreeFileCap()

	if planResp.CurriculumMode == "single" {
		// 专题装配例外（意图主权）：thematic 且任一章带 focusFiles 时不进入
		// Run() 早退、不因 FileCount>800 覆写——保持 single 落入下方装配路径，
		// 由预验证求交后的焦点文件确定性直出（零额外 LLM）。轻量预检只看
		// "有章声明焦点"，真实性裁决统一下沉到预验证求交阶段。
		thematicSingleFocus := thematic && hasAnyFocusFiles(planResp.Chapters)
		if !thematicSingleFocus {
			if m.Tree.FileCount <= 800 {
				res, err := Run(ctx, m, model, patterns, targetLanguage)
				if err != nil {
					return nil, fmt.Errorf("single mode run: %w", err)
				}
				AttachSubtreeCompanionsWithMap(res.Chapters, root, m, subsystems)
				return &DrillResult{
					Chapters:       res.Chapters,
					Plan:           planResp.Chapters,
					Replanned:      replanned,
					DroppedPaths:   res.DroppedPaths,
					CurriculumMode: "single",
					Diagnostics:    planDiag,
					Thematic:       thematic,
				}, nil
			} else {
				log.Printf("[pipelineb] Guardrail repo size (%d files) exceeds single mode capacity, overriding to matrix mode\n", m.Tree.FileCount)
				planResp.CurriculumMode = "matrix"
			}
		}
	}

	plan := planResp.Chapters

	// 目标预验证(规划非确定性,可能引用骨架外路径):无效目标剔除,
	// 全无效的规划章丢弃并登记(不再浪费下钻与跳过统计)。
	// 专题扩展:焦点文件与全集树叶索引精确求交(normalizePlanPaths 已做
	// 根名前缀/反引号/#后缀清洗),命中才保留归一化后的真实路径——焦点
	// 视野同样不豁免物理边界(幻觉剔除单一口径,与 targetPaths 同闸)。
	_, leafIdx := root.leafFilesIndexed()
	validPlan := make([]PlanChapter, 0, len(plan))
	droppedPlan := []string{}
	pathSet := map[string]bool{}
	var targets []string

	for _, ch := range plan {
		valid := ch.TargetPaths[:0:0]
		for _, p := range ch.TargetPaths {
			sub := findSubtree(root, p)
			if sub != nil {
				valid = append(valid, p)
				if !pathSet[p] {
					pathSet[p] = true
					targets = append(targets, p)
				}
			}
		}
		// 焦点文件求交：防御性再清洗与 parsePlan 侧同语义（幂等），精确
		// 匹配全集树叶索引；预验证即截到单章认知预算硬上限
		validFocus := make([]string, 0, len(ch.FocusFiles))
		for _, ff := range ch.FocusFiles {
			p := normalizeFocusFile(root.Name, ff)
			if p == "" {
				continue
			}
			if _, ok := leafIdx[p]; ok {
				validFocus = append(validFocus, p)
			}
		}
		if len(validFocus) > drillChapterFileCap {
			validFocus = validFocus[:drillChapterFileCap]
		}
		ch.FocusFiles = validFocus
		if len(valid) == 0 && len(validFocus) == 0 {
			droppedPlan = append(droppedPlan, ch.Name)
			continue
		}
		ch.TargetPaths = valid
		validPlan = append(validPlan, ch)
	}
	plan = validPlan

	if cb != nil {
		cb(ProgressStep{
			Stage:  "plan",
			Title:  "宏观课程划分完成",
			Detail: fmt.Sprintf("规划出总览课与 %d 个核心子模块", len(validPlan)),
		})
	}

	// 全集节点(装甲输入)= 全量树叶,非提取子集——子树下钻从磁盘另行
	// 提取的文件同样真实,提取配额不得缩小装甲宇宙(否则误判为幻觉)
	universe, _ := m.Tree.leafFilesIndexed()
	allNodes := make([]cluster.GitNode, 0, len(universe))
	allCandidates := make([]cognitive.CandidateOutlineFile, 0, len(universe))
	for _, f := range universe {
		allNodes = append(allNodes, cluster.GitNode{Path: f.Path, Type: "blob"})
		allCandidates = append(allCandidates, cognitive.CandidateOutlineFile{Path: f.Path, IsDoc: f.IsDoc})
	}

	byPath := map[string][]cognitive.OutlineChapter{}
	skipped := []string{}

	if os.Getenv("DRILL_LLM_SUBTREE") == "1" {
		// 实验模式：显式声明 DRILL_LLM_SUBTREE=1 时，按子树触发 LLM 选材。
		// 专题评分（scoreSubtreeFile 的 thematic 中性化）仅默认路径生效——
		// 本分支选材权交给子树 LLM，代码评分不参与；仅 capFiles 的 README
		// 保底豁免随 thematic 门控透传（专题视野不做文档霸权）。
		type subResult struct {
			path     string
			chapters []cognitive.OutlineChapter
			failed   bool
		}
		subCh := make(chan subResult, len(targets))
		var wg sync.WaitGroup
		drillSem := make(chan struct{}, DrillConcurrency())
		totalTargets := len(targets)

		for idx, tp := range targets {
			wg.Add(1)
			go func(targetIdx int, path string) {
				defer wg.Done()
				select {
				case drillSem <- struct{}{}:
				case <-ctx.Done():
					subCh <- subResult{path: path, failed: true}
					return
				}
				defer func() { <-drillSem }()

				if ctx.Err() != nil {
					subCh <- subResult{path: path, failed: true}
					return
				}

				if cb != nil {
					cb(ProgressStep{
						Stage:  "drill",
						Title:  fmt.Sprintf("子课程下钻 (%d/%d)", targetIdx+1, totalTargets),
						Detail: fmt.Sprintf("正在规划: %s", path),
					})
				}

				sub := findSubtree(root, path)
				if sub == nil {
					subCh <- subResult{path: path, failed: true}
					return
				}
				var allSubLeaves []FileMap
				if sub == root {
					allSubLeaves = sub.Files
				} else {
					allSubLeaves = sub.LeafFiles()
				}
				if len(allSubLeaves) == 0 {
					subCh <- subResult{path: path, failed: true}
					return
				}

				leaves := capFiles(allSubLeaves, effectiveCap, thematic)
				subMap := &RepoMap{RepoName: m.RepoName + "/" + sub.Name, Files: leaves, Tree: sub}
				for _, f := range leaves {
					subMap.TotalLOC += f.LOC
				}
				res, err := Run(ctx, subMap, model, patterns, targetLanguage)
				if err != nil || len(res.Chapters) == 0 {
					res, err = Run(ctx, subMap, model, patterns, targetLanguage)
					if err != nil || len(res.Chapters) == 0 {
						subCh <- subResult{path: path, failed: true}
						return
					}
				}
				if cb != nil {
					cb(ProgressStep{
						Stage:  "drill",
						Title:  fmt.Sprintf("子课程下钻 (%d/%d)", targetIdx+1, totalTargets),
						Detail: fmt.Sprintf("完成规划: %s", path),
					})
				}
				subCh <- subResult{path: path, chapters: res.Chapters}
			}(idx, tp)
		}
		wg.Wait()
		close(subCh)

		for r := range subCh {
			if r.failed {
				skipped = append(skipped, r.path)
				continue
			}
			byPath[r.path] = r.chapters
		}
		sort.Strings(skipped)
	} else {
		// 方案 A（默认彻底贯彻第一性原理）：0 次子树 LLM 调用，纯本地拓扑与 AST 评分确定性挂载（微秒级）
		totalTargets := len(targets)
		for idx, tp := range targets {
			if cb != nil {
				cb(ProgressStep{
					Stage:  "drill",
					Title:  fmt.Sprintf("子课程下钻 (%d/%d)", idx+1, totalTargets),
					Detail: fmt.Sprintf("拓扑装配: %s", tp),
				})
			}
			sub := findSubtree(root, tp)
			if sub == nil {
				skipped = append(skipped, tp)
				continue
			}
			var allSubLeaves []FileMap
			if sub == root {
				allSubLeaves = sub.Files
			} else {
				allSubLeaves = sub.LeafFiles()
			}
			if len(allSubLeaves) == 0 {
				skipped = append(skipped, tp)
				continue
			}
			// thematic 透传评分中性化：跳过 README/docs+500 与 config+200
			// 入口偏置——专题切片按符号信噪比选材，不做文档霸权
			sortedLeaves := sortSubtreeFilesByRelevance(allSubLeaves, teachingDepth, thematic)
			byPath[tp] = chunkFilesIntoOutlineChapters(sortedLeaves, drillChapterFileCap)
		}
		sort.Strings(skipped)
	}

	// 汇编:章意图顺序为纲。子树大纲的章节是资源池——多个规划章共享同一
	// 子树时按到达顺序逐个认领(每子树章只归一个规划章),而非全量复制
	// (全量复制会让装甲跨章去重清空后来的重复章)。
	next := map[string]int{}      // path -> 池游标
	lastClaim := map[string]int{} // path -> 最后认领它的产出章下标
	var chapters []cognitive.OutlineChapter
	for _, pch := range plan {
		var files []cognitive.ChapterFile
		if len(pch.FocusFiles) > 0 {
			// 专题焦点直出：预验证求交后的真实路径直接成为主文件——跳过
			// 子树池认领（确定性装配，零额外 LLM；文件已在预验证阶段截到
			// drillChapterFileCap，无需二次封顶）
			for _, p := range pch.FocusFiles {
				files = append(files, cognitive.ChapterFile{Path: p})
			}
		} else {
			for _, tp := range pch.TargetPaths {
				pool := byPath[tp]
				i := next[tp]
				if i < len(pool) {
					for _, f := range pool[i].Files {
						if len(files) >= drillChapterFileCap {
							break
						}
						files = append(files, f)
					}
					next[tp] = i + 1
					lastClaim[tp] = len(chapters)
				}
			}
		}
		if len(files) == 0 {
			continue // 池耗尽或子树被跳过:空章丢弃
		}
		chapters = append(chapters, cognitive.OutlineChapter{
			Name: pch.Name, Summary: pch.Summary, Files: files, PartTitle: pch.ModuleTitle,
		})
	}
	// 池剩余并入最后认领章(保覆盖;章数=规划数,单章文件封顶)
	for _, tp := range targets {
		pool := byPath[tp]
		if idx, ok := lastClaim[tp]; ok {
			for i := next[tp]; i < len(pool); i++ {
				for _, f := range pool[i].Files {
					if len(chapters[idx].Files) >= drillChapterFileCap {
						break
					}
					chapters[idx].Files = append(chapters[idx].Files, f)
				}
			}
		}
	}

	// 装甲：thematic 时豁免 README 保底回填（专题切片只看目标专题，文档
	// 霸权不在装甲层复发）；全仓通道不传选项，行为逐字节一致。
	var sanOpts []cognitive.SanitizeOption
	if thematic {
		sanOpts = append(sanOpts, cognitive.WithoutReadmeBackfill())
	}
	san := cognitive.SanitizeAndIntersectOutline(chapters, allNodes, "", targetLanguage, allCandidates, patterns, sanOpts...)
	chapters = san.Sanitized
	droppedPaths := san.DroppedPaths

	// 协同挂载：thematic 只跑 Pass 0（AST 物理边），跳过 Pass 1 同子系统
	// 目录补位——专题协同只信物理边，目录就近弱信号会让专题外文件挤占预算
	AttachSubtreeCompanionsWithMap(chapters, root, m, subsystems, thematic)

	// WP4.1 深度 2：覆盖率门禁仅观测（Gall's Law——下游逐子树 LLM 成本受控，
	// 不触发重规划/子树重跑；缺失告警与覆盖率指标只进结构化日志，不进 UI）。
	// 用户聚焦意图主权（与 coverage.go 门禁入口同一冲突裁决）：customPrompt
	// 经 planner/model 实例随路携带（teachingContextAware），不改 RunDrill 签名。
	observabilityCustomPrompt := ""
	if ca, ok := model.(teachingContextAware); ok {
		_, observabilityCustomPrompt = ca.TeachingContext()
	} else if ca, ok := planner.(teachingContextAware); ok {
		_, observabilityCustomPrompt = ca.TeachingContext()
	}
	if fb := evaluateSubsystemCoverage(subsystems, chapters, "", teachingDepth, observabilityCustomPrompt); fb != nil {
		planDiag.UncoveredSubsystemCount = len(fb.MissingSubsystems)
		log.Printf("[pipelineb] CoverageGate depth2 warning: uncovered core subsystems %v (summary: %s) — observability only, no replan\n",
			fb.MissingSubsystems, subsystemCoverageSummary(subsystems, chapters, ""))
	}

	if cb != nil {
		cb(ProgressStep{
			Stage:  "assemble",
			Title:  "课程树装配完成",
			Detail: fmt.Sprintf("已汇编 %d 个教学章节并完成全集物理装甲校验", len(chapters)),
		})
	}

	return &DrillResult{
		Chapters:       chapters,
		Plan:           plan,
		DroppedPlan:    droppedPlan,
		SkippedTrees:   skipped,
		Replanned:      replanned,
		DroppedPaths:   droppedPaths,
		CurriculumMode: planResp.CurriculumMode,
		Diagnostics:    planDiag,
		Thematic:       thematic,
	}, nil
}

// planDegenerate 退化判定:非根分区覆盖 <3,或过半章指向根(模型偷懒
// 整仓一章)——确定性兜底接管(收敛漏斗:模型起草,代码裁决)。
// thematic=true 时只守物理底线:parsePlan 已保证 >=1 章,焦点章的存在性
// 由 runDrillLevel 预验证对真实路径求交裁决——分区覆盖/根指向等全仓
// 启发式全部跳过(用户聚焦意图主权:绝不以分区数倒逼模型扩章)。
func planDegenerate(plan []PlanChapter, root *RepoTreeNode, thematic bool) bool {
	if thematic {
		// 专题切片：章数物理底线 len(plan) >= 1 已由 parsePlan 保证，直接放行
		// （聚焦章节宁缺毋滥——1 章专题是合法产物，不是退化）
		return false
	}
	if root.FileCount <= 3 {
		// 微型仓模式：物理分区本来就 <= 3，只要模型给出了 >= 2 个规划章即视为有效
		return len(plan) < 2
	}
	if len(plan) < 3 {
		return true
	}
	rootName := root.Name
	distinct := map[string]bool{}
	rootHits := 0
	for _, ch := range plan {
		for _, tp := range ch.TargetPaths {
			if tp == rootName || tp == "." {
				rootHits++
			} else if sub := findSubtree(root, tp); sub != nil && sub != root {
				// 以解析后子树为键:同一分区的不同写法(带根名前缀/裸名)只计 1
				distinct[sub.Path] = true
			}
		}
	}
	if rootHits > len(plan)/2 {
		return true
	}
	minDistinct := max(1, min(len(root.Children), 3))
	return len(distinct) < minDistinct
}

// normalizeTargetPath 规划目标归一化:模型输出常带仓库根名前缀、
// 引导斜杠或反引号修饰(xray-core/transport → transport)。与
// outline_sanitizer 的 cleanPrefix 同一宽容语义,在规划层单点收敛,
// 消灭"路径写法漂移 → 误判规划退化"的伪退化。
func normalizeTargetPath(rootName, path string) string {
	p := strings.TrimSpace(path)
	p = strings.Trim(p, "`")
	p = strings.TrimSpace(p)
	for len(p) > 0 && (strings.HasPrefix(p, "./") || strings.HasPrefix(p, "/")) {
		p = strings.TrimPrefix(p, "./")
		p = strings.TrimPrefix(p, "/")
	}
	if rootName != "" && p != rootName {
		p = strings.TrimPrefix(p, rootName+"/")
	}
	return p
}

// normalizePlanPaths 就地归一化规划章目标(解析闸门后立即执行:
// planDegenerate/幽灵预验证/子树认领全链共用同一规范键)。
func normalizePlanPaths(plan []PlanChapter, root *RepoTreeNode) {
	for i := range plan {
		for j, tp := range plan[i].TargetPaths {
			plan[i].TargetPaths[j] = normalizeTargetPath(root.Name, tp)
		}
		for j, ff := range plan[i].FocusFiles {
			plan[i].FocusFiles[j] = normalizeFocusFile(root.Name, ff)
		}
	}
}

// normalizeFocusFile 焦点文件归一化：normalizeTargetPath 的文件级扩展——
// 追加 "#" 后缀剥离（与 outline_sanitizer 的 path#anchor 剥离同语义：模型
// 常以 "path#Symbol" 修饰焦点，锚点真实性由装甲层裁决，预验证只认文件路径）。
// 反引号/空白/根名前缀/引导斜杠清洗由 normalizeTargetPath 统一承担。
func normalizeFocusFile(rootName, p string) string {
	p = normalizeTargetPath(rootName, p)
	if i := strings.IndexByte(p, '#'); i >= 0 {
		p = strings.TrimSpace(p[:i])
	}
	return p
}

// hasAnyFocusFiles 轻量预检：任一章声明了非空 focusFiles 即视为可装配。
// 只裁决 single 模式的分支走向（严禁 >800 覆写闸吞掉专题装配路径）；
// 严格的真实性求交校验在目标预验证阶段执行。
func hasAnyFocusFiles(plan []PlanChapter) bool {
	for _, ch := range plan {
		if len(ch.FocusFiles) > 0 {
			return true
		}
	}
	return false
}

// planFeedbackText 反馈重规划的修正指令:携带物理校验失败的具体事实
// (未解析目标/根目标占比),让模型一次修正——收敛漏斗的反馈闭环,
// 与网关侧 json_mode 反馈重试同一哲学。
// thematic=true 时反馈只指向物理事实（targetPaths/focusFiles 无法解析到
// 骨架图与符号索引中的真实路径），不输出分区数要求——聚焦章节宁缺毋滥。
func planFeedbackText(plan []PlanChapter, root *RepoTreeNode, thematic bool) string {
	if thematic {
		_, leafIdx := root.leafFilesIndexed()
		var unresolved []string
		for _, ch := range plan {
			for _, tp := range ch.TargetPaths {
				// 根名/"." 目标 = 整仓,恒可解析(findSubtree 同语义),不入未解析清单
				if tp != root.Name && tp != "." && findSubtree(root, tp) == nil {
					unresolved = append(unresolved, tp)
				}
			}
			for _, ff := range ch.FocusFiles {
				if p := normalizeFocusFile(root.Name, ff); p != "" {
					if _, ok := leafIdx[p]; !ok {
						unresolved = append(unresolved, ff)
					}
				}
			}
		}
		var sb strings.Builder
		sb.WriteString("上次专题规划未通过物理校验:")
		if len(unresolved) > 0 {
			fmt.Fprintf(&sb, "以下 targetPaths/focusFiles 无法解析到骨架图与符号索引中的真实路径: %s;", strings.Join(unresolved, ", "))
		}
		sb.WriteString("请逐字复制符号索引或骨架行中的路径标识,聚焦章节宁缺毋滥。")
		return sb.String()
	}
	if root.FileCount <= 3 {
		return "上次大纲规划章数不足:请至少给出 2 个教学章,严格遵循输出结构。"
	}
	var unresolved []string
	rootHits := 0
	for _, ch := range plan {
		for _, tp := range ch.TargetPaths {
			if tp == root.Name || tp == "." {
				rootHits++
				continue
			}
			if findSubtree(root, tp) == nil {
				unresolved = append(unresolved, tp)
			}
		}
	}
	var sb strings.Builder
	sb.WriteString("上次大纲规划未通过物理校验:")
	if len(unresolved) > 0 {
		fmt.Fprintf(&sb, "以下 targetPaths 无法解析到骨架图中的真实分区: %s;", strings.Join(unresolved, ", "))
	}
	if rootHits > len(plan)/2 {
		fmt.Fprintf(&sb, "过半章节(%d 个目标)指向仓库根;", rootHits)
	}
	minDistinct := max(1, min(len(root.Children), 3))
	fmt.Fprintf(&sb, "请重新规划:targetPaths 严格从骨架图行原样复制路径标识(禁止仓库根名前缀、绝对路径或凭记忆改写),确保至少 %d 个不同分区被有效覆盖。", minDistinct)
	return sb.String()
}

// isPermanentGatewayConfigError 永久性配置/授权错误判定：缺 Key/解密失败/
// 预算/未知 purpose——零成本退出，任何重试/修复/续写均无意义
// （drill 反馈重规划与 pipelineb Layer 2 修复共用此语义）。
func isPermanentGatewayConfigError(err error) bool {
	var gw *client.LlmGatewayError
	if !errors.As(err, &gw) {
		return false
	}
	return gw.IsMissingApiKey() || gw.IsKeyDecryptFailed() || gw.IsBudgetExceeded() || gw.IsUnknownPurpose()
}

// isRetryablePlanError 判定规划调用物理失败是否属于可退避重试的瞬态错误
func isRetryablePlanError(err error) bool {
	if err == nil {
		return false
	}
	var gw *client.LlmGatewayError
	if errors.As(err, &gw) {
		// 认证、预算、未注册 purpose 等属于致命配置/授权错误，绝不重试直接失败
		// （KEY_DECRYPT_FAILED 同为永久性配置错误：重存 Key 才能恢复，重试无意义）
		if gw.IsMissingApiKey() || gw.IsKeyDecryptFailed() || gw.IsBudgetExceeded() || gw.IsUnknownPurpose() {
			return false
		}
		// 生成失败 (502/GENERATION_FAILED)、瞬态 (503/504) 或限流 (429) 均可有界退避重试
		return gw.IsGenerationFailed() || gw.IsTransient() || gw.IsRateLimited()
	}
	// 网络层 socket 瞬断 / EOF / 连接重置
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "stream closed") ||
		strings.Contains(msg, "eof") ||
		strings.Contains(msg, "timeout")
}

// obtainPlan 规划 + A5 有界修订(needRollup ≤3 路径,补一层上卷重规划一次)。
// 退化规划:反馈重规划一次;仍退化 → fail-closed 上抛(对齐 body.go
// 2026-09-20 产品定夺:兜底=质量降级,拒绝——绝不以模板骨架伪装成品,
// 调用方回落客户端 A 规则管线的物理事实大纲)。
func obtainPlan(ctx context.Context, planner PlannerModel, root *RepoTreeNode, targetLanguage string, rollupQuota, rollupDepth int) (resp *planResponse, replanned bool, diag PipelineDiagnostics, err error) {
	// 防御钳制：配额/深度经 RollupBudgetForLevel 产生时恒合法，直调方误传
	// 0/负值时收敛默认档——绝不允许 quota=0 把补料通道静默关死
	if rollupQuota < 1 {
		rollupQuota = rollupQuotaL0
	}
	if rollupDepth < 1 {
		rollupDepth = rollupDepthL0
	}
	// 用户定制指令经 teachingContextAware 从 planner 实例随路读取（GatewayPlanner
	// 已实现该接口，测试桩按需实现）——obtainPlan 签名保持不变，意图条件不在
	// 调用链上裸传（与 coverage 观测同一挂载哲学）。customPrompt == "" 时全链路
	// （骨架/rollups/门禁/反馈）与现状逐字节一致（红线 1：能力不倒退）。
	customPrompt := ""
	if ca, ok := planner.(teachingContextAware); ok {
		_, customPrompt = ca.TeachingContext()
	}
	// 骨架通道选择：专题任务切换双段骨架（物理上卷行 + 定向符号索引），规划器
	// 获得超越 1 层目录上卷的符号级视野；全仓通道保持原骨架渲染逐字节不变。
	skeleton := RenderSkeleton(root)
	if customPrompt != "" {
		skeleton = RenderThematicSkeleton(root, thematicSkeletonBudget)
	}
	var raw string
	for attempt := 0; attempt < 2; attempt++ {
		raw, err = planner.Plan(ctx, skeleton, nil, "", targetLanguage)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return nil, false, diag, ctx.Err()
		}
		if !isRetryablePlanError(err) || attempt >= 1 {
			return nil, false, diag, err
		}
		select {
		case <-ctx.Done():
			return nil, false, diag, ctx.Err()
		case <-time.After(time.Duration(1<<attempt) * time.Second):
		}
	}
	resp, err = parsePlan(raw)
	if err != nil {
		return nil, false, diag, err
	}
	normalizePlanPaths(resp.Chapters, root)
	// 意图收敛时序 ①：首发原始判定先留档——A5 修订响应漏报 intentMode 时
	// 继承首发（继承的是模型自己的判定，不是代码猜测，零关键词匹配）。
	firstIntent := resp.IntentMode
	// A5:模型可请求补充子树上卷(≤3),补料重规划一次。概率性超额
	//(巨仓自然想上卷更多分区)确定性收敛为按序前 3——旧语义"超 3 全部
	// 丢弃"把模型的合理意图整锅扔掉,只为了让校验闸少写一行截断
	//（Phase 2 观测：截断前原始请求数与是否触顶进诊断——Phase 3.1
	// 扩容触发判据的原始事实，先量化后动线上行为）
	// 探查配额档位（rollupQuota/rollupDepth）来自用户「更深入」点击（批次：
	// 用户反馈式 rollup 控制），默认档与历史行为逐字节一致
	diag.NeedRollupRequested = len(resp.NeedRoll)
	diag.NeedRollupCapped = len(resp.NeedRoll) > rollupQuota
	diag.NeedRollupQuota = rollupQuota
	diag.NeedRollupDepth = rollupDepth
	if len(resp.NeedRoll) > rollupQuota {
		resp.NeedRoll = resp.NeedRoll[:rollupQuota]
	}
	// lastRollups 留档：A5 补料重规划成功后的反馈重规划仍携带补料视野
	// （专题/补料上下文不因退化反馈而丢失——重规划看到的世界与首发一致）。
	var lastRollups map[string]string
	if len(resp.NeedRoll) > 0 {
		rollups := map[string]string{}
		for _, p := range resp.NeedRoll {
			if sub := findSubtree(root, p); sub != nil {
				// 专题通道补料带直属文件行（专题中性排序，规划器点名分区时可见
				// "该分区有什么文件"）；全仓通道保持采样偏置渲染逐字节不变
				if customPrompt != "" {
					rollups[p] = RenderSubtreeSkeletonWithFiles(sub, rollupDepth, thematicRollupFileBudget)
				} else {
					rollups[p] = RenderSubtreeSkeleton(sub, rollupDepth)
				}
			}
		}
		if p2, ok := tryReplanningWithRollups(ctx, planner, skeleton, rollups, targetLanguage, root); ok {
			resp, replanned = p2, true
			// 意图收敛时序 ②：修订响应漏报 intentMode 时继承首发判定
			if resp.IntentMode == "" && firstIntent == "thematic_slice" {
				resp.IntentMode = "thematic_slice"
			}
			lastRollups = rollups
		}
		// 修订失败回落首发规划
	}
	// 意图收敛时序 ③ 最终归一（收敛点必须在 planDegenerate 判定之前）：
	// customPrompt 为空强制 full_repo（全仓主权在代码，模型越权声明无效）；
	// customPrompt 非空而模型漏报时归一 full_repo——fail-closed 不劣于现状，
	// 绝不写任何关键词猜测。
	if customPrompt == "" || resp.IntentMode == "" {
		resp.IntentMode = "full_repo"
	}
	thematic := customPrompt != "" && resp.IntentMode == "thematic_slice"
	diag.IntentMode = resp.IntentMode
	if planDegenerate(resp.Chapters, root, thematic) {
		diag.PlanDegenerateTriggered = true
		log.Printf("[pipelineb] DrillPlan degenerate plan (root=%s, chapters=%d) -> feedback replan\n", root.Name, len(resp.Chapters))
		raw2, err2 := planner.Plan(ctx, skeleton, lastRollups, planFeedbackText(resp.Chapters, root, thematic), targetLanguage)
		if err2 != nil {
			// 反馈重规划物理失败（限流/瞬断/密钥失效）≠ 规划退化：
			// 保真上抛底层错误（sendPipelineError 的 errors.As 依此透传网关码），
			// 绝不误报为 degenerated 掩盖真实根因
			if ctx.Err() != nil {
				return nil, false, diag, ctx.Err()
			}
			var gw2 *client.LlmGatewayError
			if errors.As(err2, &gw2) {
				return nil, false, diag, fmt.Errorf("feedback replan failed: %w", err2)
			}
		}
		if err2 == nil {
			if resp2, err3 := parsePlan(raw2); err3 == nil {
				normalizePlanPaths(resp2.Chapters, root)
				// 救回规划同样过意图归一闸：customPrompt=="" 时模型私改
				// intentMode 绝不允许把 runDrillLevel 掰进专题通道（闸不变量：
				// thematic 只来自 customPrompt 非空 + 模型输出，obtainPlan 出口
				// 恒已归一）；漏报时归一 full_repo（fail-closed，不继承首发——
				// 反馈重规划是模型对新规划的独立裁决）。
				if customPrompt == "" || resp2.IntentMode == "" {
					resp2.IntentMode = "full_repo"
				}
				if !planDegenerate(resp2.Chapters, root, thematic) {
					if resp2.CurriculumMode == "" {
						resp2.CurriculumMode = "matrix"
					}
					diag.PlanDegenerateRecovered = true
					log.Printf("[pipelineb] DrillPlan feedback replan recovered (root=%s, chapters=%d)\n", root.Name, len(resp2.Chapters))
					return resp2, true, diag, nil
				}
			}
		}
		log.Printf("[pipelineb] DrillPlan plan still degenerated after feedback retry -> fail-closed (root=%s)\n", root.Name)
		return nil, false, diag, fmt.Errorf("outline plan degenerated: 有效分区覆盖不足或过半指向根 (root=%s)", root.Name)
	}
	if resp.CurriculumMode == "" {
		resp.CurriculumMode = "matrix"
	}
	return resp, replanned, diag, nil
}

func tryReplanningWithRollups(ctx context.Context, planner PlannerModel, skeleton string, rollups map[string]string, targetLanguage string, root *RepoTreeNode) (*planResponse, bool) {
	if len(rollups) == 0 {
		return nil, false
	}
	raw2, err2 := planner.Plan(ctx, skeleton, rollups, "", targetLanguage)
	if err2 != nil {
		return nil, false
	}
	resp2, err3 := parsePlan(raw2)
	if err3 != nil {
		return nil, false
	}
	normalizePlanPaths(resp2.Chapters, root)
	if resp2.CurriculumMode == "" {
		resp2.CurriculumMode = "matrix"
	}
	return resp2, true
}

func parsePlan(raw string) (*planResponse, error) {
	start := strings.Index(raw, "{")
	if start < 0 {
		return nil, errors.New("no JSON object in plan response")
	}
	// Decoder 只取第一个完整 JSON 值——模型偶尔连排输出两个对象
	// (首尾括号截取会拼出非法文本)
	dec := json.NewDecoder(strings.NewReader(raw[start:]))
	var p planResponse
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("malformed plan JSON: %w", err)
	}
	if len(p.Chapters) == 0 {
		return nil, errors.New("zero plan chapters")
	}
	for _, c := range p.Chapters {
		// 专题切片的章可只带 focusFiles（targetPaths 为空数组合法，TS 侧 zod
		// 已放行）；结构校验只拦"双空"章——focusFiles 条目的路径真实性不做
		// 规划层判断，幻觉剔除统一交由预验证求交阶段（物理边界裁决）。
		if strings.TrimSpace(c.Name) == "" || (len(c.TargetPaths) == 0 && len(c.FocusFiles) == 0) {
			return nil, errors.New("invalid plan chapter (empty name, targets and focusFiles)")
		}
	}
	return &p, nil
}

// findSubtree 按折叠路径(相对根)找子树;目标也可以是单个文件
// (规划者常以 README 为第 1 章标的)——命中文件则包一个合成叶节点。
// 入口先归一化(根名前缀/斜杠/反引号),与 outline_sanitizer 同一宽容语义。
// 贯穿支持单链折叠节点深潜下钻（如 src/peft 内部子树 tuners/optimizers）。
func findSubtree(root *RepoTreeNode, path string) *RepoTreeNode {
	path = normalizeTargetPath(root.Name, path)
	if path == "" || path == root.Name || path == "." {
		return root // 规划者以根名为目标 = 整仓
	}
	// 1. 文件目标:全树叶子索引精确匹配（规划者常以 README.md 或具体源码文件为单章标的）
	if _, idx := root.leafFilesIndexed(); idx != nil {
		if f, ok := idx[path]; ok {
			return &RepoTreeNode{Path: f.Path, Name: f.Path, Files: []FileMap{*f}, FileCount: 1, LOC: f.LOC, Hotness: f.Hotness}
		}
	}

	// 2. 递归全路径精准匹配（直接击穿单链折叠节点，如 src/peft 内部的 tuners）
	if found := findSubtreeExact(root, path); found != nil {
		return found
	}

	// 3. 递归模糊匹配（支持短名、后缀及相对路径，如 tuners 或 peft/tuners）
	if found := findSubtreeFuzzy(root, path); found != nil {
		return found
	}

	// 4. 文件目标后缀兜底匹配（确定性字典序，仅当目录未命中时探测单文件）
	for _, f := range root.LeafFiles() {
		if strings.HasSuffix(f.Path, "/"+path) {
			return &RepoTreeNode{Path: f.Path, Name: f.Path, Files: []FileMap{f}, FileCount: 1, LOC: f.LOC, Hotness: f.Hotness}
		}
	}

	return nil
}

func findSubtreeExact(node *RepoTreeNode, target string) *RepoTreeNode {
	if node == nil {
		return nil
	}
	if node.Path == target {
		return node
	}
	for _, child := range node.Children {
		if found := findSubtreeExact(child, target); found != nil {
			return found
		}
	}
	return nil
}

func findSubtreeFuzzy(node *RepoTreeNode, target string) *RepoTreeNode {
	if node == nil {
		return nil
	}
	if node.Path != "" && (node.Path == target ||
		strings.HasSuffix(node.Path, "/"+target) ||
		node.Name == target ||
		strings.HasSuffix(node.Name, "/"+target)) {
		return node
	}
	for _, child := range node.Children {
		if found := findSubtreeFuzzy(child, target); found != nil {
			return found
		}
	}
	return nil
}

// teachingDepth 加权幅度基线（WP3.3：既有权重项为基线，深度项做加法而非重写；
// 幅度控制在基线主项之下，绝不覆盖文档/分层/热度等既有主信号）。
const (
	overviewDocBonus        = 200 // overview: 文档再加权（叠加基线 +500）
	overviewEntryBonus      = 180 // overview: 入口文件加权（index.*/main.*/mod.rs/__init__.py）
	overviewFacadeBonus     = 60  // overview: 门面导出（导出符号丰富 = 对外 API 面）
	overviewTestPenalty     = 100 // overview: 测试文件额外降权（叠加基线 -150）
	overviewDeepInternalPen = 120 // overview: 深层内部实现降权
	deepHotBonusHigh        = 120 // deep: 高热核心引擎（Hotness >= 60）
	deepHotBonusMid         = 60  // deep: 中热核心（Hotness >= 30）
	deepLocBonus            = 60  // deep: 大体量非测试核心（LOC >= 300）
	deepSpecBonus           = 150 // deep: spec/invariant 契约验证文件
	facadeExportThreshold   = 6   // 门面导出判定：导出符号数阈值
)

// scoreSubtreeFile 为子树候选文件计算架构与教学权重。
// teachingDepth（WP3.3）：overview 提升文档/入口/门面导出、降权深层内部与测试；
// deep 提升高 Hotness/高 LOC 非测试核心与 spec/invariant 契约文件；
// 空串或 standard 仅按基线权重。
// thematic：跳过 IsDoc+500 与 IsConfig+200 两个入口偏置加分块（专题切片按
// 符号信噪比选材，不做文档霸权）；其余 Layer/Exports/Hotness/LOC/测试惩罚/
// teachingDepth 加减项全部保留。零关键词匹配，纯结构化字段门控。
func scoreSubtreeFile(f FileMap, teachingDepth string, thematic bool) int {
	score := 0
	// 1. 文档与 README 优先（架构导图与设计说明）——thematic 豁免
	if f.IsDoc && !thematic {
		score += 500
	}
	// 2. 主配置文件与包清单（模块元数据核心）——thematic 豁免
	if f.IsConfig && !thematic {
		score += 200
	}
	// 3. 架构核心拓扑分层 (Foundation > Pipeline > Interface)
	switch f.Layer {
	case LayerFoundation:
		score += 150
	case LayerPipeline:
		score += 100
	case LayerInterface:
		score += 80
	}
	// 4. 导出符号数 (每个符号 +10 分，最多 120 分)
	expCount := len(f.Exports)
	if expCount > 12 {
		expCount = 12
	}
	score += expCount * 10

	// 5. 跨文件调用热度 Hotness (最多 100 分)
	if f.Hotness > 100 {
		score += 100
	} else if f.Hotness > 0 {
		score += f.Hotness
	}
	// 6. 正常实现代码量奖励 (50 ~ 800 行代码最佳)
	if f.LOC >= 50 && f.LOC <= 800 {
		score += 30
	}
	// 7. 测试文件降权（除非子树全为测试文件）
	if f.IsTest {
		score -= 150
	}
	// 8. 教学深度加权（确定性加法项，不改写基线）
	switch teachingDepth {
	case TeachingDepthOverview:
		if f.IsDoc {
			score += overviewDocBonus
		}
		if isEntrypointPath(f.Path) {
			score += overviewEntryBonus
		}
		if len(f.Exports) >= facadeExportThreshold {
			score += overviewFacadeBonus
		}
		if f.IsTest {
			score -= overviewTestPenalty
		}
		if isDeepInternalPath(f.Path) {
			score -= overviewDeepInternalPen
		}
	case TeachingDepthDeep:
		if !f.IsTest {
			if f.Hotness >= 60 {
				score += deepHotBonusHigh
			} else if f.Hotness >= 30 {
				score += deepHotBonusMid
			}
			if f.LOC >= 300 {
				score += deepLocBonus
			}
		}
		if isSpecInvariantPath(f.Path) {
			score += deepSpecBonus
		}
	}
	return score
}

// isEntrypointPath 入口文件判定：index.*、main.* 与语言惯用入口
// （mod.rs、__init__.py）。路径基名的字符串判定（1D 纯文本安全区，
// 非代码语法扫描）。
func isEntrypointPath(p string) bool {
	base := path.Base(p)
	return strings.HasPrefix(base, "index.") ||
		strings.HasPrefix(base, "main.") ||
		base == "mod.rs" ||
		base == "__init__.py"
}

// isDeepInternalPath 深层内部实现判定：internal 目录或目录深度 >= 4。
func isDeepInternalPath(p string) bool {
	if strings.Contains(p, "/internal/") ||
		strings.HasPrefix(p, "internal/") ||
		strings.Contains(p, "/.internal/") {
		return true
	}
	return strings.Count(p, "/") >= 4
}

// isSpecInvariantPath spec/invariant 契约验证文件判定：词元级匹配
// （按 . - _ 拆分基名，杜绝 inspect 误含 spec 的子串误命中）。
func isSpecInvariantPath(p string) bool {
	base := path.Base(p)
	for _, tok := range strings.FieldsFunc(base, func(r rune) bool {
		return r == '.' || r == '-' || r == '_'
	}) {
		switch tok {
		case "spec", "specs", "specification", "invariant", "invariants":
			return true
		}
	}
	return false
}

// sortSubtreeFilesByRelevance 确定性按架构与教学权重降序排列文件。
// thematic 透传 scoreSubtreeFile：跳过文档/配置入口偏置（专题中性排序）。
func sortSubtreeFilesByRelevance(files []FileMap, teachingDepth string, thematic bool) []FileMap {
	sorted := make([]FileMap, len(files))
	copy(sorted, files)
	sort.SliceStable(sorted, func(i, j int) bool {
		si := scoreSubtreeFile(sorted[i], teachingDepth, thematic)
		sj := scoreSubtreeFile(sorted[j], teachingDepth, thematic)
		if si != sj {
			return si > sj
		}
		return sorted[i].Path < sorted[j].Path
	})
	return sorted
}

// chunkFilesIntoOutlineChapters 将排序后的代表文件按课时容量切片成池供章节逐一认领。
func chunkFilesIntoOutlineChapters(files []FileMap, chunkSize int) []cognitive.OutlineChapter {
	if len(files) == 0 {
		return nil
	}
	if chunkSize <= 0 {
		chunkSize = drillChapterFileCap
	}
	var res []cognitive.OutlineChapter
	for i := 0; i < len(files); i += chunkSize {
		end := i + chunkSize
		if end > len(files) {
			end = len(files)
		}
		var cfiles []cognitive.ChapterFile
		for _, f := range files[i:end] {
			cfiles = append(cfiles, cognitive.ChapterFile{Path: f.Path})
		}
		res = append(res, cognitive.OutlineChapter{
			Files: cfiles,
		})
	}
	return res
}

func capFiles(files []FileMap, cap int, thematic bool) []FileMap {
	if len(files) <= cap {
		return files
	}
	// 分区摊开(与顶层提取同策略):子树内各子分区都有代表
	byTop := map[string][]FileMap{}
	var order []string
	for _, f := range files {
		seg := subSegment(f.Path)
		if _, ok := byTop[seg]; !ok {
			order = append(order, seg)
		}
		byTop[seg] = append(byTop[seg], f)
	}
	out := make([]FileMap, 0, cap)
	// README/docs 保底（thematic 豁免：专题切片不做文档霸权，与装甲层
	// WithoutReadmeBackfill 同一口径——保底注入会让专题外文档挤占配额）
	if !thematic {
		for _, f := range files {
			if len(out) >= cap {
				break
			}
			if f.IsDoc {
				out = append(out, f)
			}
		}
	}
	taken := map[string]bool{}
	for _, f := range out {
		taken[f.Path] = true
	}
	idx := make(map[string]int, len(order))
	for len(out) < cap {
		progressed := false
		for _, seg := range order {
			if len(out) >= cap {
				break
			}
			list := byTop[seg]
			i := idx[seg]
			if i < len(list) {
				if !taken[list[i].Path] {
					out = append(out, list[i])
					taken[list[i].Path] = true
				}
				idx[seg] = i + 1
				progressed = true
			}
		}
		if !progressed {
			break
		}
	}
	return out
}

// subSegment 子树内的次级分区键(相对子树根的下一级目录)。
func subSegment(rel string) string {
	rest := rel
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		rest = rest[i+1:]
	}
	if i := strings.IndexByte(rest, '/'); i > 0 {
		return rest[:i]
	}
	return "(root)"
}

var _ = mdpat.EstimateTokens // 保持 mdpat 依赖(P2 后续按子树计预算)

// MaxCompanionsPerLesson 单课时关联协同文件预算上限(保持轻量与聚焦)
const MaxCompanionsPerLesson = 10

func commonDirDepth(p1, p2 string) int {
	d1 := strings.Split(strings.Trim(path.Dir(p1), "/."), "/")
	d2 := strings.Split(strings.Trim(path.Dir(p2), "/."), "/")
	if len(d1) == 1 && d1[0] == "" {
		d1 = nil
	}
	if len(d2) == 1 && d2[0] == "" {
		d2 = nil
	}
	if len(d1) == 0 && len(d2) == 0 {
		return 1 // 同在根目录
	}
	if len(d1) == 0 || len(d2) == 0 {
		return 0 // 一在根目录，一在子目录
	}
	depth := 0
	minLen := len(d1)
	if len(d2) < minLen {
		minLen = len(d2)
	}
	for i := 0; i < minLen; i++ {
		if d1[i] == d2[i] {
			depth++
		} else {
			break
		}
	}
	return depth
}

// astEdgeCompanionPriority 第一轮（AST 边）优先级加成，绝对压倒任何目录
// 深度权重（depth*100 封顶不过数百，+10000 保证字典序第一段恒胜出）。
const astEdgeCompanionPriority = 10000

// genericImportDirSegments 导入归属匹配时忽略的通用目录段名（防 import
// 末段命中 src/lib 等通用段造成弱误连；与 monorepoManifestBasenames 同款
// 集中常量，非散落硬编码）。
var genericImportDirSegments = map[string]struct{}{
	"src": {}, "lib": {}, "internal": {}, "pkg": {}, "cmd": {},
	"public": {}, "dist": {}, "build": {}, "types": {}, "node_modules": {},
}

// AttachSubtreeCompanionsWithMap 将子树或仓库中未被选为主课时的物理文件
// 按两段字典序挂载至各章主课时的 CompanionFiles（WP4.2 AST 边优先）：
//   - 第一轮：仅挂有直接 CallEdges/Imports 关系且与章节主文件同属一个
//     SubsystemSpec.Prefix 的文件（astEdgeCompanionPriority +10000，
//     大于任何 depth*100）；
//   - 第二轮：同子系统内 depth*100 - len(companions) 补位；
//   - 严禁仅因共享 packages/（depth==1）跨子包错挂——子系统清单非空时
//     跨 SubsystemSpec 的文件两轮皆不挂载。
//
// thematic（variadic 追加，缺省 false = 历史行为零漂移）：专题切片只执行
// 第一轮 AST 边挂载，跳过第二轮同子系统目录补位——专题协同只信 AST 物理
// 边，目录就近的弱信号会让专题外文件挤占协同预算（深度 1 调用点不传参
// 自动兼容，无需改动）。
func AttachSubtreeCompanionsWithMap(chapters []cognitive.OutlineChapter, root *RepoTreeNode, m *RepoMap, subsystems []SubsystemSpec, thematic ...bool) {
	th := false
	if len(thematic) > 0 {
		th = thematic[0]
	}
	attachSubtreeCompanions(chapters, root, m, subsystems, th)
}

// attachSubtreeCompanions 挂载核心实现（m/subsystems 均 nil 安全：
// 双 nil 退化为纯目录拓扑就近挂载的历史行为）。
func attachSubtreeCompanions(chapters []cognitive.OutlineChapter, root *RepoTreeNode, m *RepoMap, subsystems []SubsystemSpec, thematic bool) {
	if len(chapters) == 0 || root == nil {
		return
	}

	primarySet := make(map[string]bool)
	for _, ch := range chapters {
		for _, f := range ch.Files {
			if f.Path != "" {
				primarySet[f.Path] = true
			}
		}
	}

	allLeaves := root.LeafFiles()
	var unselected []FileMap
	for _, lf := range allLeaves {
		if !primarySet[lf.Path] {
			unselected = append(unselected, lf)
		}
	}
	if len(unselected) == 0 {
		return
	}

	// 稳定排序：按代码行数/重要性降序，路径升序
	sort.Slice(unselected, func(i, j int) bool {
		if unselected[i].LOC != unselected[j].LOC {
			return unselected[i].LOC > unselected[j].LOC
		}
		return unselected[i].Path < unselected[j].Path
	})

	// 物理 AST 事实：CallEdges 邻接表（caller -> callee 集合），nil 安全
	var callAdj map[string]map[string]bool
	// 主课时文件的 Import 事实回查（ChapterFile 无载荷；仅当主文件存在于
	// 提取集 m.Files 时有 Imports，未提取文件只享受 CallEdges 边）
	primaryImports := map[string][]string{}
	if m != nil {
		if len(m.CallEdges) > 0 {
			callAdj = make(map[string]map[string]bool, len(m.CallEdges))
			for _, e := range m.CallEdges {
				if callAdj[e.Caller] == nil {
					callAdj[e.Caller] = make(map[string]bool)
				}
				callAdj[e.Caller][e.Callee] = true
			}
		}
		for _, f := range m.Files {
			primaryImports[f.Path] = f.Imports
		}
	}

	// 子系统归属（最长前缀匹配，与 finalizeSubsystemSpecs 同一语义）：
	// 无清单时全集视为同一隐含子系统（单包仓退化为历史目录拓扑行为）
	subsystemExists := len(subsystems) > 0
	prefixIndex := make(map[string]int, len(subsystems))
	prefixes := make([]string, 0, len(subsystems))
	for i, s := range subsystems {
		if _, dup := prefixIndex[s.Prefix]; !dup {
			prefixIndex[s.Prefix] = i
			prefixes = append(prefixes, s.Prefix)
		}
	}
	subsystemIndexOf := func(p string) int {
		best := longestMatchingPrefix(p, prefixes)
		if best == "" {
			return -1
		}
		return prefixIndex[best]
	}

	mounted := make(map[string]bool, len(unselected))
	// 两段字典序：第一轮 AST 边文件挂满，第二轮同子系统 depth 补位。
	// thematic 只跑第一轮（Pass 0）：专题协同只信 AST 物理边，同子系统
	// 目录补位的弱信号放行会让专题外文件挤占 MaxCompanionsPerLesson 预算。
	passLimit := 2
	if thematic {
		passLimit = 1
	}
	for pass := 0; pass < passLimit; pass++ {
		for _, u := range unselected {
			if mounted[u.Path] {
				continue
			}
			bestChIdx, bestFileIdx := -1, -1
			bestScore := -1

			for chIdx := range chapters {
				for fIdx := range chapters[chIdx].Files {
					pFile := &chapters[chIdx].Files[fIdx]
					if len(pFile.CompanionFiles) >= MaxCompanionsPerLesson {
						continue
					}
					depth := commonDirDepth(u.Path, pFile.Path)
					if depth <= 0 {
						continue
					}
					uSub, pSub := subsystemIndexOf(u.Path), subsystemIndexOf(pFile.Path)
					score := -1
					if pass == 0 {
						// 第一轮：直接 AST 边 + 同属一个子系统（双方均有归属）
						if uSub < 0 || uSub != pSub {
							continue
						}
						if !hasAstEdge(u, pFile.Path, primaryImports[pFile.Path], callAdj) {
							continue
						}
						score = astEdgeCompanionPriority + depth*100 - len(pFile.CompanionFiles)
					} else {
						// 第二轮：同子系统补位；子系统清单为空（或双方均无归属）时
						// 退回目录拓扑就近——绝不因共享 packages/（depth==1）跨子包错挂
						if subsystemExists && uSub != pSub {
							continue
						}
						score = depth*100 - len(pFile.CompanionFiles)
					}
					if score > bestScore {
						bestScore = score
						bestChIdx = chIdx
						bestFileIdx = fIdx
					}
				}
			}

			if bestChIdx >= 0 && bestFileIdx >= 0 {
				chapters[bestChIdx].Files[bestFileIdx].CompanionFiles = append(
					chapters[bestChIdx].Files[bestFileIdx].CompanionFiles,
					u.Path,
				)
				mounted[u.Path] = true
			}
		}
	}

	// 课时内协同文件升序规整
	for chIdx := range chapters {
		for fIdx := range chapters[chIdx].Files {
			comps := chapters[chIdx].Files[fIdx].CompanionFiles
			if len(comps) > 1 {
				sort.Strings(comps)
			}
		}
	}
}

// hasAstEdge 判定候选文件与主课时文件是否存在直接 AST 关系：
// CallEdges 双向直达，或 Imports 模块名与对方路径目录段的保守归属
// （如 import "@vue/runtime-core" 命中 packages/runtime-core/src/index.ts）。
// 主课时侧按 ChapterFile 的 Path/Imports 字段取用（其无 FileMap 载荷）。
func hasAstEdge(u FileMap, pPath string, pImports []string, callAdj map[string]map[string]bool) bool {
	if callAdj != nil && (callAdj[u.Path][pPath] || callAdj[pPath][u.Path]) {
		return true
	}
	for _, imp := range u.Imports {
		if importMatchesFile(imp, pPath) {
			return true
		}
	}
	for _, imp := range pImports {
		if importMatchesFile(imp, u.Path) {
			return true
		}
	}
	return false
}

// importMatchesFile 保守导入归属：导入路径末段命中文件任一目录段名
// （宁缺毋滥：通用段名 src/lib 等不参与匹配，杜绝弱信号误连）。
func importMatchesFile(imp, filePath string) bool {
	imp = strings.Trim(strings.TrimSpace(imp), "\"'")
	if i := strings.LastIndexByte(imp, '/'); i >= 0 {
		imp = imp[i+1:]
	}
	if imp == "" {
		return false
	}
	if _, generic := genericImportDirSegments[imp]; generic {
		return false
	}
	for _, seg := range strings.Split(path.Dir(filePath), "/") {
		if seg != "" && seg == imp {
			return true
		}
	}
	return false
}

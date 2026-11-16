package pipelineb

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// OutlineSamplerPurpose 网关 purpose 名（与 apps/client registry.ts 单一登记对应）。
const OutlineSamplerPurpose = "outline_sampler_v1"

// 采样策略可观测标签（契约 C4）：仅用于服务端结构化日志与接口 stats，
// 绝不渲染进导入向导 UI（最小文案公理）。
const (
	SamplingStrategyFullAst           = "full-ast"           // 策略 A：阈值内全量确定性 AST 建图（LLM 采样器短路）
	SamplingStrategyStratified        = "stratified"         // 策略 B：子系统分层配额抽样
	SamplingStrategyStratifiedPartial = "stratified-partial" // 策略 B 并发拉取部分成功（批次失败/墙钟截断，fail-open 续跑）
	SamplingStrategyPartialAst        = "partial-ast"        // 策略 A 并发拉取被墙钟/批次失败截断
	SamplingStrategyFallback8         = "fallback-8"         // 规则兜底入口文件（沿袭 8 文件硬帽族名）
)

// MaxSampledCoreFiles 单次 AI 采样与批量抓取的默认硬防御保护帽（最多 25 个文件）。
const MaxSampledCoreFiles = 25

// StratifiedSampleCapEnvVar 策略 B 总抽样上限环境变量（零硬编码红线）。
const StratifiedSampleCapEnvVar = "TREE_FIRST_STRATIFIED_CAP"

// 策略 B 自适应总上限：min(50, max(25, 活跃子系统数×3))，环境变量可整体覆盖。
const (
	stratifiedCapFloor        = 25
	stratifiedCapCeiling      = 50
	stratifiedCapPerSubsystem = 3
)

// stratifiedSampleCap 策略 B 总抽样上限：随活跃子系统数自适应扩展。
func stratifiedSampleCap(subsystemCount int) int {
	if v := os.Getenv(StratifiedSampleCapEnvVar); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return min(stratifiedCapCeiling, max(stratifiedCapFloor, subsystemCount*stratifiedCapPerSubsystem))
}

// OutlineSamplerResult AI 架构审阅与自主点名输出结构体。
type OutlineSamplerResult struct {
	ArchitectureArchetype string   `json:"architectureArchetype"`
	SubsystemCount        int      `json:"subsystemCount"`
	NeedFiles             []string `json:"needFiles"`
}

// SampleRequest 采样器输入契约（契约 C5）：骨架 + README + 作用域 + 用户选定条件——
// 教学深度/学习者画像/自定义指令自请求全链路贯穿至采样决策（WP3，零额外往返）。
type SampleRequest struct {
	Skeleton         string
	Readme           string
	Prefix           string
	TeachingDepth    string
	LearnerArchetype string
	CustomPrompt     string
}

// OutlineSampler AI 核心文件采样接口。
type OutlineSampler interface {
	SampleCoreFiles(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error)
}

// GatewaySampler 基于 LLM 网关的采样器实现。
type GatewaySampler struct {
	Client LlmGateway
	UserID *string
	// 用户选定条件（策略 B 采样定向）：由 samplerForReq 从请求克隆挂载，
	// 非空时注入网关 vars（键名 teachingDepth / learnerArchetype / customPrompt，契约 C3）
	CustomPrompt     string
	TeachingDepth    string
	LearnerArchetype string
}

// SampleCoreFiles 投喂项目骨架 + README + 用户选定条件，调用 LLM 网关自主点名需要深入提取 AST 的核心文件。
func (s *GatewaySampler) SampleCoreFiles(ctx context.Context, req SampleRequest) (*OutlineSamplerResult, error) {
	if s == nil || s.Client == nil {
		return nil, errors.New("sampler gateway client not configured")
	}
	vars := map[string]any{
		"skeleton": req.Skeleton,
		"readme":   req.Readme,
	}
	if req.Prefix != "" {
		vars["prefix"] = req.Prefix
	}
	if s.TeachingDepth != "" {
		vars["teachingDepth"] = s.TeachingDepth
	}
	if s.LearnerArchetype != "" {
		vars["learnerArchetype"] = s.LearnerArchetype
	}
	if s.CustomPrompt != "" {
		vars["customPrompt"] = s.CustomPrompt
	}

	var res OutlineSamplerResult
	if err := s.Client.Generate(ctx, OutlineSamplerPurpose, vars, s.UserID, &res); err != nil {
		return nil, fmt.Errorf("gateway %s: %w", OutlineSamplerPurpose, err)
	}
	return &res, nil
}

var _ OutlineSampler = (*GatewaySampler)(nil)

// SanitizeSampledPaths 将 AI 抽样返回的路径列表与真实 Git Tree 条目求交集，
// 丢弃所有幻觉路径、空路径、目录路径；支持 Monorepo 子卷 prefixScope 相对路径自动补齐；
// 严格限制最多 25 个文件（maxFiles 可覆盖默认帽，策略 B 大配额场景使用）。
func SanitizeSampledPaths(needFiles []string, entries []client.GitTreeEntry, prefixScope string, maxFiles ...int) []string {
	if len(needFiles) == 0 || len(entries) == 0 {
		return nil
	}
	capLimit := MaxSampledCoreFiles
	if len(maxFiles) > 0 && maxFiles[0] > 0 {
		capLimit = maxFiles[0]
	}
	scope := strings.Trim(filepath.ToSlash(prefixScope), "/ ")

	validBlobs := make(map[string]bool, len(entries))
	for _, e := range entries {
		if e.Type == "blob" && e.Size > 0 {
			rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
			validBlobs[rel] = true
		}
	}

	seen := make(map[string]bool, len(needFiles))
	out := make([]string, 0, len(needFiles))

	for _, raw := range needFiles {
		clean := strings.Trim(filepath.ToSlash(raw), "/ ")
		if clean == "" {
			continue
		}
		// 若指定了 prefixScope，支持两种合法返回：
		// 1. 全路径：已包含 scope 前缀 (e.g. "packages/core/src/index.ts")
		// 2. 相对路径：在子卷作用域内的纯相对路径 (e.g. "src/index.ts")，自动补全 scope 前缀
		if scope != "" {
			if !strings.HasPrefix(clean+"/", scope+"/") {
				scopedCandidate := scope + "/" + clean
				if validBlobs[scopedCandidate] {
					clean = scopedCandidate
				} else {
					continue
				}
			}
		}
		if seen[clean] || !validBlobs[clean] {
			continue // 丢弃已见路径与幻觉路径
		}
		seen[clean] = true
		out = append(out, clean)
		if len(out) >= capLimit {
			break
		}
	}
	return out
}

// FindReadmePathFromEntries 从 Git Tree 条目中找出主 README 文件路径（支持 prefix 作用域，子卷无 README 时平滑回退至仓库根 README）。
func FindReadmePathFromEntries(entries []client.GitTreeEntry, prefixScope string) string {
	scope := strings.Trim(filepath.ToSlash(prefixScope), "/ ")
	if scope != "" {
		if path := findReadmeInScope(entries, scope); path != "" {
			return path
		}
	}
	return findReadmeInScope(entries, "")
}

func findReadmeInScope(entries []client.GitTreeEntry, scope string) string {
	var candidate string
	var candidateRank int

	for _, e := range entries {
		if e.Type != "blob" || e.Size <= 0 {
			continue
		}
		rel := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		relScoped := rel
		if scope != "" {
			if !strings.HasPrefix(rel+"/", scope+"/") {
				continue
			}
			relScoped = strings.TrimPrefix(rel, scope+"/")
		}

		depth := strings.Count(relScoped, "/")
		if depth != 0 {
			continue // 仅考虑该层级的直属文件
		}

		base := filepath.Base(relScoped)
		lower := strings.ToLower(base)

		rank := 0
		if lower == "readme.md" {
			rank = 100
		} else if lower == "readme" {
			rank = 90
		} else if lower == "readme.rst" || lower == "readme.txt" {
			rank = 80
		} else if strings.HasPrefix(lower, "readme") {
			rank = 50
		}

		if rank > candidateRank {
			candidateRank = rank
			candidate = rel
		}
	}
	return candidate
}

// SampleOrFallbackCoreFiles 策略 B 采样编排：AI 架构审阅自主点名 + 子系统配额保底；
// 若 AI 采样超时 (4s 截止)、失败或求交后为空，则平滑 fail-open 回退至基于规则的
// 子系统配额入口文件。返回 (核心文件路径集, 采样模式 "stratified" | "fallback-8")。
// subsystems 为契约 C1 SSOT 的子系统划分；为空（单包仓库）时保持既有全仓扁平语义。
func SampleOrFallbackCoreFiles(
	ctx context.Context,
	sampler OutlineSampler,
	entries []client.GitTreeEntry,
	sreq SampleRequest,
	patterns cognitive.Patterns,
	subsystems []SubsystemSpec,
) ([]string, string) {
	totalCap := stratifiedSampleCap(len(subsystems))

	var sampled []string
	if sampler != nil {
		sampleCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		defer cancel()

		res, err := sampler.SampleCoreFiles(sampleCtx, sreq)
		if err == nil && res != nil && len(res.NeedFiles) > 0 {
			sampled = SanitizeSampledPaths(res.NeedFiles, entries, sreq.Prefix, totalCap)
		} else if err != nil {
			log.Printf("[pipelineb] outline sampler error, falling back: %v", err)
		}
	}

	if len(sampled) > 0 {
		// 策略 B 配额保底：AI 点名未覆盖的非辅助子系统补足入口/导出文件
		if len(subsystems) > 0 {
			sampled = FillSubsystemQuotaFiles(sampled, entries, patterns, subsystems, sreq.Prefix, totalCap)
		}
		return sampled, SamplingStrategyStratified
	}

	// Fail-open 兜底：规则配额入口文件（子系统配额化；总量仍 ≤ 8）
	if len(subsystems) > 0 {
		return SelectCoreFilesFromTreeSubsystemQuota(entries, patterns, 8, subsystems, sreq.Prefix), SamplingStrategyFallback8
	}
	return SelectCoreFilesFromTree(entries, patterns, 8, sreq.Prefix), SamplingStrategyFallback8
}

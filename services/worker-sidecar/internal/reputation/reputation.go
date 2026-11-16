package reputation

import (
	"strconv"
	"strings"
	"time"
)

// Tier 仓库信誉等级。
type Tier string

const (
	// TierA 高信誉经典巨仓 (High-Reputation Classic Mega-Repo)
	TierA Tier = "high"
	// TierB 标准常规仓库 (Standard Repository)
	TierB Tier = "standard"
	// TierC 低信誉可疑仓库 (Suspicious / Potential Bomb)
	TierC Tier = "suspicious"
)

// QuotaLimits 对应信誉等级的物理资源配额。
type QuotaLimits struct {
	MaxUnpackCapBytes int64 `json:"maxUnpackCapBytes"` // 归档解压总容量上限 (字节)
	MaxFiles          int   `json:"maxFiles"`          // 最大允许有效文件数
	AllowGiantScope   bool  `json:"allowGiantScope"`   // 是否允许在巨仓规模下通过自适应剪枝进入转录
}

// TierQuotas 各信誉等级对应的物理防线配额。
var TierQuotas = map[Tier]QuotaLimits{
	TierA: {
		MaxUnpackCapBytes: 250 * 1024 * 1024, // 250MB
		MaxFiles:          8000,
		AllowGiantScope:   true,
	},
	TierB: {
		MaxUnpackCapBytes: 80 * 1024 * 1024, // 80MB
		MaxFiles:          2000,
		AllowGiantScope:   false,
	},
	TierC: {
		MaxUnpackCapBytes: 30 * 1024 * 1024, // 30MB
		MaxFiles:          800,
		AllowGiantScope:   false,
	},
}

// RepoMeta 仓库信誉评估元数据入参。
type RepoMeta struct {
	Owner     string     `json:"owner"`
	Repo      string     `json:"repo"`
	Stars     int        `json:"stars"`
	Forks     int        `json:"forks"`
	CreatedAt *time.Time `json:"createdAt,omitempty"`
	NodeCount int        `json:"nodeCount,omitempty"` // 可选：Scout 探测到的文件节点数
	SizeHint  int64      `json:"sizeHint,omitempty"`  // 可选：GitHub API 返回的 size (字节)
}

// EvaluationResult 评估结果。
type EvaluationResult struct {
	Tier       Tier        `json:"tier"`
	Reason     string      `json:"reason"`
	Quotas     QuotaLimits `json:"quotas"`
	IsClassic  bool        `json:"isClassic"`  // 是否为经典高价值开源项目
	IsRejected bool        `json:"isRejected"` // 是否应在门禁处阻断
}

// EvaluateRepoReputation 评估仓库信誉梯队（确定性纯函数，0 LLM 开销）。
func EvaluateRepoReputation(meta RepoMeta) EvaluationResult {
	owner := strings.ToLower(strings.TrimSpace(meta.Owner))
	isAuthOrg := IsKnownAuthorityOrg(owner)

	// 1. Tier A 判定：高信誉经典巨仓
	// 条件：权威组织 或 Stars >= 1000 或 Forks >= 200
	if isAuthOrg || meta.Stars >= 1000 || meta.Forks >= 200 {
		reason := "社区知名高价值开源项目"
		if isAuthOrg {
			reason = "权威开源组织认证项目 (" + meta.Owner + ")"
		} else if meta.Stars >= 1000 {
			reason = "高星标开源项目 (Stars: " + formatStars(meta.Stars) + ")"
		}
		return EvaluationResult{
			Tier:       TierA,
			Reason:     reason,
			Quotas:     TierQuotas[TierA],
			IsClassic:  true,
			IsRejected: false,
		}
	}

	// 2. Tier C 判定：疑似资源炸弹 / 低信誉超标仓
	// 条件：Stars <= 10 且存在规模过大迹象 (文件数 > 2000 或 单仓体积预计 > 60MB)
	// 或者创建时间在 90 天内且没有任何社群背书却拥有上千文件
	isLowStar := meta.Stars <= 10
	isNewRepo := false
	if meta.CreatedAt != nil && time.Since(*meta.CreatedAt) < 90*24*time.Hour {
		isNewRepo = true
	}

	isOversizedForLowStar := meta.NodeCount > 2000 || (meta.SizeHint > 0 && meta.SizeHint > 60*1024*1024)
	if isLowStar && (isOversizedForLowStar || (isNewRepo && meta.NodeCount > 1000)) {
		return EvaluationResult{
			Tier:       TierC,
			Reason:     "仓库规模超限且社区信誉背书不足 (Stars <= 10)，触发资源炸弹防护门禁",
			Quotas:     TierQuotas[TierC],
			IsClassic:  false,
			IsRejected: true,
		}
	}

	// 3. Tier B 判定：常规开源与个人仓库
	return EvaluationResult{
		Tier:       TierB,
		Reason:     "常规开源仓库，适用标准资源配额",
		Quotas:     TierQuotas[TierB],
		IsClassic:  false,
		IsRejected: false,
	}
}

func formatStars(n int) string {
	if n >= 1000 {
		return strconv.Itoa(n/1000) + "k+"
	}
	return strconv.Itoa(n)
}

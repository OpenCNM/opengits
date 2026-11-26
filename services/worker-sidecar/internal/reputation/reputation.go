package reputation

import (
	"strconv"
	"strings"
	"time"
)

type Tier string

const (
	TierA Tier = "high"
	TierB Tier = "standard"
	TierC Tier = "suspicious"
)

type QuotaLimits struct {
	MaxUnpackCapBytes int64 `json:"maxUnpackCapBytes"`
	MaxFiles          int   `json:"maxFiles"`
	AllowGiantScope   bool  `json:"allowGiantScope"`
}

var TierQuotas = map[Tier]QuotaLimits{
	TierA: {
		MaxUnpackCapBytes: 250 * 1024 * 1024,
		MaxFiles:          8000,
		AllowGiantScope:   true,
	},
	TierB: {
		MaxUnpackCapBytes: 80 * 1024 * 1024,
		MaxFiles:          2000,
		AllowGiantScope:   false,
	},
	TierC: {
		MaxUnpackCapBytes: 30 * 1024 * 1024,
		MaxFiles:          800,
		AllowGiantScope:   false,
	},
}

type RepoMeta struct {
	Owner     string     `json:"owner"`
	Repo      string     `json:"repo"`
	Stars     int        `json:"stars"`
	Forks     int        `json:"forks"`
	CreatedAt *time.Time `json:"createdAt,omitempty"`
	NodeCount int        `json:"nodeCount,omitempty"`
	SizeHint  int64      `json:"sizeHint,omitempty"`
}

type EvaluationResult struct {
	Tier       Tier        `json:"tier"`
	Reason     string      `json:"reason"`
	Quotas     QuotaLimits `json:"quotas"`
	IsClassic  bool        `json:"isClassic"`
	IsRejected bool        `json:"isRejected"`
}

func EvaluateRepoReputation(meta RepoMeta) EvaluationResult {
	owner := strings.ToLower(strings.TrimSpace(meta.Owner))
	isAuthOrg := IsKnownAuthorityOrg(owner)

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

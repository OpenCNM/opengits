package transcription

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ─────────────────────────────────────────────────────────────
// 接力转录契约三件套之「编译器 + 对源硬门」（Go 镜像，2026-10 下沉）：
// 逐字对齐 apps/client/src/lib/update-market/contract.ts 的
// compileRelayMdx / l0RelayGate / countCodeBlocks / countHeadings——
// 两侧任何骨架规则/阈值语义变更必须同步（relay-contract.test.ts 与
// relay_contract_test.go 互为对拍锚点）。输出 schema 的 zod 校验在
// web 网关 purpose 层完成（单一事实源 lib/schemas/relay-contract.ts）。
// ─────────────────────────────────────────────────────────────

// RelaySection 接力章节段（type: intro|prose|code|summary）。
type RelaySection struct {
	Type      string `json:"type"`
	Heading   string `json:"heading"`
	Content   string `json:"content"`
	SourceRef string `json:"sourceRef,omitempty"`
}

// RelayConceptAnchor 术语锚点（源文术语 → 本书译法）。
type RelayConceptAnchor struct {
	Term        string `json:"term"`
	Translation string `json:"translation"`
}

// RelayTranscription 网关 structured purpose 的 object 载荷
// （zod RelayTranscriptionSchema 的 Go 承载）。
type RelayTranscription struct {
	Title          string               `json:"title"`
	Sections       []RelaySection       `json:"sections"`
	ConceptAnchors []RelayConceptAnchor `json:"conceptAnchors"`
	Coverage       struct {
		SourceSections  int `json:"sourceSections"`
		CoveredSections int `json:"coveredSections"`
	} `json:"coverage"`
}

// relay 计数正则（与 TS 同锚点语义：行首围栏/缩进块/ATX 标题）。
// 围栏正则经字符串拼接携带反引号（Go 原生字符串不能内嵌反引号）。
var (
	relayFenceRe   = regexp.MustCompile(`(?m)^` + "```")
	relayIndentRe  = regexp.MustCompile(`(?m)^(?: {4,}|\t+)\S`)
	relayHeadingRe = regexp.MustCompile(`(?m)^#{1,6}\s+\S`)
)

// countCodeBlocks 源文围栏代码块数（``` 计数的一半向上取整容错不平衡；
// 无围栏时缩进式代码块兜底计 1）——逐字对齐 contract.ts countCodeBlocks。
func countCodeBlocks(raw string) int {
	fences := len(relayFenceRe.FindAllString(raw, -1))
	if fences == 0 {
		if len(relayIndentRe.FindAllString(raw, -1)) > 0 {
			return 1
		}
		return 0
	}
	return int(math.Ceil(float64(fences) / 2))
}

// countHeadings 源文 ATX 标题数（# ~ ######）。
func countHeadings(raw string) int {
	return len(relayHeadingRe.FindAllString(raw, -1))
}

// relayGateThresholds 对源硬门阈值（env 名与默认值逐字对齐
// lib/config.ts updateMarket.relayGate——热调口径两侧一致）。
type relayGateThresholds struct {
	CodeBlockRetention float64
	HeadingCoverage    float64
	LengthRatioMin     float64
	LengthRatioMax     float64
}

func relayGateFromEnv() relayGateThresholds {
	envFloat := func(name string, def float64) float64 {
		if v := os.Getenv(name); v != "" {
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				return f
			}
		}
		return def
	}
	return relayGateThresholds{
		CodeBlockRetention: envFloat("UPDATE_RELAY_CODE_RETENTION", 0.9),
		HeadingCoverage:    envFloat("UPDATE_RELAY_HEADING_COVERAGE", 0.7),
		LengthRatioMin:     envFloat("UPDATE_RELAY_LENGTH_MIN", 0.4),
		LengthRatioMax:     envFloat("UPDATE_RELAY_LENGTH_MAX", 3),
	}
}

// RelayGateResult 对源硬门判定（对源校验，非对旧版；确定性零成本）。
type RelayGateResult struct {
	Passed bool
	Reason string
}

// relayGate L0-R：代码块保全 / 标题覆盖 / 长度带宽——逐字对齐
// contract.ts l0RelayGate 的判定序与含等边界（≥ 最低值即过）。
func relayGate(g relayGateThresholds, compiledMdx, sourceRaw string) RelayGateResult {
	if strings.TrimSpace(sourceRaw) == "" {
		return RelayGateResult{false, "源文件缺失，无法对源校验"}
	}
	if utf8.RuneCountInString(strings.TrimSpace(compiledMdx)) < 50 {
		return RelayGateResult{false, "译文过短"}
	}

	srcBlocks := countCodeBlocks(sourceRaw)
	srcHeadings := countHeadings(sourceRaw)
	outBlocks := countCodeBlocks(compiledMdx)
	outHeadings := countHeadings(compiledMdx)

	if srcBlocks > 0 {
		minBlocks := max(1, int(math.Ceil(float64(srcBlocks)*g.CodeBlockRetention)))
		if outBlocks < minBlocks {
			return RelayGateResult{false, fmt.Sprintf("代码块丢失：源 %d 个，译文仅 %d 个（要求 ≥%d）", srcBlocks, outBlocks, minBlocks)}
		}
	}
	// 标题覆盖（源标题极少时跳过——无判别力）
	if srcHeadings > 2 {
		minHeadings := int(math.Ceil(float64(srcHeadings) * g.HeadingCoverage))
		if outHeadings < minHeadings {
			return RelayGateResult{false, fmt.Sprintf("小节覆盖不足：源 %d 节，译文仅 %d 节（要求 ≥%d）", srcHeadings, outHeadings, minHeadings)}
		}
	}

	ratio := float64(utf8.RuneCountInString(compiledMdx)) / math.Max(1, float64(utf8.RuneCountInString(sourceRaw)))
	if ratio < g.LengthRatioMin {
		return RelayGateResult{false, fmt.Sprintf("译文长度仅为源文 %d%%（低于 %d%%）", int(ratio*100), int(g.LengthRatioMin*100))}
	}
	if ratio > g.LengthRatioMax {
		return RelayGateResult{false, fmt.Sprintf("译文长度达源文 %.1f 倍（超过 %g 倍）", ratio, g.LengthRatioMax)}
	}
	return RelayGateResult{Passed: true}
}

// compileRelayMdx 确定性编译器：schema → 统一 MDX。骨架规则逐字对齐
// contract.ts：H1=title；intro 段直排；其余 `## heading`；锚点以 HTML
// 注释附尾。全书排版由本函数唯一决定（不依赖模型自觉）。
func compileRelayMdx(obj RelayTranscription) string {
	parts := []string{fmt.Sprintf("# %s", strings.TrimSpace(obj.Title))}
	for _, section := range obj.Sections {
		content := strings.TrimSpace(section.Content)
		if section.Type == "intro" {
			parts = append(parts, content)
		} else {
			parts = append(parts, fmt.Sprintf("## %s\n\n%s", strings.TrimSpace(section.Heading), content))
		}
	}
	if len(obj.ConceptAnchors) > 0 {
		anchors := make([]string, 0, len(obj.ConceptAnchors))
		for _, a := range obj.ConceptAnchors {
			anchors = append(anchors, fmt.Sprintf("%s=%s", a.Term, a.Translation))
		}
		parts = append(parts, fmt.Sprintf("<!-- relay-anchors: %s -->", strings.Join(anchors, "; ")))
	}
	return strings.Join(parts, "\n\n")
}

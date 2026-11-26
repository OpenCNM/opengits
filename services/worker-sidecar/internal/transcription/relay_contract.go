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

// Mirrors TS lib/update-market/contract.ts (compileRelayMdx/l0RelayGate); layout and thresholds must stay synced.

type RelaySection struct {
	Type      string `json:"type"`
	Heading   string `json:"heading"`
	Content   string `json:"content"`
	SourceRef string `json:"sourceRef,omitempty"`
}

type RelayConceptAnchor struct {
	Term        string `json:"term"`
	Translation string `json:"translation"`
}

type RelayTranscription struct {
	Title          string               `json:"title"`
	Sections       []RelaySection       `json:"sections"`
	ConceptAnchors []RelayConceptAnchor `json:"conceptAnchors"`
	Coverage       struct {
		SourceSections  int `json:"sourceSections"`
		CoveredSections int `json:"coveredSections"`
	} `json:"coverage"`
}

var (
	relayFenceRe   = regexp.MustCompile(`(?m)^` + "```")
	relayIndentRe  = regexp.MustCompile(`(?m)^(?: {4,}|\t+)\S`)
	relayHeadingRe = regexp.MustCompile(`(?m)^#{1,6}\s+\S`)
)

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

func countHeadings(raw string) int {
	return len(relayHeadingRe.FindAllString(raw, -1))
}

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

type RelayGateResult struct {
	Passed bool
	Reason string
}

// Validates compiled MDX against original source (not prior edition) with zero-cost deterministic thresholds.
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

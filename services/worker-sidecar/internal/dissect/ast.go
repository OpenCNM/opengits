package dissect

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/treesitter"
)

const MaxDissectSteps = 8

type DissectNode struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Kind        string `json:"kind"`
	StartLine   int    `json:"startLine"`
	EndLine     int    `json:"endLine"`
	Description string `json:"description"`
}

type DissectEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	Label  string `json:"label,omitempty"`
}

type DissectRequest struct {
	Code     string `json:"code"`
	Language string `json:"language"`
}

type DissectResponse struct {
	MermaidCode string        `json:"mermaidCode"`
	Nodes       []DissectNode `json:"nodes"`
	Edges       []DissectEdge `json:"edges"`
	Language    string        `json:"language"`
	IsAst       bool          `json:"isAst"`
}

func cleanMermaidLabel(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.ReplaceAll(s, `"`, `'`)
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", "")

	for strings.Contains(s, "  ") {
		s = strings.ReplaceAll(s, "  ", " ")
	}
	// Truncate by rune count so multi-byte UTF-8 CJK labels never split mid-character.
	if runes := []rune(s); len(runes) > 40 {
		s = string(runes[:37]) + "..."
	}
	if s == "" {
		return "执行逻辑"
	}
	return s
}

func ProjectCodeAst(ctx context.Context, engine *treesitter.Engine, code string, rawLang string) (*DissectResponse, error) {
	trimmed := strings.TrimSpace(code)
	if trimmed == "" {
		return emptyDissectResponse(rawLang), nil
	}

	lines := strings.Split(code, "\n")
	totalLines := len(lines)
	if totalLines == 0 {
		totalLines = 1
	}

	canonicalLang := treesitter.CanonicalLanguage(rawLang)
	var rawNodes []treesitter.ControlFlowNode
	var err error

	if engine != nil {
		rawNodes, err = engine.ExtractControlFlow(ctx, canonicalLang, []byte(code))
	}

	if err != nil || len(rawNodes) == 0 {
		return fallbackLineDissect(code, canonicalLang), nil
	}

	sort.Slice(rawNodes, func(i, j int) bool {
		if rawNodes[i].StartLine == rawNodes[j].StartLine {
			return rawNodes[i].EndLine < rawNodes[j].EndLine
		}
		return rawNodes[i].StartLine < rawNodes[j].StartLine
	})

	steps := buildClampedSteps(rawNodes, totalLines)

	return renderMermaidFlowchart(steps, canonicalLang), nil
}

func buildClampedSteps(raw []treesitter.ControlFlowNode, totalLines int) []DissectNode {
	if len(raw) <= MaxDissectSteps {
		var res []DissectNode
		for i, n := range raw {
			sLine := clampLine(n.StartLine, 1, totalLines)
			eLine := clampLine(n.EndLine, sLine, totalLines)
			lbl, desc := formatNodeLabelAndDesc(n.Kind, n.Name)
			res = append(res, DissectNode{
				ID:          fmt.Sprintf("N%d", i+1),
				Label:       lbl,
				Kind:        n.Kind,
				StartLine:   sLine,
				EndLine:     eLine,
				Description: desc,
			})
		}
		return res
	}

	clusterSize := (len(raw) + MaxDissectSteps - 1) / MaxDissectSteps
	var res []DissectNode
	for i := 0; i < len(raw); i += clusterSize {
		endIdx := i + clusterSize
		if endIdx > len(raw) {
			endIdx = len(raw)
		}
		group := raw[i:endIdx]
		first := group[0]
		last := group[len(group)-1]

		sLine := clampLine(first.StartLine, 1, totalLines)
		eLine := clampLine(last.EndLine, sLine, totalLines)
		lbl, desc := formatNodeLabelAndDesc(first.Kind, first.Name)

		res = append(res, DissectNode{
			ID:          fmt.Sprintf("N%d", len(res)+1),
			Label:       lbl,
			Kind:        first.Kind,
			StartLine:   sLine,
			EndLine:     eLine,
			Description: desc,
		})
		if len(res) == MaxDissectSteps {
			break
		}
	}
	return res
}

func formatNodeLabelAndDesc(kind, name string) (string, string) {
	cName := cleanMermaidLabel(name)
	switch kind {
	case "function":
		return fmt.Sprintf("入口: %s", cName), fmt.Sprintf("函数入口与参数初始化: %s", cName)
	case "branch":
		return fmt.Sprintf("分支: %s", cName), fmt.Sprintf("条件校验与流程分支: %s", cName)
	case "loop":
		return fmt.Sprintf("循环: %s", cName), fmt.Sprintf("迭代处理与数据流动: %s", cName)
	case "return":
		return fmt.Sprintf("返回: %s", cName), fmt.Sprintf("逻辑终结与结果返回: %s", cName)
	case "call":
		return fmt.Sprintf("调用: %s", cName), fmt.Sprintf("核心功能与外部交互: %s", cName)
	default:
		return cName, fmt.Sprintf("代码块执行: %s", cName)
	}
}

func renderMermaidFlowchart(nodes []DissectNode, lang string) *DissectResponse {
	var sb strings.Builder
	sb.WriteString("flowchart TD\n")

	var edges []DissectEdge
	for i, node := range nodes {

		safeLabel := node.Label
		switch node.Kind {
		case "branch":
			sb.WriteString(fmt.Sprintf("  %s{\"%s\"}\n", node.ID, safeLabel))
		case "loop":
			sb.WriteString(fmt.Sprintf("  %s([\"%s\"])\n", node.ID, safeLabel))
		case "return":
			sb.WriteString(fmt.Sprintf("  %s((\"%s\"))\n", node.ID, safeLabel))
		default:
			sb.WriteString(fmt.Sprintf("  %s[\"%s\"]\n", node.ID, safeLabel))
		}

		if i > 0 {
			prev := nodes[i-1]
			edgeID := fmt.Sprintf("e-%s-%s", prev.ID, node.ID)
			var edgeLabel string
			if prev.Kind == "branch" {
				edgeLabel = "继续"
			}
			if edgeLabel != "" {
				sb.WriteString(fmt.Sprintf("  %s -->|%s| %s\n", prev.ID, edgeLabel, node.ID))
			} else {
				sb.WriteString(fmt.Sprintf("  %s --> %s\n", prev.ID, node.ID))
			}
			edges = append(edges, DissectEdge{
				ID:     edgeID,
				Source: prev.ID,
				Target: node.ID,
				Label:  edgeLabel,
			})
		}
	}

	for _, node := range nodes {
		cleanDesc := strings.ReplaceAll(node.Description, `"`, `'`)
		sb.WriteString(fmt.Sprintf("  %%%% @Payload[%s]: {\"description\": \"%s\", \"lines\": [%d, %d]}\n",
			node.ID, cleanDesc, node.StartLine, node.EndLine))
	}

	return &DissectResponse{
		MermaidCode: strings.TrimRight(sb.String(), "\n"),
		Nodes:       nodes,
		Edges:       edges,
		Language:    lang,
		IsAst:       true,
	}
}

func fallbackLineDissect(code string, lang string) *DissectResponse {
	codeLines := strings.Split(code, "\n")
	total := len(codeLines)
	if total == 0 {
		return emptyDissectResponse(lang)
	}

	var nodes []DissectNode
	if total <= 3 {
		nodes = []DissectNode{
			{
				ID:          "N1",
				Label:       "代码核心逻辑",
				Kind:        "block",
				StartLine:   1,
				EndLine:     total,
				Description: "顺序执行基础逻辑",
			},
		}
	} else {
		step1 := 1 + (total / 3)
		step2 := 1 + (total * 2 / 3)
		nodes = []DissectNode{
			{
				ID:          "N1",
				Label:       "初始化与准备",
				Kind:        "block",
				StartLine:   1,
				EndLine:     step1,
				Description: "准备运行环境与输入参数",
			},
			{
				ID:          "N2",
				Label:       "核心业务处理",
				Kind:        "block",
				StartLine:   step1 + 1,
				EndLine:     step2,
				Description: "执行核心运算与数据转换",
			},
			{
				ID:          "N3",
				Label:       "结果返回与收尾",
				Kind:        "return",
				StartLine:   step2 + 1,
				EndLine:     total,
				Description: "完成业务控制与状态流转",
			},
		}
	}

	resp := renderMermaidFlowchart(nodes, lang)
	resp.IsAst = false
	return resp
}

func emptyDissectResponse(lang string) *DissectResponse {
	return &DissectResponse{
		MermaidCode: "flowchart TD\n  N1[\"空代码块\"]\n  %% @Payload[N1]: {\"description\": \"无有效代码\", \"lines\": [1, 1]}",
		Nodes: []DissectNode{
			{
				ID:          "N1",
				Label:       "空代码块",
				Kind:        "block",
				StartLine:   1,
				EndLine:     1,
				Description: "无有效代码",
			},
		},
		Language: lang,
		IsAst:    false,
	}
}

func clampLine(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

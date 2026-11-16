package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// LLM 概念边同步（移植 apps/client/src/lib/mcp/llm-concept-edges.ts:159-198，
// 经 LLM 网关既有 purpose mcp_concept_edges）：
// - 环境开关 MCP_LLM_EDGES=true 显式启用（默认关，与 Node 同）
// - 边类型 prerequisite/related/part_of，weight 上限 0.6（确定性边主导）
// - prerequisite 候选过 FilterPrerequisiteCandidates 环卫生（反向矛盾 +
//   传递环剔除）——确定性共现/教学序边不受影响
// - 先删后建 source='llm_extracted'；全程静默失败，绝不阻断转录
// ─────────────────────────────────────────────────────────────

const llmEdgeContextMaxChars = 12000
const llmEdgeWeightCap = 0.6
const llmEdgeMaxCount = 40

// LlmConceptEdgeInput 待落库的 LLM 边（概念名已解析为节点 id）。
type LlmConceptEdgeInput struct {
	FromID   string
	ToID     string
	Type     string
	Weight   float64
	Evidence string
}

// LlmEdgesStore LLM 边同步所需数据面（PgxStore 实现；接口化便于单测 fake）。
type LlmEdgesStore interface {
	GetDocumentConceptNodes(ctx context.Context, docId string) ([]SavedConceptNode, error)
	ReplaceLlmConceptEdges(ctx context.Context, repositoryId, docId string, edges []LlmConceptEdgeInput) (int, error)
}

// llmEdgesEnabled MCP_LLM_EDGES === 'true'（显式 opt-in）。
func llmEdgesEnabled() bool {
	return os.Getenv("MCP_LLM_EDGES") == "true"
}

// llmConceptEdgesResponse 网关 purpose mcp_concept_edges 的结构化响应
// （registry.ts conceptEdgesSchema 同构）。
type llmConceptEdgesResponse struct {
	Edges []struct {
		FromConcept string  `json:"fromConcept"`
		ToConcept   string  `json:"toConcept"`
		Type        string  `json:"type"`
		Weight      float64 `json:"weight"`
		Evidence    string  `json:"evidence"`
	} `json:"edges"`
}

// SyncLlmEdgesForDocument 文档概念 LLM 边同步（finalize 成功后调用；
// 概念 <2、网关失败、解析失败均静默返回，不删旧边）。
func SyncLlmEdgesForDocument(ctx context.Context, llm LlmGatewayAPI, store LlmEdgesStore, repositoryId, docId, content, userId string) int {
	if !llmEdgesEnabled() || llm == nil || store == nil {
		return 0
	}
	concepts, err := store.GetDocumentConceptNodes(ctx, docId)
	if err != nil || len(concepts) < 2 {
		return 0
	}

	// 概念清单 + 上下文（Node 同构：chunks 拼接 cap 12000——Go 以终稿全文截断）
	var listBuilder strings.Builder
	for i, c := range concepts {
		if i > 0 {
			listBuilder.WriteString("\n")
		}
		listBuilder.WriteString(fmt.Sprintf("%d. %s", i+1, c.ConceptName))
	}
	contextText := content
	if len([]rune(contextText)) > llmEdgeContextMaxChars {
		contextText = string([]rune(contextText)[:llmEdgeContextMaxChars])
	}

	uid := userId
	res, err := llm.Complete(ctx, "mcp_concept_edges", map[string]any{
		"conceptList": listBuilder.String(),
		"contextText": contextText,
	}, &uid)
	if err != nil {
		return 0 // 静默（含缺 key）——不删旧边
	}
	var parsed llmConceptEdgesResponse
	payload := strings.TrimSpace(res.Text)
	// 容错：网关哨兵/包裹文本中提取首个 JSON 对象（首 { 到尾 }）
	if idx := strings.Index(payload, "{"); idx >= 0 {
		if end := strings.LastIndex(payload, "}"); end > idx {
			payload = payload[idx : end+1]
		}
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil || len(parsed.Edges) == 0 {
		return 0
	}

	// 概念名解析：slug 精确 → 名称精确 → 名称前缀（Node 同序）；未解析/自环弃
	bySlug := map[string]string{}
	byName := map[string]string{}
	var names []string
	for _, c := range concepts {
		bySlug[c.Slug] = c.ID
		byName[strings.TrimSpace(c.ConceptName)] = c.ID
		names = append(names, strings.TrimSpace(c.ConceptName))
	}
	resolve := func(raw string) (string, bool) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return "", false
		}
		if id, ok := bySlug[raw]; ok {
			return id, true
		}
		if id, ok := byName[raw]; ok {
			return id, true
		}
		for _, n := range names {
			if strings.HasPrefix(n, raw) || strings.HasPrefix(raw, n) {
				return byName[n], true
			}
		}
		return "", false
	}

	inputs := make([]LlmConceptEdgeInput, 0, len(parsed.Edges))
	for _, e := range parsed.Edges {
		if e.Type != "prerequisite" && e.Type != "related" && e.Type != "part_of" {
			continue
		}
		fromID, ok1 := resolve(e.FromConcept)
		toID, ok2 := resolve(e.ToConcept)
		if !ok1 || !ok2 || fromID == toID {
			continue
		}
		w := e.Weight
		if w > llmEdgeWeightCap {
			w = llmEdgeWeightCap
		}
		inputs = append(inputs, LlmConceptEdgeInput{
			FromID: fromID, ToID: toID, Type: e.Type, Weight: w,
			Evidence: truncateRunesLLM(strings.TrimSpace(e.Evidence), 300),
		})
		if len(inputs) >= llmEdgeMaxCount {
			break
		}
	}
	if len(inputs) == 0 {
		return 0
	}

	n, err := store.ReplaceLlmConceptEdges(ctx, repositoryId, docId, inputs)
	if err != nil {
		log.Printf("[llm-edges] replace failed for doc %s: %v", docId, err)
		return 0
	}
	return n
}

func truncateRunesLLM(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

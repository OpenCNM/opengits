package transcription

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
)

const llmEdgeContextMaxChars = 12000
const llmEdgeWeightCap = 0.6
const llmEdgeMaxCount = 40

type LlmConceptEdgeInput struct {
	FromID   string
	ToID     string
	Type     string
	Weight   float64
	Evidence string
}

type LlmEdgesStore interface {
	GetDocumentConceptNodes(ctx context.Context, docId string) ([]SavedConceptNode, error)
	ReplaceLlmConceptEdges(ctx context.Context, repositoryId, docId string, edges []LlmConceptEdgeInput) (int, error)
}

func llmEdgesEnabled() bool {
	return os.Getenv("MCP_LLM_EDGES") == "true"
}

type llmConceptEdgesResponse struct {
	Edges []struct {
		FromConcept string  `json:"fromConcept"`
		ToConcept   string  `json:"toConcept"`
		Type        string  `json:"type"`
		Weight      float64 `json:"weight"`
		Evidence    string  `json:"evidence"`
	} `json:"edges"`
}

// Opt-in via MCP_LLM_EDGES=true; failures return silently without deleting existing edges or blocking transcription.
func SyncLlmEdgesForDocument(ctx context.Context, llm LlmGatewayAPI, store LlmEdgesStore, repositoryId, docId, content, userId string) int {
	if !llmEdgesEnabled() || llm == nil || store == nil {
		return 0
	}
	concepts, err := store.GetDocumentConceptNodes(ctx, docId)
	if err != nil || len(concepts) < 2 {
		return 0
	}

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
		return 0
	}
	var parsed llmConceptEdgesResponse
	payload := strings.TrimSpace(res.Text)
	if idx := strings.Index(payload, "{"); idx >= 0 {
		if end := strings.LastIndex(payload, "}"); end > idx {
			payload = payload[idx : end+1]
		}
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil || len(parsed.Edges) == 0 {
		return 0
	}

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

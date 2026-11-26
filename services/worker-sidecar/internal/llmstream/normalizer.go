package llmstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
)

type PartsHistogram struct {
	Content   int `json:"content"`
	Reasoning int `json:"reasoning"`
	ToolCall  int `json:"toolCall"`
	Other     int `json:"other"`
	Unknown   int `json:"unknown"`
}

type EventsHistogram struct {
	ChunkContent   int `json:"chunkContent"`
	ChunkReasoning int `json:"chunkReasoning"`
	ToolCall       int `json:"toolCall"`
	Ping           int `json:"ping"`
}

type NormalizedPart struct {
	Kind      string
	Text      string
	ToolID    string
	ToolName  string
	ToolArgs  any
	Finish    string
	PromptTok int
	CompTok   int
	RawKeys   []string
}

// Typed structs avoid per-frame map reflection while degrading mismatched JSON field types to zero values.

type lenientString struct {
	v  string
	ok bool
}

func (s *lenientString) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var x string
		if err := json.Unmarshal(b, &x); err == nil {
			s.v, s.ok = x, true
		}
	}
	return nil
}

type lenientFloat struct {
	v float64
}

func (f *lenientFloat) UnmarshalJSON(b []byte) error {
	var x float64
	if err := json.Unmarshal(b, &x); err == nil {
		f.v = x
	}
	return nil
}

type openAIUsage struct {
	PromptTokens     lenientFloat `json:"prompt_tokens"`
	CompletionTokens lenientFloat `json:"completion_tokens"`
}

type openAIToolFunction struct {
	Name      lenientString `json:"name"`
	Arguments any           `json:"arguments"`
}

type openAIToolCall struct {
	ID       lenientString       `json:"id"`
	Function *openAIToolFunction `json:"function"`
}

type openAIDelta struct {
	ReasoningContent lenientString     `json:"reasoning_content"`
	Reasoning        lenientString     `json:"reasoning"`
	Content          lenientString     `json:"content"`
	ToolCalls        []*openAIToolCall `json:"tool_calls"`
}

type openAIChoice struct {
	FinishReason lenientString `json:"finish_reason"`
	Delta        *openAIDelta  `json:"delta"`
}

type openAIChunk struct {
	Usage   json.RawMessage `json:"usage"`
	Choices json.RawMessage `json:"choices"`
}

type anthropicUsage struct {
	OutputTokens lenientFloat `json:"output_tokens"`
}

type anthropicDelta struct {
	Type       lenientString `json:"type"`
	Text       lenientString `json:"text"`
	Thinking   lenientString `json:"thinking"`
	StopReason lenientString `json:"stop_reason"`
}

type anthropicChunk struct {
	Delta *anthropicDelta `json:"delta"`
	Usage json.RawMessage `json:"usage"`
}

func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '{'
}

func isJSONArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '['
}

// Lazily decodes top-level keys only on cold branches (finish/other/unknown/frame-1).
func rawJSONKeys(data []byte) []string {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	return keys
}

type StreamNormalizer struct {
	callID          string
	frameCounter    int
	partsHistogram  PartsHistogram
	eventsHistogram EventsHistogram
}

func NewStreamNormalizer(callID string) *StreamNormalizer {
	return &StreamNormalizer{callID: callID}
}

func (n *StreamNormalizer) ParseOpenAIChunk(data []byte) (*NormalizedPart, error) {
	n.frameCounter++
	var chunk openAIChunk
	if err := json.Unmarshal(data, &chunk); err != nil {
		n.partsHistogram.Unknown++
		return nil, fmt.Errorf("invalid json in sse data: %w", err)
	}

	var promptTok, compTok int
	if isJSONObject(chunk.Usage) {
		var usage openAIUsage
		if err := json.Unmarshal(chunk.Usage, &usage); err == nil {
			promptTok = int(usage.PromptTokens.v)
			compTok = int(usage.CompletionTokens.v)
		}
	}

	parseChoices := func() ([]*openAIChoice, bool) {
		if !isJSONArray(chunk.Choices) {
			return nil, false
		}
		var choices []*openAIChoice
		if err := json.Unmarshal(chunk.Choices, &choices); err != nil {
			return nil, true
		}
		return choices, true
	}

	choices, isArray := parseChoices()
	if !isArray || len(choices) == 0 {
		if promptTok > 0 || compTok > 0 {
			return &NormalizedPart{
				Kind:      "finish",
				Finish:    "stop",
				PromptTok: promptTok,
				CompTok:   compTok,
				RawKeys:   rawJSONKeys(data),
			}, nil
		}
		n.partsHistogram.Other++
		return &NormalizedPart{Kind: "other", RawKeys: rawJSONKeys(data)}, nil
	}

	choice := choices[0]
	if choice == nil {
		n.partsHistogram.Unknown++
		return &NormalizedPart{Kind: "unknown", RawKeys: rawJSONKeys(data)}, nil
	}

	finishReason := choice.FinishReason

	delta := choice.Delta
	if delta == nil {
		if finishReason.v != "" {
			return &NormalizedPart{
				Kind:      "finish",
				Finish:    finishReason.v,
				PromptTok: promptTok,
				CompTok:   compTok,
				RawKeys:   rawJSONKeys(data),
			}, nil
		}
		n.partsHistogram.Other++
		return &NormalizedPart{Kind: "other", RawKeys: rawJSONKeys(data)}, nil
	}

	if delta.ReasoningContent.ok && delta.ReasoningContent.v != "" {
		n.partsHistogram.Reasoning++
		n.eventsHistogram.ChunkReasoning++
		return &NormalizedPart{
			Kind: "reasoning",
			Text: delta.ReasoningContent.v,
		}, nil
	}
	if delta.Reasoning.ok && delta.Reasoning.v != "" {
		n.partsHistogram.Reasoning++
		n.eventsHistogram.ChunkReasoning++
		return &NormalizedPart{
			Kind: "reasoning",
			Text: delta.Reasoning.v,
		}, nil
	}

	if delta.Content.ok && delta.Content.v != "" {
		n.partsHistogram.Content++
		n.eventsHistogram.ChunkContent++
		return &NormalizedPart{
			Kind: "content",
			Text: delta.Content.v,
		}, nil
	}

	if len(delta.ToolCalls) > 0 {
		if tc := delta.ToolCalls[0]; tc != nil {
			var name lenientString
			var args any
			if tc.Function != nil {
				name, args = tc.Function.Name, tc.Function.Arguments
			}
			n.partsHistogram.ToolCall++
			n.eventsHistogram.ToolCall++
			return &NormalizedPart{
				Kind:     "tool_call",
				ToolID:   tc.ID.v,
				ToolName: name.v,
				ToolArgs: args,
			}, nil
		}
	}

	if finishReason.v != "" {
		return &NormalizedPart{
			Kind:      "finish",
			Finish:    finishReason.v,
			PromptTok: promptTok,
			CompTok:   compTok,
			RawKeys:   rawJSONKeys(data),
		}, nil
	}

	// Frame-1 fail-fast: alert immediately if the first frame yields no valid text.
	if n.frameCounter == 1 {
		log.Printf("[llm-stream] FRAME_1_ANOMALY: call=%s unexpected delta shape keys=%v", n.callID, rawJSONKeys(data))
	}

	n.partsHistogram.Other++
	return &NormalizedPart{Kind: "other", RawKeys: rawJSONKeys(data)}, nil
}

func (n *StreamNormalizer) ParseAnthropicChunk(eventType string, data []byte) (*NormalizedPart, error) {
	n.frameCounter++
	var chunk anthropicChunk
	if err := json.Unmarshal(data, &chunk); err != nil {
		n.partsHistogram.Unknown++
		return nil, fmt.Errorf("invalid json in anthropic sse: %w", err)
	}

	switch eventType {
	case "content_block_delta":
		if chunk.Delta != nil {
			if chunk.Delta.Type.v == "text_delta" {
				if chunk.Delta.Text.ok && chunk.Delta.Text.v != "" {
					n.partsHistogram.Content++
					n.eventsHistogram.ChunkContent++
					return &NormalizedPart{Kind: "content", Text: chunk.Delta.Text.v}, nil
				}
			} else if chunk.Delta.Type.v == "thinking_delta" {
				if chunk.Delta.Thinking.ok && chunk.Delta.Thinking.v != "" {
					n.partsHistogram.Reasoning++
					n.eventsHistogram.ChunkReasoning++
					return &NormalizedPart{Kind: "reasoning", Text: chunk.Delta.Thinking.v}, nil
				}
			}
		}
	case "message_delta":
		if chunk.Delta != nil {
			var compTok int
			if isJSONObject(chunk.Usage) {
				var usage anthropicUsage
				if err := json.Unmarshal(chunk.Usage, &usage); err == nil {
					compTok = int(usage.OutputTokens.v)
				}
			}
			return &NormalizedPart{
				Kind:    "finish",
				Finish:  chunk.Delta.StopReason.v,
				CompTok: compTok,
			}, nil
		}
	}

	n.partsHistogram.Other++
	return &NormalizedPart{Kind: "other"}, nil
}

func (n *StreamNormalizer) PartsHistogram() PartsHistogram {
	return n.partsHistogram
}

func (n *StreamNormalizer) EventsHistogram() EventsHistogram {
	return n.eventsHistogram
}

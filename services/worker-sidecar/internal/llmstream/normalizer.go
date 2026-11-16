package llmstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
)

// PartsHistogram 记录从 Provider 接收到的原始 part 统计
type PartsHistogram struct {
	Content   int `json:"content"`
	Reasoning int `json:"reasoning"`
	ToolCall  int `json:"toolCall"`
	Other     int `json:"other"`
	Unknown   int `json:"unknown"`
}

// EventsHistogram 记录向客户端发出的事件统计
type EventsHistogram struct {
	ChunkContent   int `json:"chunkContent"`
	ChunkReasoning int `json:"chunkReasoning"`
	ToolCall       int `json:"toolCall"`
	Ping           int `json:"ping"`
}

// NormalizedPart 规范化后的 Chunk 片段
type NormalizedPart struct {
	Kind      string // "content" | "reasoning" | "tool_call" | "finish" | "other" | "unknown"
	Text      string
	ToolID    string
	ToolName  string
	ToolArgs  any
	Finish    string
	PromptTok int
	CompTok   int
	RawKeys   []string
}

// ─────────────────────────────────────────────────────────────
// 帧解码：typed struct 替代 map[string]any（每帧反射装箱是长流 CPU 大头）。
//
// 宽容语义与旧 map 断言版逐条对齐（provider 畸形帧不得改变分支映射）：
// - lenientString/lenientFloat：类型不匹配按缺失处理（零值），绝不使整帧解析失败
// - choices/usage 形状判定：非数组/非对象走旧版 !ok 分支
// - choices[0]/delta/function 为 null → 指针 nil（复刻旧断言失败分支）
// - RawKeys 仅 finish/other/unknown/frame-1 冷分支需要 → 懒重解码构建
// - ToolArgs 保持 any 装箱（float64 数字与旧 map 路径一致，透传重编码不变）
// ─────────────────────────────────────────────────────────────

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
	return nil // 非字符串（数字/对象/null）按缺失处理，与旧断言语义一致
}

type lenientFloat struct {
	v float64
}

func (f *lenientFloat) UnmarshalJSON(b []byte) error {
	var x float64
	if err := json.Unmarshal(b, &x); err == nil {
		f.v = x
	}
	return nil // 非数字按 0 处理
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
	ID       lenientString      `json:"id"`
	Function *openAIToolFunction `json:"function"`
}

type openAIDelta struct {
	ReasoningContent lenientString    `json:"reasoning_content"`
	Reasoning        lenientString    `json:"reasoning"`
	Content          lenientString    `json:"content"`
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
	Delta  *anthropicDelta `json:"delta"`
	Usage  json.RawMessage `json:"usage"`
}

// isJSONObject 判定 RawMessage 是否为 JSON 对象（复刻 map 断言 ok 分支）。
func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// isJSONArray 判定 RawMessage 是否为 JSON 数组。
func isJSONArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	return len(trimmed) > 0 && trimmed[0] == '['
}

// rawJSONKeys 冷分支懒构建帧顶层键集（仅 finish/other/unknown/frame-1 需要）。
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

// StreamNormalizer 负责在流式传输中提取字段与实施 Frame-1 异常检测
type StreamNormalizer struct {
	callID          string
	frameCounter    int
	partsHistogram  PartsHistogram
	eventsHistogram EventsHistogram
}

func NewStreamNormalizer(callID string) *StreamNormalizer {
	return &StreamNormalizer{callID: callID}
}

// ParseOpenAIChunk 解析并规整 OpenAI 兼容格式的 SSE 数据行
func (n *StreamNormalizer) ParseOpenAIChunk(data []byte) (*NormalizedPart, error) {
	n.frameCounter++
	var chunk openAIChunk
	if err := json.Unmarshal(data, &chunk); err != nil {
		n.partsHistogram.Unknown++
		return nil, fmt.Errorf("invalid json in sse data: %w", err)
	}

	// usage 形状判定（非对象=旧版断言失败，tokens 置 0）
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
			return nil, true // 数组但元素畸形：复刻 choices[0] 非对象 → unknown
		}
		return choices, true
	}

	choices, isArray := parseChoices()
	if !isArray || len(choices) == 0 {
		// 可能是仅包含 usage 的结束帧
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

	// 1. 检查 reasoning (DeepSeek R1 reasoning_content 或 Qwen/OpenAI reasoning)
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

	// 2. 检查 content
	if delta.Content.ok && delta.Content.v != "" {
		n.partsHistogram.Content++
		n.eventsHistogram.ChunkContent++
		return &NormalizedPart{
			Kind: "content",
			Text: delta.Content.v,
		}, nil
	}

	// 3. 检查 tool_calls
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

	// 4. 检查 finish_reason
	if finishReason.v != "" {
		return &NormalizedPart{
			Kind:      "finish",
			Finish:    finishReason.v,
			PromptTok: promptTok,
			CompTok:   compTok,
			RawKeys:   rawJSONKeys(data),
		}, nil
	}

	// Frame-1 检测（AGENTS.md 公理 II.5）：若首帧未提取出任何有效文本，打印告警
	if n.frameCounter == 1 {
		log.Printf("[llm-stream] FRAME_1_ANOMALY: call=%s unexpected delta shape keys=%v", n.callID, rawJSONKeys(data))
	}

	n.partsHistogram.Other++
	return &NormalizedPart{Kind: "other", RawKeys: rawJSONKeys(data)}, nil
}

// ParseAnthropicChunk 解析并规整 Anthropic 格式的 SSE 数据行
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

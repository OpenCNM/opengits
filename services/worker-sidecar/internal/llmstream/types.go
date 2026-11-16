package llmstream

// ModelConfig 上游大模型服务商配置
type ModelConfig struct {
	Provider  string `json:"provider"`            // "openai", "anthropic", "deepseek", etc.
	ModelID   string `json:"modelId"`             // "gpt-4o", "claude-3-5-sonnet", etc.
	APIKey    string `json:"apiKey"`              // 明文 API Key（由 Node 内存解密后随调用单次传入）
	BaseURL   string `json:"baseURL,omitempty"`   // 可选自定义服务商 BaseURL
	APIFormat string `json:"apiFormat,omitempty"` // "openai" (缺省) | "anthropic"
}

// ChatMessage 对话消息
type ChatMessage struct {
	Role       string `json:"role"`                 // "system", "user", "assistant", "tool"
	Content    any    `json:"content"`              // string 或 []any
	Name       string `json:"name,omitempty"`       // 可选用户名或工具名
	ToolCallID string `json:"toolCallId,omitempty"` // 当 role 为 tool 时的关联 toolCallId
}

// ToolFunction 工具函数声明
type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

// ToolDefinition 工具声明
type ToolDefinition struct {
	Type     string       `json:"type"` // "function"
	Function ToolFunction `json:"function"`
}

// StreamRequest LLM 流式请求体（Node -> Go 端点契约）
type StreamRequest struct {
	Model        ModelConfig      `json:"model"`
	Messages     []ChatMessage    `json:"messages"`
	System       string           `json:"system,omitempty"`       // 系统提示词
	Tools        []ToolDefinition `json:"tools,omitempty"`        // 可选工具声明
	Temperature  *float64         `json:"temperature,omitempty"`  // 温度
	MaxTokens    *int             `json:"maxTokens,omitempty"`    // 最大生成 token
	StreamFormat string           `json:"streamFormat,omitempty"` // "ai-sdk" (缺省) | "ndjson"
	CallID       string           `json:"callId,omitempty"`       // 链路追踪 callId
}

// StreamUsage 统计用量
type StreamUsage struct {
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
}

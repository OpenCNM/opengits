package llmstream

type ModelConfig struct {
	Provider  string `json:"provider"`
	ModelID   string `json:"modelId"`
	APIKey    string `json:"apiKey"`
	BaseURL   string `json:"baseURL,omitempty"`
	APIFormat string `json:"apiFormat,omitempty"`
}

type ChatMessage struct {
	Role       string `json:"role"`
	Content    any    `json:"content"`
	Name       string `json:"name,omitempty"`
	ToolCallID string `json:"toolCallId,omitempty"`
}

type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type ToolDefinition struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type StreamRequest struct {
	Model        ModelConfig      `json:"model"`
	Messages     []ChatMessage    `json:"messages"`
	System       string           `json:"system,omitempty"`
	Tools        []ToolDefinition `json:"tools,omitempty"`
	Temperature  *float64         `json:"temperature,omitempty"`
	MaxTokens    *int             `json:"maxTokens,omitempty"`
	StreamFormat string           `json:"streamFormat,omitempty"`
	CallID       string           `json:"callId,omitempty"`
}

type StreamUsage struct {
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
}

package transcription

import (
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// LLM 网关错误码常量
const (
	ErrCodeUnknownPurpose   = client.ErrCodeUnknownPurpose
	ErrCodeBudgetExceeded   = client.ErrCodeBudgetExceeded
	ErrCodeMissingApiKey    = client.ErrCodeMissingApiKey
	ErrCodeGenerationFailed = client.ErrCodeGenerationFailed
)

// LlmGatewayError 结构化错误别名。
type LlmGatewayError = client.LlmGatewayError

// LlmTextResult text purpose 的补全结果别名。
type LlmTextResult = client.LlmTextResult

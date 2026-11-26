package transcription

import (
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

const (
	ErrCodeUnknownPurpose   = client.ErrCodeUnknownPurpose
	ErrCodeBudgetExceeded   = client.ErrCodeBudgetExceeded
	ErrCodeMissingApiKey    = client.ErrCodeMissingApiKey
	ErrCodeGenerationFailed = client.ErrCodeGenerationFailed
)

type LlmGatewayError = client.LlmGatewayError

type LlmTextResult = client.LlmTextResult

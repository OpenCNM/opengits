package transcription

import (
	"errors"

	"github.com/opengits/worker-sidecar/internal/platform/client"
)

type LlmErrClass string

const (
	ClassRateLimit             LlmErrClass = "RATE_LIMIT"
	ClassTransient             LlmErrClass = "TRANSIENT"
	ClassMissingKey            LlmErrClass = "MISSING_KEY"
	ClassBudget                LlmErrClass = "BUDGET"
	ClassUpstreamAuth          LlmErrClass = "UPSTREAM_AUTH_ERROR"
	ClassUpstreamQuota         LlmErrClass = "UPSTREAM_QUOTA_EXCEEDED"
	ClassUpstreamModelNotFound LlmErrClass = "UPSTREAM_MODEL_NOT_FOUND"
	ClassUpstreamBadRequest    LlmErrClass = "UPSTREAM_BAD_REQUEST"
	ClassFatal                 LlmErrClass = "FATAL"
)

// Single error classifier driving retry/defer/fail-closed policy; structured gateway errors take precedence over text matching.
func ClassifyLlmError(err error) LlmErrClass {
	if err == nil {
		return ""
	}
	var gw *client.LlmGatewayError
	if !errors.As(err, &gw) {
		return ClassFatal
	}
	switch {
	case gw.IsMissingApiKey(), gw.IsKeyDecryptFailed():
		return ClassMissingKey
	case gw.IsBudgetExceeded():
		return ClassBudget
	case gw.IsUpstreamAuthError():
		return ClassUpstreamAuth
	case gw.IsUpstreamQuotaExceeded():
		return ClassUpstreamQuota
	case gw.IsUpstreamModelNotFound():
		return ClassUpstreamModelNotFound
	case gw.IsUpstreamBadRequest():
		return ClassUpstreamBadRequest
	case gw.IsRateLimited():
		return ClassRateLimit
	case gw.IsTransient():
		return ClassTransient
	default:
		return ClassFatal
	}
}

func isRateLimitGatewayErr(err error) bool {
	return ClassifyLlmError(err) == ClassRateLimit
}

func isTransientGatewayErr(err error) bool {
	return ClassifyLlmError(err) == ClassTransient
}

func isRetryableGatewayErr(err error) bool {
	c := ClassifyLlmError(err)
	if c == ClassRateLimit || c == ClassTransient {
		return true
	}
	if err == nil {
		return false
	}
	var gw *client.LlmGatewayError
	if errors.As(err, &gw) {
		return false
	}
	return containsTransientNetError(err.Error())
}

func containsTransientNetError(s string) bool {
	lower := ""
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		lower += string(c)
	}
	return (len(lower) > 0 && (containsSub(lower, "connection reset") ||
		containsSub(lower, "broken pipe") ||
		containsSub(lower, "unexpected eof") ||
		containsSub(lower, "econnreset") ||
		containsSub(lower, "etimedout") ||
		containsSub(lower, "activity timeout exceeded") ||
		containsSub(lower, "socket hang up")))
}

func containsSub(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || hasSubstring(s, sub))
}

func hasSubstring(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func isMissingApiKeyErr(err error) bool {
	return ClassifyLlmError(err) == ClassMissingKey
}

func isBudgetErr(err error) bool {
	return ClassifyLlmError(err) == ClassBudget
}

// Deferrable errors (budget/exhausted rate-limit) requeue without incrementing job attempts.
func isDeferrableErr(err error) bool {
	c := ClassifyLlmError(err)
	return c == ClassBudget || c == ClassRateLimit
}

// Permanent upstream failures (auth/quota/model/bad request) fail fast without wasting retry attempts.
func isPermanentUpstreamErr(err error) bool {
	c := ClassifyLlmError(err)
	return c == ClassUpstreamAuth ||
		c == ClassUpstreamQuota ||
		c == ClassUpstreamModelNotFound ||
		c == ClassUpstreamBadRequest
}

func isNoFallbackLlmErr(err error) bool {
	c := ClassifyLlmError(err)
	return c == ClassMissingKey ||
		c == ClassBudget ||
		c == ClassRateLimit ||
		c == ClassUpstreamAuth ||
		c == ClassUpstreamQuota ||
		c == ClassUpstreamModelNotFound ||
		c == ClassUpstreamBadRequest
}

func isPermanentStructuredErrStr(msg string) bool {
	decoded, ok := client.DecodeStructuredDbError(msg)
	if !ok {
		return false
	}
	return client.IsPermanentTerminalErrorCode(decoded.Code)
}

func formatTranscriptionError(err error) string {
	if err == nil {
		return ""
	}
	var gw *client.LlmGatewayError
	if errors.As(err, &gw) && gw != nil {
		return client.EncodeStructuredDbError(gw, client.MaxStructuredDbErrLen)
	}
	return truncate(err.Error(), client.MaxStructuredDbErrLen)
}

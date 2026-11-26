package transcription

import (
	"errors"
	"fmt"
	"testing"

	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClassifyLlmError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want LlmErrClass
	}{
		{name: "nil 不是错误", err: nil, want: ""},
		{name: "缺 key → 零成本退出类", err: &client.LlmGatewayError{Code: "MISSING_API_KEY", Status: 409}, want: ClassMissingKey},
		{name: "密钥解密失败 → 零成本退出类", err: &client.LlmGatewayError{Code: client.ErrCodeKeyDecryptFailed, Status: 409}, want: ClassMissingKey},
		{name: "预算超限 → 延后类", err: &client.LlmGatewayError{Code: "BUDGET_EXCEEDED", Status: 429}, want: ClassBudget},
		{name: "429 状态限流", err: &client.LlmGatewayError{Code: "X", Status: 429}, want: ClassRateLimit},
		{name: "文案 rate limit", err: &client.LlmGatewayError{Code: "X", Message: "Too many requests: rate limit exceeded"}, want: ClassRateLimit},
		{name: "文案 throttling", err: &client.LlmGatewayError{Code: "X", Message: "THROTTLING please retry"}, want: ClassRateLimit},
		{name: "生成失败 → 致命", err: &client.LlmGatewayError{Code: "GENERATION_FAILED", Status: 502}, want: ClassFatal},
		{name: "503 状态瞬态错误", err: &client.LlmGatewayError{Code: "GENERATION_FAILED", Status: 503}, want: ClassTransient},
		{name: "504 状态瞬态超时", err: &client.LlmGatewayError{Code: "GENERATION_FAILED", Status: 504}, want: ClassTransient},
		{name: "RATE_LIMITED 错误码", err: &client.LlmGatewayError{Code: client.ErrCodeRateLimited, Status: 429}, want: ClassRateLimit},
		{name: "中文 速率限制 文案", err: &client.LlmGatewayError{Code: "GENERATION_FAILED", Message: "您的调用已触发服务商速率限制，请稍后重试"}, want: ClassRateLimit},
		{name: "中文 请求频率超限 文案", err: &client.LlmGatewayError{Code: "GENERATION_FAILED", Message: "请求频率超限，并发数超过限制"}, want: ClassRateLimit},
		{name: "文案 connection reset", err: &client.LlmGatewayError{Code: "X", Message: "connection reset by peer"}, want: ClassTransient},
		{name: "文案 gateway timeout", err: &client.LlmGatewayError{Code: "X", Message: "504 Gateway Time-out"}, want: ClassTransient},
		{name: "未知 purpose → 致命", err: &client.LlmGatewayError{Code: "UNKNOWN_PURPOSE", Status: 400}, want: ClassFatal},
		{name: "上游认证失败 → 永久性认证类", err: &client.LlmGatewayError{Code: client.ErrCodeUpstreamAuthError, Status: 401, UpstreamStatus: 401}, want: ClassUpstreamAuth},
		{name: "上游额度耗尽 → 永久性配额类（不误判为限流）", err: &client.LlmGatewayError{Code: client.ErrCodeUpstreamQuotaExceeded, Status: 402, UpstreamStatus: 429, UpstreamCode: "1308"}, want: ClassUpstreamQuota},
		{name: "上游模型不存在 → 永久性模型缺失类", err: &client.LlmGatewayError{Code: client.ErrCodeUpstreamModelNotFound, Status: 404, UpstreamStatus: 404}, want: ClassUpstreamModelNotFound},
		{name: "上游请求参数被拒 → 永久性请求错误类", err: &client.LlmGatewayError{Code: client.ErrCodeUpstreamBadRequest, Status: 400, UpstreamStatus: 400}, want: ClassUpstreamBadRequest},
		{name: "未知网关码 → 致命", err: &client.LlmGatewayError{Code: "WHATEVER", Status: 500}, want: ClassFatal},
		{name: "非网关错误（ctx/网络）→ 致命", err: errors.New("context deadline exceeded"), want: ClassFatal},
		{name: "包裹的网关错误仍可分类", err: fmt.Errorf("wrap: %w", &client.LlmGatewayError{Code: "MISSING_API_KEY"}), want: ClassMissingKey},
		{name: "包裹的永久上游错误仍可分类", err: fmt.Errorf("wrap: %w", &client.LlmGatewayError{Code: client.ErrCodeUpstreamAuthError}), want: ClassUpstreamAuth},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ClassifyLlmError(tt.err))
		})
	}
}

func TestErrPolicyPredicates(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		rate       bool
		key        bool
		budget     bool
		transient  bool
		retryable  bool
		deferrable bool
		permanent  bool
		noFallback bool
	}{
		{name: "429 status", err: &client.LlmGatewayError{Status: 429}, rate: true, retryable: true, deferrable: true, noFallback: true},
		{name: "RATE_LIMITED code", err: &client.LlmGatewayError{Code: client.ErrCodeRateLimited}, rate: true, retryable: true, deferrable: true, noFallback: true},
		{name: "Chinese rate limit message", err: &client.LlmGatewayError{Message: "并发超限，请降低并发"}, rate: true, retryable: true, deferrable: true, noFallback: true},
		{name: "MISSING_API_KEY", err: &client.LlmGatewayError{Code: "MISSING_API_KEY"}, key: true, noFallback: true},
		{name: "BUDGET_EXCEEDED", err: &client.LlmGatewayError{Code: "BUDGET_EXCEEDED"}, budget: true, deferrable: true, noFallback: true},
		{name: "503 transient", err: &client.LlmGatewayError{Status: 503}, transient: true, retryable: true},
		{name: "econnreset transient", err: &client.LlmGatewayError{Code: "X", Message: "econnreset"}, transient: true, retryable: true},
		{name: "UPSTREAM_AUTH_ERROR never retries even with connection reset text", err: &client.LlmGatewayError{Code: client.ErrCodeUpstreamAuthError, Status: 401, Message: "Invalid key (connection reset)"}, permanent: true, noFallback: true},
		{name: "UPSTREAM_QUOTA_EXCEEDED never retries or defers", err: &client.LlmGatewayError{Code: client.ErrCodeUpstreamQuotaExceeded, Status: 402, UpstreamStatus: 429}, permanent: true, noFallback: true},
		{name: "UPSTREAM_MODEL_NOT_FOUND never retries", err: &client.LlmGatewayError{Code: client.ErrCodeUpstreamModelNotFound, Status: 404}, permanent: true, noFallback: true},
		{name: "UPSTREAM_BAD_REQUEST never retries", err: &client.LlmGatewayError{Code: client.ErrCodeUpstreamBadRequest, Status: 400}, permanent: true, noFallback: true},
		{name: "raw socket error retries", err: errors.New("read: connection reset by peer"), retryable: true},
		{name: "plain error fatal", err: errors.New("boom")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.rate, isRateLimitGatewayErr(tc.err))
			assert.Equal(t, tc.key, isMissingApiKeyErr(tc.err))
			assert.Equal(t, tc.budget, isBudgetErr(tc.err))
			assert.Equal(t, tc.transient, isTransientGatewayErr(tc.err))
			assert.Equal(t, tc.retryable, isRetryableGatewayErr(tc.err))
			assert.Equal(t, tc.deferrable, isDeferrableErr(tc.err))
			assert.Equal(t, tc.permanent, isPermanentUpstreamErr(tc.err))
			assert.Equal(t, tc.noFallback, isNoFallbackLlmErr(tc.err))
		})
	}
}

func TestFormatTranscriptionErrorAndPermanentDetection(t *testing.T) {
	tests := []struct {
		name          string
		err           error
		wantPrefix    string
		wantPermanent bool
	}{
		{
			name: "UPSTREAM_AUTH_ERROR encodes structured JSON and marks permanent",
			err: &client.LlmGatewayError{
				Code:           client.ErrCodeUpstreamAuthError,
				Message:        "Incorrect API key provided",
				Provider:       "openai",
				Model:          "gpt-4o",
				UpstreamStatus: 401,
				UpstreamCode:   "invalid_api_key",
			},
			wantPrefix:    client.StructuredDbErrPrefix,
			wantPermanent: true,
		},
		{
			name: "wrapped UPSTREAM_QUOTA_EXCEEDED encodes structured JSON and marks permanent",
			err: fmt.Errorf("code-chapter llm: %w", &client.LlmGatewayError{
				Code:           client.ErrCodeUpstreamQuotaExceeded,
				Message:        "已达到 5 小时使用上限",
				Provider:       "zhipu",
				Model:          "glm-5.3-flash",
				UpstreamStatus: 429,
				UpstreamCode:   "1308",
			}),
			wantPrefix:    client.StructuredDbErrPrefix,
			wantPermanent: true,
		},
		{
			name: "GENERATION_FAILED encodes structured JSON but is NOT permanent terminal",
			err: &client.LlmGatewayError{
				Code:    client.ErrCodeGenerationFailed,
				Message: "schema mismatch",
				Status:  502,
			},
			wantPrefix:    client.StructuredDbErrPrefix,
			wantPermanent: false,
		},
		{
			name:          "plain error stays plain text and is NOT permanent terminal",
			err:           errors.New("plain timeout error"),
			wantPrefix:    "plain timeout error",
			wantPermanent: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			formatted := formatTranscriptionError(tt.err)
			assert.LessOrEqual(t, len(formatted), client.MaxStructuredDbErrLen)
			assert.True(t, len(formatted) > 0)
			if tt.wantPrefix == client.StructuredDbErrPrefix {
				assert.Contains(t, formatted, client.StructuredDbErrPrefix)
				decoded, ok := client.DecodeStructuredDbError(formatted)
				require.True(t, ok)
				assert.NotEmpty(t, decoded.Code)
			} else {
				assert.Equal(t, tt.wantPrefix, formatted)
			}
			assert.Equal(t, tt.wantPermanent, isPermanentStructuredErrStr(formatted))
		})
	}
}

package transcription

import (
	"errors"
	"fmt"
	"testing"

	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// TestClassifyLlmError 错误分类学契约：类 × 动作语义的单一来源锁定
// （审计 BUG-11~14/29/64 制度层——新增错误形态必须先在此登记）。
func TestClassifyLlmError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want LlmErrClass
	}{
		{name: "nil 不是错误", err: nil, want: ""},
		{name: "缺 key → 零成本退出类", err: &client.LlmGatewayError{Code: "MISSING_API_KEY", Status: 409}, want: ClassMissingKey},
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
		{name: "未知网关码 → 致命", err: &client.LlmGatewayError{Code: "WHATEVER", Status: 500}, want: ClassFatal},
		{name: "非网关错误（ctx/网络）→ 致命", err: errors.New("context deadline exceeded"), want: ClassFatal},
		{name: "包裹的网关错误仍可分类", err: fmt.Errorf("wrap: %w", &client.LlmGatewayError{Code: "MISSING_API_KEY"}), want: ClassMissingKey},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClassifyLlmError(tt.err); got != tt.want {
				t.Errorf("ClassifyLlmError() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestErrPolicyPredicates 谓词与分类器同源（防两套判定漂移）。
func TestErrPolicyPredicates(t *testing.T) {
	cases := []struct {
		err                                                 error
		rate, key, budget, transient, retryable, deferrable bool
	}{
		{&client.LlmGatewayError{Status: 429}, true, false, false, false, true, true},
		{&client.LlmGatewayError{Code: client.ErrCodeRateLimited}, true, false, false, false, true, true},
		{&client.LlmGatewayError{Message: "并发超限，请降低并发"}, true, false, false, false, true, true},
		{&client.LlmGatewayError{Code: "MISSING_API_KEY"}, false, true, false, false, false, false},
		{&client.LlmGatewayError{Code: "BUDGET_EXCEEDED"}, false, false, true, false, false, true},
		{&client.LlmGatewayError{Status: 503}, false, false, false, true, true, false},
		{&client.LlmGatewayError{Code: "X", Message: "econnreset"}, false, false, false, true, true, false},
		{errors.New("read: connection reset by peer"), false, false, false, false, true, false},
		{errors.New("boom"), false, false, false, false, false, false},
	}
	for i, c := range cases {
		if got := isRateLimitGatewayErr(c.err); got != c.rate {
			t.Errorf("case %d isRateLimitGatewayErr = %v, want %v", i, got, c.rate)
		}
		if got := isMissingApiKeyErr(c.err); got != c.key {
			t.Errorf("case %d isMissingApiKeyErr = %v, want %v", i, got, c.key)
		}
		if got := isBudgetErr(c.err); got != c.budget {
			t.Errorf("case %d isBudgetErr = %v, want %v", i, got, c.budget)
		}
		if got := isTransientGatewayErr(c.err); got != c.transient {
			t.Errorf("case %d isTransientGatewayErr = %v, want %v", i, got, c.transient)
		}
		if got := isRetryableGatewayErr(c.err); got != c.retryable {
			t.Errorf("case %d isRetryableGatewayErr = %v, want %v", i, got, c.retryable)
		}
		if got := isDeferrableErr(c.err); got != c.deferrable {
			t.Errorf("case %d isDeferrableErr = %v, want %v", i, got, c.deferrable)
		}
	}
}

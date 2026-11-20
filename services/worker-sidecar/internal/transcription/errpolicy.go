package transcription

import (
	"errors"

	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// ─────────────────────────────────────────────────────────────
// 转录错误分类学（收敛漏斗的确定性闸门，审计 BUG-11~14/29/64 的制度层）。
//
// 历史上 fail-open/fail-closed 判定以 errors.As + IsXxx 链散落 8 处，
// 每处的语义只能靠注释维持一致。本文件把判定收敛为单一分类器 + 显式
// 策略表：错误类 × 阶段 → 动作。任何新错误形态在此登记，消费点一律
// switch ClassifyLlmError(err)，禁止再写内联谓词链。
//
// 错误类 → 动作契约（全阶段一致语义）：
//
//	┌──────────────┬──────────────────────────────────────────────┐
//	│ RATE_LIMIT   │ 本地退避重试（withLlmRetry 1s/2s/4s×3 消化）；│
//	│              │ 重试耗尽动作升级为延后回队（isDeferrableErr，│
//	│              │ 映射为 claimDeferred），不计崩溃上限与 attempts │
//	│ TRANSIENT    │ 瞬态网络/503/504抖动重试（withLlmRetry 消化）│
//	│ MISSING_KEY  │ Fail-Closed：文档 ERROR，任务级重试兜底      │
//	│              │ （公理5：绝不以未翻译/未增强原文伪装成品）   │
//	│ BUDGET       │ 延后不计失败：BodyDeferred（队列延后再试）   │
//	│ FATAL        │ Fail-Closed：文档 ERROR，任务级重试兜底      │
//	│              │ （多块路径的块级原文兜底是 FATAL 的继续型     │
//	│              │  变体：零成本可重得、不存档、下轮补 LLM）    │
//	└──────────────┴──────────────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────

// LlmErrClass 错误类（网关 code 契约见 platform/client/llm.go）。
type LlmErrClass string

const (
	ClassRateLimit  LlmErrClass = "RATE_LIMIT"
	ClassTransient  LlmErrClass = "TRANSIENT"
	ClassMissingKey LlmErrClass = "MISSING_KEY"
	ClassBudget     LlmErrClass = "BUDGET"
	ClassFatal      LlmErrClass = "FATAL" // GENERATION_FAILED/UNKNOWN_PURPOSE/未知/ctx
)

// ClassifyLlmError 单一分类器：网关错误按 code/status/文案映射，其余一律
// FATAL（与历史行为一致——非网关错误从未有专属路径）。
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
	case gw.IsRateLimited():
		return ClassRateLimit
	case gw.IsTransient():
		return ClassTransient
	default:
		return ClassFatal
	}
}

// isRateLimitGatewayErr 限流判定（withLlmRetry 谓词；语义：429 状态或文案
// 含 429/rate limit/throttling/toomanyrequests；BUDGET/MISSING_KEY 有专属
// 语义不计入）。委托 ClassifyLlmError 单一来源。
func isRateLimitGatewayErr(err error) bool {
	return ClassifyLlmError(err) == ClassRateLimit
}

// isTransientGatewayErr 瞬态网络/网关错误判定（503/504/连接重置等）。
func isTransientGatewayErr(err error) bool {
	return ClassifyLlmError(err) == ClassTransient
}

// isRetryableGatewayErr 可重试判定（withLlmRetry 谓词：限流 429 与瞬态网络 503/504 均走退避重试）。
func isRetryableGatewayErr(err error) bool {
	c := ClassifyLlmError(err)
	if c == ClassRateLimit || c == ClassTransient {
		return true
	}
	if err == nil {
		return false
	}
	// 兜底原生网络层报错（未被封装为 LlmGatewayError 的 socket 瞬断或看门狗超时）
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

// isMissingApiKeyErr 缺 key 判定（分类器同源谓词；处置见上表 MISSING_KEY 行）。
func isMissingApiKeyErr(err error) bool {
	return ClassifyLlmError(err) == ClassMissingKey
}

// isBudgetErr 预算超限判定（延后不计失败）。
func isBudgetErr(err error) bool {
	return ClassifyLlmError(err) == ClassBudget
}

// isDeferrableErr 延后回队判定：预算不足或限流重试耗尽均延后重试，映射为 claimDeferred，不计崩溃失败、不递增 attempts。
func isDeferrableErr(err error) bool {
	c := ClassifyLlmError(err)
	return c == ClassBudget || c == ClassRateLimit
}

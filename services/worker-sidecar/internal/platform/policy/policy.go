package policy

import (
	"context"
	"log"
	"sync"
	"time"
)

// ── 紧急只读熔断（逐字移植 gateway/policy.ts 的 getGatewayPolicy + isEmergencyReadOnly）──
// 状态源 GatewayPolicyConfig 单行表；10s TTL 微缓存；DB 不可用 fail-open（默认 false）
// + 2s 负缓存防故障期间每轮空转打库。

const (
	PolicyTTLMS       = 10 * time.Second
	PolicyFailBackoff = 2 * time.Second
)

// EmergencyReadOnlyReader 熔断判定所需最小读取面（TaskStore 与 JobQueueStore 均满足）。
type EmergencyReadOnlyReader interface {
	EmergencyReadOnly(ctx context.Context) (bool, error)
}

// GatewayPolicy manages emergency read-only policy with caching and fail-open semantics.
type GatewayPolicy struct {
	mu        sync.Mutex
	value     bool
	at        time.Time
	failUntil time.Time
}

// DefaultGatewayPolicy is the shared singleton instance.
var DefaultGatewayPolicy = &GatewayPolicy{}

// NewGatewayPolicy constructs an isolated GatewayPolicy instance.
func NewGatewayPolicy() *GatewayPolicy {
	return &GatewayPolicy{}
}

// IsEmergencyReadOnly evaluates emergency read-only status with caching and fail-open backoff.
func (p *GatewayPolicy) IsEmergencyReadOnly(ctx context.Context, store EmergencyReadOnlyReader) bool {
	if store == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if now.Sub(p.at) < PolicyTTLMS && !p.at.IsZero() {
		return p.value
	}
	if now.Before(p.failUntil) {
		return false
	}
	v, err := store.EmergencyReadOnly(ctx)
	if err != nil {
		p.failUntil = now.Add(PolicyFailBackoff)
		log.Printf("[gateway/policy] policy read failed, fail-open default: %v", err)
		return false
	}
	p.value = v
	p.at = now
	return v
}

// Reset clears the cached state (useful for tests).
func (p *GatewayPolicy) Reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.value = false
	p.at = time.Time{}
	p.failUntil = time.Time{}
}

// IsEmergencyReadOnly evaluates emergency read-only status using the default gateway policy instance.
func IsEmergencyReadOnly(ctx context.Context, store EmergencyReadOnlyReader) bool {
	return DefaultGatewayPolicy.IsEmergencyReadOnly(ctx, store)
}

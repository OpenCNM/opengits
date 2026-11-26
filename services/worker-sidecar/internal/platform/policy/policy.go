package policy

import (
	"context"
	"log"
	"sync"
	"time"
)

const (
	PolicyTTLMS       = 10 * time.Second
	PolicyFailBackoff = 2 * time.Second

	MinTranscriptionConcurrency      = 1
	MaxTranscriptionConcurrency      = 32
	MinTranscriptionChunkConcurrency = 1
	MaxTranscriptionChunkConcurrency = 16
)

type RuntimePolicy struct {
	EmergencyReadOnly             bool
	TranscriptionConcurrency      *int
	TranscriptionChunkConcurrency *int
}

type EmergencyReadOnlyReader interface {
	EmergencyReadOnly(ctx context.Context) (bool, error)
}

type RuntimePolicyReader interface {
	ReadRuntimePolicy(ctx context.Context) (RuntimePolicy, error)
}

type GatewayPolicy struct {
	mu               sync.Mutex
	value            bool
	at               time.Time
	failUntil        time.Time
	runtime          RuntimePolicy
	runtimeAt        time.Time
	runtimeFailUntil time.Time
}

var DefaultGatewayPolicy = &GatewayPolicy{}

func NewGatewayPolicy() *GatewayPolicy {
	return &GatewayPolicy{}
}

func clampPtr(v *int, minVal, maxVal int) *int {
	if v == nil {
		return nil
	}
	n := *v
	if n < minVal {
		n = minVal
	} else if n > maxVal {
		n = maxVal
	}
	return &n
}

func cloneRuntimePolicy(rt RuntimePolicy) RuntimePolicy {
	out := RuntimePolicy{EmergencyReadOnly: rt.EmergencyReadOnly}
	if rt.TranscriptionConcurrency != nil {
		v := *rt.TranscriptionConcurrency
		out.TranscriptionConcurrency = &v
	}
	if rt.TranscriptionChunkConcurrency != nil {
		v := *rt.TranscriptionChunkConcurrency
		out.TranscriptionChunkConcurrency = &v
	}
	return out
}

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

func (p *GatewayPolicy) GetRuntimePolicy(ctx context.Context, store any) RuntimePolicy {
	if store == nil {
		return RuntimePolicy{}
	}
	reader, hasFull := store.(RuntimePolicyReader)
	if !hasFull {
		if er, ok := store.(EmergencyReadOnlyReader); ok {
			return RuntimePolicy{EmergencyReadOnly: p.IsEmergencyReadOnly(ctx, er)}
		}
		return RuntimePolicy{}
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if now.Sub(p.runtimeAt) < PolicyTTLMS && !p.runtimeAt.IsZero() {
		return cloneRuntimePolicy(p.runtime)
	}
	if now.Before(p.runtimeFailUntil) {
		fallback := cloneRuntimePolicy(p.runtime)
		fallback.EmergencyReadOnly = false
		return fallback
	}

	// Fail open (EmergencyReadOnly=false) on DB errors and keep last-known concurrency overrides across outages.
	rt, err := reader.ReadRuntimePolicy(ctx)
	if err != nil {
		p.runtimeFailUntil = now.Add(PolicyFailBackoff)
		log.Printf("[gateway/policy] runtime policy read failed, fail-open fallback: %v", err)
		fallback := cloneRuntimePolicy(p.runtime)
		fallback.EmergencyReadOnly = false
		return fallback
	}
	rt.TranscriptionConcurrency = clampPtr(rt.TranscriptionConcurrency, MinTranscriptionConcurrency, MaxTranscriptionConcurrency)
	rt.TranscriptionChunkConcurrency = clampPtr(rt.TranscriptionChunkConcurrency, MinTranscriptionChunkConcurrency, MaxTranscriptionChunkConcurrency)
	p.runtime = cloneRuntimePolicy(rt)
	p.runtimeAt = now
	p.value = rt.EmergencyReadOnly
	p.at = now
	return rt
}

func (p *GatewayPolicy) CachedTranscriptionChunkConcurrency() *int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runtime.TranscriptionChunkConcurrency == nil {
		return nil
	}
	v := *p.runtime.TranscriptionChunkConcurrency
	return &v
}

// Expire timestamps only so last-known concurrency overrides survive if the reload query fails.
func (p *GatewayPolicy) Invalidate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.at = time.Time{}
	p.failUntil = time.Time{}
	p.runtimeAt = time.Time{}
	p.runtimeFailUntil = time.Time{}
}

func (p *GatewayPolicy) ForceReload(ctx context.Context, store any) RuntimePolicy {
	p.Invalidate()
	return p.GetRuntimePolicy(ctx, store)
}

func (p *GatewayPolicy) Reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.value = false
	p.at = time.Time{}
	p.failUntil = time.Time{}
	p.runtime = RuntimePolicy{}
	p.runtimeAt = time.Time{}
	p.runtimeFailUntil = time.Time{}
}

func ResolveTranscriptionConcurrency(override *int, fallback int) int {
	val := fallback
	if override != nil {
		val = *override
	}
	if val < MinTranscriptionConcurrency {
		return MinTranscriptionConcurrency
	}
	if val > MaxTranscriptionConcurrency {
		return MaxTranscriptionConcurrency
	}
	return val
}

func ResolveTranscriptionChunkConcurrency(override *int, fallback int) int {
	val := fallback
	if override != nil {
		val = *override
	}
	if val < MinTranscriptionChunkConcurrency {
		return MinTranscriptionChunkConcurrency
	}
	if val > MaxTranscriptionChunkConcurrency {
		return MaxTranscriptionChunkConcurrency
	}
	return val
}

func IsEmergencyReadOnly(ctx context.Context, store EmergencyReadOnlyReader) bool {
	return DefaultGatewayPolicy.IsEmergencyReadOnly(ctx, store)
}

func GetRuntimePolicy(ctx context.Context, store any) RuntimePolicy {
	return DefaultGatewayPolicy.GetRuntimePolicy(ctx, store)
}

func CachedTranscriptionChunkConcurrency() *int {
	return DefaultGatewayPolicy.CachedTranscriptionChunkConcurrency()
}

func ForceReload(ctx context.Context, store any) RuntimePolicy {
	return DefaultGatewayPolicy.ForceReload(ctx, store)
}

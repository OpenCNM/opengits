package mcp

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRateLimiter_MemoryScrubbingAndGC_TableDriven(t *testing.T) {
	tests := []struct {
		name          string
		userCount     int
		baseTime      time.Time
		timeAdvance   time.Duration
		triggerUser   string
		expectedMaxGC int
	}{
		{
			name:          "below threshold small user pool does not trigger bulk sweep",
			userCount:     50,
			baseTime:      time.Now(),
			timeAdvance:   70 * time.Second,
			triggerUser:   "user-trigger",
			expectedMaxGC: 51,
		},
		{
			name:          "above 512 user pool with expired records scrubs all expired users",
			userCount:     600,
			baseTime:      time.Now(),
			timeAdvance:   70 * time.Second,
			triggerUser:   "user-active",
			expectedMaxGC: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			limiter := NewRateLimiter(store)
			ctx := context.Background()
			quota := UserQuota{Role: "USER", RpmLimit: 100, DailyLimit: 1000, TokenCap: 4000}

			for i := 0; i < tt.userCount; i++ {
				uid := fmt.Sprintf("u-%d", i)
				res := limiter.Check(ctx, uid, quota, tt.baseTime)
				require.True(t, res.Allowed)
			}
			limiter.mu.Lock()
			assert.Equal(t, tt.userCount, len(limiter.stats))
			limiter.mu.Unlock()

			now := tt.baseTime.Add(tt.timeAdvance)

			res := limiter.Check(ctx, tt.triggerUser, quota, now)
			require.True(t, res.Allowed)

			limiter.mu.Lock()
			tracked := len(limiter.stats)
			limiter.mu.Unlock()
			assert.LessOrEqual(t, tracked, tt.expectedMaxGC,
				"expected tracked users <= %d, got %d", tt.expectedMaxGC, tracked)
		})
	}
}

func TestRateLimiter_RPMRestrictionAndAdminExemption_TableDriven(t *testing.T) {
	tests := []struct {
		name       string
		role       string
		rpmLimit   int
		totalCalls int
		wantReject bool
	}{
		{
			name:       "standard user is blocked after exceeding RPM limit",
			role:       "USER",
			rpmLimit:   3,
			totalCalls: 4,
			wantReject: true,
		},
		{
			name:       "admin user gets elevated limits and is allowed through",
			role:       "ADMIN",
			rpmLimit:   3,
			totalCalls: 4,
			wantReject: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			limiter := NewRateLimiter(store)
			ctx := context.Background()
			now := time.Now()

			quota := UserQuota{
				Role:       tt.role,
				RpmLimit:   tt.rpmLimit,
				DailyLimit: 100,
				TokenCap:   4000,
			}

			var lastResult RateLimitResult
			for i := 0; i < tt.totalCalls; i++ {
				lastResult = limiter.Check(ctx, "test-subject", quota, now.Add(time.Duration(i)*time.Millisecond))
			}

			if tt.wantReject {
				assert.False(t, lastResult.Allowed)
				assert.Equal(t, "RPM_EXCEEDED", lastResult.Reason)
				assert.Equal(t, 429, lastResult.Status)
			} else {
				assert.True(t, lastResult.Allowed)
				assert.Equal(t, 200, lastResult.Status)
			}
		})
	}
}

package daemon

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMarkRunFailed(t *testing.T) {
	t.Helper()

	t.Run("daemon 上下文：置 failed 并记录 detail", func(t *testing.T) {
		state := &taskRunState{}
		ctx := context.WithValue(context.Background(), taskRunKey{}, state)
		MarkRunFailed(ctx, "NODE_INTERNAL_URL not set")
		assert.True(t, state.failed)
		assert.Equal(t, "NODE_INTERNAL_URL not set", state.detail)
	})

	t.Run("普通上下文：no-op（不 panic）", func(t *testing.T) {
		assert.NotPanics(t, func() {
			MarkRunFailed(context.Background(), "irrelevant")
		})
	})
}

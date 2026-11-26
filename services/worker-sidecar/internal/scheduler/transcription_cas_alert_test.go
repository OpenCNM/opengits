package scheduler

import (
	"context"
	"testing"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEvaluateCasMissWindow_TableDriven(t *testing.T) {
	tests := []struct {
		name        string
		cur         uint64
		last        uint64
		lastSet     bool
		threshold   uint64
		wantDelta   uint64
		wantAlert   bool
		wantNewLast uint64
	}{
		{
			name: "首轮只立基线不告警",
			cur:  100, last: 0, lastSet: false, threshold: 3,
			wantDelta: 0, wantAlert: false, wantNewLast: 100,
		},
		{
			name: "计数器回退（进程重启）重立基线不告警",
			cur:  2, last: 50, lastSet: true, threshold: 3,
			wantDelta: 0, wantAlert: false, wantNewLast: 2,
		},
		{
			name: "增量低于阈值静默",
			cur:  12, last: 10, lastSet: true, threshold: 3,
			wantDelta: 2, wantAlert: false, wantNewLast: 12,
		},
		{
			name: "增量达到阈值触发",
			cur:  13, last: 10, lastSet: true, threshold: 3,
			wantDelta: 3, wantAlert: true, wantNewLast: 13,
		},
		{
			name: "阈值 0 永不告警（显式关闭）",
			cur:  1000, last: 10, lastSet: true, threshold: 0,
			wantDelta: 990, wantAlert: false, wantNewLast: 1000,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			delta, alert, newLast := evaluateCasMissWindow(tt.cur, tt.last, tt.lastSet, tt.threshold)
			assert.Equal(t, tt.wantDelta, delta)
			assert.Equal(t, tt.wantAlert, alert)
			assert.Equal(t, tt.wantNewLast, newLast)
		})
	}
}

func TestRunTranscriptionCasMissAlertOnce(t *testing.T) {
	capture, srv := newCaptureServer(t)
	ctx := context.Background()

	RunTranscriptionCasMissAlertOnce(ctx, Config{TranscriptionCasMissAlertThreshold: 3})
	assert.Empty(t, capture.bodies, "webhook 未配置时必须零成本空转")

	cfg := Config{
		MonitorAlertWebhookURL:             srv.URL,
		TranscriptionCasMissAlertThreshold: 3,
	}

	RunTranscriptionCasMissAlertOnce(ctx, cfg)
	assert.Empty(t, capture.bodies, "首轮只立基线，历史累计不触发")

	metrics.Add(transcriptionStampCasMissCounter, 5)
	RunTranscriptionCasMissAlertOnce(ctx, cfg)
	require.Len(t, capture.bodies, 1)
	assert.Equal(t, transcriptionStampCasMissCounter, capture.bodies[0]["counter"])
	assert.Equal(t, float64(5), capture.bodies[0]["delta"])
	assert.Equal(t, float64(3), capture.bodies[0]["threshold"])
	assert.Contains(t, capture.bodies[0]["text"], "增量 5")

	RunTranscriptionCasMissAlertOnce(ctx, cfg)
	assert.Len(t, capture.bodies, 1, "无新增 miss 的窗口不得重复告警")
}

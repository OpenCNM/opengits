package scheduler

import (
	"context"
	"fmt"
	"sync"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

const transcriptionStampCasMissCounter = "transcription.stamp_cas_miss"

const defaultTranscriptionCasMissThreshold = 3

var casMissWindowState struct {
	mu      sync.Mutex
	lastVal uint64
	lastSet bool
}

// Establish baseline without alerting on first observation or process-restart counter resets.
func evaluateCasMissWindow(cur, last uint64, lastSet bool, threshold uint64) (delta uint64, alert bool, newLast uint64) {
	if !lastSet || cur < last {
		return 0, false, cur
	}
	delta = cur - last
	alert = threshold > 0 && delta >= threshold
	return delta, alert, cur
}

func RunTranscriptionCasMissAlertOnce(ctx context.Context, cfg Config) {
	if cfg.MonitorAlertWebhookURL == "" {
		return
	}
	threshold := cfg.TranscriptionCasMissAlertThreshold
	if threshold <= 0 {
		threshold = defaultTranscriptionCasMissThreshold
	}

	cur := uint64(metrics.Get(transcriptionStampCasMissCounter))
	casMissWindowState.mu.Lock()
	delta, alert, newLast := evaluateCasMissWindow(cur, casMissWindowState.lastVal, casMissWindowState.lastSet, uint64(threshold))
	casMissWindowState.lastVal, casMissWindowState.lastSet = newLast, true
	casMissWindowState.mu.Unlock()
	if !alert {
		return
	}

	payload := map[string]any{
		"text": fmt.Sprintf(
			"[转录链告警] transcription.stamp_cas_miss 单窗口增量 %d（阈值 %d）——盖章 CAS 持续未命中，疑似某管线漏置 PROCESSING 致内容静默不更新，请核对转录链状态重置约定",
			delta, threshold),
		"counter":   transcriptionStampCasMissCounter,
		"delta":     delta,
		"threshold": threshold,
	}
	postMonitorAlert(ctx, cfg.MonitorAlertWebhookURL, payload)
}

package scheduler

import (
	"context"
	"fmt"
	"sync"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

// ─────────────────────────────────────────────────────────────
// 转录盖章 CAS 未命中告警（transcription-cas-alert ticker）。
//
// StampProcessed 以 CAS 条件落终态（状态非 PROCESSED-with-contentId 才允许
// 盖章）。偶发 miss = 良性并发（成品被并发换入，本次成果安全弃权）；
// 持续 miss = 某条管线漏了「转录前先置 PROCESSING」的约定——任务全部
// 显示成功而内容静默不更新，只能靠该计数器暴露（/v1/metrics 出口）。
//
// 与 monitor-alert 同一告警哲学：无状态优先（加尔法则），不设抑制状态，
// ticker 节奏天然限频，静默期由接收端配置；webhook 未配置时空转零成本，
// 且复用 MonitorAlertWebhookURL——运维只配一个 webhook 即收全部告警。
// ─────────────────────────────────────────────────────────────

// transcriptionStampCasMissCounter 与 finalize_store.go metrics.Inc 的计数器名锁步。
const transcriptionStampCasMissCounter = "transcription.stamp_cas_miss"

const defaultTranscriptionCasMissThreshold = 3

// casMissWindowState 进程内窗口基线（计数器与基线同为进程内存态，
// 重启一同清零，语义自洽）。互斥锁保护手动触发与 ticker 并发。
var casMissWindowState struct {
	mu      sync.Mutex
	lastVal uint64
	lastSet bool
}

// evaluateCasMissWindow 纯函数：给定当前累计值与上轮基线，返回
// (窗口增量, 是否告警, 新基线)。首轮与计数器回退（进程重启）只立基线
// 不告警——增量语义必须建立在同一段进程生命周期的两次观测之间。
func evaluateCasMissWindow(cur, last uint64, lastSet bool, threshold uint64) (delta uint64, alert bool, newLast uint64) {
	if !lastSet || cur < last {
		return 0, false, cur
	}
	delta = cur - last
	alert = threshold > 0 && delta >= threshold
	return delta, alert, cur
}

// RunTranscriptionCasMissAlertOnce 执行一轮 CAS miss 窗口检查，超限推送 webhook。
func RunTranscriptionCasMissAlertOnce(ctx context.Context, cfg Config) {
	if cfg.MonitorAlertWebhookURL == "" {
		return // 未配置即禁用（零成本心跳）
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

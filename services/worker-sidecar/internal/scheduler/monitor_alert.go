package scheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

const monitorAlertWindow = time.Hour

const monitorCrashKind = "CRASH_INFERRED"

var monitorAlertErrorKinds = []string{
	"JS_ERROR",
	"RESOURCE_ERROR",
	"PROMISE_REJECTION",
	"RENDER_ERROR",
	"CRASH_INFERRED",
}

// Deliberately stateless; 5m tick cadence and receiver-side silencing replace suppression state.
func RunMonitorAlertOnce(ctx context.Context, cfg Config, store TaskStore) {
	if cfg.MonitorAlertWebhookURL == "" {
		return
	}

	since := time.Now().UTC().Add(-monitorAlertWindow)
	errorSessions, err := store.CountMonitorErrorSessionsSince(ctx, monitorAlertErrorKinds, since)
	if err != nil {
		log.Printf("[monitor-alert] error session count failed: %v", err)
		return
	}
	crashes, err := store.CountMonitorEventsByKindSince(ctx, monitorCrashKind, since)
	if err != nil {
		log.Printf("[monitor-alert] crash count failed: %v", err)
		return
	}

	var reasons []string
	if errorSessions >= int64(cfg.MonitorAlertErrorSessions) {
		reasons = append(reasons, fmt.Sprintf("错误会话 %d（阈值 %d）", errorSessions, cfg.MonitorAlertErrorSessions))
	}
	if crashes >= int64(cfg.MonitorAlertCrashes) {
		reasons = append(reasons, fmt.Sprintf("崩溃推断 %d（阈值 %d）", crashes, cfg.MonitorAlertCrashes))
	}
	if len(reasons) == 0 {
		return
	}

	payload := map[string]any{
		"text":          "[前端监控告警] 最近 1 小时 " + strings.Join(reasons, "、"),
		"errorSessions": errorSessions,
		"crashes":       crashes,
		"window":        "1h",
	}
	postMonitorAlert(ctx, cfg.MonitorAlertWebhookURL, payload)
}

func postMonitorAlert(ctx context.Context, webhookURL string, payload map[string]any) {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[monitor-alert] payload marshal failed: %v", err)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		log.Printf("[monitor-alert] webhook request build failed: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[monitor-alert] webhook deliver failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("[monitor-alert] webhook rejected: status=%d", resp.StatusCode)
		return
	}
	log.Printf("[monitor-alert] notified: %s", payload["text"])
}

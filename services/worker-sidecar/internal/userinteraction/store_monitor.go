package userinteraction

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// ─────────────────────────────────────────────────────────────
// 前端自研监控事件（报错/卡死/性能）：与 EpisodicEvent（产品旅程分析）
// 刻意分表——消费者是运维排障（CDC），错误聚合走 fingerprint 索引。
// 本模块是 MonitorEvent 的唯一写者（Next /api/monitor 网关 → 此处批量入库），
// 保留期清理由 scheduler.RunRetentionPrune 的 monitorEvent 段接管。
// ─────────────────────────────────────────────────────────────

// MonitorEventInput represents a single frontend monitor event payload.
type MonitorEventInput struct {
	Kind         string         `json:"kind"`
	PageURL      string         `json:"pageUrl"`
	SessionID    string         `json:"sessionId,omitempty"`
	Severity     *string        `json:"severity,omitempty"`
	Payload      map[string]any `json:"payload,omitempty"`
	RepositoryID *string        `json:"repositoryId,omitempty"`
}

// allowedMonitorEventKinds 与 apps/client/src/lib/monitor/events.ts 的
// MONITOR_EVENT_KINDS 注册表两侧同步（tests/unit/monitor-kinds.test.ts 守护）。
var allowedMonitorEventKinds = map[string]struct{}{
	"SESSION_START":     {},
	"SESSION_END":       {},
	"CRASH_INFERRED":    {},
	"JS_ERROR":          {},
	"RESOURCE_ERROR":    {},
	"PROMISE_REJECTION": {},
	"RENDER_ERROR":      {},
	"FREEZE":            {},
	"WEB_VITALS":        {},
}

// monitorErrorKinds 需要服务端计算聚合指纹的事件类。
var monitorErrorKinds = map[string]struct{}{
	"JS_ERROR":          {},
	"PROMISE_REJECTION": {},
	"RENDER_ERROR":      {},
}

// 指纹归一化仅用两条 1D 纯文本替换（数字/长十六进制串→占位符），
// 属正则安全区（token 掩码同款）；超过两条防御补丁即触发加尔上限重构。
var (
	monitorLongHexRegex = regexp.MustCompile(`[0-9a-fA-F-]{16,}`)
	monitorNumRegex     = regexp.MustCompile(`\d+`)
)

// monitorFingerprint 归一化错误指纹：kind + message 模板化 + stack 顶部 3 帧
// 的「函数名|文件基名」（剔除行列号），sha256 取前 16 hex。
// 行号被剔除：同一错误在迭代构建后仍聚合到同一指纹；数字被占位符化：
// "Failed to fetch 404" 与 "Failed to fetch 500" 归并同源。
func monitorFingerprint(kind, message, stack string) string {
	var sb strings.Builder
	sb.WriteString(kind)
	sb.WriteByte('|')
	sb.WriteString(normalizeMonitorText(message))
	for _, frame := range monitorTopFrames(stack, 3) {
		sb.WriteByte('|')
		sb.WriteString(frame)
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(sum[:8])
}

// normalizeMonitorText 剔除消息中的易变量（数字/十六进制/UUID），保留错误模板骨架。
func normalizeMonitorText(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "<empty>"
	}
	s = monitorLongHexRegex.ReplaceAllString(s, "<hex>")
	return monitorNumRegex.ReplaceAllString(s, "<n>")
}

// monitorTopFrames 逐行扫描 V8 stack，提取顶部 n 帧的「函数名|文件基名」。
// 行列号刻意丢弃（归一化）；无函数名的帧记 <anonymous>。
func monitorTopFrames(stack string, n int) []string {
	frames := make([]string, 0, n)
	for _, line := range strings.Split(stack, "\n") {
		if len(frames) >= n {
			break
		}
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "at ") {
			continue
		}
		body := strings.TrimPrefix(line, "at ")
		fn, loc := "", body
		// V8 两种形态：`at fn (url:1:2)` 与 `at url:1:2`
		if i := strings.IndexByte(body, '('); i >= 0 {
			fn = strings.TrimSpace(body[:i])
			loc = strings.TrimSuffix(strings.TrimSpace(body[i+1:]), ")")
		}
		// 尾部 :line:col 用双 LastIndex 剥离（首个冒号会截断 https:// 协议头）
		if i := strings.LastIndexByte(loc, ':'); i >= 0 {
			if j := strings.LastIndexByte(loc[:i], ':'); j >= 0 {
				i = j
			}
			loc = loc[:i]
		}
		if fn == "" {
			fn = "<anonymous>"
		}
		frames = append(frames, fn+"|"+filepath.Base(loc))
	}
	return frames
}

// monitorPayloadString 取 payload 中的字符串字段（缺省空串），指纹输入提取用。
func monitorPayloadString(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	if v, ok := payload[key].(string); ok {
		return v
	}
	return ""
}

// RecordMonitorEvents batch-inserts valid monitor events into "MonitorEvent"
// with server-side error fingerprinting and repository attribution.
func (s *PgxStore) RecordMonitorEvents(ctx context.Context, userID string, events []MonitorEventInput) (int, error) {
	if len(events) == 0 || userID == "" {
		return 0, nil
	}

	const maxBatch = 50
	if len(events) > maxBatch {
		events = events[:maxBatch]
	}

	var validEvents []MonitorEventInput
	for _, ev := range events {
		if _, ok := allowedMonitorEventKinds[ev.Kind]; ok {
			validEvents = append(validEvents, ev)
		}
	}
	if len(validEvents) == 0 {
		return 0, nil
	}

	// 与 RecordTelemetryEvents 同款：按 pageUrl 兜底解析仓库归因
	needLookup := make(map[string]struct{})
	for _, ev := range validEvents {
		if ev.RepositoryID == nil || *ev.RepositoryID == "" {
			if m := telemetryRepoRegex.FindStringSubmatch(ev.PageURL); len(m) >= 3 {
				needLookup[strings.ToLower(m[1])+"/"+strings.ToLower(m[2])] = struct{}{}
			}
		}
	}
	idMap := make(map[string]string, len(needLookup))
	if len(needLookup) > 0 {
		owners := make([]string, 0, len(needLookup))
		for ref := range needLookup {
			owners = append(owners, strings.Split(ref, "/")[0])
		}
		if rows, err := db.New(s.pool).GetRepoIDsByOwnerList(ctx, owners); err == nil {
			for _, r := range rows {
				idMap[r.Owner+"/"+r.Repo] = r.ID
			}
		}
	}

	q := db.New(s.pool)
	inserted := 0
	for _, ev := range validEvents {
		pageURL := ev.PageURL
		if pageURL == "" {
			pageURL = "unknown"
		}
		sessionID := ev.SessionID
		if sessionID == "" {
			sessionID = "unknown"
		}

		var repoIDText pgtype.Text
		if ev.RepositoryID != nil && *ev.RepositoryID != "" {
			repoIDText = pgtype.Text{String: *ev.RepositoryID, Valid: true}
		} else if m := telemetryRepoRegex.FindStringSubmatch(pageURL); len(m) >= 3 {
			if found, ok := idMap[strings.ToLower(m[1])+"/"+strings.ToLower(m[2])]; ok {
				repoIDText = pgtype.Text{String: found, Valid: true}
			}
		}

		var fpText pgtype.Text
		if _, ok := monitorErrorKinds[ev.Kind]; ok {
			fp := monitorFingerprint(
				ev.Kind,
				monitorPayloadString(ev.Payload, "message"),
				monitorPayloadString(ev.Payload, "stack"),
			)
			fpText = pgtype.Text{String: fp, Valid: true}
		}

		var sevText pgtype.Text
		if ev.Severity != nil && *ev.Severity != "" {
			sevText = pgtype.Text{String: *ev.Severity, Valid: true}
		}

		var payloadJSON []byte
		if ev.Payload != nil {
			payloadJSON, _ = json.Marshal(ev.Payload)
		}

		if err := q.InsertMonitorEvent(ctx, db.InsertMonitorEventParams{
			ID:           uuid.New().String(),
			SessionId:    sessionID,
			Kind:         ev.Kind,
			PageUrl:      pageURL,
			UserId:       pgtype.Text{String: userID, Valid: true},
			RepositoryId: repoIDText,
			Fingerprint:  fpText,
			Severity:     sevText,
			Payload:      payloadJSON,
		}); err == nil {
			inserted++
		}
	}
	return inserted, nil
}

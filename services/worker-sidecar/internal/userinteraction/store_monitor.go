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

type MonitorEventInput struct {
	Kind         string         `json:"kind"`
	PageURL      string         `json:"pageUrl"`
	SessionID    string         `json:"sessionId,omitempty"`
	Severity     *string        `json:"severity,omitempty"`
	Payload      map[string]any `json:"payload,omitempty"`
	RepositoryID *string        `json:"repositoryId,omitempty"`
}

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

var monitorErrorKinds = map[string]struct{}{
	"JS_ERROR":          {},
	"PROMISE_REJECTION": {},
	"RENDER_ERROR":      {},
}

var (
	monitorLongHexRegex = regexp.MustCompile(`[0-9a-fA-F-]{16,}`)
	monitorNumRegex     = regexp.MustCompile(`\d+`)
)

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

func normalizeMonitorText(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "<empty>"
	}
	s = monitorLongHexRegex.ReplaceAllString(s, "<hex>")
	return monitorNumRegex.ReplaceAllString(s, "<n>")
}

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
		if i := strings.IndexByte(body, '('); i >= 0 {
			fn = strings.TrimSpace(body[:i])
			loc = strings.TrimSuffix(strings.TrimSpace(body[i+1:]), ")")
		}
		// Strip trailing :line:col via LastIndex so https:// protocol colons stay intact.
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

func monitorPayloadString(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	if v, ok := payload[key].(string); ok {
		return v
	}
	return ""
}

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

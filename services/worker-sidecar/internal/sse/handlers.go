package sse

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/jobs"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

type Gateway struct {
	cfg       Config
	store     Store
	auth      *AuthResolver
	hub       *JobSnapshotHub
	authCache *SessionAuthCache
	limiter   *ConnLimiter

	activeClientsHub *snapshotHub[string, []ProjectedClient]
	notificationsHub *snapshotHub[string, *NotificationSnapshot]
	repoIngestHub    *snapshotHub[string, string]
}

type SSEGateway = Gateway

func NewGateway(cfg Config, store Store) *Gateway {
	cache := NewSessionAuthCache()
	auth := NewAuthResolver(cfg, store, cache)
	hub := NewJobSnapshotHub(store)
	limiter := NewConnLimiter(cfg.SseMaxConnsPerUser, cfg.SseMaxConnsPerIP, cfg.SseMaxGlobalConns)

	probeMs := cfg.SseProbeIntervalMs
	if probeMs <= 0 {
		probeMs = 10000
	}
	probeInterval := time.Duration(probeMs) * time.Millisecond

	g := &Gateway{
		cfg:       cfg,
		store:     store,
		auth:      auth,
		hub:       hub,
		authCache: cache,
		limiter:   limiter,
	}
	g.activeClientsHub = newSnapshotHub[string](func(ctx context.Context, userId string) ([]ProjectedClient, error) {
		return store.GetActiveClients(ctx, userId, time.Now())
	}, 30*time.Second)
	g.notificationsHub = newSnapshotHub[string](func(ctx context.Context, userId string) (*NotificationSnapshot, error) {
		return store.GetNotificationSnapshot(ctx, userId)
	}, probeInterval)
	g.repoIngestHub = newSnapshotHub[string](func(ctx context.Context, repositoryId string) (string, error) {
		return store.GetRepoIngestSnapshot(ctx, repositoryId)
	}, probeInterval)
	return g
}

func NewSSEGateway(cfg Config, store Store) *Gateway {
	return NewGateway(cfg, store)
}

func (g *Gateway) Close() {
	if g != nil && g.authCache != nil {
		g.authCache.Close()
	}
}

func (g *Gateway) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/ingest-jobs/{id}/events", g.HandleIngestJobEvents)
	mux.HandleFunc("GET /v1/sse/ingest-jobs/{id}/events", g.HandleIngestJobEvents)

	mux.HandleFunc("GET /api/mcp/active-clients/stream", g.HandleMcpActiveClients)
	mux.HandleFunc("GET /v1/sse/mcp/active-clients/stream", g.HandleMcpActiveClients)

	mux.HandleFunc("GET /api/notifications/stream", g.HandleNotifications)
	mux.HandleFunc("GET /v1/sse/notifications/stream", g.HandleNotifications)

	mux.HandleFunc("GET /api/ingest/{owner}/{repo}/events", g.HandleRepoIngestEvents)
	mux.HandleFunc("GET /v1/sse/ingest/{owner}/{repo}/events", g.HandleRepoIngestEvents)
}

func (g *Gateway) acquireConn(w http.ResponseWriter, r *http.Request, userId string) (func(), bool) {
	if g.limiter == nil {
		return func() {}, true
	}
	clientIP := ExtractClientIP(r)
	release, err := g.limiter.Acquire(userId, clientIP)
	if err != nil {
		if errors.Is(err, ErrTooManyPerUser) || errors.Is(err, ErrTooManyPerIP) {
			w.Header().Set("Retry-After", "5")
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"Too many concurrent SSE connections"}`))
			return nil, false
		}
		if errors.Is(err, ErrTooManyGlobal) {
			w.Header().Set("Retry-After", "10")
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"Server busy, too many active connections"}`))
			return nil, false
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return nil, false
	}
	return release, true
}

func (g *Gateway) HandleIngestJobEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "Bad Request: Missing job id", http.StatusBadRequest)
		return
	}

	userId, authenticated, err := g.auth.ResolveAuth(r.Context(), r)
	if err != nil || !authenticated || userId == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	headerSince := r.Header.Get("last-event-id")
	querySince := r.URL.Query().Get("since")
	since := -1
	if headerSince != "" {
		if n, parseErr := strconv.Atoi(headerSince); parseErr == nil {
			since = n
		}
	} else if querySince != "" {
		if n, parseErr := strconv.Atoi(querySince); parseErr == nil {
			since = n
		}
	}

	initialJob, err := g.store.GetImportJobSnapshot(r.Context(), id)
	if err != nil || initialJob == nil || initialJob.UserID != userId {
		http.Error(w, "Job not found", http.StatusNotFound)
		return
	}

	release, ok := g.acquireConn(w, r, userId)
	if !ok {
		return
	}
	defer release()

	sw, err := NewWriter(w)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer sw.Close()

	_ = sw.SendRetry(3000)

	jobLifetimeMs := g.cfg.SseJobMaxLifetimeMs
	if jobLifetimeMs <= 0 {
		jobLifetimeMs = 900000
	}
	lifetimeTimer := time.NewTimer(time.Duration(jobLifetimeMs) * time.Millisecond)
	defer lifetimeTimer.Stop()

	heartbeatMs := g.cfg.SseHeartbeatMs
	if heartbeatMs <= 0 {
		heartbeatMs = 15000
	}
	heartbeatTicker := time.NewTicker(time.Duration(heartbeatMs) * time.Millisecond)
	defer heartbeatTicker.Stop()

	sub := g.hub.Subscribe(id)
	defer sub.cancel()

	cursor := since
	lastQueuePos := -1

	initialEvents, _ := g.store.GetImportJobEvents(r.Context(), id, cursor)
	for _, ev := range initialEvents {
		if ev.Seq > cursor {
			_ = sw.SendEvent(strconv.Itoa(ev.Seq), "", formatJobEvent(ev))
			cursor = ev.Seq
		}
	}
	if initialJob.Status == "QUEUED" {
		pos, _ := g.store.GetQueuedJobPosition(r.Context(), initialJob.CreatedAt)
		lastQueuePos = pos
		msg := "已排到队首,即将开始导入…"
		if pos > 0 {
			msg = fmt.Sprintf("当前排队中:前面还有 %d 个导入任务,请稍候…", pos)
		}
		_ = sw.SendEvent("", "", map[string]string{"type": "log", "message": msg})
	}

	// Delegate terminal status checks to jobs.IsTerminal (SSOT) so SSE and runner never drift.
	if jobs.IsTerminal(jobs.ImportJobStatus(initialJob.Status)) {
		g.emitTerminalEvent(sw, id, cursor, initialJob)
		return
	}

	consecutiveNulls := 0
	for {
		select {
		case <-r.Context().Done():
			return
		// Close cleanly at max lifetime so browsers reconnect seamlessly via Last-Event-ID.
		case <-lifetimeTimer.C:
			_ = sw.SendComment("lifetime_refresh")
			return
		case <-heartbeatTicker.C:
			if err := sw.SendComment("ping"); err != nil {
				return
			}
		case bundle, ok := <-sub.C:
			if !ok {
				return
			}
			if bundle == nil || bundle.Err != nil || bundle.Job == nil {
				consecutiveNulls++
				if consecutiveNulls >= 3 {
					_ = sw.SendEvent(strconv.Itoa(cursor+1), "", map[string]string{"type": "error", "message": "任务已不存在"})
					return
				}
				continue
			}
			consecutiveNulls = 0

			if bundle.Job.UserID != userId {
				_ = sw.SendEvent(strconv.Itoa(cursor+1), "", map[string]string{"type": "error", "message": "任务已不存在"})
				return
			}

			for _, ev := range bundle.Events {
				if ev.Seq > cursor {
					_ = sw.SendEvent(strconv.Itoa(ev.Seq), "", formatJobEvent(ev))
					cursor = ev.Seq
				}
			}

			if bundle.Job.Status == "QUEUED" && bundle.QueuePosition != lastQueuePos {
				lastQueuePos = bundle.QueuePosition
				msg := "已排到队首,即将开始导入…"
				if bundle.QueuePosition > 0 {
					msg = fmt.Sprintf("当前排队中:前面还有 %d 个导入任务,请稍候…", bundle.QueuePosition)
				}
				_ = sw.SendEvent("", "", map[string]string{"type": "log", "message": msg})
			}

			if jobs.IsTerminal(jobs.ImportJobStatus(bundle.Job.Status)) {
				g.emitTerminalEvent(sw, id, cursor, bundle.Job)
				return
			}
		}
	}
}

func (g *Gateway) emitTerminalEvent(sw *Writer, jobId string, cursor int, job *ImportJobSnapshot) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	hasTerminal, _ := g.store.HasTerminalEvent(ctx, jobId)
	if !hasTerminal {
		payload := map[string]any{
			"type":    "done",
			"message": "Ingestion complete",
		}
		if job.Status != "COMPLETED" {
			payload["type"] = "error"
			if job.Error != nil && *job.Error != "" {
				rawErr := *job.Error
				if decoded, ok := client.DecodeStructuredDbError(rawErr); ok {
					if decoded.Message != "" {
						payload["message"] = decoded.Message
						payload["upstreamMessage"] = decoded.Message
					} else {
						payload["message"] = rawErr
					}
					if decoded.Code != "" {
						payload["code"] = decoded.Code
					}
					if decoded.Provider != "" {
						payload["provider"] = decoded.Provider
					}
					if decoded.Model != "" {
						payload["model"] = decoded.Model
					}
					if decoded.UpstreamStatus > 0 {
						payload["upstreamStatus"] = decoded.UpstreamStatus
					}
					if decoded.UpstreamCode != "" {
						payload["upstreamCode"] = decoded.UpstreamCode
					}
				} else {
					payload["message"] = rawErr
				}
			} else {
				payload["message"] = "导入任务失败"
			}
		}
		_ = sw.SendEvent(strconv.Itoa(cursor+1), "", payload)
	}
}

func formatJobEvent(ev ImportJobEventDTO) []byte {
	var m map[string]any
	if len(ev.Payload) > 0 {
		_ = json.Unmarshal(ev.Payload, &m)
	}
	if m == nil {
		m = make(map[string]any)
	}
	m["type"] = ev.Type
	b, err := json.Marshal(m)
	if err != nil {
		return []byte(fmt.Sprintf(`{"type":%q}`, ev.Type))
	}
	return b
}

func (g *Gateway) HandleMcpActiveClients(w http.ResponseWriter, r *http.Request) {
	userId, authenticated, err := g.auth.ResolveAuth(r.Context(), r)
	if err != nil || !authenticated || userId == "" {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		_, _ = w.Write([]byte("data: {\"clients\":[],\"unauthenticated\":true}\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		return
	}

	release, ok := g.acquireConn(w, r, userId)
	if !ok {
		return
	}
	defer release()

	sw, err := NewWriter(w)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer sw.Close()

	_ = sw.SendRetry(3000)

	maxLifetimeMs := g.cfg.SseMaxLifetimeMs
	if maxLifetimeMs <= 0 {
		maxLifetimeMs = 600000
	}
	lifetimeTimer := time.NewTimer(time.Duration(maxLifetimeMs) * time.Millisecond)
	defer lifetimeTimer.Stop()

	heartbeatTicker := time.NewTicker(20 * time.Second)
	defer heartbeatTicker.Stop()

	sub := g.activeClientsHub.Subscribe(userId)
	defer sub.cancel()

	clients, _ := g.store.GetActiveClients(r.Context(), userId, time.Now())
	if clients == nil {
		clients = []ProjectedClient{}
	}
	lastBytes, _ := json.Marshal(clients)
	_ = sw.SendEvent("", "", map[string]any{"clients": clients})

	for {
		select {
		case <-r.Context().Done():
			return
		case <-lifetimeTimer.C:
			return
		case <-heartbeatTicker.C:
			if err := sw.SendComment("heartbeat"); err != nil {
				return
			}
		case next := <-sub.C:
			if next == nil {
				next = []ProjectedClient{}
			}
			nextBytes, _ := json.Marshal(next)
			if !bytes.Equal(lastBytes, nextBytes) {
				lastBytes = nextBytes
				_ = sw.SendEvent("", "", map[string]any{"clients": next})
			}
		}
	}
}

func (g *Gateway) HandleNotifications(w http.ResponseWriter, r *http.Request) {
	userId, authenticated, err := g.auth.ResolveAuth(r.Context(), r)
	if err != nil || !authenticated || userId == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	release, ok := g.acquireConn(w, r, userId)
	if !ok {
		return
	}
	defer release()

	sw, err := NewWriter(w)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer sw.Close()

	maxLifetimeMs := g.cfg.SseMaxLifetimeMs
	if maxLifetimeMs <= 0 {
		maxLifetimeMs = 600000
	}

	sub := g.notificationsHub.Subscribe(userId)
	defer sub.cancel()

	heartbeatTicker := time.NewTicker(25 * time.Second)
	defer heartbeatTicker.Stop()

	lifetimeTimer := time.NewTimer(time.Duration(maxLifetimeMs) * time.Millisecond)
	defer lifetimeTimer.Stop()

	lastSnap, err := g.store.GetNotificationSnapshot(r.Context(), userId)
	if err == nil && lastSnap != nil {
		_ = sw.SendEvent("", "notifications", lastSnap)
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-lifetimeTimer.C:
			return
		case <-heartbeatTicker.C:
			if err := sw.SendComment("heartbeat"); err != nil {
				return
			}
		case nextSnap := <-sub.C:
			if nextSnap != nil {
				if lastSnap == nil || nextSnap.UnreadCount != lastSnap.UnreadCount || !stringPtrEqual(nextSnap.LatestID, lastSnap.LatestID) {
					lastSnap = nextSnap
					_ = sw.SendEvent("", "notifications", nextSnap)
				}
			}
		}
	}
}

func (g *Gateway) HandleRepoIngestEvents(w http.ResponseWriter, r *http.Request) {
	owner := strings.TrimSpace(r.PathValue("owner"))
	repo := strings.TrimSpace(r.PathValue("repo"))
	edition := strings.TrimSpace(r.URL.Query().Get("edition"))

	if owner == "" || repo == "" {
		http.Error(w, "Bad Request: Missing repo path", http.StatusBadRequest)
		return
	}

	userId, _, _ := g.auth.ResolveAuth(r.Context(), r)

	branch := strings.TrimSpace(r.URL.Query().Get("branch"))
	if branch == "" {
		branch = g.cfg.DefaultBranch
	}
	if branch == "" {
		branch = "main"
	}
	repoSnap, err := g.store.GetRepositoryForEvents(r.Context(), owner, repo, branch, edition)
	if err != nil || repoSnap == nil {
		http.Error(w, "Repository not found", http.StatusNotFound)
		return
	}

	hasAccess, err := g.store.VerifyRepoAccess(r.Context(), repoSnap.ID, repoSnap.IsPublic, userId)
	if err != nil || !hasAccess {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	release, ok := g.acquireConn(w, r, userId)
	if !ok {
		return
	}
	defer release()

	sw, err := NewWriter(w)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer sw.Close()

	maxLifetimeMs := g.cfg.SseMaxLifetimeMs
	if maxLifetimeMs <= 0 {
		maxLifetimeMs = 600000
	}

	sub := g.repoIngestHub.Subscribe(repoSnap.ID)
	defer sub.cancel()

	heartbeatTicker := time.NewTicker(25 * time.Second)
	defer heartbeatTicker.Stop()

	lifetimeTimer := time.NewTimer(time.Duration(maxLifetimeMs) * time.Millisecond)
	defer lifetimeTimer.Stop()

	lastSnapStr, _ := g.store.GetRepoIngestSnapshot(r.Context(), repoSnap.ID)
	_ = sw.SendEvent("", "ingest", lastSnapStr)

	for {
		select {
		case <-r.Context().Done():
			return
		case <-lifetimeTimer.C:
			return
		case <-heartbeatTicker.C:
			if err := sw.SendComment("heartbeat"); err != nil {
				return
			}
		case nextSnapStr := <-sub.C:
			if nextSnapStr != lastSnapStr {
				lastSnapStr = nextSnapStr
				_ = sw.SendEvent("", "ingest", nextSnapStr)
			}
		}
	}
}

func stringPtrEqual(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

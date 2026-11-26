package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/metrics"
)

func (s *server) cachedLookupToken(ctx context.Context, tokenHash string) (*TokenRecord, error) {
	v, err := s.tokenCache.getOrLoadWithCustomTTL(tokenHash, func() (any, time.Duration, error) {
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		rec, qerr := s.store.LookupToken(loadCtx, tokenHash)
		if qerr != nil {
			return nil, 0, qerr
		}
		if rec == nil {

			return nil, 10 * time.Second, nil
		}

		return rec, 5 * time.Minute, nil
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	rec, ok := v.(*TokenRecord)
	if !ok || rec == nil {
		return nil, nil
	}
	return rec, nil
}

func (s *server) cachedGetUserQuota(ctx context.Context, userID string) (UserQuota, error) {
	v, err := s.userQuotaCache.getOrLoad(userID, func() (any, error) {
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		quota, qerr := s.store.GetUserQuota(loadCtx, userID)
		if qerr != nil {
			return nil, qerr
		}
		return quota, nil
	})
	if err != nil {
		return UserQuota{}, err
	}
	if q, ok := v.(UserQuota); ok {
		return q, nil
	}
	return UserQuota{}, fmt.Errorf("unexpected quota type in cache")
}

func (s *server) cachedDefaultBranchRepo(ctx context.Context, owner, repo string) *RepoRow {
	rs, ok := s.store.(ReadStore)
	if !ok {
		return nil
	}
	v, err := s.routeCheckCache.getOrLoad(owner+"/"+repo, func() (any, error) {
		row, qerr := rs.FindDefaultBranchRepo(ctx, owner, repo, defaultBranchFromEnv())
		if qerr != nil {
			// Log lookup errors before negative-caching so upstream DB failures do not masquerade as silent 404s.
			fmt.Fprintf(os.Stderr, "[mcp-sidecar] FindDefaultBranchRepo(%s/%s) error: %v\n", owner, repo, qerr)
			return (any)(nil), nil
		}
		return row, nil
	})
	if err != nil {
		return nil
	}
	row, _ := v.(*RepoRow)
	return row
}

func (s *server) checkRepoGate(w http.ResponseWriter, r *http.Request, owner, repo, userID string, id json.RawMessage) (*RepoRow, bool) {
	rs, ok := s.store.(ReadStore)
	if !ok {
		return nil, false
	}
	repoRow := s.cachedDefaultBranchRepo(r.Context(), owner, repo)
	if repoRow == nil {
		writeJSONRPCError(w, http.StatusNotFound, -32000, "Repository not found", id)
		return nil, true
	}
	if repoRow.McpStatus == "PAUSED" {
		writeJSONRPCError(w, http.StatusServiceUnavailable, -32000,
			"MCP service for this repository is currently paused by administrator", id)
		return repoRow, true
	}
	if !repoRow.IsPublic {
		allowed, _ := rs.HasSavedRepoAccess(r.Context(), repoRow.ID, userID)
		if !allowed {
			writeJSONRPCError(w, http.StatusForbidden, -32001, "Forbidden: Repository is private", id)
			return repoRow, true
		}
	}
	return repoRow, false
}

func defaultBranchFromEnv() string {
	if v := os.Getenv("DEFAULT_BRANCH"); v != "" {
		return v
	}
	return "main"
}

func clientNameFromRequest(r *http.Request) string {

	name := firstNonEmpty(r.Header.Get("X-Mcp-Client-Name"), r.Header.Get("User-Agent"))
	if name == "" {
		return "Unknown Client"
	}
	return normalizeClientName(name)
}

func writeJSONRPCError(w http.ResponseWriter, status, code int, message string, id json.RawMessage) {
	setMCPCors(w)
	idStr := "null"
	if len(id) > 0 {
		idStr = string(id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"jsonrpc":"2.0","error":{"code":%d,"message":%s},"id":%s}`,
		code, jsonString(message), idStr)
}

type callToolResultEnvelope struct {
	Content []callToolContent `json:"content"`
	IsError bool              `json:"isError,omitempty"`
	modernResultFields
}

type callToolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// Preserve struct field order (content before isError) for byte-identical legacy JSON-RPC wire output.
func writeCallToolResult(w http.ResponseWriter, id json.RawMessage, result readResult, era eraInfo) {
	setMCPCors(w)
	envelope := callToolResultEnvelope{
		Content: []callToolContent{{Type: "text", Text: result.Text}},
		IsError: result.IsError,
	}
	envelope.setModernEnvelope(era, false)
	writeJSONRPCResponse(w, id, envelope)
}

func writeJSONRPCResponse(w http.ResponseWriter, id json.RawMessage, result any) {
	setMCPCors(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	idVal := json.RawMessage("null")
	if len(id) > 0 && string(id) != "" {
		idVal = id
	}
	resp := struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  any             `json:"result"`
	}{
		JSONRPC: "2.0",
		ID:      idVal,
		Result:  result,
	}
	_ = json.NewEncoder(w).Encode(resp)
}

func setMCPCors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", corsAllowedOrigin())
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Mcp-Method, Mcp-Name, Mcp-Protocol-Version")
}

func corsAllowedOrigin() string {
	if v := os.Getenv("CORS_ALLOWED_ORIGIN"); v != "" {
		return v
	}
	return "*"
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// Coalesce lastUsedAt/presence writes within 60s (under the 5m SSE window) to avoid per-request DB amplification.
type meterThrottle struct {
	mu   sync.Mutex
	last map[string]time.Time
}

const meterThrottleWindow = 60 * time.Second

func newMeterThrottle() *meterThrottle {
	return &meterThrottle{last: make(map[string]time.Time)}
}

func (t *meterThrottle) allow(key string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if v, ok := t.last[key]; ok && now.Sub(v) < meterThrottleWindow {
		return false
	}
	t.last[key] = now

	if len(t.last) > 4096 {
		for k, v := range t.last {
			if now.Sub(v) >= meterThrottleWindow {
				delete(t.last, k)
			}
		}
	}
	return true
}

func (s *server) fireAndForget(rec *TokenRecord, r *http.Request) {
	clientName := normalizeClientName(r.Header.Get("User-Agent"))
	tokenID := rec.TokenID
	userID := rec.UserID
	clientVer := firstNonEmpty(r.Header.Get("X-Client-Version"), r.Header.Get("Mcp-Client-Version"))
	ip := clientIP(r)
	now := time.Now()
	touchOK := s.meterThrottle.allow("tok:"+tokenID, now)
	presenceOK := s.meterThrottle.allow("usr:"+userID+"|"+clientName, now)
	if !touchOK && !presenceOK {
		metrics.Inc("mcp.meter_throttle_saved_writes")
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if touchOK {
			_ = s.store.TouchTokenLastUsed(ctx, tokenID)
		}
		if presenceOK {
			_ = s.store.UpsertPresence(ctx, userID, clientName, clientVer, ip)
		}
	}()
}

func (s *server) proxyRequest(w http.ResponseWriter, r *http.Request, body []byte, opts ...proxyOpt) {
	if r.Header.Get("x-mcp-upstream-hop") != "" {
		writeRawJSON(w, http.StatusBadGateway, `{"error":"mcp-sidecar: circular proxy loop detected"}`)
		return
	}
	target := s.cfg.UpstreamURL + r.URL.RequestURI()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, reader)
	if err != nil {
		writeRawJSON(w, http.StatusBadGateway, `{"error":"mcp-sidecar: failed to build upstream request"}`)
		return
	}
	for k, vs := range r.Header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set("x-mcp-upstream-hop", "1")
	for _, opt := range opts {
		opt(req, s.cfg)
	}
	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := s.proxy.Do(req)
	if err != nil {
		writeRawJSON(w, http.StatusBadGateway, `{"error":"mcp-sidecar: upstream unreachable"}`)
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

type proxyOpt func(*http.Request, Config)

func withQuotaSkip() proxyOpt {
	return func(req *http.Request, cfg Config) {
		req.Header.Set(cfg.UpstreamSkipHeader, "1")
		req.Header.Set("x-internal-token", cfg.InternalToken)
	}
}

func extractBearerToken(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		if token := strings.TrimSpace(auth[len("Bearer "):]); token != "" {
			return token
		}
	}
	if token := strings.TrimSpace(r.URL.Query().Get("token")); token != "" {
		return token
	}
	if token := strings.TrimSpace(r.URL.Query().Get("apiKey")); token != "" {
		return token
	}
	return ""
}

func clientIP(r *http.Request) string {

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		return strings.TrimSpace(parts[0])
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func writeRawJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprint(w, body)
}

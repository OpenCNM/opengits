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

// cachedLookupToken 令牌查询缓存（5m 正常 token，10s 负缓存防无效 Token 击穿轰炸 DB，并发单飞去重）。
func (s *server) cachedLookupToken(ctx context.Context, tokenHash string) (*TokenRecord, error) {
	v, err := s.tokenCache.getOrLoadWithCustomTTL(tokenHash, func() (any, time.Duration, error) {
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		rec, qerr := s.store.LookupToken(loadCtx, tokenHash)
		if qerr != nil {
			return nil, 0, qerr
		}
		if rec == nil {
			// 10s 负缓存（防无效 Token 击穿轰炸 DB）
			return nil, 10 * time.Second, nil
		}
		// 正常 Token 缓存 5 分钟
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

// cachedGetUserQuota 用户配额查询缓存（60s TTL，并发单飞去重）。
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

// cachedDefaultBranchRepo 路由前置检查缓存（60s TTL，null 也缓存——扫描防护）。
func (s *server) cachedDefaultBranchRepo(ctx context.Context, owner, repo string) *RepoRow {
	rs, ok := s.store.(ReadStore)
	if !ok {
		return nil
	}
	v, err := s.routeCheckCache.getOrLoad(owner+"/"+repo, func() (any, error) {
		row, qerr := rs.FindDefaultBranchRepo(ctx, owner, repo, defaultBranchFromEnv())
		if qerr != nil {
			// 查询失败与未命中同形（null 缓存防扫描），但必须留痕——静默 404 是排障黑洞
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

// checkRepoGate 路由前置检查（对齐 Node route：cachedRepo → 404/503/403 JSON-RPC 错误 + CORS）。
// 返回 (row, true) 表示已阻断响应；(row, false) 表示通过检查；若 store 未实现 ReadStore 则返回 (nil, false)。
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
	// 对齐 Node 路由：x-mcp-client-name || user-agent || 'Unknown Client'，再经归一化
	name := firstNonEmpty(r.Header.Get("X-Mcp-Client-Name"), r.Header.Get("User-Agent"))
	if name == "" {
		return "Unknown Client"
	}
	return normalizeClientName(name)
}

// writeJSONRPCError 仓库级错误信封（对齐 Node 路由的 NextResponse.json JSON-RPC 形态 + CORS）。
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

// callToolResultEnvelope tools/call 结果信封（对齐 SDK CallToolResult 投影：
// content 数组，isError 仅在 true 时出现——JSON 序列化丢弃零值 omitempty 字段；
// 2026-07-28 modern 时代附 resultType/_meta）。
type callToolResultEnvelope struct {
	Content []callToolContent `json:"content"`
	IsError bool              `json:"isError,omitempty"`
	modernResultFields
}

type callToolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// writeCallToolResult 成功/错误工具结果信封。legacy 时代输出与历史版本字节级一致
// （struct 序列化字段序与旧 Fprintf 拼接相同：content → isError）。
func writeCallToolResult(w http.ResponseWriter, id json.RawMessage, result readResult, era eraInfo) {
	setMCPCors(w)
	envelope := callToolResultEnvelope{
		Content: []callToolContent{{Type: "text", Text: result.Text}},
		IsError: result.IsError,
	}
	envelope.setModernEnvelope(era, false)
	writeJSONRPCResponse(w, id, envelope)
}

// writeJSONRPCResponse 标准 JSON-RPC 成功信封
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

// setMCPCors 对齐 getCorsHeaders('GET, POST, OPTIONS') 的公开面取值；
// Mcp-Method/Mcp-Name/Mcp-Protocol-Version 为 2026-07-28 Streamable HTTP 标准请求头。
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

// meterThrottle 计量写节流器：lastUsedAt / presence 均为低敏遥测
// （presence 消费方 SSE 活跃窗口 cutoff=now-5min，lastUsedAt 无业务读），
// 60s 内同键合并为一次写。
type meterThrottle struct {
	mu   sync.Mutex
	last map[string]time.Time
}

// meterThrottleWindow 节流窗口（远小于 presence 5min 活跃窗口）。
const meterThrottleWindow = 60 * time.Second

func newMeterThrottle() *meterThrottle {
	return &meterThrottle{last: make(map[string]time.Time)}
}

// allow 键在窗口内已写过则返回 false；首次/过期返回 true 并占位。
func (t *meterThrottle) allow(key string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if v, ok := t.last[key]; ok && now.Sub(v) < meterThrottleWindow {
		return false
	}
	t.last[key] = now
	// 空间回收：表超限时清掉窗口外条目
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

// proxyRequest 透传：保留方法/路径/查询/头/体，可选附加 quota-skip 内部头。
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

// withQuotaSkip 注入 quota-skip 头 + 内部令牌签名（Node request-guard 据此跳过重复计量）。
func withQuotaSkip() proxyOpt {
	return func(req *http.Request, cfg Config) {
		req.Header.Set(cfg.UpstreamSkipHeader, "1")
		req.Header.Set("x-internal-token", cfg.InternalToken)
	}
}

// extractBearerToken Authorization 头优先，兼容 ?token= / ?apiKey=（SSE 客户端）。
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
	// Caddy 反代场景：取 X-Forwarded-For 首段
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

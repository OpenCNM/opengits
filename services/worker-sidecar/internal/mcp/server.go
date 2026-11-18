package mcp

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// freeProtocolMethods 对齐 request-guard.ts FREE_PROTOCOL_METHODS：
// 协议级握手/发现不消耗配额（注意 resources/read 故意不在其中）。
var freeProtocolMethods = map[string]bool{
	"initialize":                true,
	"tools/list":                true,
	"prompts/list":              true,
	"resources/list":            true,
	"prompts/get":               true,
	"ping":                      true,
	"notifications/initialized": true,
	"notifications/cancelled":   true,
	"server/discover":           true,
}

func isFreeMethod(method string) bool {
	if freeProtocolMethods[method] {
		return true
	}
	return strings.HasPrefix(method, "notifications/")
}

// jsonRpcBody 单条 JSON-RPC 请求的最小解析面（method 即配额判定输入；
// params._meta 为 2026-07-28 无状态时代的协议版本声明载体）。
type jsonRpcBody struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	// Meta 单独缓存 params._meta（时代判定输入）；解析一次后全程复用，
	// 下游 dispatch/bundle/prompts 直接消费 Params 原始字节，避免整包二次解析
	Meta map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON 单次解析：body → 字段 + params._meta 提取（大 arguments 体只走一遍）
func (b *jsonRpcBody) UnmarshalJSON(data []byte) error {
	type alias struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	b.JSONRPC, b.ID, b.Method, b.Params = a.JSONRPC, a.ID, a.Method, a.Params
	if len(a.Params) > 0 {
		var probe struct {
			Meta map[string]json.RawMessage `json:"_meta"`
		}
		if err := json.Unmarshal(a.Params, &probe); err == nil {
			b.Meta = probe.Meta
		}
	}
	return nil
}

type server struct {
	cfg     Config
	store   Store
	limiter *RateLimiter
	proxy   *http.Client
	// reader 为 nil 时（store 未实现 ReadStore）read 族全部透传
	reader *readService
	// 路由前置检查缓存（对齐 repo-resolve-cache 的 cachedDefaultBranchRepository：60s TTL + null 缓存）
	routeCheckCache *ttlCache
	// 鉴权令牌与配额缓存（5m 正常 token / 10s 负缓存 / 60s 配额缓存，singleflight 去重）
	tokenCache     *ttlCache
	userQuotaCache *ttlCache
	// Bundle 元数据缓存（60s TTL + 10s 负缓存，singleflight 去重）
	bundleCache *ttlCache
	// 双轨制核心内存只读投影（Fast Track）
	projectionStore *ProjectionStore
	// 工具命令执行注册表（Command Pattern）
	toolRegistry *ToolRegistry
	hubRegistry  *HubToolRegistry
	// 计量写节流（lastUsedAt/presence 60s 合并：两者仅运维展示与 5min
	// 活跃窗口消费，每请求 2 次写往返是无谓放大）
	meterThrottle *meterThrottle
}

// MCPServer 统一封装 HTTP 服务端点与内部 server 实例。
type MCPServer struct {
	HttpServer *http.Server
	server     *server
}

// Shutdown 优雅关闭 MCP HTTP 服务，并尽力排空遥测批量写在途条目。
func (m *MCPServer) Shutdown(ctx context.Context) error {
	if m == nil || m.server == nil {
		return nil
	}
	if st, ok := m.server.store.(interface{ StopTelemetryBatcher() }); ok {
		st.StopTelemetryBatcher()
	}
	// 限流账本在途增量排空（节流窗口内未落库的计数）
	m.server.limiter.FlushPending()
	if m.HttpServer == nil {
		return nil
	}
	return m.HttpServer.Shutdown(ctx)
}

// ProjectionStore 访问当前 MCP 实例挂载的内存投影存储体。
// NewMCPServer 构建 MCP 服务端点，支持外部注入共享连接池、检索引擎与投影存储体。
func NewMCPServer(cfg Config, pool *pgxpool.Pool, searchEngine SearchEngine, projStore *ProjectionStore) *MCPServer {
	var store *pgxStore
	if pool != nil {
		store = NewPgxStoreWithPool(pool, cfg, searchEngine)
	} else if cfg.DatabaseURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		var err error
		store, err = newPgxStore(ctx, cfg)
		cancel()
		if err != nil {
			log.Fatalf("[mcp-sidecar] failed to init pgx pool: %v", err)
		}
		if searchEngine != nil {
			store.searchEngine = searchEngine
		}
	}

	srv := newServer(cfg, store)
	if projStore != nil {
		srv.projectionStore = projStore
	}

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.routes(http.HandlerFunc(srv.handleRoot)),
		ReadHeaderTimeout: 10 * time.Second,
	}

	return &MCPServer{
		HttpServer: httpServer,
		server:     srv,
	}
}

func newServer(cfg Config, store Store) *server {
	s := &server{
		cfg:             cfg,
		store:           store,
		limiter:         NewRateLimiter(store),
		routeCheckCache: newTTLCache(60*time.Second, 512),
		tokenCache:      newTTLCache(5*time.Minute, 2048),
		userQuotaCache:  newTTLCache(60*time.Second, 2048),
		bundleCache:     newTTLCache(60*time.Second, 256),
		projectionStore: newProjectionStore(),
		toolRegistry:    defaultToolRegistry(),
		hubRegistry:     defaultHubToolRegistry(),
		meterThrottle:   newMeterThrottle(),
		proxy: &http.Client{
			Timeout: time.Duration(cfg.ProxyTimeoutMs) * time.Millisecond,
			Transport: &http.Transport{
				MaxIdleConns:          16,
				MaxIdleConnsPerHost:   16, // 透传上游固定单 host（web:3000），缺省 2 会使池形同虚设
				IdleConnTimeout:       90 * time.Second,
				ResponseHeaderTimeout: time.Duration(cfg.ProxyTimeoutMs) * time.Millisecond,
			},
		},
	}
	if rs, ok := store.(ReadStore); ok {
		s.reader = newReadServiceWithConfig(rs, cfg)
	}
	return s
}

func (s *server) routes(root http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeRawJSON(w, http.StatusOK, `{"status":"ok"}`)
	})
	mux.HandleFunc("POST /v1/projection/invalidate", s.handleInvalidateProjection)
	// 其余全部走 MCP 控制面管线（含 GET 发现面——直接透传，Node 侧语义不变）
	mux.Handle("/", root)
	return mux
}

type invalidateProjectionReq struct {
	RepositoryID string `json:"repositoryId"`
	Owner        string `json:"owner"`
	Repo         string `json:"repo"`
}

func (s *server) handleInvalidateProjection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := r.Header.Get("x-internal-token")
	if token == "" {
		if auth := r.Header.Get("authorization"); strings.HasPrefix(auth, "Bearer ") {
			token = strings.TrimPrefix(auth, "Bearer ")
		}
	}
	if !tokenEquals(token, s.cfg.InternalToken) {
		writeRawJSON(w, http.StatusUnauthorized, `{"error":"unauthorized"}`)
		return
	}

	var req invalidateProjectionReq
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	if s.projectionStore != nil {
		if req.RepositoryID != "" {
			s.projectionStore.InvalidateByID(req.RepositoryID)
		}
		if req.Owner != "" && req.Repo != "" {
			s.projectionStore.Invalidate(req.Owner, req.Repo)
		}
	}

	writeRawJSON(w, http.StatusOK, `{"ok":true}`)
}

// handleRoot MCP 控制面入口。
func (s *server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		setMCPCors(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method == http.MethodGet {
		owner, repo, isSingleRepo := singleRepoSegments(r.URL.Path)
		isHub := isHubPath(r.URL.Path)
		bundleID, isBundle := bundleSegments(r.URL.Path)

		switch {
		case isSingleRepo:
			s.handleRepoDiscovery(w, r, owner, repo)
			return
		case isHub:
			s.handleHubDiscovery(w, r)
			return
		case isBundle:
			s.handleBundleDiscovery(w, r, bundleID)
			return
		default:
			s.proxyRequest(w, r, nil)
			return
		}
	}

	if r.Method != http.MethodPost {
		s.proxyRequest(w, r, nil)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		writeRawJSON(w, http.StatusBadRequest, `{"error":"failed to read request body"}`)
		return
	}

	// 鉴权：Bearer / ?token= / ?apiKey=（对齐 token-auth.ts extractBearerToken）
	token := extractBearerToken(r)
	if token == "" {
		// 无凭证（session cookie 流量）→ 原样透传，Node 侧 NextAuth 鉴权不变
		s.proxyRequest(w, r, body)
		return
	}

	ctx := r.Context()
	rec, err := s.cachedLookupToken(ctx, sha256Hex(token))
	if err != nil || rec == nil {
		// 无效/已吊销 token：硬拒 401，绝不回落 Cookie（对齐 Node 身份串号防线）
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeRawJSON(w, http.StatusUnauthorized,
			`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized: invalid or revoked API token"},"id":null}`)
		return
	}

	// fire-and-forget：token lastUsedAt + 心跳 presence（对齐 Node 路由的记录语义）
	s.fireAndForget(rec, r)

	var rpc jsonRpcBody
	_ = json.Unmarshal(body, &rpc)
	method := rpc.Method

	owner, repo, isSingleRepo := singleRepoSegments(r.URL.Path)
	isHub := isHubPath(r.URL.Path)
	bundleID, isBundle := bundleSegments(r.URL.Path)

	// 2026-07-28 无状态时代判定（body 优先，与 SDK classifyInboundRequest 一致）
	era := detectEra(rpc.Meta)
	switch {
	case isHub:
		era.ServerName = "opengits-user-hub"
	case isBundle:
		era.ServerName = "opengits-mcp-bundle"
	default:
		era.ServerName = "opengits-mcp-sidecar"
	}
	if !validateModernEra(w, rpc.ID, rpc.Meta, era) {
		return
	}
	if era.Modern {
		// 规范删除语义：initialize 握手与 ping 在 2026-07-28 已移除，
		// modern 时代按未定义方法应答（对齐 SDK "refused" 行为）
		switch method {
		case "initialize", "ping", "logging/setLevel":
			writeJSONRPCError(w, http.StatusOK, -32601,
				"Method not found: "+method+" was removed in protocol "+modernProtocolVersion, rpc.ID)
			return
		}
	}

	// server/discover：三端点共用的协议发现面（2026-07-28 MUST），静态原生应答
	if method == "server/discover" {
		s.handleServerDiscover(w, rpc.ID, era)
		return
	}

	// 原生应答：ping、notifications/*（零内容风险的协议级方法；modern 时代已在上方拦截）。
	switch {
	case method == "ping":
		setMCPCors(w)
		// JSON-RPC 要求响应回显请求 id：硬编码 id:null 会被按 id 匹配的
		// MCP 客户端（官方 SDK/Cursor）当孤儿帧，ping 被计为超时。
		// id 缺失时（非法请求）保留 null 字面量。
		id := []byte("null")
		if len(rpc.ID) > 0 {
			id = rpc.ID
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(id) + `,"result":{}}`))
		return
	case strings.HasPrefix(method, "notifications/"):
		setMCPCors(w)
		w.WriteHeader(http.StatusAccepted)
		return
	}

	// MCP Prompts 协议面 100% 由 Go 原生承接，不再反代 Node
	if method == "prompts/list" {
		s.handleNativePromptsList(w, rpc.ID, era)
		return
	}
	if method == "prompts/get" {
		s.handleNativePromptsGet(w, rpc.Params, rpc.ID, era)
		return
	}

	if isSingleRepo && (method == "initialize" || method == "tools/list") {
		if _, blocked := s.checkRepoGate(w, r, owner, repo, rec.UserID, rpc.ID); blocked {
			return
		}
		if method == "initialize" {
			s.handleNativeInitialize(w, body, rpc.ID)
		} else {
			s.handleNativeToolsList(w, rpc.ID, era)
		}
		return
	}

	if isHub && (method == "initialize" || method == "tools/list" || method == "resources/list") {
		switch method {
		case "initialize":
			s.handleHubInitialize(w, body, rpc.ID)
		case "tools/list":
			s.handleHubToolsList(w, rpc.ID, era)
		case "resources/list":
			s.handleHubResourcesList(w, rpc.ID, era)
		}
		return
	}

	if isBundle && (method == "initialize" || method == "tools/list") {
		switch method {
		case "initialize":
			s.handleBundleInitialize(w, r.Context(), bundleID, body, rpc.ID)
		case "tools/list":
			s.handleBundleToolsList(w, rpc.ID, era)
		}
		return
	}

	if isFreeMethod(method) {
		// 协议级握手/发现：不计量，透传（Node 对 free method 本就不扣配额，无需 skip 头）
		s.proxyRequest(w, r, body)
		return
	}

	// 计量路径：Go 是唯一计量点 → 透传携带 quota-skip 头，Node 侧跳过重复计数
	quota, err := s.cachedGetUserQuota(ctx, rec.UserID)
	if err != nil {
		// fail-open：配额查询失败不阻断（与 Node catch→null→默认配额语义近似，避免边缘 5xx）
		quota = UserQuota{Role: "USER", RpmLimit: 30, DailyLimit: 100, TokenCap: 4000}
	}
	result := s.limiter.Check(ctx, rec.UserID, quota, time.Now())
	if !result.Allowed {
		for k, v := range result.Headers {
			w.Header().Set(k, v)
		}
		writeRawJSON(w, result.Status, result.ErrorFmt)
		return
	}

	// Bundle 模式原生承接（4 大核心工具纯 Go 执行）
	if isBundle {
		if s.tryNativeBundle(w, r, body, rpc, bundleID, rec.UserID, quota, era) {
			return
		}
	}

	// Hub 模式原生承接（Phase 2d+ 收官）：resources/read 与 tools/call
	if isHub {
		if method == "resources/read" {
			var rParams struct {
				URI string `json:"uri"`
			}
			_ = json.Unmarshal(rpc.Params, &rParams)
			if rParams.URI == "hub://overview" {
				text := s.reader.runHubOverview(ctx, rec.UserID)
				setMCPCors(w)
				result := map[string]any{
					"contents": []map[string]any{
						{
							"uri":      "hub://overview",
							"mimeType": "text/markdown",
							"text":     text,
						},
					},
				}
				if era.Modern {
					// resources/read 属 CacheableResult；授权响应禁止共享缓存
					result["resultType"] = resultTypeComplete
					result["ttlMs"] = modernListTTLMs
					result["cacheScope"] = modernCacheScope
					result["_meta"] = map[string]any{
						metaKeyServerInfo: ServerInfo{Name: era.ServerName, Version: "1.0.0"},
					}
				}
				writeJSONRPCResponse(w, rpc.ID, result)
				return
			}
			writeJSONRPCError(w, http.StatusOK, -32602, "Resource not found: "+rParams.URI, rpc.ID)
			return
		}
		if s.tryNativeHub(w, r, body, rpc, rec.UserID, quota, era) {
			return
		}
	}

	// Phase 2b：单仓路由的 read 族 tools/call Go 原生执行（其余工具透传不变）
	if s.tryNativeRead(w, r, body, rpc, rec.UserID, quota, era) {
		return
	}
	s.proxyRequest(w, r, body, withQuotaSkip())
}

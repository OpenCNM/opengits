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

// Handshake/discovery methods are quota-free; resources/read intentionally consumes quota.
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

type jsonRpcBody struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`

	Meta map[string]json.RawMessage `json:"-"`
}

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

	reader *readService

	routeCheckCache *ttlCache

	tokenCache     *ttlCache
	userQuotaCache *ttlCache

	bundleCache *ttlCache

	projectionStore *ProjectionStore

	toolRegistry *ToolRegistry
	hubRegistry  *HubToolRegistry

	meterThrottle *meterThrottle
}

type MCPServer struct {
	HttpServer *http.Server
	server     *server
}

func (m *MCPServer) Shutdown(ctx context.Context) error {
	if m == nil || m.server == nil {
		return nil
	}
	if st, ok := m.server.store.(interface{ StopTelemetryBatcher() }); ok {
		st.StopTelemetryBatcher()
	}

	m.server.limiter.FlushPending()
	if m.HttpServer == nil {
		return nil
	}
	return m.HttpServer.Shutdown(ctx)
}

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
				MaxIdleConnsPerHost:   16, // Override default MaxIdleConnsPerHost=2 so upstream keep-alive pooling works for single-host proxying.
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

	token := extractBearerToken(r)
	if token == "" {

		s.proxyRequest(w, r, body)
		return
	}

	ctx := r.Context()
	rec, err := s.cachedLookupToken(ctx, sha256Hex(token))
	if err != nil || rec == nil {
		// Hard-reject invalid bearer tokens with 401 instead of falling back to session cookies.
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeRawJSON(w, http.StatusUnauthorized,
			`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized: invalid or revoked API token"},"id":null}`)
		return
	}

	s.fireAndForget(rec, r)

	var rpc jsonRpcBody
	_ = json.Unmarshal(body, &rpc)
	method := rpc.Method

	owner, repo, isSingleRepo := singleRepoSegments(r.URL.Path)
	isHub := isHubPath(r.URL.Path)
	bundleID, isBundle := bundleSegments(r.URL.Path)

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

		// Reject legacy handshake, ping, and logging methods in the stateless modern era per MCP spec.
		switch method {
		case "initialize", "ping", "logging/setLevel":
			writeJSONRPCError(w, http.StatusOK, -32601,
				"Method not found: "+method+" was removed in protocol "+modernProtocolVersion, rpc.ID)
			return
		}
	}

	if method == "server/discover" {
		s.handleServerDiscover(w, rpc.ID, era)
		return
	}

	switch {
	case method == "ping":
		setMCPCors(w)

		// Echo the JSON-RPC request id (defaulting to null literal) because MCP clients treat id:null mismatches as timeouts.
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

		s.proxyRequest(w, r, body)
		return
	}

	quota, err := s.cachedGetUserQuota(ctx, rec.UserID)
	if err != nil {

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

	if isBundle {
		if s.tryNativeBundle(w, r, body, rpc, bundleID, rec.UserID, quota, era) {
			return
		}
	}

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

	if s.tryNativeRead(w, r, body, rpc, rec.UserID, quota, era) {
		return
	}
	s.proxyRequest(w, r, body, withQuotaSkip())
}

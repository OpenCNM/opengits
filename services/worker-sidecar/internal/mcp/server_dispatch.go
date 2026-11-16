package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// toolCanonicalName 对齐 unknown-tool-fallback.ts TOOL_ALIASES：别名 → 规范工具名。
// 分派与 policy 门控均以规范名为准（Node 侧注册/门控按规范名）。
// toolCanonicalName = 共享别名交集（tools_list.go）+ Go 特有 overlay 合并。
// Go 特有条目：
// 1. list_repositories / list_repos 映射至 list_resources（Node 侧未收录的客户端常见别名）；
// 2. read_document 映射至 read 作为向下兼容门面别名（Phase 2c 显式门面契约）：
//    - 携带 path 或 section 时按 read 语义定位精读；
//    - 无参时由 isReadDocumentFacade 门面短路为 outline 宏观形态；
//    与 TS 侧 tools/document.ts 的向下兼容委派契约双端逐字一致。
var toolCanonicalName = func() map[string]string {
	merged := make(map[string]string, len(toolCanonicalNameGen)+4)
	for k, v := range toolCanonicalNameGen {
		merged[k] = v
	}
	merged["list_repositories"] = "list_resources"
	merged["list_repos"] = "list_resources"
	merged["read_document"] = "read"
	return merged
}()

// toolsCallParams JSON-RPC tools/call 的 params 面（name + arguments）。
type toolsCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type readCallArgs struct {
	Repository     *string  `json:"repository"`
	Edition        *string  `json:"edition"`
	Category       *string  `json:"category"`
	Target         *string  `json:"target"`
	Path           *string  `json:"path"`
	Section        *string  `json:"section"`
	Action         *string  `json:"action"`
	Query          *string  `json:"query"`
	Title          *string  `json:"title"`
	Insight        *string  `json:"insight"`
	Context        *string  `json:"context"`
	Tags           []string `json:"tags"`
	Concept        *string  `json:"concept"`
	Filter         *string  `json:"filter"`
	Mode           *string  `json:"mode"`
	Detail         *string  `json:"detail"`
	TokenBudget    *float64 `json:"token_budget"`
	Limit          *int     `json:"limit"`
	Symbol         *string  `json:"symbol"`
	File           *string  `json:"file"`
	IncludeCode    *bool    `json:"include_code"`
	IncludeCallers *bool    `json:"include_callers"`
	Aspect         *string  `json:"aspect"`
	Role           *string  `json:"role"`
	StartLine      *int     `json:"start_line"`
	EndLine        *int     `json:"end_line"`
}

// rpcParams 仅用于二次解析 params 字段（body 已读入）。
type rpcParams struct {
	Params *toolsCallParams `json:"params"`
}

// singleRepoSegments 解析 /api/mcp/{owner}/{repo} 形态；非单仓（hub/bundle 等）返回 false。
// owner/repo 在此入口单点 ToLower 归一（存储行全小写，与 ingest 写入侧同口径）：
// 下游门禁（MCPFindDefaultBranchRepo 精确等值）、fast-track 投影缓存键与
// ResolveSingleRepo 三层同时吃到小写——混合大小写 URL 不再在门禁层 404
// （对齐 Node repository-resolver BUG-06「地址栏混写大小写不可 404」契约）。
func singleRepoSegments(path string) (owner, repo string, ok bool) {
	trimmed := strings.Trim(path, "/")
	parts := strings.Split(trimmed, "/")
	// 期望 [api mcp owner repo]，且 owner/repo 不含进一步子路径（readiness 等非 JSON-RPC 面不走此分支）
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "mcp" || parts[2] == "" || parts[3] == "" {
		return "", "", false
	}
	owner, repo = strings.ToLower(parts[2]), strings.ToLower(parts[3])
	// 保留字路由在归一后判定，杜绝 /Bundle /Hub 等大小写变体绕过保留字闯入单仓面
	if owner == "bundle" || owner == "hub" || owner == "tokens" || owner == "active-clients" {
		return "", "", false
	}
	return owner, repo, true
}

// bundleSegments 解析 /api/mcp/bundle/{bundleId} 形态；非 bundle 返回 false。
func bundleSegments(path string) (bundleID string, ok bool) {
	trimmed := strings.Trim(path, "/")
	parts := strings.Split(trimmed, "/")
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "mcp" && parts[2] == "bundle" && parts[3] != "" {
		return parts[3], true
	}
	return "", false
}

// isHubPath 判断是否为 /api/mcp/hub 路由。
func isHubPath(path string) bool {
	trimmed := strings.Trim(path, "/")
	return trimmed == "api/mcp/hub"
}

// tryNativeHub Hub 模式原生工具执行入口（清单与 NativeHubToolsList 锁步）；返回 false = 维持透传。
func (s *server) tryNativeHub(w http.ResponseWriter, r *http.Request, body []byte, rpc jsonRpcBody, userID string, quota UserQuota, era eraInfo) bool {
	if s.reader == nil || rpc.Method != "tools/call" {
		return false
	}
	var params toolsCallParams
	if err := json.Unmarshal(rpc.Params, &params); err != nil {
		return false
	}
	canonical, ok := toolCanonicalName[params.Name]
	if !ok {
		return false
	}
	var args readCallArgs
	if len(params.Arguments) > 0 {
		_ = json.Unmarshal(params.Arguments, &args)
	}

	isReadDocumentFacade := params.Name == "read_document" && args.Path == nil && args.Section == nil
	effectiveCanonical := canonical
	if isReadDocumentFacade {
		effectiveCanonical = "outline"
	}
	if !s.reader.toolEnabled(r.Context(), effectiveCanonical, quota) {
		return false
	}

	target := ""
	if args.Target != nil {
		target = *args.Target
	} else if args.Path != nil {
		if args.Section != nil && *args.Section != "" {
			target = *args.Path + "#" + *args.Section
		} else {
			target = *args.Path
		}
	}

	clientName := clientNameFromRequest(r)
	ctx := r.Context()
	repoRef := deref(args.Repository)
	edition := deref(args.Edition)

	env := HubToolExecutionContext{
		UserID:               userID,
		ClientName:           clientName,
		Args:                 args,
		Quota:                quota,
		Target:               target,
		Canonical:            canonical,
		IsReadDocumentFacade: isReadDocumentFacade,
		RepoRef:              repoRef,
		Edition:              edition,
	}

	result, ok := s.hubRegistry.Dispatch(ctx, s.reader, env)
	if !ok {
		return false
	}

	if !result.IsError {
		policyBudget := s.reader.readPolicyTokenBudget(ctx, canonical)
		result.Text = s.reader.applyCognitiveBudget(ctx, canonical, result.Text, quota, policyBudget, args.TokenBudget, target)
	}

	writeCallToolResult(w, rpc.ID, result, era)
	return true
}

// tryNativeRead read/outline/list_resources 族原生执行入口；返回 false = 维持透传。
// 覆盖条件：单仓路由 + tools/call + 别名族命中 + policy/tier 启用（按规范名）。
func (s *server) tryNativeRead(w http.ResponseWriter, r *http.Request, body []byte, rpc jsonRpcBody, userID string, quota UserQuota, era eraInfo) bool {
	if s.reader == nil || rpc.Method != "tools/call" {
		return false
	}
	owner, repo, ok := singleRepoSegments(r.URL.Path)
	if !ok {
		return false
	}

	var params toolsCallParams
	if err := json.Unmarshal(rpc.Params, &params); err != nil {
		return false
	}
	if _, ok := toolCanonicalName[params.Name]; !ok {
		return false
	}
	var args readCallArgs
	if len(params.Arguments) > 0 {
		_ = json.Unmarshal(params.Arguments, &args)
	}

	// read_document 无参 → 门面回退到 outline（Phase 2c 起为 Go 原生）
	isReadDocumentFacade := params.Name == "read_document" && args.Path == nil && args.Section == nil

	// policy/tier 门控：禁用或档位不足 → 透传（Node 产出精确 did-you-mean 形态）
	canonical := toolCanonicalName[params.Name]
	if isReadDocumentFacade {
		canonical = "outline"
	}
	if !s.reader.toolEnabled(r.Context(), canonical, quota) {
		return false
	}

	// 别名参数改写（对齐 request-normalizer：path/section → target）
	target := ""
	if args.Target != nil {
		target = *args.Target
	} else if args.Path != nil {
		if args.Section != nil && *args.Section != "" {
			target = *args.Path + "#" + *args.Section
		} else {
			target = *args.Path
		}
	}

	edition := r.URL.Query().Get("edition")

	// ── Fast Track（双轨制内存只读投影轨）：适用于公共基线且无下钻 path 的高频只读请求 ──
	if s.tryProjectionFastTrack(w, r, rpc.ID, owner, repo, edition, canonical, userID, quota, args, target, isReadDocumentFacade, era) {
		return true
	}

	// 路由前置检查（对齐 Node route：cachedRepo → 404/503/403 JSON-RPC 错误 + CORS）
	repoRow, blocked := s.checkRepoGate(w, r, owner, repo, userID, rpc.ID)
	if blocked {
		return true
	}
	if repoRow == nil {
		return false
	}

	resolved, err := s.store.(ReadStore).ResolveSingleRepo(r.Context(), owner, repo, defaultBranchFromEnv(), edition, userID)
	if err != nil || resolved == nil {
		writeJSONRPCError(w, http.StatusNotFound, -32000, "Repository not found", rpc.ID)
		return true
	}

	// ── Fresh Track 穿透预热：仅在公共基线（无私有副本且非暂停）时填充共享内存投影 ──
	var warmedProj *RepoStructuralProjection
	if s.projectionStore != nil && resolved.Repository.IsPublic && resolved.Repository.McpStatus != "PAUSED" && !s.hasUserPrivateDocs(r.Context(), resolved.Repository.ID, userID) {
		if existing, found := s.projectionStore.Get(owner, repo, edition); found && existing != nil {
			warmedProj = existing
		} else {
			if proj, err := BuildRepoProjection(r.Context(), s.store.(ReadStore), resolved); err == nil && proj != nil {
				s.projectionStore.Set(proj)
				warmedProj = proj
			}
		}
	}

	clientName := clientNameFromRequest(r)
	ctx := r.Context()

	env := ToolExecutionContext{
		Resolved:             resolved,
		UserID:               userID,
		ClientName:           clientName,
		Args:                 args,
		Quota:                quota,
		Target:               target,
		Canonical:            canonical,
		IsReadDocumentFacade: isReadDocumentFacade,
		WarmedProj:           warmedProj,
	}

	result := s.toolRegistry.Dispatch(ctx, s.reader, env)

	// 认知预算拦截与 Markdown 语法装甲（Cognitive Budget Guard 决胜）
	if !result.IsError {
		policyBudget := s.reader.readPolicyTokenBudget(ctx, canonical)
		result.Text = s.reader.applyCognitiveBudget(ctx, canonical, result.Text, quota, policyBudget, args.TokenBudget, target)
	}

	writeCallToolResult(w, rpc.ID, result, era)
	return true
}

// tryProjectionFastTrack 双轨制内存只读投影轨（Fast Track 责任链拦截器）。
// 适用于公共基线且无下钻 path 的高频只读请求（微秒级直出）。
func (s *server) tryProjectionFastTrack(
	w http.ResponseWriter,
	r *http.Request,
	rpcID json.RawMessage,
	owner, repo, edition, canonical, userID string,
	quota UserQuota,
	args readCallArgs,
	target string,
	isReadDocumentFacade bool,
	era eraInfo,
) bool {
	isOutlineFastCandidate := (canonical == "outline" && (args.Path == nil || *args.Path == "")) || isReadDocumentFacade
	isListResourcesCandidate := canonical == "list_resources"
	isCourseMapCandidate := canonical == "explore_concept" && args.Action != nil && *args.Action == "course_map"
	isFastTrackEligible := isOutlineFastCandidate || isListResourcesCandidate || isCourseMapCandidate

	if !isFastTrackEligible || s.projectionStore == nil {
		return false
	}

	proj, hit := s.projectionStore.Get(owner, repo, edition)
	if !hit || proj == nil || !proj.IsPublic || proj.McpStatus == "PAUSED" {
		return false
	}

	if userID != "" && s.hasUserPrivateDocs(r.Context(), proj.RepoID, userID) {
		return false
	}

	var text string
	switch {
	case isListResourcesCandidate:
		text = proj.PreRenderedListResources
	case isOutlineFastCandidate:
		text = proj.PreRenderedOutline
	case isCourseMapCandidate:
		text = proj.PreRenderedCourseMap
	}

	// 认知预算拦截与 Markdown 语法装甲
	policyBudget := s.reader.readPolicyTokenBudget(r.Context(), canonical)
	text = s.reader.applyCognitiveBudget(r.Context(), canonical, text, quota, policyBudget, args.TokenBudget, target)

	// 异步轻量遥测（完全不阻塞微秒级直出）
	clientName := clientNameFromRequest(r)
	go func(repoID string, docCount int) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if isOutlineFastCandidate {
			s.reader.recordTelemetry(ctx, CallLogEntry{
				ToolName: "outline", UserID: userID, ClientName: clientName, RepositoryID: repoID,
				Dimension: "documents", Status: "SUCCESS",
				ResultCount: docCount, ResponseTimeMs: 0,
			})
		} else if isCourseMapCandidate {
			s.reader.recordTelemetry(ctx, CallLogEntry{
				ToolName: "explore_concept", UserID: userID, ClientName: clientName, RepositoryID: repoID,
				Dimension: "all", Status: "SUCCESS", ResultCount: 1,
				ResponseTimeMs: 0,
			})
		}
	}(proj.RepoID, proj.DocCount)

	writeCallToolResult(w, rpcID, readResult{Text: text}, era)
	return true
}

// hasUserPrivateDocs 检查用户在该仓库是否存在私有文档副本（内存缓存 60s，防击穿）。
func (s *server) hasUserPrivateDocs(ctx context.Context, repoID, userID string) bool {
	if userID == "" || repoID == "" {
		return false
	}
	cacheKey := "priv_docs:" + repoID + ":" + userID
	v, err := s.routeCheckCache.getOrLoad(cacheKey, func() (any, error) {
		if rs, ok := s.store.(ReadStore); ok {
			return rs.HasPrivateDocs(ctx, repoID, userID), nil
		}
		return false, nil
	})
	if err != nil {
		return false
	}
	has, _ := v.(bool)
	return has
}

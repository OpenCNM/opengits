package mcp

import (
	"context"
	"fmt"
)

// ─────────────────────────────────────────────────────────────
// 单仓模式工具命令模式（Command Pattern & Tool Registry）
// ─────────────────────────────────────────────────────────────

// ToolExecutionContext 单仓原生工具执行上下文。
type ToolExecutionContext struct {
	Resolved             *ResolvedRepo
	UserID               string
	ClientName           string
	Args                 readCallArgs
	Quota                UserQuota
	Target               string
	Canonical            string
	IsReadDocumentFacade bool
	WarmedProj           *RepoStructuralProjection
}

// ToolHandler 单个 MCP 工具命令执行器（Command Pattern 接口）。
type ToolHandler interface {
	Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult
}

// ToolRegistry 单仓工具注册表与分发中心。
type ToolRegistry struct {
	handlers map[string]ToolHandler
	defaultH ToolHandler
}

func newToolRegistry(defaultHandler ToolHandler) *ToolRegistry {
	return &ToolRegistry{
		handlers: make(map[string]ToolHandler),
		defaultH: defaultHandler,
	}
}

func (r *ToolRegistry) Register(name string, h ToolHandler) {
	r.handlers[name] = h
}

func (r *ToolRegistry) Dispatch(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	if env.IsReadDocumentFacade {
		if h, ok := r.handlers["outline"]; ok {
			return h.Execute(ctx, reader, env)
		}
	}
	if h, ok := r.handlers[env.Canonical]; ok {
		return h.Execute(ctx, reader, env)
	}
	if r.defaultH != nil {
		return r.defaultH.Execute(ctx, reader, env)
	}
	return readResult{IsError: true, Text: "unsupported tool: " + env.Canonical}
}

type outlineHandler struct{}

func (outlineHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	if (env.Args.Path == nil || *env.Args.Path == "" || env.IsReadDocumentFacade) && env.WarmedProj != nil {
		if !env.IsReadDocumentFacade {
			reader.recordTelemetry(ctx, CallLogEntry{
				ToolName: "outline", UserID: env.UserID, ClientName: env.ClientName, RepositoryID: env.Resolved.Repository.ID,
				Dimension: "documents", Status: telemetryStatus(len(env.Resolved.Documents)),
				ResultCount: len(env.Resolved.Documents), ResponseTimeMs: 0,
			})
		}
		return readResult{Text: env.WarmedProj.PreRenderedOutline}
	}
	path := ""
	if !env.IsReadDocumentFacade {
		path = deref(env.Args.Path)
	}
	return reader.runOutline(ctx, env.Resolved, env.UserID, env.ClientName, path)
}

type listResourcesHandler struct{}

func (listResourcesHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	if env.WarmedProj != nil {
		return readResult{Text: env.WarmedProj.PreRenderedListResources}
	}
	return reader.runListResources(ctx, env.Resolved)
}

type exploreConceptHandler struct{}

func (exploreConceptHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	if env.Args.Action != nil && *env.Args.Action == "course_map" && env.WarmedProj != nil {
		reader.recordTelemetry(ctx, CallLogEntry{
			ToolName: "explore_concept", UserID: env.UserID, ClientName: env.ClientName, RepositoryID: env.Resolved.Repository.ID,
			Dimension: "all", Status: "SUCCESS", ResultCount: 1,
			ResponseTimeMs: 0,
		})
		return readResult{Text: env.WarmedProj.PreRenderedCourseMap}
	}
	return reader.runExploreConcept(ctx, env.Resolved, env.UserID, env.ClientName, exploreConceptArgs{
		Concept: env.Args.Concept, Action: env.Args.Action,
	})
}

type searchHandler struct{}

func (searchHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	sa := searchCallArgs{
		Query: env.Args.Query, Filter: env.Args.Filter, Mode: env.Args.Mode,
		Detail: env.Args.Detail, TokenBudget: env.Args.TokenBudget,
	}
	if sa.Filter == nil && sa.Mode != nil {
		sa.Filter = sa.Mode
		sa.Mode = nil
	}
	return reader.runSearch(ctx, env.Resolved, env.UserID, env.ClientName, sa)
}

type breakingChangesHandler struct{}

func (breakingChangesHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	return reader.runBreakingChanges(ctx, env.Resolved, env.UserID, env.ClientName, breakingArgs{
		Query: env.Args.Query, Limit: env.Args.Limit, Detail: env.Args.Detail,
	})
}

type readSymbolHandler struct{}

func (readSymbolHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	return reader.runReadSymbol(ctx, env.Resolved, env.UserID, env.ClientName, readSymbolArgs{
		Symbol:         env.Args.Symbol,
		File:           env.Args.File,
		IncludeCode:    env.Args.IncludeCode,
		IncludeCallers: env.Args.IncludeCallers,
		Aspect:         env.Args.Aspect,
	})
}

type searchSymbolsHandler struct{}

func (searchSymbolsHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	return reader.runSearchSymbols(ctx, env.Resolved, env.UserID, env.ClientName, searchSymbolsArgs{
		Query: env.Args.Query,
		File:  env.Args.File,
		Limit: env.Args.Limit,
		Role:  env.Args.Role,
	})
}

type readSourceFileHandler struct{}

func (readSourceFileHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	return reader.runReadSourceFile(ctx, env.Resolved, env.UserID, env.ClientName, readSourceFileArgs{
		Path:      env.Args.Path,
		StartLine: env.Args.StartLine,
		EndLine:   env.Args.EndLine,
	})
}

type readDefaultHandler struct{}

func (readDefaultHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	aspect := deref(env.Args.Aspect)
	return reader.runRead(ctx, env.Resolved, env.UserID, env.ClientName, env.Target, aspect, env.Quota)
}

// unsupportedToolHandler 失效封闭兜底：别名表命中但注册表缺 handler 时响亮报错，
// 禁止静默落到 read 语义执行（清单-注册表漂移必须显式失败，不得伪装成功）。
type unsupportedToolHandler struct{}

func (unsupportedToolHandler) Execute(_ context.Context, _ *readService, env ToolExecutionContext) readResult {
	return readResult{
		IsError: true,
		Text:    fmt.Sprintf("unsupported tool: %s (native registry miss — must be registered natively or proxied to Node)", env.Canonical),
	}
}

func defaultToolRegistry() *ToolRegistry {
	reg := newToolRegistry(unsupportedToolHandler{})
	reg.Register("read", readDefaultHandler{})
	reg.Register("outline", outlineHandler{})
	reg.Register("list_resources", listResourcesHandler{})
	reg.Register("explore_concept", exploreConceptHandler{})
	reg.Register("search", searchHandler{})
	reg.Register("check_breaking_changes", breakingChangesHandler{})
	reg.Register("read_symbol", readSymbolHandler{})
	reg.Register("search_symbols", searchSymbolsHandler{})
	reg.Register("read_source_file", readSourceFileHandler{})
	return reg
}

// ─────────────────────────────────────────────────────────────
// Hub 多仓书架模式工具命令模式（Command Pattern）
// ─────────────────────────────────────────────────────────────

// HubToolExecutionContext Hub 模式原生工具执行上下文。
type HubToolExecutionContext struct {
	UserID               string
	ClientName           string
	Args                 readCallArgs
	Quota                UserQuota
	Target               string
	Canonical            string
	IsReadDocumentFacade bool
	RepoRef              string
	Edition              string
}

// HubToolHandler Hub 模式 MCP 工具命令执行器。
type HubToolHandler interface {
	Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool)
}

// HubToolRegistry Hub 工具注册表。
type HubToolRegistry struct {
	handlers map[string]HubToolHandler
}

func newHubToolRegistry() *HubToolRegistry {
	return &HubToolRegistry{
		handlers: make(map[string]HubToolHandler),
	}
}

func (r *HubToolRegistry) Register(name string, h HubToolHandler) {
	r.handlers[name] = h
}

func (r *HubToolRegistry) Dispatch(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	if env.IsReadDocumentFacade {
		aspect := deref(env.Args.Aspect)
		return reader.runHubRead(ctx, env.UserID, env.ClientName, env.RepoRef, env.Edition, "", aspect, env.Quota, true), true
	}
	if h, ok := r.handlers[env.Canonical]; ok {
		return h.Execute(ctx, reader, env)
	}
	return readResult{}, false
}

type hubListResourcesHandler struct{}

func (hubListResourcesHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	return reader.runHubListResources(ctx, env.UserID, env.Args.Category, env.Args.Query), true
}

type hubOutlineHandler struct{}

func (hubOutlineHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	return reader.runHubOutline(ctx, env.UserID, env.ClientName, env.RepoRef, deref(env.Args.Path)), true
}

type hubReadHandler struct{}

func (hubReadHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	aspect := deref(env.Args.Aspect)
	return reader.runHubRead(ctx, env.UserID, env.ClientName, env.RepoRef, env.Edition, env.Target, aspect, env.Quota, false), true
}

type hubSearchHandler struct{}

func (hubSearchHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	sa := searchCallArgs{
		Query: env.Args.Query, Filter: env.Args.Filter, Mode: env.Args.Mode,
		Detail: env.Args.Detail, TokenBudget: env.Args.TokenBudget,
		Repository: env.Args.Repository, Edition: env.Args.Edition,
	}
	if sa.Filter == nil && sa.Mode != nil {
		sa.Filter = sa.Mode
		sa.Mode = nil
	}
	return reader.runHubSearch(ctx, env.UserID, env.ClientName, sa), true
}

type hubBreakingChangesHandler struct{}

func (hubBreakingChangesHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	return reader.runHubBreakingChanges(ctx, env.UserID, env.ClientName, breakingArgs{
		Query: env.Args.Query, Limit: env.Args.Limit, Detail: env.Args.Detail, RepoRef: env.Args.Repository,
	}), true
}

type hubExploreConceptHandler struct{}

func (hubExploreConceptHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	return reader.runHubExploreConcept(ctx, env.UserID, env.ClientName, exploreConceptArgs{
		Concept: env.Args.Concept, Action: env.Args.Action,
	}, env.RepoRef), true
}

type hubReadSymbolHandler struct{}

func (hubReadSymbolHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	return reader.runHubReadSymbol(ctx, env.UserID, env.ClientName, env.RepoRef, readSymbolArgs{
		Symbol:         env.Args.Symbol,
		File:           env.Args.File,
		IncludeCode:    env.Args.IncludeCode,
		IncludeCallers: env.Args.IncludeCallers,
		Aspect:         env.Args.Aspect,
	}), true
}

type hubSearchSymbolsHandler struct{}

func (hubSearchSymbolsHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	return reader.runHubSearchSymbols(ctx, env.UserID, env.ClientName, env.RepoRef, searchSymbolsArgs{
		Query: env.Args.Query,
		File:  env.Args.File,
		Limit: env.Args.Limit,
		Role:  env.Args.Role,
	}), true
}

type hubReadSourceFileHandler struct{}

func (hubReadSourceFileHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	return reader.runHubReadSourceFile(ctx, env.UserID, env.ClientName, env.RepoRef, readSourceFileArgs{
		Path:      env.Args.Path,
		StartLine: env.Args.StartLine,
		EndLine:   env.Args.EndLine,
	}), true
}

func defaultHubToolRegistry() *HubToolRegistry {
	reg := newHubToolRegistry()
	reg.Register("list_resources", hubListResourcesHandler{})
	reg.Register("outline", hubOutlineHandler{})
	reg.Register("read", hubReadHandler{})
	reg.Register("search", hubSearchHandler{})
	reg.Register("check_breaking_changes", hubBreakingChangesHandler{})
	reg.Register("explore_concept", hubExploreConceptHandler{})
	reg.Register("read_symbol", hubReadSymbolHandler{})
	reg.Register("search_symbols", hubSearchSymbolsHandler{})
	reg.Register("read_source_file", hubReadSourceFileHandler{})
	return reg
}


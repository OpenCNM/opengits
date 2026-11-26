package mcp

import (
	"context"
	"fmt"
	"strings"
)

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

type ToolHandler interface {
	Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult
}

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
		if h, ok := r.handlers["browse"]; ok {
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

func firstNonEmptyPtr(vals ...*string) string {
	for _, v := range vals {
		if v != nil && strings.TrimSpace(*v) != "" {
			return strings.TrimSpace(*v)
		}
	}
	return ""
}

type browseHandler struct{}

func (browseHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	view := strings.ToLower(strings.TrimSpace(deref(env.Args.View)))
	hasPath := env.Args.Path != nil && strings.TrimSpace(*env.Args.Path) != ""

	if env.IsReadDocumentFacade {
		if env.WarmedProj != nil {
			return readResult{Text: env.WarmedProj.PreRenderedOutline}
		}
		return reader.runOutline(ctx, env.Resolved, env.UserID, env.ClientName, "")
	}

	switch view {
	case "coverage", "recommend":
		q := firstNonEmptyPtr(env.Args.Query, env.Args.Concept, env.Args.Path)
		act := view
		return reader.runExploreConcept(ctx, env.Resolved, env.UserID, env.ClientName, exploreConceptArgs{
			Concept: &q, Action: &act,
		})
	case "resources":
		if !hasPath {
			if env.WarmedProj != nil {
				return readResult{Text: env.WarmedProj.PreRenderedListResources}
			}
			return reader.runListResources(ctx, env.Resolved)
		}
	case "course_map":
		if !hasPath {
			if env.WarmedProj != nil {
				reader.recordTelemetry(ctx, CallLogEntry{
					ToolName: "browse", UserID: env.UserID, ClientName: env.ClientName, RepositoryID: env.Resolved.Repository.ID,
					Dimension: "all", Status: "SUCCESS", ResultCount: 1, ResponseTimeMs: 0,
				})
				return readResult{Text: env.WarmedProj.PreRenderedCourseMap}
			}
			act := "course_map"
			return reader.runExploreConcept(ctx, env.Resolved, env.UserID, env.ClientName, exploreConceptArgs{
				Concept: env.Args.Concept, Action: &act,
			})
		}
	case "architecture":
		act := "architecture"
		sub := firstNonEmptyPtr(env.Args.Path, env.Args.Concept, env.Args.Query)
		return reader.runExploreConcept(ctx, env.Resolved, env.UserID, env.ClientName, exploreConceptArgs{
			Concept: &sub, Action: &act,
		})
	}

	if !hasPath && env.WarmedProj != nil {
		reader.recordTelemetry(ctx, CallLogEntry{
			ToolName: "browse", UserID: env.UserID, ClientName: env.ClientName, RepositoryID: env.Resolved.Repository.ID,
			Dimension: "documents", Status: telemetryStatus(len(env.Resolved.Documents)),
			ResultCount: len(env.Resolved.Documents), ResponseTimeMs: 0,
		})
		return readResult{Text: env.WarmedProj.PreRenderedOutline}
	}
	return reader.runOutline(ctx, env.Resolved, env.UserID, env.ClientName, deref(env.Args.Path))
}

type searchHandler struct{}

func (searchHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	filter := strings.ToLower(strings.TrimSpace(firstNonEmptyPtr(env.Args.Filter, env.Args.Mode, env.Args.Dimension)))
	switch filter {
	case "symbols", "symbol":
		fileArg := env.Args.File
		if fileArg == nil {
			fileArg = env.Args.Path
		}
		return reader.runSearchSymbols(ctx, env.Resolved, env.UserID, env.ClientName, searchSymbolsArgs{
			Query: env.Args.Query,
			File:  fileArg,
			Limit: env.Args.Limit,
			Role:  env.Args.Role,
		})
	case "gotchas", "gotcha", "warning":
		return reader.runBreakingChanges(ctx, env.Resolved, env.UserID, env.ClientName, breakingArgs{
			Query: env.Args.Query, Limit: env.Args.Limit, Detail: env.Args.Detail,
		})
	}

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

type readDefaultHandler struct{}

func (readDefaultHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	hasConcept := env.Args.Concept != nil && strings.TrimSpace(*env.Args.Concept) != ""
	hasAction := env.Args.Action != nil && strings.TrimSpace(*env.Args.Action) != ""
	if hasConcept || (hasAction && env.Target == "") {
		act := strings.TrimSpace(deref(env.Args.Action))
		if act == "" {
			act = "details"
		}
		return reader.runExploreConcept(ctx, env.Resolved, env.UserID, env.ClientName, exploreConceptArgs{
			Concept: env.Args.Concept, Action: &act,
		})
	}
	aspect := deref(env.Args.Aspect)
	return reader.runRead(ctx, env.Resolved, env.UserID, env.ClientName, env.Target, aspect, env.Quota)
}

type readCodeHandler struct{}

func (readCodeHandler) Execute(ctx context.Context, reader *readService, env ToolExecutionContext) readResult {
	if sym := strings.TrimSpace(deref(env.Args.Symbol)); sym != "" {
		filePtr := env.Args.File
		if filePtr == nil || strings.TrimSpace(*filePtr) == "" {
			filePtr = env.Args.Path
		}
		return reader.runReadSymbol(ctx, env.Resolved, env.UserID, env.ClientName, readSymbolArgs{
			Symbol:         &sym,
			File:           filePtr,
			IncludeCode:    env.Args.IncludeCode,
			IncludeCallers: env.Args.IncludeCallers,
			Aspect:         env.Args.Aspect,
		})
	}
	if filePath := firstNonEmptyPtr(env.Args.Path, env.Args.File); filePath != "" {
		return reader.runReadSourceFile(ctx, env.Resolved, env.UserID, env.ClientName, readSourceFileArgs{
			Path:      &filePath,
			StartLine: env.Args.StartLine,
			EndLine:   env.Args.EndLine,
		})
	}
	return readResult{
		IsError: true,
		Text:    `Error: pass either "symbol" (exact AST symbol name) or "path" (repository-relative source file path). Use search(filter="symbols") to discover symbols.`,
	}
}

// Fail closed on missing registered handlers so tool alias drift never falls back silently.
type unsupportedToolHandler struct{}

func (unsupportedToolHandler) Execute(_ context.Context, _ *readService, env ToolExecutionContext) readResult {
	return readResult{
		IsError: true,
		Text:    fmt.Sprintf("unsupported tool: %s (native registry miss — must be registered natively or proxied to Node)", env.Canonical),
	}
}

func defaultToolRegistry() *ToolRegistry {
	reg := newToolRegistry(unsupportedToolHandler{})
	reg.Register("browse", browseHandler{})
	reg.Register("search", searchHandler{})
	reg.Register("read", readDefaultHandler{})
	reg.Register("read_code", readCodeHandler{})
	return reg
}

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

type HubToolHandler interface {
	Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool)
}

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

type hubBrowseHandler struct{}

func (hubBrowseHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	view := strings.ToLower(strings.TrimSpace(deref(env.Args.View)))
	hasPath := env.Args.Path != nil && strings.TrimSpace(*env.Args.Path) != ""

	if env.IsReadDocumentFacade {
		aspect := deref(env.Args.Aspect)
		return reader.runHubRead(ctx, env.UserID, env.ClientName, env.RepoRef, env.Edition, "", aspect, env.Quota, true), true
	}

	if view == "coverage" || view == "recommend" {
		q := firstNonEmptyPtr(env.Args.Query, env.Args.Concept, env.Args.Path)
		act := view
		return reader.runHubExploreConcept(ctx, env.UserID, env.ClientName, exploreConceptArgs{
			Concept: &q, Action: &act,
		}, env.RepoRef), true
	}

	if env.RepoRef == "" {
		return reader.runHubListResources(ctx, env.UserID, env.Args.Category, env.Args.Query), true
	}

	if (view == "architecture" || view == "course_map") && (!hasPath || view == "architecture") {
		act := view
		sub := firstNonEmptyPtr(env.Args.Path, env.Args.Concept, env.Args.Query)
		return reader.runHubExploreConcept(ctx, env.UserID, env.ClientName, exploreConceptArgs{
			Concept: &sub, Action: &act,
		}, env.RepoRef), true
	}

	return reader.runHubOutline(ctx, env.UserID, env.ClientName, env.RepoRef, deref(env.Args.Path)), true
}

type hubReadHandler struct{}

func (hubReadHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	hasConcept := env.Args.Concept != nil && strings.TrimSpace(*env.Args.Concept) != ""
	hasAction := env.Args.Action != nil && strings.TrimSpace(*env.Args.Action) != ""
	if hasConcept || (hasAction && env.Target == "") {
		act := strings.TrimSpace(deref(env.Args.Action))
		if act == "" {
			act = "details"
		}
		return reader.runHubExploreConcept(ctx, env.UserID, env.ClientName, exploreConceptArgs{
			Concept: env.Args.Concept, Action: &act,
		}, env.RepoRef), true
	}
	aspect := deref(env.Args.Aspect)
	return reader.runHubRead(ctx, env.UserID, env.ClientName, env.RepoRef, env.Edition, env.Target, aspect, env.Quota, false), true
}

type hubSearchHandler struct{}

func (hubSearchHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	filter := strings.ToLower(strings.TrimSpace(firstNonEmptyPtr(env.Args.Filter, env.Args.Mode, env.Args.Dimension)))
	switch filter {
	case "symbols", "symbol":
		fileArg := env.Args.File
		if fileArg == nil {
			fileArg = env.Args.Path
		}
		return reader.runHubSearchSymbols(ctx, env.UserID, env.ClientName, env.RepoRef, searchSymbolsArgs{
			Query: env.Args.Query,
			File:  fileArg,
			Limit: env.Args.Limit,
			Role:  env.Args.Role,
		}), true
	case "gotchas", "gotcha", "warning":
		repoPtr := env.Args.Repository
		if env.RepoRef != "" {
			repoPtr = &env.RepoRef
		}
		return reader.runHubBreakingChanges(ctx, env.UserID, env.ClientName, breakingArgs{
			Query: env.Args.Query, Limit: env.Args.Limit, Detail: env.Args.Detail, RepoRef: repoPtr,
		}), true
	}

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

type hubReadCodeHandler struct{}

func (hubReadCodeHandler) Execute(ctx context.Context, reader *readService, env HubToolExecutionContext) (readResult, bool) {
	if sym := strings.TrimSpace(deref(env.Args.Symbol)); sym != "" {
		filePtr := env.Args.File
		if filePtr == nil || strings.TrimSpace(*filePtr) == "" {
			filePtr = env.Args.Path
		}
		return reader.runHubReadSymbol(ctx, env.UserID, env.ClientName, env.RepoRef, readSymbolArgs{
			Symbol:         &sym,
			File:           filePtr,
			IncludeCode:    env.Args.IncludeCode,
			IncludeCallers: env.Args.IncludeCallers,
			Aspect:         env.Args.Aspect,
		}), true
	}
	if filePath := firstNonEmptyPtr(env.Args.Path, env.Args.File); filePath != "" {
		return reader.runHubReadSourceFile(ctx, env.UserID, env.ClientName, env.RepoRef, readSourceFileArgs{
			Path:      &filePath,
			StartLine: env.Args.StartLine,
			EndLine:   env.Args.EndLine,
		}), true
	}
	return readResult{
		IsError: true,
		Text:    `Error: pass either "symbol" (exact AST symbol name) or "path" (repository-relative source file path). Use search(filter="symbols") to discover symbols.`,
	}, true
}

func defaultHubToolRegistry() *HubToolRegistry {
	reg := newHubToolRegistry()
	reg.Register("browse", hubBrowseHandler{})
	reg.Register("search", hubSearchHandler{})
	reg.Register("read", hubReadHandler{})
	reg.Register("read_code", hubReadCodeHandler{})
	return reg
}

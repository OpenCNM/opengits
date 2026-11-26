package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

var toolCanonicalName = func() map[string]string {
	merged := make(map[string]string, len(toolCanonicalNameGen)+4)
	for k, v := range toolCanonicalNameGen {
		merged[k] = v
	}
	merged["list_repositories"] = "browse"
	merged["list_repos"] = "browse"
	merged["read_document"] = "read"
	return merged
}()

func strPtr(s string) *string { return &s }

func normalizeLegacyCall(rawName, canonical string, args *readCallArgs) (effectiveCanonical string, isReadDocFacade bool) {
	effectiveCanonical = canonical
	norm := strings.ToLower(strings.TrimSpace(rawName))

	if norm == "read_document" && args.Path == nil && args.Section == nil && args.Target == nil {
		return "browse", true
	}

	if norm == "explore_concept" || norm == "course_map" || norm == "skill_coverage" || norm == "recommend_tutorial" {
		act := strings.ToLower(strings.TrimSpace(deref(args.Action)))
		switch norm {
		case "course_map":
			act = "course_map"
		case "skill_coverage":
			act = "coverage"
		case "recommend_tutorial":
			act = "recommend"
		}
		if act == "course_map" || act == "architecture" || act == "coverage" || act == "recommend" {
			effectiveCanonical = "browse"
			args.View = strPtr(act)
			if act == "architecture" && args.Concept != nil && *args.Concept != "" && args.Path == nil {
				args.Path = args.Concept
			}
			if (act == "coverage" || act == "recommend") && args.Concept != nil && *args.Concept != "" && args.Query == nil {
				args.Query = args.Concept
			}
			return effectiveCanonical, false
		}
	}

	switch effectiveCanonical {
	case "browse":
		if (norm == "list_resources" || norm == "list_repositories" || norm == "list_repos" ||
			norm == "list_tutorials" || norm == "list_tutorial") && args.View == nil && args.Path == nil {
			args.View = strPtr("resources")
		}
	case "read":
		if args.Action == nil {
			switch norm {
			case "concept_neighbors":
				args.Action = strPtr("neighbors")
			case "learning_path":
				args.Action = strPtr("path")
			case "explore_concept", "concept_details", "get_concept_details":
				args.Action = strPtr("details")
			}
		}
	case "search":
		if args.Filter == nil && args.Mode != nil {
			args.Filter = args.Mode
		}
		if args.Filter == nil && args.Dimension != nil {
			dim := strings.ToLower(strings.TrimSpace(*args.Dimension))
			if dim == "gotcha" || dim == "warning" {
				args.Filter = strPtr("gotchas")
			} else {
				args.Filter = args.Dimension
			}
		}
		if args.Filter != nil {
			f := strings.ToLower(strings.TrimSpace(*args.Filter))
			switch f {
			case "gotcha", "warning":
				args.Filter = strPtr("gotchas")
			case "symbol":
				args.Filter = strPtr("symbols")
			}
		}
		switch norm {
		case "check_breaking_changes", "breaking_changes", "breaking_change", "check_breaking_change":
			args.Filter = strPtr("gotchas")
		case "search_symbols", "find_symbols", "symbol_search", "search_symbol", "find_symbol":
			args.Filter = strPtr("symbols")
		case "search_architecture":
			if args.Filter == nil {
				args.Filter = strPtr("architecture")
			}
		case "search_code_examples":
			if args.Filter == nil {
				args.Filter = strPtr("code")
			}
		case "concept_search":
			if args.Filter == nil {
				args.Filter = strPtr("concept")
			}
		case "search_docs", "search_doc":
			if args.Filter == nil {
				args.Filter = strPtr("docs")
			}
		}
	}
	return effectiveCanonical, false
}

func combineRepoEdition(repoRef, edition string) string {
	repoRef = strings.TrimSpace(repoRef)
	edition = strings.TrimSpace(edition)
	if repoRef == "" {
		return ""
	}
	if edition != "" && !strings.Contains(repoRef, "@") {
		return repoRef + "@" + edition
	}
	return repoRef
}

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
	View           *string  `json:"view"`
	Action         *string  `json:"action"`
	Query          *string  `json:"query"`
	Title          *string  `json:"title"`
	Insight        *string  `json:"insight"`
	Context        *string  `json:"context"`
	Tags           []string `json:"tags"`
	Concept        *string  `json:"concept"`
	Filter         *string  `json:"filter"`
	Mode           *string  `json:"mode"`
	Dimension      *string  `json:"dimension"`
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

type rpcParams struct {
	Params *toolsCallParams `json:"params"`
}

// Lowercase owner/repo once at ingress so routing gates, caches, and DB queries remain case-insensitive.
func singleRepoSegments(path string) (owner, repo string, ok bool) {
	trimmed := strings.Trim(path, "/")
	parts := strings.Split(trimmed, "/")

	if len(parts) != 4 || parts[0] != "api" || parts[1] != "mcp" || parts[2] == "" || parts[3] == "" {
		return "", "", false
	}
	owner, repo = strings.ToLower(parts[2]), strings.ToLower(parts[3])
	// Check reserved route names after lowercasing so /Hub or /Bundle cannot hit single-repo handling.
	if owner == "bundle" || owner == "hub" || owner == "tokens" || owner == "active-clients" {
		return "", "", false
	}
	return owner, repo, true
}

func bundleSegments(path string) (bundleID string, ok bool) {
	trimmed := strings.Trim(path, "/")
	parts := strings.Split(trimmed, "/")
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "mcp" && parts[2] == "bundle" && parts[3] != "" {
		return parts[3], true
	}
	return "", false
}

func isHubPath(path string) bool {
	trimmed := strings.Trim(path, "/")
	return trimmed == "api/mcp/hub"
}

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

	effectiveCanonical, isReadDocumentFacade := normalizeLegacyCall(params.Name, canonical, &args)
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
	} else if args.Section != nil && *args.Section != "" {
		target = *args.Section
	}

	clientName := clientNameFromRequest(r)
	ctx := r.Context()
	edition := deref(args.Edition)
	repoRef := combineRepoEdition(deref(args.Repository), edition)

	env := HubToolExecutionContext{
		UserID:               userID,
		ClientName:           clientName,
		Args:                 args,
		Quota:                quota,
		Target:               target,
		Canonical:            effectiveCanonical,
		IsReadDocumentFacade: isReadDocumentFacade,
		RepoRef:              repoRef,
		Edition:              edition,
	}

	result, ok := s.hubRegistry.Dispatch(ctx, s.reader, env)
	if !ok {
		return false
	}

	if !result.IsError {
		policyBudget := s.reader.readPolicyTokenBudget(ctx, effectiveCanonical)
		result.Text = s.reader.applyCognitiveBudget(ctx, effectiveCanonical, result.Text, quota, policyBudget, args.TokenBudget, target)
	}

	writeCallToolResult(w, rpc.ID, result, era)
	return true
}

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
	rawCanonical, ok := toolCanonicalName[params.Name]
	if !ok {
		return false
	}
	var args readCallArgs
	if len(params.Arguments) > 0 {
		_ = json.Unmarshal(params.Arguments, &args)
	}

	canonical, isReadDocumentFacade := normalizeLegacyCall(params.Name, rawCanonical, &args)
	if !s.reader.toolEnabled(r.Context(), canonical, quota) {
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
	} else if args.Section != nil && *args.Section != "" {
		target = *args.Section
	}

	edition := r.URL.Query().Get("edition")

	if s.tryProjectionFastTrack(w, r, rpc.ID, owner, repo, edition, canonical, userID, quota, args, target, isReadDocumentFacade, era) {
		return true
	}

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

	if !result.IsError {
		policyBudget := s.reader.readPolicyTokenBudget(ctx, canonical)
		result.Text = s.reader.applyCognitiveBudget(ctx, canonical, result.Text, quota, policyBudget, args.TokenBudget, target)
	}

	writeCallToolResult(w, rpc.ID, result, era)
	return true
}

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
	view := strings.ToLower(strings.TrimSpace(deref(args.View)))
	hasPath := args.Path != nil && *args.Path != ""
	isListResourcesCandidate := canonical == "browse" && view == "resources" && !hasPath
	isCourseMapCandidate := canonical == "browse" && view == "course_map" && !hasPath
	isOutlineFastCandidate := (canonical == "browse" && !hasPath && (view == "" || view == "outline")) || isReadDocumentFacade
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

	policyBudget := s.reader.readPolicyTokenBudget(r.Context(), canonical)
	text = s.reader.applyCognitiveBudget(r.Context(), canonical, text, quota, policyBudget, args.TokenBudget, target)

	clientName := clientNameFromRequest(r)
	go func(repoID string, docCount int) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if isOutlineFastCandidate {
			s.reader.recordTelemetry(ctx, CallLogEntry{
				ToolName: "browse", UserID: userID, ClientName: clientName, RepositoryID: repoID,
				Dimension: "documents", Status: "SUCCESS",
				ResultCount: docCount, ResponseTimeMs: 0,
			})
		} else if isCourseMapCandidate {
			s.reader.recordTelemetry(ctx, CallLogEntry{
				ToolName: "browse", UserID: userID, ClientName: clientName, RepositoryID: repoID,
				Dimension: "all", Status: "SUCCESS", ResultCount: 1,
				ResponseTimeMs: 0,
			})
		}
	}(proj.RepoID, proj.DocCount)

	writeCallToolResult(w, rpcID, readResult{Text: text}, era)
	return true
}

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

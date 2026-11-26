package rsg

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strings"
)

type SymbolLookupRequest struct {
	Owner    string                 `json:"owner"`
	Repo     string                 `json:"repo"`
	Sha      string                 `json:"sha"`
	Name     string                 `json:"name"`
	File     string                 `json:"file,omitempty"`
	Artifact *SemanticGraphArtifact `json:"artifact,omitempty"`
}

type SymbolLookupDetail struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	File      string   `json:"file"`
	StartLine int      `json:"startLine"`
	EndLine   int      `json:"endLine"`
	Role      string   `json:"role"`
	PageRank  float64  `json:"pageRank"`
	Importers int      `json:"importers"`
	Callers   []string `json:"callers"`
}

type SymbolLookupResponse struct {
	Ok     bool                `json:"ok"`
	Found  bool                `json:"found"`
	Symbol *SymbolLookupDetail `json:"symbol,omitempty"`
	Error  string              `json:"error,omitempty"`
}

type SymbolSearchRequest struct {
	Owner      string                 `json:"owner,omitempty"`
	Repo       string                 `json:"repo,omitempty"`
	Sha        string                 `json:"sha,omitempty"`
	Query      string                 `json:"query"`
	File       string                 `json:"file,omitempty"`
	RoleFilter string                 `json:"roleFilter,omitempty"`
	Limit      int                    `json:"limit,omitempty"`
	Artifact   *SemanticGraphArtifact `json:"artifact,omitempty"`
}

type SymbolSearchResponse struct {
	Ok      bool                  `json:"ok"`
	Symbols []*SymbolLookupDetail `json:"symbols"`
	Error   string                `json:"error,omitempty"`
}

type symbolCandidate struct {
	file     string
	sym      SymbolEntry
	pageRank float64
	role     GraphNodeRole
}

func normalizeRepoPath(p string) string {
	clean := strings.Trim(strings.ReplaceAll(p, "\\", "/"), "/")
	return strings.TrimPrefix(clean, "./")
}

func LookupSymbolDetail(artifact *SemanticGraphArtifact, name, preferFile string) *SymbolLookupDetail {
	if artifact == nil {
		return nil
	}
	cleanName := strings.TrimSpace(name)
	if cleanName == "" {
		return nil
	}

	nodeMap := make(map[string]SemanticGraphArtifactNode, len(artifact.Nodes)*2)
	for _, node := range artifact.Nodes {
		nodeMap[node.Path] = node
		cleanP := normalizeRepoPath(node.Path)
		if cleanP != "" {
			nodeMap[cleanP] = node
		}
	}

	var chosenFile string
	var chosenSym SymbolEntry
	var hasChosen bool

	cleanPrefer := normalizeRepoPath(preferFile)
	if cleanPrefer != "" {

		for _, f := range sortedSymbolFiles(artifact.SymbolsByFile) {
			syms := artifact.SymbolsByFile[f]
			cleanF := normalizeRepoPath(f)
			if f == preferFile || cleanF == cleanPrefer {
				for _, s := range syms {
					if s.Name == cleanName {
						chosenFile = f
						chosenSym = s
						hasChosen = true
						break
					}
				}
			}
			if hasChosen {
				break
			}
		}

		if !hasChosen {
			for _, gs := range artifact.GoldenSymbols {
				cleanF := normalizeRepoPath(gs.File)
				if (gs.File == preferFile || cleanF == cleanPrefer) && gs.Name == cleanName {
					chosenFile = gs.File
					chosenSym = SymbolEntry{
						Name:      gs.Name,
						Kind:      gs.Kind,
						Importers: gs.Importers,
					}
					populateSymbolSpan(&chosenSym, artifact.SymbolsByFile[gs.File], gs.Name)
					hasChosen = true
					break
				}
			}
		}
	}

	if !hasChosen {
		var candidates []symbolCandidate
		seenFile := make(map[string]bool)

		for _, f := range sortedSymbolFiles(artifact.SymbolsByFile) {
			syms := artifact.SymbolsByFile[f]
			cleanF := normalizeRepoPath(f)
			for _, s := range syms {
				if s.Name != cleanName {
					continue
				}
				node, role := resolveNodeRoleAndRank(nodeMap, f, cleanF)
				candidates = append(candidates, symbolCandidate{
					file:     f,
					sym:      s,
					pageRank: node.PageRank,
					role:     role,
				})
				seenFile[cleanF] = true
			}
		}

		for _, gs := range artifact.GoldenSymbols {
			if gs.Name != cleanName {
				continue
			}
			cleanF := normalizeRepoPath(gs.File)
			if seenFile[cleanF] {
				continue
			}
			node, role := resolveNodeRoleAndRank(nodeMap, gs.File, cleanF)
			sym := SymbolEntry{
				Name:      gs.Name,
				Kind:      gs.Kind,
				Importers: gs.Importers,
			}
			populateSymbolSpan(&sym, artifact.SymbolsByFile[gs.File], gs.Name)
			candidates = append(candidates, symbolCandidate{
				file:     gs.File,
				sym:      sym,
				pageRank: node.PageRank,
				role:     role,
			})
			seenFile[cleanF] = true
		}

		if len(candidates) == 0 {
			return nil
		}

		sort.SliceStable(candidates, func(i, j int) bool {
			if candidates[i].pageRank != candidates[j].pageRank {
				return candidates[i].pageRank > candidates[j].pageRank
			}
			if candidates[i].sym.Importers != candidates[j].sym.Importers {
				return candidates[i].sym.Importers > candidates[j].sym.Importers
			}
			if candidates[i].sym.Exported != candidates[j].sym.Exported {
				return candidates[i].sym.Exported && !candidates[j].sym.Exported
			}
			return candidates[i].file < candidates[j].file
		})

		chosenFile = candidates[0].file
		chosenSym = candidates[0].sym
		hasChosen = true
	}

	if !hasChosen {
		return nil
	}

	cleanChosenFile := normalizeRepoPath(chosenFile)
	node, ok := nodeMap[chosenFile]
	if !ok {
		node = nodeMap[cleanChosenFile]
	}

	role := string(node.Role)
	if role == "" {
		role = string(RoleLeafUtility)
	}
	roundedPR := math.Round(node.PageRank*1000) / 1000

	kind := chosenSym.Kind
	if kind == "" {
		kind = "function"
	}

	callers := extractCallers(artifact, chosenFile, chosenSym.Name)

	return &SymbolLookupDetail{
		Name:      chosenSym.Name,
		Kind:      kind,
		File:      chosenFile,
		StartLine: chosenSym.StartLine,
		EndLine:   chosenSym.EndLine,
		Role:      role,
		PageRank:  roundedPR,
		Importers: chosenSym.Importers,
		Callers:   callers,
	}
}

func (h *Handler) HandleSymbolLookup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
			Ok:    false,
			Error: "method not allowed",
		})
		return
	}

	var req SymbolLookupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
			Ok:    false,
			Error: "invalid json body: " + err.Error(),
		})
		return
	}

	if strings.TrimSpace(req.Name) == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
			Ok:    false,
			Error: "symbol name is required",
		})
		return
	}

	var artifact *SemanticGraphArtifact
	if req.Artifact != nil {
		artifact = req.Artifact
	} else {
		if err := AssertSafeSegment(req.Owner); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
				Ok:    false,
				Error: err.Error(),
			})
			return
		}
		if err := AssertSafeSegment(req.Repo); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
				Ok:    false,
				Error: err.Error(),
			})
			return
		}
		if err := AssertSafeSegment(req.Sha); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
				Ok:    false,
				Error: err.Error(),
			})
			return
		}

		loaded, err := h.LoadOrBuildSemanticGraph(r.Context(), req.Owner, req.Repo, req.Sha)
		if err != nil || loaded == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
				Ok:    false,
				Found: false,
				Error: "semantic graph artifact not found",
			})
			return
		}
		artifact = loaded
	}

	detail := LookupSymbolDetail(artifact, req.Name, req.File)
	if detail == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
			Ok:    true,
			Found: false,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(SymbolLookupResponse{
		Ok:     true,
		Found:  true,
		Symbol: detail,
	})
}

func (h *Handler) HandleSymbolSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(SymbolSearchResponse{
			Ok:    false,
			Error: "method not allowed",
		})
		return
	}

	var req SymbolSearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(SymbolSearchResponse{
			Ok:    false,
			Error: "invalid json body: " + err.Error(),
		})
		return
	}

	var artifact *SemanticGraphArtifact
	if req.Artifact != nil {
		artifact = req.Artifact
	} else {
		if err := AssertSafeSegment(req.Owner); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(SymbolSearchResponse{
				Ok:    false,
				Error: err.Error(),
			})
			return
		}
		if err := AssertSafeSegment(req.Repo); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(SymbolSearchResponse{
				Ok:    false,
				Error: err.Error(),
			})
			return
		}
		if err := AssertSafeSegment(req.Sha); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(SymbolSearchResponse{
				Ok:    false,
				Error: err.Error(),
			})
			return
		}

		loaded, err := h.LoadOrBuildSemanticGraph(r.Context(), req.Owner, req.Repo, req.Sha)
		if err != nil || loaded == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(SymbolSearchResponse{
				Ok:    false,
				Error: "semantic graph artifact not found",
			})
			return
		}
		artifact = loaded
	}

	results := SearchSymbols(artifact, SearchSymbolsOptions{
		Query:      req.Query,
		PreferFile: req.File,
		RoleFilter: req.RoleFilter,
		Limit:      req.Limit,
	})

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(SymbolSearchResponse{
		Ok:      true,
		Symbols: results,
	})
}

func resolveNodeRoleAndRank(nodeMap map[string]SemanticGraphArtifactNode, file, cleanFile string) (SemanticGraphArtifactNode, GraphNodeRole) {
	node, ok := nodeMap[file]
	if !ok {
		node = nodeMap[cleanFile]
	}
	role := node.Role
	if role == "" {
		role = RoleLeafUtility
	}
	return node, role
}

func populateSymbolSpan(target *SymbolEntry, syms []SymbolEntry, name string) {
	for _, s := range syms {
		if s.Name == name {
			target.StartLine = s.StartLine
			target.EndLine = s.EndLine
			target.Exported = s.Exported
			break
		}
	}
}

func extractCallers(artifact *SemanticGraphArtifact, chosenFile, symName string) []string {
	if artifact == nil || len(artifact.CallEdges) == 0 {
		return nil
	}
	cleanChosenFile := normalizeRepoPath(chosenFile)
	callers := make([]string, 0, 4)
	seenCaller := make(map[string]bool)
	for _, edge := range artifact.CallEdges {
		cleanCalleeFile := normalizeRepoPath(edge.CalleeFile)
		cleanCallerFile := normalizeRepoPath(edge.CallerFile)
		matchFile := cleanCalleeFile != "" && (edge.CalleeFile == chosenFile || cleanCalleeFile == cleanChosenFile)

		isTarget := false
		if edge.CalleeSymbol != "" {
			if edge.CalleeSymbol == symName && (edge.CalleeFile == "" || matchFile) {
				isTarget = true
			}
		} else if matchFile {
			isTarget = true
		}

		if !isTarget {
			continue
		}

		caller := edge.CallerFile
		if caller == "" || (cleanCallerFile == cleanChosenFile && edge.CallerSymbol != "") {
			caller = edge.CallerSymbol
		}
		if caller != "" && !seenCaller[caller] {
			seenCaller[caller] = true
			callers = append(callers, caller)
			if len(callers) >= 4 {
				break
			}
		}
	}
	return callers
}

type SearchSymbolsOptions struct {
	Query      string `json:"query"`
	PreferFile string `json:"preferFile,omitempty"`
	RoleFilter string `json:"roleFilter,omitempty"`
	Limit      int    `json:"limit,omitempty"`
}

type searchCandidate struct {
	file      string
	sym       SymbolEntry
	pageRank  float64
	role      GraphNodeRole
	relevance float64
	score     float64
}

func SearchSymbols(artifact *SemanticGraphArtifact, opts SearchSymbolsOptions) []*SymbolLookupDetail {
	if artifact == nil {
		return nil
	}

	limit := opts.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 30 {
		limit = 30
	}

	qClean := strings.ToLower(strings.TrimSpace(opts.Query))
	preferClean := normalizeRepoPath(opts.PreferFile)
	roleFilter := strings.ToLower(strings.TrimSpace(opts.RoleFilter))

	nodeMap := make(map[string]SemanticGraphArtifactNode, len(artifact.Nodes)*2)
	for _, node := range artifact.Nodes {
		nodeMap[node.Path] = node
		cleanP := normalizeRepoPath(node.Path)
		if cleanP != "" {
			nodeMap[cleanP] = node
		}
	}

	seenKey := make(map[string]bool)
	var candidates []searchCandidate

	evalSymbol := func(f string, s SymbolEntry) {
		cleanF := normalizeRepoPath(f)
		if preferClean != "" && !strings.Contains(cleanF, preferClean) {
			return
		}

		key := cleanF + "@" + s.Name
		if seenKey[key] {
			return
		}

		node, role := resolveNodeRoleAndRank(nodeMap, f, cleanF)
		if roleFilter != "" && roleFilter != "all" && strings.ToLower(string(role)) != roleFilter {
			return
		}

		sLower := strings.ToLower(s.Name)
		relevance := 0.0
		if qClean == "" {
			relevance = 0.5
		} else if sLower == qClean {
			relevance = 1.0
		} else if strings.HasPrefix(sLower, qClean) {
			relevance = 0.7
		} else if strings.Contains(sLower, qClean) {
			relevance = 0.4
		} else {
			return
		}

		score := relevance*2.0 + node.PageRank*1.0 + float64(s.Importers)/100.0
		if s.Exported {
			score += 0.05
		}

		candidates = append(candidates, searchCandidate{
			file:      f,
			sym:       s,
			pageRank:  node.PageRank,
			role:      role,
			relevance: relevance,
			score:     score,
		})
		seenKey[key] = true
	}

	// Iterate files in sorted order so equal-score candidates produce deterministic output.
	for _, f := range sortedSymbolFiles(artifact.SymbolsByFile) {
		for _, s := range artifact.SymbolsByFile[f] {
			evalSymbol(f, s)
		}
	}

	for _, gs := range artifact.GoldenSymbols {
		sym := SymbolEntry{
			Name:      gs.Name,
			Kind:      gs.Kind,
			Importers: gs.Importers,
			Exported:  true,
		}
		populateSymbolSpan(&sym, artifact.SymbolsByFile[gs.File], gs.Name)
		evalSymbol(gs.File, sym)
	}

	if len(candidates) == 0 {
		return nil
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		if candidates[i].pageRank != candidates[j].pageRank {
			return candidates[i].pageRank > candidates[j].pageRank
		}
		if candidates[i].sym.Importers != candidates[j].sym.Importers {
			return candidates[i].sym.Importers > candidates[j].sym.Importers
		}
		return candidates[i].sym.Name < candidates[j].sym.Name
	})

	if len(candidates) > limit {
		candidates = candidates[:limit]
	}

	results := make([]*SymbolLookupDetail, 0, len(candidates))
	for _, c := range candidates {
		callers := extractCallers(artifact, c.file, c.sym.Name)
		kind := c.sym.Kind
		if kind == "" {
			kind = "function"
		}
		results = append(results, &SymbolLookupDetail{
			Name:      c.sym.Name,
			Kind:      kind,
			File:      c.file,
			StartLine: c.sym.StartLine,
			EndLine:   c.sym.EndLine,
			Role:      string(c.role),
			PageRank:  math.Round(c.pageRank*1000) / 1000,
			Importers: c.sym.Importers,
			Callers:   callers,
		})
	}

	return results
}

func FallbackSearchClusters(profileClustersRaw []byte, opts SearchSymbolsOptions) []*SymbolLookupDetail {
	if len(profileClustersRaw) == 0 {
		return nil
	}
	var clusters []struct {
		Title         string `json:"title"`
		TeachingOrder int    `json:"teachingOrder"`
		Cognitive     *struct {
			GoldenSymbols []struct {
				Name string `json:"name"`
				File string `json:"file"`
				Kind string `json:"kind"`
			} `json:"goldenSymbols"`
			CallFlow []struct {
				Caller string `json:"caller"`
				Callee string `json:"callee"`
			} `json:"callFlow"`
		} `json:"cognitive"`
	}
	if err := json.Unmarshal(profileClustersRaw, &clusters); err != nil {
		return nil
	}

	limit := opts.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 30 {
		limit = 30
	}

	qClean := strings.ToLower(strings.TrimSpace(opts.Query))
	preferClean := normalizeRepoPath(opts.PreferFile)

	seen := make(map[string]bool)
	var candidates []*SymbolLookupDetail

	for _, c := range clusters {
		if c.Cognitive == nil {
			continue
		}
		for _, gs := range c.Cognitive.GoldenSymbols {
			cleanF := normalizeRepoPath(gs.File)
			if preferClean != "" && !strings.Contains(cleanF, preferClean) {
				continue
			}
			key := cleanF + "@" + gs.Name
			if seen[key] {
				continue
			}

			sLower := strings.ToLower(gs.Name)
			match := false
			if qClean == "" || sLower == qClean || strings.HasPrefix(sLower, qClean) || strings.Contains(sLower, qClean) {
				match = true
			}
			if !match {
				continue
			}

			var callers []string
			for _, step := range c.Cognitive.CallFlow {
				if strings.Contains(strings.ToLower(step.Callee), sLower) && step.Caller != "" {
					callers = append(callers, step.Caller)
				}
			}

			kind := gs.Kind
			if kind == "" {
				kind = "function"
			}

			candidates = append(candidates, &SymbolLookupDetail{
				Name:      gs.Name,
				Kind:      kind,
				File:      gs.File,
				Role:      "core_contract",
				PageRank:  0.05,
				Importers: 1,
				Callers:   callers,
			})
			seen[key] = true
		}
	}

	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates
}

func sortedSymbolFiles(m map[string][]SymbolEntry) []string {
	out := make([]string, 0, len(m))
	for f := range m {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

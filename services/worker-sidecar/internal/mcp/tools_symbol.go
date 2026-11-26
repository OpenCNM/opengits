package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

var (
	graphBackfillCache = newTTLCache(5*time.Minute, 256)
	graphBackfillHTTP  = &http.Client{Timeout: 75 * time.Second}
)

type readSymbolArgs struct {
	Symbol         *string `json:"symbol"`
	File           *string `json:"file"`
	IncludeCode    *bool   `json:"include_code"`
	IncludeCallers *bool   `json:"include_callers"`
	Aspect         *string `json:"aspect"`
}

func (s *readService) runReadSymbol(ctx context.Context, resolved *ResolvedRepo, userID, clientName string, args readSymbolArgs) readResult {
	startTime := time.Now()
	cleanSym := strings.TrimSpace(deref(args.Symbol))
	if cleanSym == "" {
		return readResult{
			Text:    `Error: "symbol" is required. Pass a code symbol name (e.g. "InitScheduler", "PageRank"). Use explore_concept(action="architecture") to inspect subsystem components and call flows.`,
			IsError: true,
		}
	}

	cleanFile := strings.TrimSpace(deref(args.File))
	includeCode := true
	if args.IncludeCode != nil {
		includeCode = *args.IncludeCode
	}
	includeCallers := true
	if args.IncludeCallers != nil {
		includeCallers = *args.IncludeCallers
	}

	repo := resolved.Repository

	sha := ""
	if s.store != nil {
		if _, _, sSha, ok := s.store.GetRepoGitSha(ctx, repo.ID); ok && sSha != "" {
			sha = sSha
		}
	}
	if sha == "" && len(repo.RepoProfile) > 0 {
		var prof map[string]any
		if err := json.Unmarshal(repo.RepoProfile, &prof); err == nil {
			if sVal, ok := prof["gitSha"].(string); ok && sVal != "" {
				sha = sVal
			}
		}
	}
	if sha == "" {
		sha = repo.Branch
	}

	graphDir := os.Getenv("SEMANTIC_GRAPH_DIR")
	if graphDir == "" {
		graphDir = "storage/graphs"
	}
	archiveRoot := resolveArchiveRoot()

	var detail *rsg.SymbolLookupDetail
	if artifact := s.loadSemanticGraphForMCP(ctx, graphDir, repo.Owner, repo.Repo, sha, repo.Branch); artifact != nil {
		detail = rsg.LookupSymbolDetail(artifact, cleanSym, cleanFile)
	}

	var matchedChapterTitle string
	var matchedChapterOrder int
	var availableCandidates []string

	if len(repo.RepoProfile) > 0 {
		var profile map[string]json.RawMessage
		_ = json.Unmarshal(repo.RepoProfile, &profile)
		if raw, ok := profile["codeClusters"]; ok && len(raw) > 0 {
			var clusters []codeClusterRow
			if json.Unmarshal(raw, &clusters) == nil {
				for i := range clusters {
					c := &clusters[i]
					if c.Cognitive == nil {
						continue
					}

					for _, gs := range c.Cognitive.GoldenSymbols {
						availableCandidates = append(availableCandidates, fmt.Sprintf("%s (%s)", gs.Name, gs.File))
					}
					if detail == nil {
						for _, gs := range c.Cognitive.GoldenSymbols {
							if strings.EqualFold(gs.Name, cleanSym) {
								if cleanFile != "" && !strings.Contains(strings.ToLower(gs.File), strings.ToLower(cleanFile)) {
									continue
								}
								detail = &rsg.SymbolLookupDetail{
									Name:     gs.Name,
									Kind:     gs.Kind,
									File:     gs.File,
									Role:     "core_contract",
									PageRank: 0.05,
								}

								for _, step := range c.Cognitive.CallFlow {
									if strings.Contains(strings.ToLower(step.Callee), strings.ToLower(cleanSym)) && step.Caller != "" {
										detail.Callers = append(detail.Callers, step.Caller)
									}
								}
								matchedChapterTitle = c.Title
								matchedChapterOrder = c.TeachingOrder
								break
							}
						}
					}
				}
			}
		}
	}

	if detail == nil && cleanFile != "" {
		if onDemand := extractOnDemandFileSymbols(ctx, archiveRoot, repo.Owner, repo.Repo, cleanFile, nonEmptyStrings(sha, repo.Branch)...); len(onDemand) > 0 {
			for _, candidate := range onDemand {
				if strings.EqualFold(candidate.Name, cleanSym) {
					detail = candidate
					break
				}
			}
			if detail == nil {
				symLower := strings.ToLower(cleanSym)
				for _, candidate := range onDemand {
					if strings.Contains(strings.ToLower(candidate.Name), symLower) {
						detail = candidate
						break
					}
				}
			}
			if detail == nil {
				for _, candidate := range onDemand {
					availableCandidates = append(availableCandidates, fmt.Sprintf("%s (%s)", candidate.Name, candidate.File))
				}
			}
		}
	}

	if detail == nil {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName:       "read_symbol",
			UserID:         userID,
			ClientName:     clientName,
			RepositoryID:   repo.ID,
			Dimension:      "symbols",
			Status:         "EMPTY_RESULT",
			ResultCount:    0,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})

		var b strings.Builder
		fmt.Fprintf(&b, "Error: Symbol %q not found in %s/%s.", cleanSym, repo.Owner, repo.Repo)
		if len(availableCandidates) > 0 {

			unique := make(map[string]bool)
			var sortedCandidates []string
			for _, cand := range availableCandidates {
				if !unique[cand] {
					unique[cand] = true
					sortedCandidates = append(sortedCandidates, cand)
				}
			}
			sort.Strings(sortedCandidates)
			if len(sortedCandidates) > 8 {
				sortedCandidates = sortedCandidates[:8]
			}
			b.WriteString("\n\nAvailable golden symbols in this repository:\n")
			for _, cand := range sortedCandidates {
				fmt.Fprintf(&b, "- %s\n", cand)
			}
			b.WriteString("\n(Use explore_concept with action=\"architecture\" to view subsystem component collaboration maps and call flows.)")
		}
		return readResult{Text: b.String(), IsError: true}
	}

	if matchedChapterOrder == 0 && len(resolved.Documents) > 0 {
		for _, doc := range resolved.Documents {
			if strings.Contains(strings.ToLower(doc.Path), "chapter") || strings.Contains(strings.ToLower(doc.Path), strings.ToLower(filepath.Base(detail.File))) {
				matchedChapterTitle = doc.Title
				break
			}
		}
	}

	aspect := "contract"
	if args.Aspect != nil && strings.TrimSpace(*args.Aspect) != "" {
		aspect = strings.ToLower(strings.TrimSpace(*args.Aspect))
	}
	if aspect != "contract" && aspect != "architecture" && aspect != "implementation" {
		aspect = "contract"
	}

	sourceSnippet := ""
	if includeCode && aspect != "architecture" {
		for _, ref := range nonEmptyStrings(sha, repo.Branch) {
			sourceSnippet = readSymbolSourceCode(archiveRoot, repo.Owner, repo.Repo, ref, detail.File, detail.Name, detail.StartLine, detail.EndLine)
			if sourceSnippet != "" {
				break
			}
			if raw := fetchImmutableSourceFile(ctx, archiveRoot, repo.Owner, repo.Repo, ref, detail.File); raw != "" {
				sourceSnippet = sliceSymbolSourceContent(raw, detail.Name, detail.StartLine, detail.EndLine)
				if sourceSnippet != "" {
					break
				}
			}
		}
	}

	var b strings.Builder
	kindStr := detail.Kind
	if kindStr == "" {
		kindStr = "symbol"
	}
	if aspect == "architecture" {
		fmt.Fprintf(&b, "# 🏛️ Architecture Role: `%s` (%s)\n\n", detail.Name, kindStr)
	} else {
		fmt.Fprintf(&b, "# 🔍 Code Symbol: `%s` (%s)\n\n", detail.Name, kindStr)
	}

	lineInfo := ""
	if detail.StartLine > 0 && detail.EndLine >= detail.StartLine {
		lineInfo = fmt.Sprintf(" (Lines %d–%d)", detail.StartLine, detail.EndLine)
	}
	fmt.Fprintf(&b, "- **File**: `%s`%s\n", detail.File, lineInfo)

	roleLabel := roleDisplayLabel(detail.Role)
	fmt.Fprintf(&b, "- **Role**: `%s`", roleLabel)
	if detail.PageRank > 0 {
		fmt.Fprintf(&b, " | **PageRank**: %.3f", detail.PageRank)
	}
	if detail.Importers > 0 {
		fmt.Fprintf(&b, " | **Importers**: %d", detail.Importers)
	}
	b.WriteString("\n")

	if includeCallers && len(detail.Callers) > 0 {
		b.WriteString("- **Cross-Module Callers**: ")
		b.WriteString(strings.Join(detail.Callers, ", "))
		b.WriteString("\n")
	}

	if matchedChapterTitle != "" {
		if matchedChapterOrder > 0 {
			fmt.Fprintf(&b, "- **Curriculum Chapter**: Chapter %d: %s\n", matchedChapterOrder, matchedChapterTitle)
		} else {
			fmt.Fprintf(&b, "- **Curriculum Chapter**: %s\n", matchedChapterTitle)
		}
	}

	if aspect == "architecture" {
		b.WriteString("\n*(Architecture mode: implementation code omitted. Pass aspect=\"contract\" for type signatures, or aspect=\"implementation\" for source code.)*\n")
	} else if aspect == "contract" {
		if includeCode {
			b.WriteString("\n### Type & Interface Contract\n\n")
			if sourceSnippet != "" {
				lang := detectSourceLanguage(detail.File)
				sig := extractSymbolSignature(sourceSnippet, detail.Name, lang)
				if sig == "" {
					sig = sourceSnippet
				}
				fmt.Fprintf(&b, "```%s\n%s\n```\n", lang, sig)
				b.WriteString("\n*(Contract mode: body omitted to preserve context tokens. Pass aspect=\"implementation\" for full source body, or aspect=\"architecture\" for system context.)*\n")
			} else {
				b.WriteString("*(Source code archive file not found on disk; refer to file path above)*\n")
			}
		}
	} else {
		if includeCode {
			b.WriteString("\n### Source Implementation\n\n")
			if sourceSnippet != "" {
				lang := detectSourceLanguage(detail.File)
				fmt.Fprintf(&b, "```%s\n%s\n```\n", lang, sourceSnippet)
			} else {
				b.WriteString("*(Source code archive file not found on disk; refer to file path above)*\n")
			}
		}
	}

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName:       "read_symbol",
		UserID:         userID,
		ClientName:     clientName,
		RepositoryID:   repo.ID,
		Dimension:      "symbols",
		Status:         "SUCCESS",
		ResultCount:    1,
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})

	return readResult{Text: b.String()}
}

func (s *readService) runHubReadSymbol(ctx context.Context, userID, clientName, repoRef string, args readSymbolArgs) readResult {
	cleanRef := strings.TrimSpace(repoRef)
	if cleanRef == "" {
		return readResult{
			Text:    `On OpenGits Hub mode, pass "repository" (e.g. "owner/repo" or from list_resources) to specify the target codebase for symbol inspection.`,
			IsError: true,
		}
	}

	resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, cleanRef, "")
	if err != nil || resolved == nil {
		return hubRefNotFoundError(cleanRef)
	}

	if !resolved.Repository.IsPublic {
		allowed, err := s.store.HasSavedRepoAccess(ctx, resolved.Repository.ID, userID)
		if err != nil || !allowed {
			return readResult{
				Text:    fmt.Sprintf(`Forbidden: Repository %q is private.`, cleanRef),
				IsError: true,
			}
		}
	}

	return s.runReadSymbol(ctx, resolved, userID, clientName, args)
}

type searchSymbolsArgs struct {
	Query *string `json:"query"`
	File  *string `json:"file"`
	Limit *int    `json:"limit"`
	Role  *string `json:"role"`
}

func (s *readService) runSearchSymbols(ctx context.Context, resolved *ResolvedRepo, userID, clientName string, args searchSymbolsArgs) readResult {
	startTime := time.Now()
	cleanQuery := strings.TrimSpace(deref(args.Query))
	cleanFile := strings.TrimSpace(deref(args.File))
	cleanRole := strings.TrimSpace(deref(args.Role))

	limit := 10
	if args.Limit != nil && *args.Limit > 0 {
		limit = *args.Limit
	}
	if limit > 30 {
		limit = 30
	}

	repo := resolved.Repository

	sha := ""
	if s.store != nil {
		if _, _, sSha, ok := s.store.GetRepoGitSha(ctx, repo.ID); ok && sSha != "" {
			sha = sSha
		}
	}
	if sha == "" && len(repo.RepoProfile) > 0 {
		var prof map[string]any
		if err := json.Unmarshal(repo.RepoProfile, &prof); err == nil {
			if sVal, ok := prof["gitSha"].(string); ok && sVal != "" {
				sha = sVal
			}
		}
	}
	if sha == "" {
		sha = repo.Branch
	}

	graphDir := os.Getenv("SEMANTIC_GRAPH_DIR")
	if graphDir == "" {
		graphDir = "storage/graphs"
	}

	opts := rsg.SearchSymbolsOptions{
		Query:      cleanQuery,
		PreferFile: cleanFile,
		RoleFilter: cleanRole,
		Limit:      limit,
	}

	var results []*rsg.SymbolLookupDetail
	if artifact := s.loadSemanticGraphForMCP(ctx, graphDir, repo.Owner, repo.Repo, sha, repo.Branch); artifact != nil {
		results = rsg.SearchSymbols(artifact, opts)
	}

	if len(results) == 0 && len(repo.RepoProfile) > 0 {
		var profile map[string]json.RawMessage
		if json.Unmarshal(repo.RepoProfile, &profile) == nil {
			if raw, ok := profile["codeClusters"]; ok && len(raw) > 0 {
				results = rsg.FallbackSearchClusters(raw, opts)
			}
		}
	}

	if len(results) == 0 && cleanFile != "" {
		archiveRoot := resolveArchiveRoot()
		if onDemand := extractOnDemandFileSymbols(ctx, archiveRoot, repo.Owner, repo.Repo, cleanFile, nonEmptyStrings(sha, repo.Branch)...); len(onDemand) > 0 {
			qLower := strings.ToLower(cleanQuery)
			for _, cand := range onDemand {
				if cleanRole != "" && cleanRole != "all" && cand.Role != cleanRole {
					continue
				}
				if qLower != "" && !strings.Contains(strings.ToLower(cand.Name), qLower) {
					continue
				}
				results = append(results, cand)
				if len(results) >= limit {
					break
				}
			}
		}
	}

	if len(results) == 0 {
		s.recordTelemetry(ctx, CallLogEntry{
			ToolName:       "search_symbols",
			UserID:         userID,
			ClientName:     clientName,
			RepositoryID:   repo.ID,
			Dimension:      "symbols",
			Status:         "EMPTY_RESULT",
			ResultCount:    0,
			ResponseTimeMs: time.Since(startTime).Milliseconds(),
		})

		var b strings.Builder
		if cleanQuery != "" {
			fmt.Fprintf(&b, "No symbols found matching query %q in %s/%s.", cleanQuery, repo.Owner, repo.Repo)
			if cleanFile != "" {
				fmt.Fprintf(&b, " (filtered by file %q)", cleanFile)
			}
			b.WriteString("\n\n(Tip: Call search_symbols without query to see top architectural anchors, or use outline to explore document structure.)")
		} else {
			fmt.Fprintf(&b, "No symbols found in %s/%s.", repo.Owner, repo.Repo)
		}
		return readResult{Text: b.String()}
	}

	var b strings.Builder
	if cleanQuery == "" {
		fmt.Fprintf(&b, "# 🏛️ Top Architectural Symbols in %s/%s (Found %d)\n\n", repo.Owner, repo.Repo, len(results))
	} else {
		fmt.Fprintf(&b, "# 🔎 Symbol Search: %q in %s/%s (Found %d)\n\n", cleanQuery, repo.Owner, repo.Repo, len(results))
	}

	for _, sym := range results {
		kind := sym.Kind
		if kind == "" {
			kind = "function"
		}
		fmt.Fprintf(&b, "### `%s` (%s)\n", sym.Name, kind)
		lineInfo := ""
		if sym.StartLine > 0 && sym.EndLine >= sym.StartLine {
			lineInfo = fmt.Sprintf(" (Lines %d–%d)", sym.StartLine, sym.EndLine)
		}
		fmt.Fprintf(&b, "- **File**: `%s`%s | **Role**: `%s`", sym.File, lineInfo, roleDisplayLabel(sym.Role))
		if sym.PageRank > 0 {
			fmt.Fprintf(&b, " | **PageRank**: %.3f", sym.PageRank)
		}
		if sym.Importers > 0 {
			fmt.Fprintf(&b, " | **Importers**: %d", sym.Importers)
		}
		b.WriteString("\n")
		if len(sym.Callers) > 0 {
			fmt.Fprintf(&b, "- **Cross-Module Callers**: %s\n", strings.Join(sym.Callers, ", "))
		}
		fmt.Fprintf(&b, "- 👉 Inspect signature: `read_symbol(symbol=%q, aspect=\"contract\")`\n\n", sym.Name)
	}

	b.WriteString("*(Tip: Pass aspect=\"contract\" to read_symbol for lightweight type signature (~80% token savings), or aspect=\"implementation\" for full source code.)*\n")

	s.recordTelemetry(ctx, CallLogEntry{
		ToolName:       "search_symbols",
		UserID:         userID,
		ClientName:     clientName,
		RepositoryID:   repo.ID,
		Dimension:      "symbols",
		Status:         "SUCCESS",
		ResultCount:    len(results),
		ResponseTimeMs: time.Since(startTime).Milliseconds(),
	})

	return readResult{Text: b.String()}
}

func (s *readService) runHubSearchSymbols(ctx context.Context, userID, clientName, repoRef string, args searchSymbolsArgs) readResult {
	cleanRef := strings.TrimSpace(repoRef)
	if cleanRef == "" {
		return readResult{
			Text:    `On OpenGits Hub mode, pass "repository" (e.g. "owner/repo" or from list_resources) to specify the target codebase for symbol search.`,
			IsError: true,
		}
	}

	resolved, err := s.store.ResolveBookshelfRepo(ctx, userID, cleanRef, "")
	if err != nil || resolved == nil {
		return hubRefNotFoundError(cleanRef)
	}

	if !resolved.Repository.IsPublic {
		allowed, err := s.store.HasSavedRepoAccess(ctx, resolved.Repository.ID, userID)
		if err != nil || !allowed {
			return readResult{
				Text:    fmt.Sprintf(`Forbidden: Repository %q is private.`, cleanRef),
				IsError: true,
			}
		}
	}

	return s.runSearchSymbols(ctx, resolved, userID, clientName, args)
}

func roleDisplayLabel(role string) string {
	switch role {
	case "core_contract":
		return "Core Contract (核心契约)"
	case "entry_point":
		return "Entry Point (系统入口)"
	case "pipeline_flow":
		return "Pipeline Flow (流程管道)"
	case "leaf_utility":
		return "Leaf Utility (基础工具)"
	default:
		if role == "" {
			return "Core Component"
		}
		return role
	}
}

func detectSourceLanguage(path string) string {
	return armor.DetectSourceLanguage(path)
}

func readSymbolSourceCode(archiveRoot, owner, repo, ref, relPath, symName string, startLine, endLine int) string {
	if archiveRoot == "" || owner == "" || repo == "" || ref == "" || relPath == "" {
		return ""
	}
	raw := readRawArchiveFileForSymbol(archiveRoot, owner, repo, ref, relPath)
	if raw == "" {
		compactPath := archive.CompactArchivePathFor(archiveRoot, owner, repo, ref)
		if cst, cerr := os.Stat(compactPath); cerr == nil && !cst.IsDir() {
			if startLine > 0 && endLine >= startLine {
				if content, err := archive.ReadSingleFileFromCompactArchive(compactPath, relPath, startLine, endLine, maxSourceFileReadBytes); err == nil {
					return content
				}
				return ""
			}
			content, err := archive.ReadSingleFileFromCompactArchive(compactPath, relPath, 0, 0, maxSourceFileReadBytes)
			if err != nil || content == "" {
				return ""
			}
			raw = content
		}
	}
	if raw == "" {
		return ""
	}
	return sliceSymbolSourceContent(raw, symName, startLine, endLine)
}

func sliceSymbolSourceContent(raw, symName string, startLine, endLine int) string {
	lines := strings.Split(raw, "\n")
	if len(lines) == 0 {
		return ""
	}

	if startLine > 0 && endLine >= startLine && startLine <= len(lines) {
		if endLine > len(lines) {
			endLine = len(lines)
		}
		return strings.Join(lines[startLine-1:endLine], "\n")
	}

	if symName != "" {
		symLower := strings.ToLower(symName)
		matchLine := -1
		for idx, line := range lines {
			lineLower := strings.ToLower(line)
			if strings.Contains(lineLower, symLower) &&
				(strings.Contains(lineLower, "func ") ||
					strings.Contains(lineLower, "type ") ||
					strings.Contains(lineLower, "def ") ||
					strings.Contains(lineLower, "class ") ||
					strings.Contains(lineLower, "function ") ||
					strings.Contains(lineLower, "interface ")) {
				matchLine = idx + 1
				break
			}
		}
		if matchLine > 0 {
			targetEnd := matchLine + 40
			if targetEnd > len(lines) {
				targetEnd = len(lines)
			}
			return strings.Join(lines[matchLine-1:targetEnd], "\n")
		}
	}

	if len(lines) <= 120 {
		return raw
	}

	return strings.Join(lines[:60], "\n") + "\n\n// ... [Truncated: specify symbol start_line/end_line for targeted inspection]"
}

func extractOnDemandFileSymbols(ctx context.Context, archiveRoot, owner, repo, relPath string, refs ...string) []*rsg.SymbolLookupDetail {
	cleanRel := strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(relPath)), "./")
	if cleanRel == "" {
		return nil
	}
	var raw string
	for _, ref := range refs {
		if ref == "" {
			continue
		}
		raw = readRawArchiveFileForSymbol(archiveRoot, owner, repo, ref, cleanRel)
		if raw == "" && archiveRoot != "" {
			compactPath := archive.CompactArchivePathFor(archiveRoot, owner, repo, ref)
			if content, err := archive.ReadSingleFileFromCompactArchive(compactPath, cleanRel, 0, 0, maxSourceFileReadBytes); err == nil {
				raw = content
			}
		}
		if raw == "" {
			raw = fetchImmutableSourceFile(ctx, archiveRoot, owner, repo, ref, cleanRel)
		}
		if raw != "" {
			break
		}
	}
	if raw == "" {
		return nil
	}
	defs := rsg.DefaultLanguageDefinitions()
	if defs == nil {
		return nil
	}
	ast := defs.ExtractFileAst(raw, cleanRel)
	if len(ast.Symbols) == 0 {
		return nil
	}
	out := make([]*rsg.SymbolLookupDetail, 0, len(ast.Symbols))
	for _, sym := range ast.Symbols {
		out = append(out, &rsg.SymbolLookupDetail{
			Name:      sym.Name,
			Kind:      sym.Kind,
			File:      cleanRel,
			StartLine: sym.StartLine,
			EndLine:   sym.EndLine,
			Role:      "leaf_utility",
		})
	}
	return out
}

func readRawArchiveFileForSymbol(archiveRoot, owner, repo, ref, relPath string) string {
	if archiveRoot == "" || owner == "" || repo == "" || ref == "" || relPath == "" {
		return ""
	}
	for _, base := range []string{
		filepath.Join(archiveRoot, owner, repo, ref),
		archive.ArchiveDirFor(archiveRoot, owner, repo, ref),
	} {
		full := filepath.Join(base, filepath.FromSlash(relPath))
		rel, err := filepath.Rel(base, full)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		f, err := os.Open(full)
		if err != nil {
			continue
		}
		st, err := f.Stat()
		if err != nil || st.IsDir() || st.Size() > maxSourceFileReadBytes {
			_ = f.Close()
			continue
		}
		b, err := io.ReadAll(io.LimitReader(f, maxSourceFileReadBytes+1))
		_ = f.Close()
		if err == nil && int64(len(b)) <= maxSourceFileReadBytes {
			return string(b)
		}
	}
	return ""
}

func extractSymbolSignature(sourceCode, symName, lang string) string {
	return armor.ExtractSymbolSignature(sourceCode, symName, lang)
}

func (s *readService) loadSemanticGraphForMCP(ctx context.Context, graphDir, owner, repo, sha, branch string) *rsg.SemanticGraphArtifact {
	refs := nonEmptyStrings(sha, branch)
	if len(refs) == 0 || owner == "" || repo == "" {
		return nil
	}

	for _, ref := range refs {
		if artifact, err := rsg.LoadSemanticGraphArtifact(graphDir, owner, repo, ref); err == nil && artifact != nil {
			return artifact
		}
	}

	if s != nil && s.store != nil {
		for _, ref := range refs {
			if persisted, err := s.store.LoadSemanticGraph(ctx, owner, repo, ref); err == nil && persisted != nil {
				_, _ = rsg.SaveSemanticGraphArtifact(graphDir, owner, repo, ref, persisted)
				return persisted
			}
		}
	}

	if s == nil || s.workerSidecarURL == "" || sha == "" || strings.EqualFold(owner, "web-docs") {
		return nil
	}

	sfKey := strings.ToLower(owner) + "/" + strings.ToLower(repo) + "@" + strings.ToLower(sha)
	res, err := graphBackfillCache.getOrLoadWithCustomTTL(sfKey, func() (any, time.Duration, error) {
		for _, ref := range refs {
			if artifact, err := rsg.LoadSemanticGraphArtifact(graphDir, owner, repo, ref); err == nil && artifact != nil {
				return artifact, 10 * time.Minute, nil
			}
			if s.store != nil {
				if persisted, err := s.store.LoadSemanticGraph(ctx, owner, repo, ref); err == nil && persisted != nil {
					_, _ = rsg.SaveSemanticGraphArtifact(graphDir, owner, repo, ref, persisted)
					return persisted, 10 * time.Minute, nil
				}
			}
		}

		payload, _ := json.Marshal(struct {
			Owner string `json:"owner"`
			Repo  string `json:"repo"`
			Sha   string `json:"sha"`
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}{
			Owner: owner,
			Repo:  repo,
			Sha:   sha,
			Query: "",
			Limit: 1,
		})

		reqCtx, cancel := context.WithTimeout(ctx, 65*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, s.workerSidecarURL+"/v1/graph/symbol-search", bytes.NewReader(payload))
		if err != nil {
			return (*rsg.SemanticGraphArtifact)(nil), 1 * time.Minute, nil
		}
		req.Header.Set("Content-Type", "application/json")
		if s.internalToken != "" {
			req.Header.Set("x-internal-token", s.internalToken)
		}

		resp, err := graphBackfillHTTP.Do(req)
		if err != nil {
			return (*rsg.SemanticGraphArtifact)(nil), 1 * time.Minute, nil
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))

		if resp.StatusCode != http.StatusOK {
			return (*rsg.SemanticGraphArtifact)(nil), 5 * time.Minute, nil
		}

		if s.store != nil {
			if persisted, err := s.store.LoadSemanticGraph(ctx, owner, repo, sha); err == nil && persisted != nil {
				_, _ = rsg.SaveSemanticGraphArtifact(graphDir, owner, repo, sha, persisted)
				return persisted, 10 * time.Minute, nil
			}
		}
		if artifact, err := rsg.LoadSemanticGraphArtifact(graphDir, owner, repo, sha); err == nil && artifact != nil {
			return artifact, 10 * time.Minute, nil
		}
		return (*rsg.SemanticGraphArtifact)(nil), 1 * time.Minute, nil
	})
	if err != nil {
		return nil
	}

	artifact, _ := res.(*rsg.SemanticGraphArtifact)
	return artifact
}

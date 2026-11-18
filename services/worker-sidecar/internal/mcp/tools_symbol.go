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
	graphBackfillHTTP  = &http.Client{Timeout: 45 * time.Second}
)

// readSymbolArgs read_symbol 工具调用参数。
type readSymbolArgs struct {
	Symbol         *string `json:"symbol"`
	File           *string `json:"file"`
	IncludeCode    *bool   `json:"include_code"`
	IncludeCallers *bool   `json:"include_callers"`
	Aspect         *string `json:"aspect"`
}

// runReadSymbol 执行单仓代码符号精确查询与源码切片直出。
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

	// 1. 确定 Git SHA / 分支基线
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

	// 2. 尝试从 RSG 语义图谱产物查找（本地盘 → PostgreSQL → Worker 懒回填）
	var detail *rsg.SymbolLookupDetail
	if artifact := s.loadSemanticGraphForMCP(ctx, graphDir, repo.Owner, repo.Repo, sha, repo.Branch); artifact != nil {
		detail = rsg.LookupSymbolDetail(artifact, cleanSym, cleanFile)
	}

	// 3. 若 RSG 未生成或未命中，回退到 repoProfile.codeClusters (GoldenSymbols + CallFlow)
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
					// 收集所有候选符号供未命中提示
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
								// 从 callFlow 收集被调用方
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

	// 4. 若依然未命中，给出明确提示与候选列表
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
			// 去重排序后最多展示 8 个候选
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

	// 5. 查找归属教学章节（若之前未在 codeClusters 关联）
	if matchedChapterOrder == 0 && len(resolved.Documents) > 0 {
		for _, doc := range resolved.Documents {
			if strings.Contains(strings.ToLower(doc.Path), "chapter") || strings.Contains(strings.ToLower(doc.Path), strings.ToLower(filepath.Base(detail.File))) {
				matchedChapterTitle = doc.Title
				break
			}
		}
	}

	// 6. 读取真实源码切片
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

	// 7. 格式化 Markdown 输出
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
	} else { // "implementation"
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

// runHubReadSymbol 执行 Hub 模式跨仓/单仓代码符号查询。
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

// searchSymbolsArgs search_symbols 工具调用参数。
type searchSymbolsArgs struct {
	Query *string `json:"query"`
	File  *string `json:"file"`
	Limit *int    `json:"limit"`
	Role  *string `json:"role"`
}

// runSearchSymbols 执行单仓代码符号模糊检索与拓扑排序直出。
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

	// 1. 确定 Git SHA / 分支基线
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

	// 2. 尝试从 RSG 语义图谱检索（本地盘 → PostgreSQL → Worker 懒回填）
	var results []*rsg.SymbolLookupDetail
	if artifact := s.loadSemanticGraphForMCP(ctx, graphDir, repo.Owner, repo.Repo, sha, repo.Branch); artifact != nil {
		results = rsg.SearchSymbols(artifact, opts)
	}

	// 3. 若未生成或未命中，回退到 repoProfile.codeClusters
	if len(results) == 0 && len(repo.RepoProfile) > 0 {
		var profile map[string]json.RawMessage
		if json.Unmarshal(repo.RepoProfile, &profile) == nil {
			if raw, ok := profile["codeClusters"]; ok && len(raw) > 0 {
				results = rsg.FallbackSearchClusters(raw, opts)
			}
		}
	}

	// 4. 若依然无结果，返回友好提示
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

	// 5. 格式化 Markdown 输出
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

// runHubSearchSymbols 执行 Hub 模式跨仓/单仓代码符号模糊检索。
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

// readSymbolSourceCode 从本地磁盘解压归档中安全提取代码片段（封顶 2MB 防内存膨胀）。
func readSymbolSourceCode(archiveRoot, owner, repo, ref, relPath, symName string, startLine, endLine int) string {
	if archiveRoot == "" || owner == "" || repo == "" || ref == "" || relPath == "" {
		return ""
	}
	base := filepath.Join(archiveRoot, owner, repo, ref)
	var raw string
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		lowerBase := archive.ArchiveDirFor(archiveRoot, owner, repo, ref)
		if st2, err2 := os.Stat(lowerBase); err2 == nil && st2.IsDir() {
			base = lowerBase
		} else {
			compactPath := archive.CompactArchivePathFor(archiveRoot, owner, repo, ref)
			if cst, cerr := os.Stat(compactPath); cerr == nil && !cst.IsDir() {
				if startLine > 0 && endLine >= startLine {
					content, err := archive.ReadSingleFileFromCompactArchive(compactPath, relPath, startLine, endLine, maxSourceFileReadBytes)
					if err == nil {
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
	}

	if raw == "" {
		full := filepath.Join(base, filepath.FromSlash(relPath))
		rel, err := filepath.Rel(base, full)
		if err != nil || strings.HasPrefix(rel, "..") {
			return ""
		}
		f, err := os.Open(full)
		if err != nil {
			return ""
		}
		defer f.Close()

		st, err := f.Stat()
		if err != nil || st.IsDir() || st.Size() > maxSourceFileReadBytes {
			return ""
		}

		b, err := io.ReadAll(io.LimitReader(f, maxSourceFileReadBytes+1))
		if err != nil || int64(len(b)) > maxSourceFileReadBytes {
			return ""
		}
		raw = string(b)
	}
	return sliceSymbolSourceContent(raw, symName, startLine, endLine)
}

func sliceSymbolSourceContent(raw, symName string, startLine, endLine int) string {
	lines := strings.Split(raw, "\n")
	if len(lines) == 0 {
		return ""
	}

	// 1. 若有准确起止行号，直接切片
	if startLine > 0 && endLine >= startLine && startLine <= len(lines) {
		if endLine > len(lines) {
			endLine = len(lines)
		}
		return strings.Join(lines[startLine-1:endLine], "\n")
	}

	// 2. 若行号缺失，尝试在文件中扫描符号定义签名
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

	// 3. 若文件整体较小（<= 120 行），输出全量
	if len(lines) <= 120 {
		return raw
	}

	// 4. 超大文件截断输出前 60 行
	return strings.Join(lines[:60], "\n") + "\n\n// ... [Truncated: specify symbol start_line/end_line for targeted inspection]"
}

// extractSymbolSignature 纯确定性状态机提取代码符号接口契约与签名（零语法正则，严格遵守 Chomsky 边界与 GO-004）。
func extractSymbolSignature(sourceCode, symName, lang string) string {
	return armor.ExtractSymbolSignature(sourceCode, symName, lang)
}

// loadSemanticGraphForMCP 统一读取 RSG 语义图谱：
// 1. 本地磁盘缓存 → 2. PostgreSQL RepoSemanticGraph → 3. 向 worker-sidecar 发起单飞按需懒回填。
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

		reqCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
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

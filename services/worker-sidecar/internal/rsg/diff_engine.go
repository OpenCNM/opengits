package rsg

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

const DefaultBackboneDriftEditionThreshold = 0.3

func readHeaderSample(filePath string) []byte {
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer f.Close()
	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	if n <= 0 {
		return nil
	}
	return buf[:n]
}

func ComputeBackboneDrift(previous, current *SemanticGraphArtifact) *BackboneDrift {
	if previous == nil || current == nil || len(previous.BackboneNodes) == 0 || len(current.BackboneNodes) == 0 {
		return nil
	}
	prev := make(map[string]bool, len(previous.BackboneNodes))
	for _, p := range previous.BackboneNodes {
		prev[p] = true
	}
	curr := make(map[string]bool, len(current.BackboneNodes))
	for _, p := range current.BackboneNodes {
		curr[p] = true
	}
	var added []string
	for _, p := range current.BackboneNodes {
		if !prev[p] {
			added = append(added, p)
		}
	}
	var removed []string
	for _, p := range previous.BackboneNodes {
		if !curr[p] {
			removed = append(removed, p)
		}
	}
	union := make(map[string]bool)
	for _, p := range previous.BackboneNodes {
		union[p] = true
	}
	for _, p := range current.BackboneNodes {
		union[p] = true
	}
	if len(union) == 0 {
		return &BackboneDrift{Index: 0, AddedBackbone: added, RemovedBackbone: removed, UnionSize: 0}
	}
	idx := float64(len(added)+len(removed)) / float64(len(union))
	return &BackboneDrift{
		Index:           idx,
		AddedBackbone:   added,
		RemovedBackbone: removed,
		UnionSize:       len(union),
	}
}

func readLines(filePath string, startLine, endLine int) (string, error) {
	return readLinesCached(nil, filePath, startLine, endLine)
}

// Cache file reads and errors per diff call so multi-symbol diffs do not re-read and re-split the same file.
type fileLinesCache struct {
	cache map[string]*cachedFileLines
}

type cachedFileLines struct {
	lines []string
	err   error
}

func newFileLinesCache() *fileLinesCache {
	return &fileLinesCache{cache: make(map[string]*cachedFileLines)}
}

func (c *fileLinesCache) file(filePath string) *cachedFileLines {
	if f, ok := c.cache[filePath]; ok {
		return f
	}
	f := &cachedFileLines{}
	if data, err := os.ReadFile(filePath); err != nil {
		f.err = err
	} else {
		content := strings.ReplaceAll(string(data), "\r\n", "\n")
		f.lines = strings.Split(content, "\n")
	}
	c.cache[filePath] = f
	return f
}

func readLinesCached(lc *fileLinesCache, filePath string, startLine, endLine int) (string, error) {
	var lines []string
	var readErr error
	if lc != nil {
		f := lc.file(filePath)
		lines, readErr = f.lines, f.err
	} else {
		data, err := os.ReadFile(filePath)
		if err != nil {
			readErr = err
		} else {
			content := strings.ReplaceAll(string(data), "\r\n", "\n")
			lines = strings.Split(content, "\n")
		}
	}
	if readErr != nil {
		return "", readErr
	}
	if startLine < 1 {
		startLine = 1
	}
	if startLine > len(lines) {
		return "", nil
	}
	if endLine > len(lines) {
		endLine = len(lines)
	}
	if startLine > endLine {
		return "", nil
	}
	var sb strings.Builder
	for i := startLine - 1; i < endLine; i++ {
		sb.WriteString(lines[i])
		sb.WriteByte('\n')
	}
	return sb.String(), nil
}

type codeNormalizerScanner struct {
	runes        []rune
	n            int
	pos          int
	pendingSpace bool
	sb           strings.Builder
}

func newCodeNormalizerScanner(code string) *codeNormalizerScanner {
	r := []rune(code)
	return &codeNormalizerScanner{
		runes: r,
		n:     len(r),
	}
}

func (s *codeNormalizerScanner) at(offset int) rune {
	idx := s.pos + offset
	if idx < s.n {
		return s.runes[idx]
	}
	return 0
}

func (s *codeNormalizerScanner) scanStringLiteral() {
	quote := s.runes[s.pos]
	s.flushPendingSpace()
	s.sb.WriteRune(quote)
	s.pos++

	for s.pos < s.n {
		r := s.runes[s.pos]
		s.sb.WriteRune(r)
		s.pos++
		if r == '\\' && s.pos < s.n {
			s.sb.WriteRune(s.runes[s.pos])
			s.pos++
		} else if r == quote {
			break
		}
	}
}

func (s *codeNormalizerScanner) scanLineComment() {
	for s.pos < s.n && s.runes[s.pos] != '\n' {
		s.pos++
	}
	s.pendingSpace = true
}

func (s *codeNormalizerScanner) scanBlockComment() {
	s.pos += 2
	for s.pos < s.n {
		if s.runes[s.pos] == '*' && s.at(1) == '/' {
			s.pos += 2
			break
		}
		s.pos++
	}
	s.pendingSpace = true
}

func (s *codeNormalizerScanner) flushPendingSpace() {
	if s.pendingSpace {
		if s.sb.Len() > 0 {
			s.sb.WriteByte(' ')
		}
		s.pendingSpace = false
	}
}

func (s *codeNormalizerScanner) Normalize() string {
	for s.pos < s.n {
		r := s.runes[s.pos]

		if r == '"' || r == '\'' || r == '`' {
			s.scanStringLiteral()
			continue
		}

		if r == '/' && s.at(1) == '/' {
			s.pos += 2
			s.scanLineComment()
			continue
		}
		if r == '/' && s.at(1) == '*' {
			s.scanBlockComment()
			continue
		}
		if r == '#' {
			s.pos++
			s.scanLineComment()
			continue
		}

		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			s.pendingSpace = true
			s.pos++
			continue
		}

		s.flushPendingSpace()
		s.sb.WriteRune(r)
		s.pos++
	}

	return strings.TrimSpace(s.sb.String())
}

func stripCommentsAndNormalizeSpace(code string) string {
	return newCodeNormalizerScanner(code).Normalize()
}

func isCodeSubstantivelyEqual(oldCode, newCode string) bool {
	if oldCode == newCode {
		return true
	}
	normOld := stripCommentsAndNormalizeSpace(oldCode)
	normNew := stripCommentsAndNormalizeSpace(newCode)
	return normOld == normNew
}

type symbolDiffStrategy interface {
	Format(oldCode, newCode string) string
}

type addedSymbolDiffStrategy struct{}

func (addedSymbolDiffStrategy) Format(_, newCode string) string {
	lines := strings.Split(strings.TrimSpace(newCode), "\n")
	limit := 4
	if len(lines) < limit {
		limit = len(lines)
	}
	var sb strings.Builder
	for i := 0; i < limit; i++ {
		sb.WriteString("+ ")
		sb.WriteString(strings.TrimSpace(lines[i]))
		sb.WriteByte('\n')
	}
	if len(lines) > limit {
		sb.WriteString("+ ... (truncated)\n")
	}
	return sb.String()
}

type removedSymbolDiffStrategy struct{}

func (removedSymbolDiffStrategy) Format(oldCode, _ string) string {
	lines := strings.Split(strings.TrimSpace(oldCode), "\n")
	limit := 4
	if len(lines) < limit {
		limit = len(lines)
	}
	var sb strings.Builder
	for i := 0; i < limit; i++ {
		sb.WriteString("- ")
		sb.WriteString(strings.TrimSpace(lines[i]))
		sb.WriteByte('\n')
	}
	if len(lines) > limit {
		sb.WriteString("- ... (truncated)\n")
	}
	return sb.String()
}

type modifiedSymbolDiffStrategy struct{}

func (modifiedSymbolDiffStrategy) Format(oldCode, newCode string) string {
	oldLines := strings.Split(strings.TrimSpace(oldCode), "\n")
	newLines := strings.Split(strings.TrimSpace(newCode), "\n")

	firstDiff := 0
	for i := 0; i < len(oldLines) && i < len(newLines); i++ {
		if strings.TrimSpace(oldLines[i]) != strings.TrimSpace(newLines[i]) {
			firstDiff = i
			break
		}
	}

	start := firstDiff - 1
	if start < 0 {
		start = 0
	}

	var sb strings.Builder

	if start < firstDiff && start < len(oldLines) {
		sb.WriteString("  ")
		sb.WriteString(strings.TrimSpace(oldLines[start]))
		sb.WriteByte('\n')
	}

	oldLimit := 3
	for i := firstDiff; i < len(oldLines) && i < firstDiff+oldLimit; i++ {
		sb.WriteString("- ")
		sb.WriteString(strings.TrimSpace(oldLines[i]))
		sb.WriteByte('\n')
	}

	newLimit := 3
	for i := firstDiff; i < len(newLines) && i < firstDiff+newLimit; i++ {
		sb.WriteString("+ ")
		sb.WriteString(strings.TrimSpace(newLines[i]))
		sb.WriteByte('\n')
	}
	return sb.String()
}

var symbolDiffStrategies = map[string]symbolDiffStrategy{
	"added":    addedSymbolDiffStrategy{},
	"removed":  removedSymbolDiffStrategy{},
	"modified": modifiedSymbolDiffStrategy{},
}

func trimDiffSnippetToBudget(snippet string, maxTokens int) string {
	if mdpat.EstimateTokens(snippet) <= maxTokens {
		return strings.TrimRight(snippet, "\n")
	}
	lines := strings.Split(snippet, "\n")
	var trimmed strings.Builder
	for _, l := range lines {
		if mdpat.EstimateTokens(trimmed.String()+"\n"+l) > maxTokens-10 {
			trimmed.WriteString("  ... (truncated to token budget)\n")
			break
		}
		trimmed.WriteString(l)
		trimmed.WriteByte('\n')
	}
	return strings.TrimRight(trimmed.String(), "\n")
}

func generateSymbolDiffSnippet(oldCode, newCode, change string) string {
	strategy, ok := symbolDiffStrategies[change]
	if !ok {
		return ""
	}
	raw := strategy.Format(oldCode, newCode)
	return trimDiffSnippetToBudget(raw, 150)
}

type symbolChangeContext struct {
	cfg     Config
	owner   string
	repo    string
	fromSha string
	toSha   string
	file    string
	oldSym  SymbolEntry
	newSym  SymbolEntry

	lines *fileLinesCache
}

type symbolChangeEvaluator interface {
	Evaluate(ctx symbolChangeContext) (changed bool, decided bool)
}

type exportStatusEvaluator struct{}

func (exportStatusEvaluator) Evaluate(ctx symbolChangeContext) (bool, bool) {
	if ctx.oldSym.Exported != ctx.newSym.Exported {
		return true, true
	}
	return false, false
}

type diskSemanticEvaluator struct{}

func (diskSemanticEvaluator) Evaluate(ctx symbolChangeContext) (bool, bool) {
	archiveRoot := ctx.cfg.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}
	oldPath := filepath.Join(archive.ArchiveDirFor(archiveRoot, ctx.owner, ctx.repo, ctx.fromSha), filepath.FromSlash(ctx.file))
	newPath := filepath.Join(archive.ArchiveDirFor(archiveRoot, ctx.owner, ctx.repo, ctx.toSha), filepath.FromSlash(ctx.file))

	oldContent, errOld := readLinesCached(ctx.lines, oldPath, ctx.oldSym.StartLine, ctx.oldSym.EndLine)
	newContent, errNew := readLinesCached(ctx.lines, newPath, ctx.newSym.StartLine, ctx.newSym.EndLine)
	if errOld == nil && errNew == nil {
		if isCodeSubstantivelyEqual(oldContent, newContent) {
			return false, true
		}
		return true, true
	}
	return false, false
}

type lineSpanFallbackEvaluator struct{}

func (lineSpanFallbackEvaluator) Evaluate(ctx symbolChangeContext) (bool, bool) {
	oldSpan := ctx.oldSym.EndLine - ctx.oldSym.StartLine
	newSpan := ctx.newSym.EndLine - ctx.newSym.StartLine
	if oldSpan != newSpan {
		return true, true
	}
	return false, true
}

var defaultSymbolChangeEvaluators = []symbolChangeEvaluator{
	exportStatusEvaluator{},
	diskSemanticEvaluator{},
	lineSpanFallbackEvaluator{},
}

func checkSymbolContentChanged(cfg Config, owner, repo, fromSha, toSha, file string, oldSym, newSym SymbolEntry, lc *fileLinesCache) bool {
	ctx := symbolChangeContext{
		cfg:     cfg,
		owner:   owner,
		repo:    repo,
		fromSha: fromSha,
		toSha:   toSha,
		file:    file,
		oldSym:  oldSym,
		newSym:  newSym,
		lines:   lc,
	}

	for _, evaluator := range defaultSymbolChangeEvaluators {
		if changed, decided := evaluator.Evaluate(ctx); decided {
			return changed
		}
	}
	return false
}

func tryBuildArtifact(cfg Config, owner, repo, sha string) *SemanticGraphArtifact {
	archiveRoot := cfg.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}
	graphDir := cfg.SemanticGraphDir
	if graphDir == "" {
		graphDir = "storage/graphs"
	}

	archiveDir := archive.ArchiveDirFor(archiveRoot, owner, repo, sha)
	if fi, err := os.Stat(archiveDir); err != nil || !fi.IsDir() {
		return nil
	}

	defs := DefaultLanguageDefinitions()
	patterns := DefaultIngestPatterns()

	var nodes []GitNode
	_ = filepath.Walk(archiveDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(archiveDir, path)
		if err != nil {
			return nil
		}
		nodes = append(nodes, GitNode{
			Path: filepath.ToSlash(rel),
			Type: "blob",
			Size: info.Size(),
		})
		return nil
	})

	art, err := BuildRepoSemanticGraph(context.Background(), archiveRoot, graphDir, owner, repo, sha, defs, patterns, nodes)
	if err != nil {
		return nil
	}
	return art
}

func ComputeGraphSemanticDiff(cfg Config, req GraphDiffRequest) (*GraphDiffResponse, error) {
	graphDir := cfg.SemanticGraphDir
	if graphDir == "" {
		graphDir = "storage/graphs"
	}

	fromArtifact, err := LoadSemanticGraphArtifact(graphDir, req.Owner, req.Repo, req.FromSha)
	if err != nil || fromArtifact == nil {
		fromArtifact = tryBuildArtifact(cfg, req.Owner, req.Repo, req.FromSha)
	}

	toArtifact, err := LoadSemanticGraphArtifact(graphDir, req.Owner, req.Repo, req.ToSha)
	if err != nil || toArtifact == nil {
		toArtifact = tryBuildArtifact(cfg, req.Owner, req.Repo, req.ToSha)
	}

	patterns := loadIngestPatterns("")
	classifier := NewInfraClassifier(patterns)

	resp := ComputeGraphSemanticDiffWithClassifier(cfg, req, fromArtifact, toArtifact, classifier)
	return resp, nil
}

func ComputeGraphSemanticDiffWithArtifacts(
	cfg Config,
	req GraphDiffRequest,
	fromArtifact, toArtifact *SemanticGraphArtifact,
) *GraphDiffResponse {
	return ComputeGraphSemanticDiffWithClassifier(cfg, req, fromArtifact, toArtifact, nil)
}

func ComputeGraphSemanticDiffWithClassifier(
	cfg Config,
	req GraphDiffRequest,
	fromArtifact, toArtifact *SemanticGraphArtifact,
	classifier *InfraClassifier,
) *GraphDiffResponse {
	if classifier == nil {
		classifier = GetDefaultInfraClassifier()
	}
	archiveRoot := cfg.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}
	modifiedSet := make(map[string]bool, len(req.ModifiedFiles))
	for _, f := range req.ModifiedFiles {
		modifiedSet[f] = true
	}
	addedSet := make(map[string]bool, len(req.AddedFiles))
	for _, f := range req.AddedFiles {
		addedSet[f] = true
	}
	removedSet := make(map[string]bool, len(req.RemovedFiles))
	for _, f := range req.RemovedFiles {
		removedSet[f] = true
	}

	fileDiffs, exportedChangedSymbols := extractFileDiffs(cfg, req, fromArtifact, toArtifact, classifier, archiveRoot)

	rippleCallers := propagateRipple(fromArtifact, toArtifact, exportedChangedSymbols, fileDiffs)
	isBreaking := checkBreakingChange(fromArtifact, removedSet, fileDiffs)

	drift := ComputeBackboneDrift(fromArtifact, toArtifact)
	suggestsNewEdition := false
	if drift != nil && drift.Index >= DefaultBackboneDriftEditionThreshold {
		suggestsNewEdition = true
	}

	chapterDecisions, exemptCount, updateCount := classifyChapters(req, fileDiffs, rippleCallers, addedSet, removedSet, modifiedSet, classifier, isBreaking)

	stats := GraphDiffStats{
		TotalFiles:     len(fileDiffs),
		TotalChapters:  len(req.Chapters),
		ExemptChapters: exemptCount,
		UpdateChapters: updateCount,
	}
	for _, d := range fileDiffs {
		stats.RecordCategory(d.Category)
	}

	return &GraphDiffResponse{
		FromSha:            req.FromSha,
		ToSha:              req.ToSha,
		FileDiffs:          fileDiffs,
		ChapterDecisions:   chapterDecisions,
		GraphDrift:         drift,
		SuggestsNewEdition: suggestsNewEdition,
		IsBreaking:         isBreaking,
		Stats:              stats,
	}
}

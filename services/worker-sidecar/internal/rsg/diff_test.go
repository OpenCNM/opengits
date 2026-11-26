package rsg

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func makeTestArtifact(t *testing.T, symbols map[string][]SymbolEntry, edges ...CallEdge) *SemanticGraphArtifact {
	t.Helper()
	return &SemanticGraphArtifact{
		Version:       2,
		SymbolsByFile: symbols,
		CallEdges:     edges,
	}
}

func makeDiffRequest(owner, repo, fromSha, toSha string, modified []string, chapters ...DiffChapterInput) GraphDiffRequest {
	return GraphDiffRequest{
		Owner:         owner,
		Repo:          repo,
		FromSha:       fromSha,
		ToSha:         toSha,
		ModifiedFiles: modified,
		Chapters:      chapters,
	}
}

func TestDiffEngineAstIdenticalKeepExemption(t *testing.T) {
	fromArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/core/math.go": {
			{Name: "Add", Kind: "function", Exported: true, StartLine: 1, EndLine: 5},
			{Name: "Sub", Kind: "function", Exported: true, StartLine: 7, EndLine: 12},
		},
	})
	toArtifact := makeTestArtifact(t, map[string][]SymbolEntry{

		"src/core/math.go": {
			{Name: "Add", Kind: "function", Exported: true, StartLine: 11, EndLine: 15},
			{Name: "Sub", Kind: "function", Exported: true, StartLine: 17, EndLine: 22},
		},
	})

	req := makeDiffRequest("testowner", "testrepo", "sha1", "sha2",
		[]string{"src/core/math.go"},
		DiffChapterInput{Path: "chapters/01.mdx", Files: []string{"src/core/math.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(Config{}, req, fromArtifact, toArtifact)

	fileDiff, ok := resp.FileDiffs["src/core/math.go"]
	require.True(t, ok, "expected fileDiff for src/core/math.go")
	assert.Equal(t, FileCategoryAstIdentical, fileDiff.Category)

	require.Len(t, resp.ChapterDecisions, 1)
	decision := resp.ChapterDecisions[0]
	assert.Equal(t, ActionKeep, decision.Action)
	require.NotNil(t, decision.KeepExemption)
	assert.Contains(t, decision.KeepExemption.Reason, "AST 语义无实质变动")
}

func TestIsCodeSubstantivelyEqual_CommentAndWhitespace(t *testing.T) {
	tests := []struct {
		name      string
		oldCode   string
		newCode   string
		wantEqual bool
	}{
		{
			name:      "exact match",
			oldCode:   "func Add(a, b int) int { return a + b }",
			newCode:   "func Add(a, b int) int { return a + b }",
			wantEqual: true,
		},
		{
			name:      "single-line comments added and removed",
			oldCode:   "// Old comment\nfunc Add(a, b int) int {\n  // do addition\n  return a + b\n}",
			newCode:   "func Add(a, b int) int {\n  /* new block comment */\n  return a + b // inline\n}",
			wantEqual: true,
		},
		{
			name:      "hash comments for python/shell",
			oldCode:   "# Compute sum\ndef add(a, b):\n    return a + b",
			newCode:   "def add(a, b):\n    # Helper\n    return a + b # inline",
			wantEqual: true,
		},
		{
			name:      "whitespace indentation formatting differences",
			oldCode:   "func Sub(a, b int) int {\n\treturn a - b\n}",
			newCode:   "func Sub(a,   b int) int { \n    return   a - b \n}",
			wantEqual: true,
		},
		{
			name:      "string literal containing comment symbols must not be stripped",
			oldCode:   `func Url() string { return "http://example.com" }`,
			newCode:   `func Url() string { return "http://other.com" }`,
			wantEqual: false,
		},
		{
			name:      "substantive logic change",
			oldCode:   "func Add(a, b int) int { return a + b }",
			newCode:   "func Add(a, b int) int { return a + b + 1 }",
			wantEqual: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isCodeSubstantivelyEqual(tt.oldCode, tt.newCode)
			assert.Equal(t, tt.wantEqual, got)
		})
	}
}

func TestGenerateSymbolDiffSnippet_Bounded(t *testing.T) {
	t.Run("added symbol format", func(t *testing.T) {
		snippet := generateSymbolDiffSnippet("", "func Multiply(a, b int) int {\n  return a * b\n}", "added")
		assert.Contains(t, snippet, "+ func Multiply(a, b int) int {")
		assert.Contains(t, snippet, "+ return a * b")
	})

	t.Run("removed symbol format", func(t *testing.T) {
		snippet := generateSymbolDiffSnippet("func Old(a int) {\n  return\n}", "", "removed")
		assert.Contains(t, snippet, "- func Old(a int) {")
		assert.Contains(t, snippet, "- return")
	})

	t.Run("modified symbol format", func(t *testing.T) {
		oldCode := "func Calc(x int) int {\n  val := x * 2\n  return val\n}"
		newCode := "func Calc(x int) int {\n  val := x * 3\n  return val\n}"
		snippet := generateSymbolDiffSnippet(oldCode, newCode, "modified")
		assert.Contains(t, snippet, "- val := x * 2")
		assert.Contains(t, snippet, "+ val := x * 3")
	})

	t.Run("token bounded truncation", func(t *testing.T) {
		var longLines []string
		for i := 0; i < 200; i++ {
			longLines = append(longLines, fmt.Sprintf("  field%d := computeComplexSomethingBigValue(%d)", i, i))
		}
		longCode := strings.Join(longLines, "\n")
		snippet := generateSymbolDiffSnippet("", longCode, "added")
		assert.LessOrEqual(t, mdpat.EstimateTokens(snippet), 150)
	})
}

func TestDiffEngineCommentAndFormattingKeepExemption(t *testing.T) {
	archiveRoot := t.TempDir()
	cfg := Config{ArchiveRoot: archiveRoot}

	oldDir := filepath.Join(archiveRoot, "owner", "repo", "sha1", "src")
	newDir := filepath.Join(archiveRoot, "owner", "repo", "sha2", "src")
	require.NoError(t, os.MkdirAll(oldDir, 0755))
	require.NoError(t, os.MkdirAll(newDir, 0755))

	oldSrc := "package src\n\n// Add numbers\nfunc Add(a, b int) int {\n\treturn a + b\n}\n"
	newSrc := "package src\n\n// Add numbers with improved documentation\n// and formatting notes\nfunc Add(a, b int) int {\n\t// perform addition\n\treturn a + b\n}\n"

	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "math.go"), []byte(oldSrc), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "math.go"), []byte(newSrc), 0644))

	fromArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/math.go": {
			{Name: "Add", Kind: "function", Exported: true, StartLine: 4, EndLine: 6},
		},
	})
	toArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/math.go": {

			{Name: "Add", Kind: "function", Exported: true, StartLine: 5, EndLine: 8},
		},
	})

	req := makeDiffRequest("owner", "repo", "sha1", "sha2",
		[]string{"src/math.go"},
		DiffChapterInput{Path: "chapters/01.mdx", Files: []string{"src/math.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(cfg, req, fromArtifact, toArtifact)

	fileDiff, ok := resp.FileDiffs["src/math.go"]
	require.True(t, ok)
	assert.Equal(t, FileCategoryAstIdentical, fileDiff.Category)

	require.Len(t, resp.ChapterDecisions, 1)
	decision := resp.ChapterDecisions[0]
	assert.Equal(t, ActionKeep, decision.Action)
	require.NotNil(t, decision.KeepExemption)
	assert.Contains(t, decision.KeepExemption.Reason, "AST 语义无实质变动")
}

func TestDiffEngineSurgicalDiffSnippetGeneration(t *testing.T) {
	archiveRoot := t.TempDir()
	cfg := Config{ArchiveRoot: archiveRoot}

	oldDir := filepath.Join(archiveRoot, "owner", "repo", "sha1", "src")
	newDir := filepath.Join(archiveRoot, "owner", "repo", "sha2", "src")
	require.NoError(t, os.MkdirAll(oldDir, 0755))
	require.NoError(t, os.MkdirAll(newDir, 0755))

	oldSrc := "package src\n\nfunc Compute(x int) int {\n\treturn x * 2\n}\n"
	newSrc := "package src\n\nfunc Compute(x int) int {\n\treturn x * 3\n}\n"

	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "calc.go"), []byte(oldSrc), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "calc.go"), []byte(newSrc), 0644))

	fromArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/calc.go": {
			{Name: "Compute", Kind: "function", Exported: true, StartLine: 3, EndLine: 5},
		},
	})
	toArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/calc.go": {
			{Name: "Compute", Kind: "function", Exported: true, StartLine: 3, EndLine: 5},
		},
	})

	req := makeDiffRequest("owner", "repo", "sha1", "sha2",
		[]string{"src/calc.go"},
		DiffChapterInput{Path: "chapters/01.mdx", Files: []string{"src/calc.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(cfg, req, fromArtifact, toArtifact)

	fileDiff, ok := resp.FileDiffs["src/calc.go"]
	require.True(t, ok)
	assert.Equal(t, FileCategoryExportedChanged, fileDiff.Category)
	require.Len(t, fileDiff.SymbolDiffs, 1)

	symDiff := fileDiff.SymbolDiffs[0]
	assert.Equal(t, "Compute", symDiff.Name)
	assert.NotEmpty(t, symDiff.DiffSnippet)
	assert.Contains(t, symDiff.DiffSnippet, "- return x * 2")
	assert.Contains(t, symDiff.DiffSnippet, "+ return x * 3")

	require.Len(t, resp.ChapterDecisions, 1)
	decision := resp.ChapterDecisions[0]
	assert.Equal(t, ActionUpdate, decision.Action)
	require.Len(t, decision.SurgicalAnchors, 1)
	assert.Equal(t, symDiff.DiffSnippet, decision.SurgicalAnchors[0].DiffSnippet)
}

func TestDiffSnippetStrategyDirect(t *testing.T) {
	t.Run("unknown strategy returns empty", func(t *testing.T) {
		snippet := generateSymbolDiffSnippet("old", "new", "unknown_strategy")
		assert.Empty(t, snippet)
	})

	t.Run("added strategy directly", func(t *testing.T) {
		s := addedSymbolDiffStrategy{}
		out := s.Format("", "line1\nline2\nline3\nline4\nline5")
		assert.Contains(t, out, "+ line1")
		assert.Contains(t, out, "+ line4")
		assert.Contains(t, out, "+ ... (truncated)")
	})

	t.Run("removed strategy directly", func(t *testing.T) {
		s := removedSymbolDiffStrategy{}
		out := s.Format("del1\ndel2\ndel3\ndel4\ndel5", "")
		assert.Contains(t, out, "- del1")
		assert.Contains(t, out, "- del4")
		assert.Contains(t, out, "- ... (truncated)")
	})

	t.Run("modified strategy with context", func(t *testing.T) {
		s := modifiedSymbolDiffStrategy{}
		out := s.Format("common\noldVal", "common\nnewVal")
		assert.Contains(t, out, "  common")
		assert.Contains(t, out, "- oldVal")
		assert.Contains(t, out, "+ newVal")
	})
}

func TestSymbolChangeEvaluatorChain(t *testing.T) {
	t.Run("export status evaluator triggers on visibility change", func(t *testing.T) {
		ctx := symbolChangeContext{
			oldSym: SymbolEntry{Exported: false},
			newSym: SymbolEntry{Exported: true},
		}
		eval := exportStatusEvaluator{}
		changed, decided := eval.Evaluate(ctx)
		assert.True(t, decided)
		assert.True(t, changed)
	})

	t.Run("export status evaluator passes through when unchanged", func(t *testing.T) {
		ctx := symbolChangeContext{
			oldSym: SymbolEntry{Exported: true},
			newSym: SymbolEntry{Exported: true},
		}
		eval := exportStatusEvaluator{}
		changed, decided := eval.Evaluate(ctx)
		assert.False(t, decided)
		assert.False(t, changed)
	})

	t.Run("line span fallback evaluates lines", func(t *testing.T) {
		ctxChanged := symbolChangeContext{
			oldSym: SymbolEntry{StartLine: 1, EndLine: 5},
			newSym: SymbolEntry{StartLine: 1, EndLine: 10},
		}
		eval := lineSpanFallbackEvaluator{}
		changed, decided := eval.Evaluate(ctxChanged)
		assert.True(t, decided)
		assert.True(t, changed)

		ctxUnchanged := symbolChangeContext{
			oldSym: SymbolEntry{StartLine: 1, EndLine: 5},
			newSym: SymbolEntry{StartLine: 10, EndLine: 14},
		}
		changed, decided = eval.Evaluate(ctxUnchanged)
		assert.True(t, decided)
		assert.False(t, changed)
	})
}

func TestGraphDiffStatsAccumulator(t *testing.T) {
	var stats GraphDiffStats
	stats.RecordCategory(FileCategoryAstIdentical)
	stats.RecordCategory(FileCategoryPrivateOnly)
	stats.RecordCategory(FileCategoryExportedChanged)
	stats.RecordCategory(FileCategoryRippleAffected)

	assert.Equal(t, 1, stats.AstIdenticalFiles)
	assert.Equal(t, 1, stats.PrivateOnlyFiles)
	assert.Equal(t, 1, stats.ExportedChangedFiles)
	assert.Equal(t, 1, stats.RippleAffectedFiles)
}

func TestDiffEnginePrivateOnlyKeepExemption(t *testing.T) {
	fromArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/core/service.go": {
			{Name: "PublicAPI", Kind: "function", Exported: true, StartLine: 1, EndLine: 10},
			{Name: "internalHelper", Kind: "function", Exported: false, StartLine: 12, EndLine: 20},
		},
	})
	toArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/core/service.go": {
			{Name: "PublicAPI", Kind: "function", Exported: true, StartLine: 1, EndLine: 10},

			{Name: "internalHelper", Kind: "function", Exported: false, StartLine: 12, EndLine: 27},
		},
	})

	req := makeDiffRequest("testowner", "testrepo", "sha1", "sha2",
		[]string{"src/core/service.go"},
		DiffChapterInput{Path: "chapters/02.mdx", Files: []string{"src/core/service.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(Config{}, req, fromArtifact, toArtifact)

	fileDiff, ok := resp.FileDiffs["src/core/service.go"]
	require.True(t, ok)
	assert.Equal(t, FileCategoryPrivateOnly, fileDiff.Category)

	require.Len(t, resp.ChapterDecisions, 1)
	decision := resp.ChapterDecisions[0]
	assert.Equal(t, ActionKeep, decision.Action)
	require.NotNil(t, decision.KeepExemption)
	assert.Contains(t, decision.KeepExemption.Reason, "内部私有实现发生变动")
}

func TestDiffEngineExportedChanged(t *testing.T) {
	fromArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/auth/jwt.go": {
			{Name: "VerifyJWT", Kind: "function", Exported: true, StartLine: 1, EndLine: 15},
		},
	})
	toArtifact := makeTestArtifact(t, map[string][]SymbolEntry{
		"src/auth/jwt.go": {

			{Name: "VerifyJWT", Kind: "function", Exported: true, StartLine: 1, EndLine: 31},
		},
	})

	req := makeDiffRequest("testowner", "testrepo", "sha1", "sha2",
		[]string{"src/auth/jwt.go"},
		DiffChapterInput{Path: "chapters/03.mdx", Files: []string{"src/auth/jwt.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(Config{}, req, fromArtifact, toArtifact)

	fileDiff, ok := resp.FileDiffs["src/auth/jwt.go"]
	require.True(t, ok)
	assert.Equal(t, FileCategoryExportedChanged, fileDiff.Category)

	require.Len(t, resp.ChapterDecisions, 1)
	decision := resp.ChapterDecisions[0]
	assert.Equal(t, ActionUpdate, decision.Action)
	assert.Nil(t, decision.KeepExemption)
	require.NotEmpty(t, decision.SurgicalAnchors)
	assert.Equal(t, "VerifyJWT", decision.SurgicalAnchors[0].SymbolName)
}

func TestDiffEngineMissingArtifactSafeFallback(t *testing.T) {
	req := makeDiffRequest("testowner", "testrepo", "sha1", "sha2",
		[]string{"src/core/handler.go"},
		DiffChapterInput{Path: "chapters/01.mdx", Files: []string{"src/core/handler.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(Config{}, req, nil, nil)

	fileDiff, ok := resp.FileDiffs["src/core/handler.go"]
	require.True(t, ok)
	assert.Equal(t, FileCategoryExportedChanged, fileDiff.Category)

	require.Len(t, resp.ChapterDecisions, 1)
	decision := resp.ChapterDecisions[0]
	assert.Equal(t, ActionUpdate, decision.Action)
	assert.Nil(t, decision.KeepExemption)
}

func TestDiffEngineUntouchedChapterCleanVerdict(t *testing.T) {
	req := makeDiffRequest("testowner", "testrepo", "sha1", "sha2",
		[]string{"src/other/code.go"},
		DiffChapterInput{Path: "chapters/untouched.mdx", Files: []string{"src/untouched/code.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(Config{}, req, nil, nil)

	require.Len(t, resp.ChapterDecisions, 1)
	decision := resp.ChapterDecisions[0]
	assert.Equal(t, ActionKeep, decision.Action)
	assert.Nil(t, decision.KeepExemption, "untouched chapter should not have KeepExemption populated")
	assert.Equal(t, 0, resp.Stats.ExemptChapters)
}

func TestDiffEngineCallGraphRipple(t *testing.T) {
	fromArtifact := makeTestArtifact(t,
		map[string][]SymbolEntry{
			"src/auth/jwt.go": {
				{Name: "VerifyJWT", Kind: "function", Exported: true, StartLine: 1, EndLine: 15},
			},
			"src/api/routes.go": {
				{Name: "HandleLogin", Kind: "function", Exported: true, StartLine: 10, EndLine: 25},
			},
		},
		CallEdge{
			CallerFile:   "src/api/routes.go",
			CallerSymbol: "HandleLogin",
			CalleeFile:   "src/auth/jwt.go",
			CalleeSymbol: "VerifyJWT",
			Line:         15,
		},
	)
	toArtifact := makeTestArtifact(t,
		map[string][]SymbolEntry{
			"src/auth/jwt.go": {
				{Name: "VerifyJWT", Kind: "function", Exported: true, StartLine: 1, EndLine: 35},
			},
			"src/api/routes.go": {
				{Name: "HandleLogin", Kind: "function", Exported: true, StartLine: 10, EndLine: 25},
			},
		},
		CallEdge{
			CallerFile:   "src/api/routes.go",
			CallerSymbol: "HandleLogin",
			CalleeFile:   "src/auth/jwt.go",
			CalleeSymbol: "VerifyJWT",
			Line:         15,
		},
	)

	req := makeDiffRequest("testowner", "testrepo", "sha1", "sha2",
		[]string{"src/auth/jwt.go"},
		DiffChapterInput{Path: "chapters/auth.mdx", Files: []string{"src/auth/jwt.go"}},
		DiffChapterInput{Path: "chapters/api.mdx", Files: []string{"src/api/routes.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(Config{}, req, fromArtifact, toArtifact)

	apiDiff, ok := resp.FileDiffs["src/api/routes.go"]
	require.True(t, ok, "expected routes.go to be recognized as ripple-affected")
	assert.Equal(t, FileCategoryRippleAffected, apiDiff.Category)

	require.Len(t, resp.ChapterDecisions, 2)
	assert.Equal(t, ActionUpdate, resp.ChapterDecisions[0].Action)
	assert.Equal(t, ActionUpdate, resp.ChapterDecisions[1].Action, "api.mdx should be marked for update via ripple")
	require.NotEmpty(t, resp.ChapterDecisions[1].SurgicalAnchors)
	assert.Equal(t, "ripple", resp.ChapterDecisions[1].SurgicalAnchors[0].Change)
}

func TestDiffEngineMultiHopTransitiveRipple(t *testing.T) {
	fromArtifact := makeTestArtifact(t,
		map[string][]SymbolEntry{
			"src/db/repo.go":      {{Name: "FindUser", Kind: "function", Exported: true, StartLine: 1, EndLine: 10}},
			"src/service/user.go": {{Name: "GetUser", Kind: "function", Exported: true, StartLine: 1, EndLine: 10}},
			"src/api/handler.go":  {{Name: "HandleGetUser", Kind: "function", Exported: true, StartLine: 1, EndLine: 10}},
		},
		CallEdge{CallerFile: "src/service/user.go", CallerSymbol: "GetUser", CalleeFile: "src/db/repo.go", CalleeSymbol: "FindUser", Line: 5},
		CallEdge{CallerFile: "src/api/handler.go", CallerSymbol: "HandleGetUser", CalleeFile: "src/service/user.go", CalleeSymbol: "GetUser", Line: 5},
	)
	toArtifact := makeTestArtifact(t,
		map[string][]SymbolEntry{
			"src/db/repo.go":      {{Name: "FindUser", Kind: "function", Exported: true, StartLine: 1, EndLine: 25}},
			"src/service/user.go": {{Name: "GetUser", Kind: "function", Exported: true, StartLine: 1, EndLine: 10}},
			"src/api/handler.go":  {{Name: "HandleGetUser", Kind: "function", Exported: true, StartLine: 1, EndLine: 10}},
		},
		CallEdge{CallerFile: "src/service/user.go", CallerSymbol: "GetUser", CalleeFile: "src/db/repo.go", CalleeSymbol: "FindUser", Line: 5},
		CallEdge{CallerFile: "src/api/handler.go", CallerSymbol: "HandleGetUser", CalleeFile: "src/service/user.go", CalleeSymbol: "GetUser", Line: 5},
	)

	req := makeDiffRequest("testowner", "testrepo", "sha1", "sha2",
		[]string{"src/db/repo.go"},
		DiffChapterInput{Path: "chapters/db.mdx", Files: []string{"src/db/repo.go"}},
		DiffChapterInput{Path: "chapters/service.mdx", Files: []string{"src/service/user.go"}},
		DiffChapterInput{Path: "chapters/api.mdx", Files: []string{"src/api/handler.go"}},
	)

	resp := ComputeGraphSemanticDiffWithArtifacts(Config{}, req, fromArtifact, toArtifact)

	assert.Equal(t, FileCategoryRippleAffected, resp.FileDiffs["src/service/user.go"].Category)
	assert.Equal(t, FileCategoryRippleAffected, resp.FileDiffs["src/api/handler.go"].Category,
		"2-hop downstream caller src/api/handler.go must be reached by transitive ripple")

	require.Len(t, resp.ChapterDecisions, 3)
	for i, ch := range []string{"chapters/db.mdx", "chapters/service.mdx", "chapters/api.mdx"} {
		assert.Equal(t, ch, resp.ChapterDecisions[i].Path)
		assert.Equal(t, ActionUpdate, resp.ChapterDecisions[i].Action)
	}
}

func TestInfraClassifierPolyglotEcosystem(t *testing.T) {
	classifier := GetDefaultInfraClassifier()

	tests := []struct {
		name       string
		givePath   string
		giveSample []byte
		wantInfra  bool
	}{

		{name: "Swift Package.resolved", givePath: "Package.resolved", wantInfra: true},
		{name: "Dart pubspec.lock", givePath: "pubspec.lock", wantInfra: true},
		{name: "Haskell cabal.project.freeze", givePath: "cabal.project.freeze", wantInfra: true},
		{name: "Elixir mix.lock", givePath: "mix.lock", wantInfra: true},
		{name: "C# packages.lock.json", givePath: "packages.lock.json", wantInfra: true},
		{name: "Nix flake.lock", givePath: "flake.lock", wantInfra: true},
		{name: "Gradle gradle.lockfile", givePath: "gradle.lockfile", wantInfra: true},
		{name: "Bazel MODULE.bazel.lock", givePath: "MODULE.bazel.lock", wantInfra: true},
		{name: "Terraform .terraform.lock.hcl", givePath: ".terraform.lock.hcl", wantInfra: true},
		{name: "Python uv.lock", givePath: "uv.lock", wantInfra: true},
		{name: "Python poetry.lock", givePath: "poetry.lock", wantInfra: true},
		{name: "Go go.sum", givePath: "go.sum", wantInfra: true},
		{name: "Go go.work.sum", givePath: "go.work.sum", wantInfra: true},
		{name: "Rust Cargo.lock", givePath: "Cargo.lock", wantInfra: true},
		{name: "Node pnpm-lock.yaml", givePath: "pnpm-lock.yaml", wantInfra: true},
		{name: "Node yarn.lock", givePath: "yarn.lock", wantInfra: true},
		{name: "Node package-lock.json", givePath: "package-lock.json", wantInfra: true},
		{name: "Node bun.lockb", givePath: "bun.lockb", wantInfra: true},

		{name: "TypeScript tsconfig.json", givePath: "tsconfig.json", wantInfra: true},
		{name: "TypeScript tsconfig.base.json", givePath: "tsconfig.base.json", wantInfra: true},
		{name: "Jest jest.config.json", givePath: "jest.config.json", wantInfra: true},
		{name: "Prettier .prettierrc", givePath: ".prettierrc", wantInfra: true},
		{name: "ESLint .eslintrc", givePath: ".eslintrc", wantInfra: true},
		{name: "Git .gitignore", givePath: ".gitignore", wantInfra: true},
		{name: "Git .gitattributes", givePath: ".gitattributes", wantInfra: true},
		{name: "Docker .dockerignore", givePath: ".dockerignore", wantInfra: true},
		{name: "NPM .npmignore", givePath: ".npmignore", wantInfra: true},
		{name: "Turbo turbo.json", givePath: "turbo.json", wantInfra: true},

		{name: "Dockerfile", givePath: "Dockerfile", wantInfra: true},
		{name: "docker-compose.yml", givePath: "docker-compose.yml", wantInfra: true},
		{name: "GitHub Actions workflow", givePath: ".github/workflows/ci.yml", wantInfra: true},
		{name: "GitLab CI", givePath: ".gitlab/ci/test.yml", wantInfra: true},

		{name: "PNG image", givePath: "assets/logo.png", wantInfra: true},
		{name: "SVG diagram", givePath: "diagram.svg", wantInfra: true},
		{name: "Wasm binary", givePath: "app.wasm", wantInfra: true},
		{name: "PDF document", givePath: "manual.pdf", wantInfra: true},

		{name: "Protobuf generated UTF-8", givePath: "proto/user.pb.go", giveSample: []byte("// Code generated by protoc. DO NOT EDIT."), wantInfra: true},
		{name: "Protobuf generated UTF-16LE", givePath: "proto/user.pb.go", giveSample: []byte("\x00/\x00/\x00 \x00@\x00g\x00e\x00n\x00e\x00r\x00a\x00t\x00e\x00d\x00"), wantInfra: true},

		{name: "Go source distributed.lock.go", givePath: "src/sync/distributed.lock.go", wantInfra: false},
		{name: "TS source spin.lock.ts", givePath: "src/concurrency/spin.lock.ts", wantInfra: false},
		{name: "Python source thread.lock.py", givePath: "thread.lock.py", wantInfra: false},
		{name: "Go source DockerfileGenerator.go", givePath: "pkg/gen/DockerfileGenerator.go", wantInfra: false},
		{name: "TS source docker-compose-validator.ts", givePath: "docker-compose-validator.ts", wantInfra: false},
		{name: "Go source main.go", givePath: "main.go", wantInfra: false},
		{name: "Rust source lib.rs", givePath: "src/lib.rs", wantInfra: false},
		{name: "Markdown doc intro.md", givePath: "docs/intro.md", wantInfra: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifier.IsNonTeachingInfra(tt.givePath, tt.giveSample)
			assert.Equal(t, tt.wantInfra, got, "File %q classification mismatch", tt.givePath)
		})
	}
}

func BenchmarkComputeGraphDiff(b *testing.B) {
	b.ReportAllocs()
	fromArtifact := &SemanticGraphArtifact{
		Version: 2,
		SymbolsByFile: map[string][]SymbolEntry{
			"src/core/math.go": {
				{Name: "Add", Kind: "function", Exported: true, StartLine: 1, EndLine: 5},
				{Name: "Sub", Kind: "function", Exported: true, StartLine: 7, EndLine: 12},
			},
		},
	}
	toArtifact := &SemanticGraphArtifact{
		Version: 2,
		SymbolsByFile: map[string][]SymbolEntry{
			"src/core/math.go": {
				{Name: "Add", Kind: "function", Exported: true, StartLine: 11, EndLine: 15},
				{Name: "Sub", Kind: "function", Exported: true, StartLine: 17, EndLine: 22},
			},
		},
	}
	req := GraphDiffRequest{
		Owner:         "bench-owner",
		Repo:          "bench-repo",
		FromSha:       "sha1",
		ToSha:         "sha2",
		ModifiedFiles: []string{"src/core/math.go"},
		Chapters: []DiffChapterInput{
			{Path: "chapters/01.mdx", Files: []string{"src/core/math.go"}},
		},
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = ComputeGraphSemanticDiffWithArtifacts(Config{}, req, fromArtifact, toArtifact)
	}
}

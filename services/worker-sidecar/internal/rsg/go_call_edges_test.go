package rsg

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGoImportBindingsAndCrossFileCallEdges(t *testing.T) {
	defs := DefaultLanguageDefinitions()

	t.Run("go.scm preserves empty Bindings for unaliased imports and captures explicit aliases", func(t *testing.T) {
		src := `package main

import (
	"fmt"
	_ "example.com/repo/sideeffect"
	ctxalias "example.com/repo/common/ctx"
)

func main() {
	fmt.Println("ok")
	ctxalias.WithValue()
}
`
		ast := defs.ExtractFileAst(src, "cmd/main.go")
		require.NotNil(t, ast)

		byMod := make(map[string][]string, len(ast.Imports))
		for _, imp := range ast.Imports {
			byMod[imp.Module] = imp.Bindings
		}
		assert.Empty(t, byMod["fmt"], "unaliased stdlib import must keep empty Bindings")
		assert.Empty(t, byMod["example.com/repo/sideeffect"], "blank import must keep empty Bindings")
		assert.Equal(t, []string{"ctxalias"}, byMod["example.com/repo/common/ctx"])
	})

	t.Run("cross-package, multi-file package, same-package, and alias resolution", func(t *testing.T) {
		files := []SourceFileInput{
			{
				Path:    "go.mod",
				Content: "module example.com/xray\n\ngo 1.24\n",
			},
			{
				Path: "app/commander/commander.go",
				Content: `package commander

import (
	"fmt"

	"example.com/xray/common/errors"
	c "example.com/xray/common/ctx"
	"example.com/xray/transport/internet"
)

type Server struct{}

func NewCommander() {
	fmt.Println("boot")
	_ = errors.New("boom")
	c.WithInbound()
	internet.ListenSystem()
	helperInSamePkg()
}
`,
			},
			{
				Path: "app/commander/outbound.go",
				Content: `package commander

import "example.com/xray/common/errors"

type Conn interface{ Close() }

func helperInSamePkg() {}

func HandleConn(conn Conn) {
	conn.Close()
	_ = errors.New("closed")
}
`,
			},
			{
				Path: "common/errors/errors.go",
				Content: `package errors

type Error struct{}

func (e *Error) Base() *Error { return e }

func New(msg string) *Error {
	doLog(msg)
	return &Error{}
}
`,
			},
			{
				Path: "common/errors/log.go",
				Content: `package errors

func doLog(msg string) {}
`,
			},
			{
				Path: "common/ctx/context.go",
				Content: `package ctx

func WithInbound() {}
`,
			},
			{
				Path: "transport/internet/internet.go",
				Content: `package internet

type Dialer interface{}
`,
			},
			{
				Path: "transport/internet/tcp_hub.go",
				Content: `package internet

func ListenSystem() {}
`,
			},
			{
				Path: "transport/internet/extra.go",
				Content: `package internet

type Dummy struct{}

func (d *Dummy) Close() {}
`,
			},
		}

		graph, err := defs.BuildSemanticGraph(files)
		require.NoError(t, err)
		require.NotNil(t, graph)

		hasEdge := func(callerFile, callerSym, calleeFile, calleeSym string) bool {
			for _, e := range graph.CallEdges {
				if e.CallerFile == callerFile && e.CallerSymbol == callerSym &&
					e.CalleeFile == calleeFile && e.CalleeSymbol == calleeSym {
					return true
				}
			}
			return false
		}

		assert.True(t, hasEdge("app/commander/commander.go", "NewCommander", "common/errors/errors.go", "New"))
		assert.True(t, hasEdge("app/commander/outbound.go", "HandleConn", "common/errors/errors.go", "New"))
		assert.True(t, hasEdge("app/commander/commander.go", "NewCommander", "common/ctx/context.go", "WithInbound"), "aliased import across pkg without ctx.go")
		assert.True(t, hasEdge("app/commander/commander.go", "NewCommander", "transport/internet/tcp_hub.go", "ListenSystem"), "non-primary file in imported package")
		assert.True(t, hasEdge("app/commander/commander.go", "NewCommander", "app/commander/outbound.go", "helperInSamePkg"), "same-package cross-file unqualified call")
		assert.True(t, hasEdge("common/errors/errors.go", "New", "common/errors/log.go", "doLog"), "same-package unexported helper call")
		assert.False(t, hasEdge("app/commander/outbound.go", "HandleConn", "transport/internet/extra.go", "Close"), "receiver Close() must not falsely link to unrelated pkg")

		var newSym *SymbolEntry
		for i := range graph.SymbolsByFile["common/errors/errors.go"] {
			s := &graph.SymbolsByFile["common/errors/errors.go"][i]
			if s.Name == "New" {
				newSym = s
				break
			}
		}
		require.NotNil(t, newSym)
		assert.GreaterOrEqual(t, newSym.Importers, 2, "errors.New should aggregate cross-file Go importers")
		assert.NotEmpty(t, graph.GoldenSymbols, "Go repo should populate GoldenSymbols")
	})

	t.Run("inferred module prefix works without go.mod (BuildRepoSemanticGraph path)", func(t *testing.T) {
		files := []SourceFileInput{
			{
				Path: "app/cmd/main.go",
				Content: `package main

import (
	"github.com/acme/proj/common/errors"
	"github.com/acme/proj/common/ctx"
)

func main() {
	errors.New()
	ctx.From()
}
`,
			},
			{
				Path:    "common/errors/errors.go",
				Content: "package errors\nfunc New() {}\n",
			},
			{
				Path:    "common/ctx/context.go",
				Content: "package ctx\nfunc From() {}\n",
			},
		}

		graph, err := defs.BuildSemanticGraph(files)
		require.NoError(t, err)

		var resolved []string
		for _, e := range graph.CallEdges {
			resolved = append(resolved, e.CalleeFile+"#"+e.CalleeSymbol)
		}
		assert.Contains(t, resolved, "common/errors/errors.go#New")
		assert.Contains(t, resolved, "common/ctx/context.go#From")
	})

	t.Run("AST qualifier resolves same-line multi-package calls, multiline selector, raw & dot imports without false edges", func(t *testing.T) {
		files := []SourceFileInput{
			{
				Path:    "go.mod",
				Content: "module example.com/app\n\ngo 1.24\n",
			},
			{
				Path: "cmd/main.go",
				Content: `package main

import (
	a "example.com/app/pkga"
	b ` + "`example.com/app/pkgb`" + `
	c "example.com/app/pkgc"
	. "example.com/app/dotpkg"
)

func wrap(x, y any) { _ = c.Unused }

func Run() {
	wrap(a.New(), b.New())
	a.
		From()
	DotHelper()
}
`,
			},
			{Path: "pkga/a.go", Content: "package pkga\nfunc New() int { return 1 }\nfunc From() {}\n"},
			{Path: "pkgb/b.go", Content: "package pkgb\nfunc New() int { return 2 }\n"},
			{Path: "pkgc/c.go", Content: "package pkgc\nvar Unused = 0\nfunc New() int { return 3 }\n"},
			{Path: "dotpkg/d.go", Content: "package dotpkg\nfunc DotHelper() {}\n"},
		}

		graph, err := defs.BuildSemanticGraph(files)
		require.NoError(t, err)

		var resolved []string
		for _, e := range graph.CallEdges {
			resolved = append(resolved, e.CallerSymbol+"->"+e.CalleeFile+"#"+e.CalleeSymbol)
		}
		assert.Contains(t, resolved, "Run->pkga/a.go#New")
		assert.Contains(t, resolved, "Run->pkgb/b.go#New")
		assert.Contains(t, resolved, "Run->pkga/a.go#From")
		assert.Contains(t, resolved, "Run->dotpkg/d.go#DotHelper")
		assert.NotContains(t, resolved, "Run->pkgc/c.go#New", "unused c.New must not be mislinked from same-line a.New()/b.New()")
	})
}

func TestGoCrossFileCallEdges_CachedXrayCore(t *testing.T) {
	storageDir := os.Getenv("OPENGITS_STORAGE_DIR")
	if storageDir == "" {
		t.Skip("OPENGITS_STORAGE_DIR not set; skipping cached xtls/xray-core verification")
	}
	xrayDir := filepath.Join(storageDir, "repos", "xtls", "xray-core")
	entries, err := os.ReadDir(xrayDir)
	if err != nil || len(entries) == 0 {
		t.Skip("cached xtls/xray-core archive not available")
	}
	repoRoot := filepath.Join(xrayDir, entries[0].Name())

	var files []SourceFileInput
	err = filepath.WalkDir(repoRoot, func(p string, d os.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".go") {
			return walkErr
		}
		rel, relErr := filepath.Rel(repoRoot, p)
		if relErr != nil {
			return relErr
		}
		raw, readErr := os.ReadFile(p)
		if readErr != nil {
			return readErr
		}
		files = append(files, SourceFileInput{
			Path:    filepath.ToSlash(rel),
			Content: string(raw),
		})
		return nil
	})
	require.NoError(t, err)
	require.NotEmpty(t, files)

	defs := DefaultLanguageDefinitions()
	graph, err := defs.BuildSemanticGraph(files)
	require.NoError(t, err)

	crossFile := 0
	for _, e := range graph.CallEdges {
		if e.CallerFile != e.CalleeFile {
			crossFile++
		}
	}
	assert.Greater(t, crossFile, 100, "xtls/xray-core should resolve substantial cross-file Go call edges")
	assert.NotEmpty(t, graph.GoldenSymbols, "xtls/xray-core should produce GoldenSymbols")
}

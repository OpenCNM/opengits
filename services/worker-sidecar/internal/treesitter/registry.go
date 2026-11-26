package treesitter

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed assets/core/ts_core.wasm
var coreWasmFS embed.FS

//go:embed assets/grammars/*.wasm
var grammarsFS embed.FS

//go:embed assets/queries/*.scm
var queriesFS embed.FS

var extToLanguage = map[string]string{
	".go":      "go",
	".py":      "python",
	".pyi":     "python",
	".pyw":     "python",
	".ts":      "tsx",
	".mts":     "tsx",
	".cts":     "tsx",
	".tsx":     "tsx",
	".js":      "javascript",
	".mjs":     "javascript",
	".cjs":     "javascript",
	".jsx":     "javascript",
	".java":    "java",
	".c":       "c",
	".h":       "c",
	".cpp":     "cpp",
	".cc":      "cpp",
	".cxx":     "cpp",
	".hpp":     "cpp",
	".hh":      "cpp",
	".hxx":     "cpp",
	".cs":      "csharp",
	".rs":      "rust",
	".php":     "php",
	".rb":      "ruby",
	".rake":    "ruby",
	".gemspec": "ruby",
	".kt":      "kotlin",
	".kts":     "kotlin",
	".swift":   "swift",
	".dart":    "dart",
	".scala":   "scala",
	".sc":      "scala",
	".sh":      "bash",
	".bash":    "bash",
	".zsh":     "bash",
	".lua":     "lua",
	".ex":      "elixir",
	".exs":     "elixir",
	".zig":     "zig",
	".sql":     "sql",

	".html":   "html",
	".htm":    "html",
	".css":    "css",
	".json":   "json",
	".yml":    "yaml",
	".yaml":   "yaml",
	".vue":    "vue",
	".m":      "objc",
	".sol":    "solidity",
	".ps1":    "powershell",
	".psm1":   "powershell",
	".psd1":   "powershell",
	".ml":     "ocaml",
	".svelte": "svelte",
	".hs":     "haskell",
	".r":      "r",
	".jl":     "julia",
	".clj":    "clojure",
	".cljs":   "clojure",
	".cljc":   "clojure",
	".edn":    "clojure",
	".pl":     "perl",
	".pm":     "perl",
	".pod":    "perl",

	".toml":       "toml",
	".cmake":      "cmake",
	".mk":         "make",
	".mak":        "make",
	".make":       "make",
	".dockerfile": "dockerfile",
	".gleam":      "gleam",
	".mbt":        "moonbit",
	".typ":        "typst",
}

// Checked only after extension lookup misses so mapped file extensions are never shadowed.
var basenameToLanguage = map[string]string{
	"dockerfile":     "dockerfile",
	"containerfile":  "dockerfile",
	"cmakelists.txt": "cmake",
	"makefile":       "make",
	"gnumakefile":    "make",
}

var basenamePrefixToLanguage = [][2]string{
	{"dockerfile.", "dockerfile"},
	{"containerfile.", "dockerfile"},
	{"makefile.", "make"},
}

var LanguageToCFunction = map[string]string{
	"typescript": "tree_sitter_typescript",
	"tsx":        "tree_sitter_tsx",
	"javascript": "tree_sitter_javascript",
	"python":     "tree_sitter_python",
	"go":         "tree_sitter_go",
	"java":       "tree_sitter_java",
	"c":          "tree_sitter_c",
	"cpp":        "tree_sitter_cpp",
	"csharp":     "tree_sitter_c_sharp",
	"rust":       "tree_sitter_rust",
	"php":        "tree_sitter_php",
	"ruby":       "tree_sitter_ruby",
	"kotlin":     "tree_sitter_kotlin",
	"swift":      "tree_sitter_swift",
	"dart":       "tree_sitter_dart",
	"scala":      "tree_sitter_scala",
	"bash":       "tree_sitter_bash",
	"lua":        "tree_sitter_lua",
	"elixir":     "tree_sitter_elixir",
	"zig":        "tree_sitter_zig",
	"sql":        "tree_sitter_sql",
	"html":       "tree_sitter_html",
	"css":        "tree_sitter_css",
	"json":       "tree_sitter_json",
	"yaml":       "tree_sitter_yaml",
	"vue":        "tree_sitter_vue",
	"objc":       "tree_sitter_objc",
	"solidity":   "tree_sitter_solidity",
	"powershell": "tree_sitter_powershell",
	"ocaml":      "tree_sitter_ocaml",
	"svelte":     "tree_sitter_svelte",
	"haskell":    "tree_sitter_haskell",
	"r":          "tree_sitter_r",
	"julia":      "tree_sitter_julia",
	"clojure":    "tree_sitter_clojure",
	"perl":       "tree_sitter_perl",
	"toml":       "tree_sitter_toml",
	"dockerfile": "tree_sitter_dockerfile",
	"cmake":      "tree_sitter_cmake",
	"make":       "tree_sitter_make",
	"gleam":      "tree_sitter_gleam",
	"moonbit":    "tree_sitter_moonbit",
	"typst":      "tree_sitter_typst",
}

func DetectLanguage(filePath string) string {
	ext := strings.ToLower(filepath.Ext(filePath))
	if lang, ok := extToLanguage[ext]; ok {
		return lang
	}
	base := strings.ToLower(filepath.Base(strings.ReplaceAll(filePath, "\\", "/")))
	if lang, ok := basenameToLanguage[base]; ok {
		return lang
	}
	for _, m := range basenamePrefixToLanguage {
		if strings.HasPrefix(base, m[0]) {
			return m[1]
		}
	}
	return ""
}

func loadCoreWasm() ([]byte, error) {
	return coreWasmFS.ReadFile("assets/core/ts_core.wasm")
}

func loadGrammarWasm(lang string, diskSearchPaths ...string) ([]byte, error) {
	wasmName := fmt.Sprintf("tree-sitter-%s.wasm", lang)
	embeddedPath := "assets/grammars/" + wasmName

	data, err := grammarsFS.ReadFile(embeddedPath)
	if err == nil {
		return data, nil
	}

	candidates := append(diskSearchPaths,
		"storage/grammars",
		"/storage/grammars",
		"../../storage/grammars",
		"../storage/grammars",
		filepath.Join(os.Getenv("STORAGE_ROOT"), "grammars"),
	)
	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		path1 := filepath.Join(dir, wasmName)
		if d, err := os.ReadFile(path1); err == nil {
			return d, nil
		}
		path2 := filepath.Join(dir, lang+".wasm")
		if d, err := os.ReadFile(path2); err == nil {
			return d, nil
		}
	}

	return nil, fmt.Errorf("grammar for %q not found (checked embedded and disk paths)", lang)
}

func loadQuery(lang string, diskSearchPaths ...string) ([]byte, error) {
	queryName := lang + ".scm"
	embeddedPath := "assets/queries/" + queryName

	data, err := queriesFS.ReadFile(embeddedPath)
	if err == nil {
		return data, nil
	}

	candidates := append(diskSearchPaths,
		"storage/queries",
		"/storage/queries",
		"storage/grammars",
		"/storage/grammars",
		"../../storage/queries",
		"../../storage/grammars",
		"../storage/queries",
		"../storage/grammars",
		filepath.Join(os.Getenv("STORAGE_ROOT"), "queries"),
		filepath.Join(os.Getenv("STORAGE_ROOT"), "grammars"),
	)
	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		p := filepath.Join(dir, queryName)
		if d, err := os.ReadFile(p); err == nil {
			return d, nil
		}
	}

	return nil, fmt.Errorf("query for %q not found", lang)
}

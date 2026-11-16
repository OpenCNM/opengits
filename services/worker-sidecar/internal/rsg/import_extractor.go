package rsg

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/treesitter"
)

// LanguageDefinition contains metadata and import patterns for a language.
type LanguageDefinition struct {
	Name               string          `json:"name"`
	Extensions         []string        `json:"extensions"`
	ImportPatternsRaw  []mdpat.JsRegex `json:"importPatterns"`
	ExportConvention   string          `json:"exportConvention"`
	ImportBindingStyle string          `json:"importBindingStyle"`
	EntryFilePatterns  []string        `json:"entryFilePatterns"`

	compiledPatterns []*regexp.Regexp
}

// RSGConfig mirrors ENGINE_CONFIG.semanticGraph.
type RSGConfig struct {
	CoreContractInDegreeQuantile float64 `json:"coreContractInDegreeQuantile"`
	BackbonePageRankQuantile     float64 `json:"backbonePageRankQuantile"`
	DampingFactor                float64 `json:"dampingFactor"`
	PagerankIterations           int     `json:"pagerankIterations"`
	ExcludeTestsFromEdges        bool    `json:"excludeTestsFromEdges"`
	GoldenSymbolRatio            float64 `json:"goldenSymbolRatio"`
	GoldenSymbolMinImporters     int     `json:"goldenSymbolMinImporters"`
	MaxParseFiles                int     `json:"maxParseFiles"`
	MaxParseFileBytes            int     `json:"maxParseFileBytes"`
	MaxCallSitesPerFile          int     `json:"maxCallSitesPerFile"`
}

// LanguageDefinitions is loaded from language-definitions.json.
type LanguageDefinitions struct {
	Languages            map[string]*LanguageDefinition `json:"languages"`
	ExtensionToLanguage  map[string]string              `json:"extensionToLanguage"`
	TestPatternsRaw      []mdpat.JsRegex                `json:"testPatterns"`
	EntryPointFiles      []string                       `json:"entryPointFiles"`
	EntryPointPrefixes   []string                       `json:"entryPointPrefixes"`
	ResolvableExtensions []string                       `json:"resolvableExtensions"`
	Config               RSGConfig                      `json:"config"`

	compiledTestPatterns []*regexp.Regexp
	entryPointFilesSet   map[string]bool
	resolvableExtsSet    map[string]bool

	tsEngine     *treesitter.Engine
	tsEngineOnce sync.Once
}

// SetTsEngine sets or overrides the Tree-sitter engine.
func (d *LanguageDefinitions) SetTsEngine(engine *treesitter.Engine) {
	if d == nil {
		return
	}
	d.tsEngine = engine
}

// GetTsEngine lazily initializes and returns the Tree-sitter engine.
func (d *LanguageDefinitions) GetTsEngine() *treesitter.Engine {
	if d == nil {
		return nil
	}
	d.tsEngineOnce.Do(func() {
		if d.tsEngine != nil {
			return
		}
		ctx := context.Background()
		engine, err := treesitter.NewEngine(ctx)
		if err == nil {
			d.tsEngine = engine
		}
	})
	return d.tsEngine
}

// Close releases resources held by LanguageDefinitions.
func (d *LanguageDefinitions) Close() error {
	if d == nil || d.tsEngine == nil {
		return nil
	}
	return d.tsEngine.Close()
}

// LINT-EXEMPT: code-syntax-regex-fallback (BUG-65 residual — tsEngine 缺席时
// 的 Go import 提取兜底，含多行 import 块；主路径为 tree-sitter @import 查询)
var (
	goSingleImportRegex = regexp.MustCompile(`import\s+["']([^"']+)["']`)
	goBlockImportRegex  = regexp.MustCompile(`(?s)import\s*\(\s*([\s\S]*?)\)`)
	goStringInBlock     = regexp.MustCompile(`["']([^"']+)["']`)
)

// LoadLanguageDefinitions loads and compiles language patterns from JSON.
// If filePath is empty, returns native DefaultLanguageDefinitions.
// If filePath is non-empty but unreadable, fails closed and returns an error.
func LoadLanguageDefinitions(filePath string) (*LanguageDefinitions, error) {
	if filePath == "" {
		return DefaultLanguageDefinitions(), nil
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("[rsg] explicit language-definitions path %q specified but unreadable: %w", filePath, err)
	}

	var defs LanguageDefinitions
	if err := json.Unmarshal(data, &defs); err != nil {
		return nil, fmt.Errorf("unmarshal language-definitions.json: %w", err)
	}

	// Compile per-language import patterns
	for _, lang := range defs.Languages {
		lang.compiledPatterns = mdpat.CompileJSRegexes(lang.ImportPatternsRaw, lang.Name)
	}

	// Compile test patterns
	defs.compiledTestPatterns = mdpat.CompileJSRegexes(defs.TestPatternsRaw, "testPatterns")

	// Pre-index entry points
	defs.entryPointFilesSet = make(map[string]bool, len(defs.EntryPointFiles))
	for _, f := range defs.EntryPointFiles {
		defs.entryPointFilesSet[f] = true
	}

	// Pre-index resolvable extensions
	defs.resolvableExtsSet = make(map[string]bool, len(defs.ResolvableExtensions))
	for _, ext := range defs.ResolvableExtensions {
		defs.resolvableExtsSet[ext] = true
	}

	return &defs, nil
}

// ExtractExtension returns the lowercase file extension with leading dot.
func ExtractExtension(filePath string) string {
	if filePath == "" {
		return ""
	}
	normalized := strings.ReplaceAll(filePath, "\\", "/")
	filename := path.Base(normalized)
	lastDot := strings.LastIndex(filename, ".")
	if lastDot <= 0 {
		return ""
	}
	return strings.ToLower(filename[lastDot:])
}

// DetectLanguage resolves the language entry for a file path.
func (d *LanguageDefinitions) DetectLanguage(filePath string) *LanguageDefinition {
	ext := ExtractExtension(filePath)
	if ext == "" {
		return nil
	}
	langName, ok := d.ExtensionToLanguage[ext]
	if !ok {
		return nil
	}
	return d.Languages[langName]
}

// IsTestFile checks if a path matches any test file patterns.
func (d *LanguageDefinitions) IsTestFile(filePath string) bool {
	normalized := strings.ReplaceAll(filePath, "\\", "/")
	for _, re := range d.compiledTestPatterns {
		if re.MatchString(normalized) {
			return true
		}
	}
	return false
}

// IsIsolatedNamedEntry checks if an isolated file is a recognized entry point.
func (d *LanguageDefinitions) IsIsolatedNamedEntry(filePath string) bool {
	normalized := strings.ReplaceAll(filePath, "\\", "/")
	fileName := path.Base(normalized)
	if d.entryPointFilesSet[fileName] {
		return true
	}
	for _, pref := range d.EntryPointPrefixes {
		if strings.HasPrefix(fileName, pref) {
			return true
		}
	}
	return false
}

// ExtractImportPaths extracts import paths from file content for any supported language.
func (d *LanguageDefinitions) ExtractImportPaths(content string, filePath string) []string {
	if content == "" || filePath == "" {
		return nil
	}

	// 1. Tree-sitter AST extraction
	if tsLang := treesitter.DetectLanguage(filePath); tsLang != "" {
		if out := d.extractTsImports(tsLang, content); len(out) > 0 {
			return out
		}
	}

	// 2. Regex fallback
	lang := d.DetectLanguage(filePath)
	if lang == nil {
		return nil
	}

	rawSet := make(map[string]bool)

	for _, re := range lang.compiledPatterns {
		matches := re.FindAllStringSubmatch(content, -1)
		for _, sm := range matches {
			for i := 1; i < len(sm); i++ {
				if sm[i] != "" {
					rawSet[sm[i]] = true
					break
				}
			}
		}
	}

	// Go custom extractor parity
	if lang.Name == "go" {
		for _, sm := range goSingleImportRegex.FindAllStringSubmatch(content, -1) {
			if len(sm) > 1 && sm[1] != "" {
				rawSet[sm[1]] = true
			}
		}
		for _, block := range goBlockImportRegex.FindAllStringSubmatch(content, -1) {
			if len(block) > 1 {
				for _, lineSm := range goStringInBlock.FindAllStringSubmatch(block[1], -1) {
					if len(lineSm) > 1 && lineSm[1] != "" {
						rawSet[lineSm[1]] = true
					}
				}
			}
		}
	}

	results := make([]string, 0, len(rawSet))
	for imp := range rawSet {
		results = append(results, imp)
	}
	return results
}

func (d *LanguageDefinitions) extractTsImports(tsLang, content string) []string {
	ts := d.GetTsEngine()
	if ts == nil {
		return nil
	}
	tsRes, err := ts.ParseAndExtract(context.Background(), tsLang, []byte(content))
	if err != nil || tsRes == nil || len(tsRes.Imports) == 0 {
		return nil
	}
	var out []string
	seen := make(map[string]bool)
	for _, imp := range tsRes.Imports {
		if imp.Module != "" && !seen[imp.Module] {
			seen[imp.Module] = true
			out = append(out, imp.Module)
		}
	}
	return out
}

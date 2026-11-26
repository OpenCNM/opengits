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

type LanguageDefinition struct {
	Name               string          `json:"name"`
	Extensions         []string        `json:"extensions"`
	ImportPatternsRaw  []mdpat.JsRegex `json:"importPatterns"`
	ExportConvention   string          `json:"exportConvention"`
	ImportBindingStyle string          `json:"importBindingStyle"`
	EntryFilePatterns  []string        `json:"entryFilePatterns"`

	compiledPatterns []*regexp.Regexp
}

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

func (d *LanguageDefinitions) SetTsEngine(engine *treesitter.Engine) {
	if d == nil {
		return
	}
	d.tsEngine = engine
}

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

func (d *LanguageDefinitions) Close() error {
	if d == nil || d.tsEngine == nil {
		return nil
	}
	return d.tsEngine.Close()
}

// LINT-EXEMPT: code-syntax-regex-fallback (Go import fallback when tsEngine is unavailable; primary path uses Tree-sitter)
var (
	goSingleImportRegex = regexp.MustCompile(`import\s+["']([^"']+)["']`)
	goBlockImportRegex  = regexp.MustCompile(`(?s)import\s*\(\s*([\s\S]*?)\)`)
	goStringInBlock     = regexp.MustCompile(`["']([^"']+)["']`)
)

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

	for _, lang := range defs.Languages {
		lang.compiledPatterns = mdpat.CompileJSRegexes(lang.ImportPatternsRaw, lang.Name)
	}

	defs.compiledTestPatterns = mdpat.CompileJSRegexes(defs.TestPatternsRaw, "testPatterns")

	defs.entryPointFilesSet = make(map[string]bool, len(defs.EntryPointFiles))
	for _, f := range defs.EntryPointFiles {
		defs.entryPointFilesSet[f] = true
	}

	defs.resolvableExtsSet = make(map[string]bool, len(defs.ResolvableExtensions))
	for _, ext := range defs.ResolvableExtensions {
		defs.resolvableExtsSet[ext] = true
	}

	return &defs, nil
}

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

func (d *LanguageDefinitions) IsTestFile(filePath string) bool {
	normalized := strings.ReplaceAll(filePath, "\\", "/")
	for _, re := range d.compiledTestPatterns {
		if re.MatchString(normalized) {
			return true
		}
	}
	return false
}

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

func (d *LanguageDefinitions) ExtractImportPaths(content string, filePath string) []string {
	if content == "" || filePath == "" {
		return nil
	}

	if tsLang := treesitter.DetectLanguage(filePath); tsLang != "" {
		if out := d.extractTsImports(tsLang, content); len(out) > 0 {
			return out
		}
	}

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

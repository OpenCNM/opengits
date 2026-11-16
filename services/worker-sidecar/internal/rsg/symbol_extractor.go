package rsg

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"

	"github.com/opengits/worker-sidecar/internal/treesitter"
)

// tsEngineWarnOnce 引擎不可用告警只发一次(部署级病理,逐文件刷屏无信息量)。
var tsEngineWarnOnce sync.Once

// refTokenRegex 引用常量提取（大写开头 token），extractFileAstInternal 每文件热路径使用。
var refTokenRegex = regexp.MustCompile(`\b([A-Z][A-Za-z0-9_]{2,})\b`)

func warnTsEngineUnavailable() {
	tsEngineWarnOnce.Do(func() {
		log.Printf("[RsgAst] tree-sitter engine unavailable (init failed); AST symbols skipped for all files — check wasm runtime")
	})
}

// ignoredCallKeywords 非函数调用的关键字(语言关键字不得计入调用点)。
var ignoredCallKeywords = map[string]bool{
	"if": true, "else": true, "for": true, "while": true, "switch": true,
	"catch": true, "return": true, "sizeof": true, "typeof": true, "new": true,
	"super": true, "this": true, "import": true, "export": true, "function": true,
	"func": true, "fn": true, "def": true, "class": true, "struct": true,
	"interface": true, "type": true, "case": true, "select": true, "defer": true,
	"go": true, "panic": true, "throw": true, "try": true, "finally": true,
	"with": true, "yield": true, "from": true, "as": true, "let": true, "const": true,
	"var": true, "match": true, "loop": true, "trait": true, "impl": true,
	"package": true,
}

// ExtractSymbols extracts AST symbols from file content using language definitions.
func ExtractSymbols(defs *LanguageDefinitions, content, filePath string) *FileAstExtraction {
	if defs == nil {
		return &FileAstExtraction{}
	}
	return defs.ExtractFileAst(content, filePath)
}

// ExtractSymbols implements cognitive.SymbolExtractor.
func (d *LanguageDefinitions) ExtractSymbols(content, filePath string) []SymbolEntry {
	if d == nil {
		return nil
	}
	res := d.ExtractFileAst(content, filePath)
	if res == nil {
		return nil
	}
	return res.Symbols
}

// ImportRecord represents an import statement with its target module and extracted named bindings.
type ImportRecord struct {
	Module   string   `json:"module"`
	Bindings []string `json:"bindings"`
}

// CallSite represents an invocation site inside a file (callee simple name + 1-based line).
type CallSite struct {
	Name string `json:"name"`
	Line int    `json:"line"`
}

// FileAstExtraction holds symbols, imports, call sites, and referenced constants extracted from a source file.
type FileAstExtraction struct {
	Symbols             []SymbolEntry  `json:"symbols"`
	Imports             []ImportRecord `json:"imports"`
	CallSites           []CallSite     `json:"callSites"`
	ReferencedConstants []string       `json:"referencedConstants"`
	RawImports          []string       `json:"rawImports,omitempty"`
}

// Clone returns a deep copy of FileAstExtraction to prevent concurrency data races.
func (f *FileAstExtraction) Clone() *FileAstExtraction {
	if f == nil {
		return nil
	}
	c := &FileAstExtraction{
		Symbols:             make([]SymbolEntry, len(f.Symbols)),
		Imports:             make([]ImportRecord, len(f.Imports)),
		CallSites:           make([]CallSite, len(f.CallSites)),
		ReferencedConstants: make([]string, len(f.ReferencedConstants)),
		RawImports:          make([]string, len(f.RawImports)),
	}
	copy(c.Symbols, f.Symbols)
	for i, imp := range f.Imports {
		bindings := make([]string, len(imp.Bindings))
		copy(bindings, imp.Bindings)
		c.Imports[i] = ImportRecord{
			Module:   imp.Module,
			Bindings: bindings,
		}
	}
	copy(c.CallSites, f.CallSites)
	copy(c.ReferencedConstants, f.ReferencedConstants)
	copy(c.RawImports, f.RawImports)
	return c
}

// ExtractFileAstWithSha extracts declaration symbols, import records, call sites, and constants from source code,
// utilizing the thread-safe in-memory AstCache for O(1) instant retrieval when blobSha matches.
func (d *LanguageDefinitions) ExtractFileAstWithSha(content string, filePath string, blobSha string) *FileAstExtraction {
	if content == "" || filePath == "" {
		return &FileAstExtraction{
			Symbols:             []SymbolEntry{},
			Imports:             []ImportRecord{},
			CallSites:           []CallSite{},
			ReferencedConstants: []string{},
			RawImports:          []string{},
		}
	}

	lang := d.DetectLanguage(filePath)
	if lang == nil {
		return &FileAstExtraction{
			Symbols:             []SymbolEntry{},
			Imports:             []ImportRecord{},
			CallSites:           []CallSite{},
			ReferencedConstants: []string{},
			RawImports:          []string{},
		}
	}

	langName := lang.Name
	cache := GetDefaultAstCache()

	if blobSha == "" && len(content) > 0 {
		blobSha = ComputeContentSha(content)
	}

	cacheKey := MakeAstCacheKey(blobSha, langName)
	if cache != nil && cacheKey != "" {
		if cached, ok := cache.Get(cacheKey); ok {
			return cached
		}
	}

	res := d.extractFileAstInternal(content, filePath, lang, langName)

	if cache != nil && cacheKey != "" && res != nil {
		cache.Put(cacheKey, res)
	}

	return res
}

// ExtractFileAst extracts declaration symbols, import records, call sites, and constants from source code.
// Fully backward-compatible wrapper around ExtractFileAstWithSha.
func (d *LanguageDefinitions) ExtractFileAst(content string, filePath string) *FileAstExtraction {
	return d.ExtractFileAstWithSha(content, filePath, "")
}

func (d *LanguageDefinitions) extractFileAstInternal(content string, filePath string, lang *LanguageDefinition, langName string) *FileAstExtraction {
	exportConvention := "all_top_level"
	importBindingStyle := "none"
	if lang.ExportConvention != "" {
		exportConvention = lang.ExportConvention
	}
	if lang.ImportBindingStyle != "" {
		importBindingStyle = lang.ImportBindingStyle
	}

	lines := strings.Split(content, "\n")

	isPython := langName == "python" || langName == "mojo"
	isRuby := langName == "ruby"

	var symbols []SymbolEntry
	var callSites []CallSite
	var tsRes *treesitter.ExtractionResult

	// BUG-65 已关闭(36 门语法资产内嵌,commit 0383ecf8):正则符号/导入/
	// 调用点兜底整块退役。引擎不可用或扩展名未映射 → 零符号 + 显式告警
	// (fail-visible),绝不以关键词匹配伪装 AST 符号——幻影符号会污染
	// 下游锚点与调用边(伪弹性,静默掩盖部署级病理)。
	tsLang := treesitter.DetectLanguage(filePath)
	if tsLang == "" {
		log.Printf("[RsgAst] no tree-sitter grammar mapped for %s; AST symbols skipped", filePath)
	}
	if tsLang != "" {
		if syms, cs, res, ok := d.extractFromTreeSitter(filePath, tsLang, content, lines, exportConvention, isPython, isRuby); ok {
			symbols = syms
			callSites = cs
			tsRes = res
		}
	}

	// Named Import Bindings:AST 优先;AST import 捕获未覆盖的语言
	// (见 import_fallback.go)由配置模式兜底供血——golden 对拍锁定。
	var imports []ImportRecord
	if tsRes != nil && len(tsRes.Imports) > 0 {
		for _, imp := range tsRes.Imports {
			imports = append(imports, ImportRecord{
				Module:   imp.Module,
				Bindings: imp.Bindings,
			})
		}
	} else {
		imports = d.extractFallbackImports(content, filePath, lines, importBindingStyle)
	}

	// 4. Referenced Constants (Capitalized tokens)
	refSet := make(map[string]bool)
	for _, line := range lines {
		matches := refTokenRegex.FindAllStringSubmatch(line, -1)
		for _, sm := range matches {
			if len(sm) > 1 {
				refSet[sm[1]] = true
			}
		}
	}
	refConstants := make([]string, 0, len(refSet))
	for c := range refSet {
		refConstants = append(refConstants, c)
	}
	sort.Strings(refConstants)

	rawImportsSet := make(map[string]bool)
	for _, imp := range imports {
		if imp.Module != "" {
			rawImportsSet[imp.Module] = true
		}
	}
	rawImports := make([]string, 0, len(rawImportsSet))
	for m := range rawImportsSet {
		rawImports = append(rawImports, m)
	}
	sort.Strings(rawImports)

	return &FileAstExtraction{
		Symbols:             symbols,
		Imports:             imports,
		CallSites:           callSites,
		ReferencedConstants: refConstants,
		RawImports:          rawImports,
	}
}

func (d *LanguageDefinitions) extractFromTreeSitter(
	filePath string,
	tsLang string,
	content string,
	lines []string,
	exportConvention string,
	isPython, isRuby bool,
) ([]SymbolEntry, []CallSite, *treesitter.ExtractionResult, bool) {
	ts := d.GetTsEngine()
	if ts == nil {
		warnTsEngineUnavailable()
		return nil, nil, nil, false
	}
	tsRes, err := ts.ParseAndExtract(context.Background(), tsLang, []byte(content))
	if err != nil || tsRes == nil {
		log.Printf("[RsgAst] tree-sitter extract failed for %s (%s): %v; AST symbols skipped", filePath, tsLang, err)
		return nil, nil, nil, false
	}

	var symbols []SymbolEntry
	for _, s := range tsRes.Symbols {
		var line string
		if s.StartLine >= 1 && s.StartLine <= len(lines) {
			line = lines[s.StartLine-1]
		}
		trimmed := strings.TrimSpace(line)

		var isExported bool
		switch exportConvention {
		case "wrapper_declaration":
			isExported = strings.HasPrefix(trimmed, "export ") || strings.HasPrefix(trimmed, "export\t") || strings.Contains(trimmed, "export default")
		case "capitalized_name":
			r := []rune(s.Name)
			isExported = len(r) > 0 && unicode.IsUpper(r[0])
		case "visibility_modifier":
			isExported = strings.Contains(trimmed, "pub ") || strings.Contains(trimmed, "pub(") || strings.Contains(trimmed, "public ")
		case "all_top_level":
			fallthrough
		default:
			if isPython || isRuby {
				indent := len(line) - len(strings.TrimLeft(line, " \t"))
				isExported = indent == 0 && !strings.HasPrefix(s.Name, "_")
			} else {
				isExported = true
			}
		}

		symbols = append(symbols, SymbolEntry{
			Name:      s.Name,
			Kind:      s.Kind,
			StartLine: s.StartLine,
			EndLine:   s.EndLine,
			Exported:  isExported,
		})
	}

	declaredAtLine := make(map[string]map[int]bool)
	for _, sym := range symbols {
		if declaredAtLine[sym.Name] == nil {
			declaredAtLine[sym.Name] = make(map[int]bool)
		}
		declaredAtLine[sym.Name][sym.StartLine] = true
	}

	maxCallSites := d.Config.MaxCallSitesPerFile
	if maxCallSites <= 0 {
		maxCallSites = 500
	}
	var callSites []CallSite
	seenCallAtLine := make(map[string]bool)
	for _, cs := range tsRes.CallSites {
		if len(callSites) >= maxCallSites {
			break
		}
		if ignoredCallKeywords[cs.Name] {
			continue
		}
		if declaredAtLine[cs.Name] != nil && declaredAtLine[cs.Name][cs.Line] {
			continue
		}
		callKey := fmt.Sprintf("%s:%d", cs.Name, cs.Line)
		if seenCallAtLine[callKey] {
			continue
		}
		seenCallAtLine[callKey] = true
		callSites = append(callSites, CallSite{
			Name: cs.Name,
			Line: cs.Line,
		})
	}

	return symbols, callSites, tsRes, true
}

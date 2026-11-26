package cognitive

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type Patterns interface {
	IsBinaryOrArchiveFile(path string) bool
	IsDocFile(path string) bool
	IsCodeFile(path string) bool
	IsNonContentDir(path string) bool
	IsNonContentFile(path string) bool
	IsTestFile(path string) bool
	IsReadme(path string) bool
	IsMetaOrProtocolDoc(path string) bool
	IsCoreDocEntryKeyword(path string) bool
	IsTopLevelDocDir(dir string) bool
	IsEntryPointFile(filename string) bool
	IsBuildSystemFile(filename string) bool
	MarkdownExtensions() []string
	IsConfigFile(filename string) bool
	IsDataModelFile(filename string) bool
	IsTypeHubFile(filename string) bool
	IsUtilityFile(filename string) bool
}

var extTailRe = mdpat.ExtTailRe

type ingestPatterns struct {
	DocExtensions              map[string]bool
	CodeExtensions             map[string]bool
	nonContentDir              []*regexp.Regexp
	nonContentFile             []*regexp.Regexp
	EntryPointFiles            map[string]bool
	testPatterns               []*regexp.Regexp
	metaOrProtocolDocPattern   *regexp.Regexp
	coreDocEntryKeywordPattern *regexp.Regexp
	TopLevelDocDirs            map[string]bool
	TopLevelDocDirsList        []string
	BuildSystemFiles           map[string]bool
	configPatterns             []*regexp.Regexp
	dataModelPatterns          []*regexp.Regexp
	typeHubPatterns            []*regexp.Regexp
	utilityPatterns            []*regexp.Regexp
	BinaryOrArchiveExtensions  map[string]bool
	markdownExtensions         []string
	ReadmePattern              *regexp.Regexp
}

func (p *ingestPatterns) IsBinaryOrArchiveFile(fp string) bool {
	if fp == "" {
		return false
	}
	ext := strings.ToLower(mdpat.ExtractExtension(fp))
	return p.BinaryOrArchiveExtensions[ext]
}

func (p *ingestPatterns) IsDocFile(fp string) bool {
	if fp == "" {
		return false
	}
	ext := strings.ToLower(mdpat.ExtractExtension(fp))
	return p.DocExtensions[ext]
}

func (p *ingestPatterns) IsCodeFile(fp string) bool {
	if fp == "" {
		return false
	}
	ext := strings.ToLower(mdpat.ExtractExtension(fp))
	return p.CodeExtensions[ext]
}

func (p *ingestPatterns) IsNonContentDir(fp string) bool {
	if fp == "" {
		return false
	}
	trimmed := strings.Trim(fp, "/")
	if trimmed == "" {
		return false
	}
	for _, seg := range strings.Split(trimmed, "/") {
		if seg == "" {
			continue
		}
		for _, re := range p.nonContentDir {
			if re.MatchString(seg) {
				return true
			}
		}
	}
	return false
}

func (p *ingestPatterns) IsNonContentFile(fp string) bool {
	if fp == "" {
		return false
	}
	parts := strings.Split(fp, "/")
	fileName := parts[len(parts)-1]
	if i := strings.LastIndex(fileName, "."); i >= 0 && i > 0 {
		if re := extTailRe.FindString(fileName); re != "" {
			fileName = strings.TrimSuffix(fileName, re)
		}
	}
	if fileName == "" {
		return false
	}
	for _, re := range p.nonContentFile {
		if re.MatchString(fileName) {
			return true
		}
	}
	return false
}

func (p *ingestPatterns) IsTestFile(path string) bool {
	if path == "" {
		return false
	}
	for _, re := range p.testPatterns {
		if re.MatchString(path) {
			return true
		}
	}
	return false
}

func (p *ingestPatterns) IsReadme(path string) bool {
	if path == "" {
		return false
	}
	parts := strings.Split(path, "/")
	filename := parts[len(parts)-1]
	if p.ReadmePattern != nil {
		return p.ReadmePattern.MatchString(filename)
	}
	lower := strings.ToLower(filename)
	return lower == "readme" || strings.HasPrefix(lower, "readme.")
}

func (p *ingestPatterns) IsMetaOrProtocolDoc(fileName string) bool {
	if fileName == "" {
		return false
	}
	if p.metaOrProtocolDocPattern != nil && p.metaOrProtocolDocPattern.MatchString(fileName) {
		return true
	}
	return false
}

func (p *ingestPatterns) IsCoreDocEntryKeyword(fileName string) bool {
	if fileName == "" {
		return false
	}
	if p.coreDocEntryKeywordPattern != nil && p.coreDocEntryKeywordPattern.MatchString(fileName) {
		return true
	}
	return false
}

func (p *ingestPatterns) IsTopLevelDocDir(firstSegmentOrPath string) bool {
	if firstSegmentOrPath == "" {
		return false
	}
	lower := strings.ToLower(firstSegmentOrPath)
	parts := strings.Split(lower, "/")
	first := parts[0]
	if p.TopLevelDocDirs[first] {
		return true
	}
	for _, dir := range p.TopLevelDocDirsList {
		if strings.HasPrefix(lower, strings.ToLower(dir)) {
			return true
		}
	}
	return false
}

func (p *ingestPatterns) IsEntryPointFile(filename string) bool {
	lower := strings.ToLower(filename)
	return p.EntryPointFiles[lower]
}

func (p *ingestPatterns) IsBuildSystemFile(filename string) bool {
	lower := strings.ToLower(filename)
	return p.BuildSystemFiles[lower]
}

func (p *ingestPatterns) MarkdownExtensions() []string {
	if len(p.markdownExtensions) == 0 {
		return []string{".md", ".markdown", ".mdx"}
	}
	return p.markdownExtensions
}

func (p *ingestPatterns) IsConfigFile(filename string) bool {
	for _, re := range p.configPatterns {
		if re.MatchString(filename) {
			return true
		}
	}
	return false
}

func (p *ingestPatterns) IsDataModelFile(filename string) bool {
	for _, re := range p.dataModelPatterns {
		if re.MatchString(filename) {
			return true
		}
	}
	return false
}

func (p *ingestPatterns) IsTypeHubFile(filename string) bool {
	for _, re := range p.typeHubPatterns {
		if re.MatchString(filename) {
			return true
		}
	}
	return false
}

func (p *ingestPatterns) IsUtilityFile(filename string) bool {
	for _, re := range p.utilityPatterns {
		if re.MatchString(filename) {
			return true
		}
	}
	return false
}

var (
	defaultPatternsOnce sync.Once
	defaultPatternsInst *ingestPatterns
)

func DefaultPatterns() *ingestPatterns {
	defaultPatternsOnce.Do(func() {
		defaultPatternsInst = buildDefaultPatterns()
	})
	return defaultPatternsInst
}

// Empty path uses native defaults; non-empty unreadable path fails closed.
func LoadIngestPatterns(patternsPath string) (*ingestPatterns, error) {
	if patternsPath == "" {
		return DefaultPatterns(), nil
	}

	raw, err := os.ReadFile(patternsPath)
	if err != nil {
		return nil, fmt.Errorf("LoadIngestPatterns: read %s: %w", patternsPath, err)
	}

	var doc struct {
		DocExtensions          []string        `json:"docExtensions"`
		CodeExtensions         []string        `json:"codeExtensions"`
		NonContentDirPatterns  []mdpat.JsRegex `json:"nonContentDirPatterns"`
		NonContentFilePatterns []mdpat.JsRegex `json:"nonContentFilePatterns"`
		Sniffer                struct {
			MarkdownExtensions []string `json:"markdownExtensions"`
		} `json:"sniffer"`
		EntryPointFiles            []string        `json:"entryPointFiles"`
		ReadmePattern              mdpat.JsRegex   `json:"readmePattern"`
		TestPatterns               []mdpat.JsRegex `json:"testPatterns"`
		MetaOrProtocolDocPattern   mdpat.JsRegex   `json:"metaOrProtocolDocPattern"`
		CoreDocEntryKeywordPattern mdpat.JsRegex   `json:"coreDocEntryKeywordPattern"`
		TopLevelDocDirs            []string        `json:"topLevelDocDirs"`
		BuildSystemFiles           []string        `json:"buildSystemFiles"`
		ConfigPatterns             []mdpat.JsRegex `json:"configPatterns"`
		DataModelPatterns          []mdpat.JsRegex `json:"dataModelPatterns"`
		TypeHubPatterns            []mdpat.JsRegex `json:"typeHubPatterns"`
		UtilityPatterns            []mdpat.JsRegex `json:"utilityPatterns"`
		BinaryOrArchiveExtensions  []string        `json:"binaryOrArchiveExtensions"`
	}

	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("LoadIngestPatterns: unmarshal %s: %w", patternsPath, err)
	}

	p := &ingestPatterns{
		DocExtensions:             make(map[string]bool),
		CodeExtensions:            make(map[string]bool),
		nonContentDir:             mdpat.CompileJSRegexes(doc.NonContentDirPatterns, "cognitive"),
		nonContentFile:            mdpat.CompileJSRegexes(doc.NonContentFilePatterns, "cognitive"),
		EntryPointFiles:           make(map[string]bool),
		testPatterns:              mdpat.CompileJSRegexes(doc.TestPatterns, "cognitive"),
		TopLevelDocDirs:           make(map[string]bool),
		TopLevelDocDirsList:       doc.TopLevelDocDirs,
		BuildSystemFiles:          make(map[string]bool),
		configPatterns:            mdpat.CompileJSRegexes(doc.ConfigPatterns, "cognitive"),
		dataModelPatterns:         mdpat.CompileJSRegexes(doc.DataModelPatterns, "cognitive"),
		typeHubPatterns:           mdpat.CompileJSRegexes(doc.TypeHubPatterns, "cognitive"),
		utilityPatterns:           mdpat.CompileJSRegexes(doc.UtilityPatterns, "cognitive"),
		BinaryOrArchiveExtensions: make(map[string]bool),
		markdownExtensions:        doc.Sniffer.MarkdownExtensions,
	}

	for _, e := range doc.DocExtensions {
		p.DocExtensions[strings.ToLower(e)] = true
	}
	for _, e := range doc.CodeExtensions {
		p.CodeExtensions[strings.ToLower(e)] = true
	}
	for _, f := range doc.EntryPointFiles {
		p.EntryPointFiles[strings.ToLower(f)] = true
	}
	if rp := mdpat.CompileJSRegexes([]mdpat.JsRegex{doc.ReadmePattern}, "cognitive"); len(rp) > 0 {
		p.ReadmePattern = rp[0]
	}
	if mp := mdpat.CompileJSRegexes([]mdpat.JsRegex{doc.MetaOrProtocolDocPattern}, "cognitive"); len(mp) > 0 {
		p.metaOrProtocolDocPattern = mp[0]
	}
	if cp := mdpat.CompileJSRegexes([]mdpat.JsRegex{doc.CoreDocEntryKeywordPattern}, "cognitive"); len(cp) > 0 {
		p.coreDocEntryKeywordPattern = cp[0]
	}
	for _, d := range doc.TopLevelDocDirs {
		p.TopLevelDocDirs[strings.ToLower(d)] = true
	}
	for _, f := range doc.BuildSystemFiles {
		p.BuildSystemFiles[strings.ToLower(f)] = true
	}
	for _, e := range doc.BinaryOrArchiveExtensions {
		p.BinaryOrArchiveExtensions[strings.ToLower(e)] = true
	}

	return p, nil
}

func buildDefaultPatterns() *ingestPatterns {
	return &ingestPatterns{
		DocExtensions: map[string]bool{
			".adoc":     true,
			".markdown": true,
			".md":       true,
			".mdx":      true,
			".rst":      true,
			".tex":      true,
			".txt":      true,
		},
		CodeExtensions: map[string]bool{
			".bend":   true,
			".c":      true,
			".carbon": true,
			".cc":     true,
			".cjs":    true,
			".clj":    true,
			".cljc":   true,
			".cljs":   true,
			".cpp":    true,
			".cs":     true,
			".cxx":    true,
			".dart":   true,
			".erl":    true,
			".ex":     true,
			".exs":    true,
			".fs":     true,
			".fsi":    true,
			".fsx":    true,
			".gleam":  true,
			".go":     true,
			".groovy": true,
			".h":      true,
			".hpp":    true,
			".hrl":    true,
			".hs":     true,
			".hxx":    true,
			".java":   true,
			".jl":     true,
			".js":     true,
			".jsx":    true,
			".kt":     true,
			".kts":    true,
			".lhs":    true,
			".lua":    true,
			".mbt":    true,
			".mjs":    true,
			".ml":     true,
			".mli":    true,
			".mojo":   true,
			".nim":    true,
			".odin":   true,
			".php":    true,
			".py":     true,
			".pyi":    true,
			".pyw":    true,
			".r":      true,
			".rb":     true,
			".rs":     true,
			".scala":  true,
			".sol":    true,
			".swift":  true,
			".ts":     true,
			".tsx":    true,
			".typ":    true,
			".v":      true,
			".zig":    true,
			".🔥":      true,
		},
		nonContentDir: []*regexp.Regexp{
			regexp.MustCompile(`(?i)^(?:assets?|media|images?|img|icons?|public|static|screenshots?|figures?|fixtures)$`),
			regexp.MustCompile(`(?i)^(?:dist|build|out|target|release|debug|node_modules|vendor|bower_components|jspm_packages)$`),
			regexp.MustCompile(`^(?:\.github|\.vscode|\.idea|\.gitlab|\.circleci|\.cargo)$`),
			regexp.MustCompile(`^(?:\.git|\.hg|\.svn|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache)$`),
			regexp.MustCompile(`^(?:\.agents|\.claude|\.cursor|\.codex|\.windsurf|\.forge|\.kiro|\.continue|\.aider|\.cline|\.clinerules|\.greptile)$`),
			regexp.MustCompile(`(?i)^(?:evals?|benchmarks?)$`),
			regexp.MustCompile(`(?i)^(?:logs?|tmp|temp|cache)$`),
			regexp.MustCompile(`(?i)^(?:changelogs?|release[-_]notes?|releases?|changes?|\.changeset|(?:packages|internal|private)[-_](?:private|internal|packages|modules))$`),
		},
		nonContentFile: []*regexp.Regexp{
			regexp.MustCompile(`(?i)^(?:license|licence|code_of_conduct|security|contributing|pull_request_template|issue_template|changelog|changes)$`),
		},
		EntryPointFiles: map[string]bool{
			"app.js":    true,
			"app.py":    true,
			"app.ts":    true,
			"app.tsx":   true,
			"index.js":  true,
			"index.jsx": true,
			"index.ts":  true,
			"index.tsx": true,
			"lib.go":    true,
			"lib.rs":    true,
			"main.c":    true,
			"main.cpp":  true,
			"main.go":   true,
			"main.java": true,
			"main.py":   true,
			"main.rs":   true,
			"main.ts":   true,
			"main.tsx":  true,
			"mod.rs":    true,
			"page.jsx":  true,
			"page.tsx":  true,
			"route.js":  true,
			"route.ts":  true,
			"server.js": true,
			"server.ts": true,
		},
		testPatterns: []*regexp.Regexp{
			regexp.MustCompile(`\.test\.`),
			regexp.MustCompile(`\.spec\.`),
			regexp.MustCompile(`_test\.`),
			regexp.MustCompile(`_spec\.`),
			regexp.MustCompile(`\/test\/`),
			regexp.MustCompile(`\/tests\/`),
			regexp.MustCompile(`\/__tests__\/`),
			regexp.MustCompile(`^test\/`),
			regexp.MustCompile(`^tests\/`),
			regexp.MustCompile(`^e2e\/`),
			regexp.MustCompile(`\/e2e\/`),
		},
		metaOrProtocolDocPattern:   regexp.MustCompile(`(?i)^(?:readme|changelog|history|license|licence|contributing|code_of_conduct|security|pull_request_template|issue_template)\.`),
		coreDocEntryKeywordPattern: regexp.MustCompile(`(?i)^(?:intro|introduction|overview|quickstart|getting-started|start|guide|tutorial|index)\b`),
		TopLevelDocDirs: map[string]bool{
			"book":      true,
			"content":   true,
			"docs":      true,
			"en":        true,
			"i18n":      true,
			"locales":   true,
			"packages":  true,
			"tutorials": true,
			"zh":        true,
		},
		TopLevelDocDirsList: []string{
			"book",
			"content",
			"docs",
			"en",
			"i18n",
			"locales",
			"packages",
			"tutorials",
			"zh",
		},
		BuildSystemFiles: map[string]bool{
			"*.cabal":           true,
			"*.csproj":          true,
			"*.fsproj":          true,
			"*.nimble":          true,
			"*.rockspec":        true,
			"*.sln":             true,
			"build.gradle":      true,
			"build.gradle.kts":  true,
			"build.sbt":         true,
			"build.zig":         true,
			"cabal.project":     true,
			"cargo.lock":        true,
			"cargo.toml":        true,
			"cmakelists.txt":    true,
			"composer.json":     true,
			"composer.lock":     true,
			"deps.edn":          true,
			"description":       true,
			"dune":              true,
			"dune-project":      true,
			"foundry.toml":      true,
			"gemfile":           true,
			"gemfile.lock":      true,
			"gleam.toml":        true,
			"go.mod":            true,
			"go.sum":            true,
			"hardhat.config.js": true,
			"makefile":          true,
			"manifest.toml":     true,
			"mix.exs":           true,
			"mojoproject.toml":  true,
			"moon.mod.json":     true,
			"package.json":      true,
			"package.swift":     true,
			"package.yaml":      true,
			"pipfile":           true,
			"pom.xml":           true,
			"project.clj":       true,
			"project.toml":      true,
			"pubspec.yaml":      true,
			"pyproject.toml":    true,
			"rebar.config":      true,
			"requirements.txt":  true,
			"setup.py":          true,
			"truffle-config.js": true,
			"tsconfig.json":     true,
			"typst.toml":        true,
			"v.mod":             true,
		},
		configPatterns: []*regexp.Regexp{
			regexp.MustCompile(`configs?`),
			regexp.MustCompile(`settings?`),
			regexp.MustCompile(`constants?`),
			regexp.MustCompile(`\.env`),
			regexp.MustCompile(`options?`),
		},
		dataModelPatterns: []*regexp.Regexp{
			regexp.MustCompile(`schema`),
			regexp.MustCompile(`models?`),
			regexp.MustCompile(`entity|entities`),
			regexp.MustCompile(`prisma\/`),
			regexp.MustCompile(`dto`),
		},
		typeHubPatterns: []*regexp.Regexp{
			regexp.MustCompile(`\.d\.ts$`),
			regexp.MustCompile(`types?\.(ts|js|go|rs|py)$`),
			regexp.MustCompile(`\/types\/`),
			regexp.MustCompile(`\/interfaces\/`),
		},
		utilityPatterns: []*regexp.Regexp{
			regexp.MustCompile(`utils?`),
			regexp.MustCompile(`helpers?`),
			regexp.MustCompile(`common`),
			regexp.MustCompile(`formatters?`),
			regexp.MustCompile(`shared`),
		},
		BinaryOrArchiveExtensions: map[string]bool{
			".7z":     true,
			".a":      true,
			".ai":     true,
			".avi":    true,
			".bin":    true,
			".bz2":    true,
			".class":  true,
			".dll":    true,
			".dmg":    true,
			".dylib":  true,
			".eot":    true,
			".exe":    true,
			".flac":   true,
			".gz":     true,
			".iso":    true,
			".jar":    true,
			".mov":    true,
			".mp3":    true,
			".mp4":    true,
			".o":      true,
			".ogg":    true,
			".otf":    true,
			".psd":    true,
			".pyc":    true,
			".rar":    true,
			".sketch": true,
			".so":     true,
			".tar":    true,
			".tgz":    true,
			".ttf":    true,
			".wasm":   true,
			".wav":    true,
			".webm":   true,
			".woff":   true,
			".woff2":  true,
			".xz":     true,
			".zip":    true,
		},
		markdownExtensions: []string{".md", ".markdown", ".mdx"},
		ReadmePattern:      regexp.MustCompile(`(?i)readme`),
	}
}

package cluster

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
	IsNonContentDir(path string) bool
	IsNonContentFile(path string) bool
	IsCodeFile(path string) bool
	IsDocFile(path string) bool
	IsEntryPoint(path string) bool
}

type IngestPatterns struct {
	DocExtensions      map[string]bool
	CodeExtensions     map[string]bool
	nonContentDir      []*regexp.Regexp
	nonContentFile     []*regexp.Regexp
	EntryPointFiles    map[string]bool
	EntryPointPrefixes []string
}

var extTailRe = mdpat.ExtTailRe

func (p *IngestPatterns) IsDocFile(fp string) bool {
	if p == nil || fp == "" {
		return false
	}
	return p.DocExtensions[strings.ToLower(mdpat.ExtractExtensionBase(fp))]
}

func (p *IngestPatterns) IsCodeFile(fp string) bool {
	if p == nil || fp == "" {
		return false
	}
	return p.CodeExtensions[strings.ToLower(mdpat.ExtractExtensionBase(fp))]
}

func (p *IngestPatterns) IsNonContentDir(fp string) bool {
	if p == nil || fp == "" {
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

func (p *IngestPatterns) IsNonContentFile(fp string) bool {
	if p == nil || fp == "" {
		return false
	}
	parts := strings.Split(fp, "/")
	fileName := parts[len(parts)-1]
	if i := strings.LastIndex(fileName, "."); i >= 0 && i > 0 {
		if re := extTailRe.FindString(fileName); re != "" {
			fileName = strings.TrimSuffix(fileName, re)
		}
	}
	for _, re := range p.nonContentFile {
		if re.MatchString(fileName) {
			return true
		}
	}
	return false
}

func (p *IngestPatterns) IsEntryPoint(path string) bool {
	if p == nil || path == "" {
		return false
	}
	base := path
	if idx := strings.LastIndex(path, "/"); idx >= 0 {
		base = path[idx+1:]
	}
	if p.EntryPointFiles[base] {
		return true
	}
	for _, pref := range p.EntryPointPrefixes {
		if strings.HasPrefix(base, pref) {
			return true
		}
	}
	return false
}

var (
	defaultPatternsOnce sync.Once
	defaultPatterns     *IngestPatterns
)

func DefaultPatterns() *IngestPatterns {
	defaultPatternsOnce.Do(func() {
		defaultPatterns = buildDefaultPatterns()
	})
	return defaultPatterns
}

func buildDefaultPatterns() *IngestPatterns {
	docExts := map[string]bool{
		"md": true, "mdx": true, "markdown": true, "txt": true, "rst": true, "adoc": true, "tex": true,
	}
	codeExts := map[string]bool{
		"bend": true, "c": true, "carbon": true, "cc": true, "cjs": true,
		"clj": true, "cljc": true, "cljs": true, "cpp": true, "cs": true,
		"cxx": true, "dart": true, "erl": true, "ex": true, "exs": true,
		"fs": true, "fsi": true, "fsx": true, "gleam": true, "go": true,
		"groovy": true, "h": true, "hpp": true, "hrl": true, "hs": true,
		"hxx": true, "java": true, "jl": true, "js": true, "jsx": true,
		"kt": true, "kts": true, "lhs": true, "lua": true, "mbt": true,
		"mjs": true, "ml": true, "mli": true, "mojo": true, "nim": true,
		"odin": true, "php": true, "py": true, "pyi": true, "pyw": true,
		"r": true, "rb": true, "rs": true, "scala": true, "sol": true,
		"swift": true, "ts": true, "tsx": true, "typ": true, "v": true,
		"zig": true, "🔥": true,
	}
	nonContentDir := []*regexp.Regexp{
		regexp.MustCompile(`(?i)^(?:assets?|media|images?|img|icons?|public|static|screenshots?|figures?|fixtures)$`),
		regexp.MustCompile(`(?i)^(?:dist|build|out|target|release|debug|node_modules|vendor|bower_components|jspm_packages)$`),
		regexp.MustCompile(`^(?:\.github|\.vscode|\.idea|\.gitlab|\.circleci|\.cargo)$`),
		regexp.MustCompile(`^(?:\.git|\.hg|\.svn|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache)$`),
		regexp.MustCompile(`^(?:\.agents|\.claude|\.cursor|\.codex|\.windsurf|\.forge|\.kiro|\.continue|\.aider|\.cline|\.clinerules|\.greptile)$`),
		regexp.MustCompile(`(?i)^(?:evals?|benchmarks?)$`),
		regexp.MustCompile(`(?i)^(?:logs?|tmp|temp|cache)$`),
		regexp.MustCompile(`(?i)^(?:changelogs?|release[-_]notes?|releases?|changes?|\.changeset|(?:packages|internal|private)[-_](?:private|internal|packages|modules))$`),
	}
	nonContentFile := []*regexp.Regexp{
		regexp.MustCompile(`(?i)^(?:license|licence|code_of_conduct|security|contributing|pull_request_template|issue_template|changelog|changes)$`),
	}
	entryPointFiles := map[string]bool{
		"app.js": true, "app.py": true, "app.ts": true, "app.tsx": true,
		"index.js": true, "index.jsx": true, "index.ts": true, "index.tsx": true,
		"lib.go": true, "lib.rs": true, "main.c": true, "main.cpp": true,
		"main.go": true, "main.java": true, "main.py": true, "main.rs": true,
		"main.ts": true, "main.tsx": true, "mod.rs": true, "page.jsx": true,
		"page.tsx": true, "route.js": true, "route.ts": true, "server.js": true,
		"server.ts": true,
	}
	entryPointPrefixes := []string{"index.", "main.", "app.", "server.", "route.", "page."}

	return &IngestPatterns{
		DocExtensions:      docExts,
		CodeExtensions:     codeExts,
		nonContentDir:      nonContentDir,
		nonContentFile:     nonContentFile,
		EntryPointFiles:    entryPointFiles,
		EntryPointPrefixes: entryPointPrefixes,
	}
}

// Empty path uses native defaults; non-empty unreadable path fails closed.
func LoadIngestPatterns(path string) (*IngestPatterns, error) {
	if path == "" {
		return DefaultPatterns(), nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("[cluster] explicit ingest patterns path %q specified but unreadable: %w", path, err)
	}

	var doc struct {
		DocExtensions          []string        `json:"docExtensions"`
		CodeExtensions         []string        `json:"codeExtensions"`
		NonContentDirPatterns  []mdpat.JsRegex `json:"nonContentDirPatterns"`
		NonContentFilePatterns []mdpat.JsRegex `json:"nonContentFilePatterns"`
		EntryPointFiles        []string        `json:"entryPointFiles"`
		EntryPointPrefixes     []string        `json:"entryPointPrefixes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}

	docExts := make(map[string]bool, len(doc.DocExtensions))
	for _, ext := range doc.DocExtensions {
		docExts[strings.ToLower(strings.TrimPrefix(ext, "."))] = true
	}
	codeExts := make(map[string]bool, len(doc.CodeExtensions))
	for _, ext := range doc.CodeExtensions {
		codeExts[strings.ToLower(strings.TrimPrefix(ext, "."))] = true
	}

	entryFiles := make(map[string]bool, len(doc.EntryPointFiles))
	for _, f := range doc.EntryPointFiles {
		entryFiles[f] = true
	}

	return &IngestPatterns{
		DocExtensions:      docExts,
		CodeExtensions:     codeExts,
		nonContentDir:      mdpat.CompileJSRegexes(doc.NonContentDirPatterns, "cluster"),
		nonContentFile:     mdpat.CompileJSRegexes(doc.NonContentFilePatterns, "cluster"),
		EntryPointFiles:    entryFiles,
		EntryPointPrefixes: doc.EntryPointPrefixes,
	}, nil
}

package rsg

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
}

type ingestPatterns struct {
	DocExtensions             map[string]bool
	CodeExtensions            map[string]bool
	nonContentDir             []*regexp.Regexp
	nonContentFile            []*regexp.Regexp
	EntryPointFiles           map[string]bool
	TopLevelDocDirs           map[string]bool
	BuildSystemFiles          map[string]bool
	BinaryOrArchiveExtensions map[string]bool
}

var extTailRe = mdpat.ExtTailRe

func (p *ingestPatterns) IsDocFile(fp string) bool {
	if p == nil || fp == "" {
		return false
	}
	return p.DocExtensions[strings.ToLower(mdpat.ExtractExtension(fp))]
}

func (p *ingestPatterns) IsCodeFile(fp string) bool {
	if p == nil || fp == "" {
		return false
	}
	return p.CodeExtensions[strings.ToLower(mdpat.ExtractExtension(fp))]
}

func (p *ingestPatterns) IsNonContentDir(fp string) bool {
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

func (p *ingestPatterns) IsNonContentFile(fp string) bool {
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

type rawPatternsDoc struct {
	DocExtensions             []string        `json:"docExtensions"`
	CodeExtensions            []string        `json:"codeExtensions"`
	NonContentDirPatterns     []mdpat.JsRegex `json:"nonContentDirPatterns"`
	NonContentFilePatterns    []mdpat.JsRegex `json:"nonContentFilePatterns"`
	EntryPointFiles           []string        `json:"entryPointFiles"`
	TopLevelDocDirs           []string        `json:"topLevelDocDirs"`
	BuildSystemFiles          []string        `json:"buildSystemFiles"`
	BinaryOrArchiveExtensions []string        `json:"binaryOrArchiveExtensions"`
}

var (
	defaultIngestPatternsOnce      sync.Once
	defaultIngestPatternsSingleton *ingestPatterns
)

func DefaultIngestPatterns() *ingestPatterns {
	defaultIngestPatternsOnce.Do(func() {
		defaultIngestPatternsSingleton = buildDefaultIngestPatterns()
	})
	return defaultIngestPatternsSingleton
}

func buildDefaultIngestPatterns() *ingestPatterns {
	p := &ingestPatterns{
		DocExtensions: map[string]bool{
			".adoc": true, ".markdown": true, ".md": true, ".mdx": true, ".rst": true, ".tex": true, ".txt": true,
		},
		CodeExtensions: map[string]bool{
			".bend": true, ".c": true, ".carbon": true, ".cc": true, ".cjs": true,
			".clj": true, ".cljc": true, ".cljs": true, ".cpp": true, ".cs": true,
			".cxx": true, ".dart": true, ".erl": true, ".ex": true, ".exs": true,
			".fs": true, ".fsi": true, ".fsx": true, ".gleam": true, ".go": true,
			".groovy": true, ".h": true, ".hpp": true, ".hrl": true, ".hs": true,
			".hxx": true, ".java": true, ".jl": true, ".js": true, ".jsx": true,
			".kt": true, ".kts": true, ".lhs": true, ".lua": true, ".mbt": true,
			".mjs": true, ".ml": true, ".mli": true, ".mojo": true, ".nim": true,
			".odin": true, ".php": true, ".py": true, ".pyi": true, ".pyw": true,
			".r": true, ".rb": true, ".rs": true, ".scala": true, ".sol": true,
			".swift": true, ".ts": true, ".tsx": true, ".typ": true, ".v": true,
			".zig": true, ".🔥": true,
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
			"app.js": true, "app.py": true, "app.ts": true, "app.tsx": true,
			"index.js": true, "index.jsx": true, "index.ts": true, "index.tsx": true,
			"lib.go": true, "lib.rs": true, "main.c": true, "main.cpp": true,
			"main.go": true, "main.java": true, "main.py": true, "main.rs": true,
			"main.ts": true, "main.tsx": true, "mod.rs": true, "page.jsx": true,
			"page.tsx": true, "route.js": true, "route.ts": true, "server.js": true,
			"server.ts": true,
		},
		TopLevelDocDirs: map[string]bool{
			"book": true, "content": true, "docs": true, "en": true, "i18n": true,
			"locales": true, "packages": true, "tutorials": true, "zh": true,
		},
		BuildSystemFiles: map[string]bool{
			"*.cabal": true, "*.csproj": true, "*.fsproj": true, "*.nimble": true,
			"*.rockspec": true, "*.sln": true, "build.gradle": true, "build.gradle.kts": true,
			"build.sbt": true, "build.zig": true, "cabal.project": true, "cargo.lock": true,
			"cargo.toml": true, "cmakelists.txt": true, "composer.json": true, "composer.lock": true,
			"deps.edn": true, "description": true, "dune": true, "dune-project": true,
			"foundry.toml": true, "gemfile": true, "gemfile.lock": true, "gleam.toml": true,
			"go.mod": true, "go.sum": true, "hardhat.config.js": true, "makefile": true,
			"manifest.toml": true, "mix.exs": true, "mojoproject.toml": true, "moon.mod.json": true,
			"package.json": true, "package.swift": true, "package.yaml": true, "pipfile": true,
			"pom.xml": true, "project.clj": true, "project.toml": true, "pubspec.yaml": true,
			"pyproject.toml": true, "rebar.config": true, "requirements.txt": true, "setup.py": true,
			"truffle-config.js": true, "tsconfig.json": true, "typst.toml": true, "v.mod": true,
		},
		BinaryOrArchiveExtensions: map[string]bool{
			".7z": true, ".a": true, ".ai": true, ".avi": true, ".bin": true,
			".bz2": true, ".class": true, ".dll": true, ".dmg": true, ".dylib": true,
			".eot": true, ".exe": true, ".flac": true, ".gif": true, ".gz": true,
			".iso": true, ".jar": true, ".jpeg": true, ".jpg": true, ".mov": true,
			".mp3": true, ".mp4": true, ".o": true, ".ogg": true, ".otf": true,
			".psd": true, ".pyc": true, ".rar": true, ".sketch": true, ".so": true,
			".tar": true, ".tgz": true, ".ttf": true, ".wasm": true, ".wav": true,
			".webm": true, ".woff": true, ".woff2": true, ".xz": true, ".zip": true,
		},
	}
	return p
}

func loadIngestPatterns(path string) *ingestPatterns {
	if path == "" {
		return DefaultIngestPatterns()
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		panic(fmt.Sprintf("[rsg-patterns] explicit patterns path %q specified but unreadable: %v", path, err))
	}

	var doc rawPatternsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic(fmt.Sprintf("[rsg-patterns] explicit patterns path %q parse failed: %v", path, err))
	}

	p := &ingestPatterns{
		DocExtensions:             make(map[string]bool, len(doc.DocExtensions)),
		CodeExtensions:            make(map[string]bool, len(doc.CodeExtensions)),
		nonContentDir:             mdpat.CompileJSRegexes(doc.NonContentDirPatterns, "rsg"),
		nonContentFile:            mdpat.CompileJSRegexes(doc.NonContentFilePatterns, "rsg"),
		EntryPointFiles:           make(map[string]bool, len(doc.EntryPointFiles)),
		TopLevelDocDirs:           make(map[string]bool, len(doc.TopLevelDocDirs)),
		BuildSystemFiles:          make(map[string]bool, len(doc.BuildSystemFiles)),
		BinaryOrArchiveExtensions: make(map[string]bool, len(doc.BinaryOrArchiveExtensions)),
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
	for _, d := range doc.TopLevelDocDirs {
		p.TopLevelDocDirs[strings.ToLower(d)] = true
	}
	for _, b := range doc.BuildSystemFiles {
		p.BuildSystemFiles[strings.ToLower(b)] = true
	}
	for _, b := range doc.BinaryOrArchiveExtensions {
		p.BinaryOrArchiveExtensions[strings.ToLower(b)] = true
	}

	return p
}

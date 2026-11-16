package rsg

import (
	"bytes"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Regex patterns for Layer 2: Universal Pattern Matcher
var (
	// Lockfile regex covers all modern language ecosystems:
	// npm, yarn, pnpm, bun, cargo, go, poetry, pipenv, pdm, uv, composer,
	// gemfile, pubspec, cabal, mix, nuget, nix, renv, conan, gradle, bazel, terraform, deno.
	lockfileRegex = regexp.MustCompile(`(?i)(?:^|/)(?:(?:.*[-._])?lock(?:b|\.ya?ml|\.json|\.hcl)?|.*\.lock(?:\.[a-zA-Z0-9]+)?|.*\.lockfile|.*\.freeze|.*\.resolved|go\.(?:work\.)?sum)$`)

	// DevOps, CI/CD, container and automation pipeline definitions.
	devopsRegex = regexp.MustCompile(`(?i)(?:^|/)(?:\.github|\.gitlab|\.circleci|\.?azure-pipelines|\.buildkite|\.?travis|\.?drone|\.woodpecker|\.jenkins|Jenkinsfile$|Dockerfile(?:[-._].*)?$|docker-compose(?:[-._].*)?\.ya?ml$)`)

	// Toolchain, linter, formatter and VCS metadata configs (.*rc, .*ignore, .*config.*, tsconfig, etc.).
	toolchainRegex = regexp.MustCompile(`(?i)(?:^|/)(?:\.[^/]+|.*(?:rc|ignore)|(?:.*[-._])?config(?:[-._].*)?|(?:.*[-._])?(?:editorconfig|gitattributes|gitignore|prettier|eslint|stylelint|biome|ruff|rubocop|flake8|pylintrc|clippy|rustfmt|golangci|tsconfig|turbo|nx|lerna)(?:[-._].*)?)$`)

	// Default fallback patterns for governance files if ingestPatterns is nil.
	defaultNonContentFileRegex = regexp.MustCompile(`(?i)^(?:license|licence|code_of_conduct|security|contributing|pull_request_template|issue_template|changelog|changes)(?:\.[a-zA-Z0-9]+)?$`)
	defaultNonContentDirRegex  = regexp.MustCompile(`(?i)^(?:assets?|media|images?|img|icons?|public|static|screenshots?|figures?|fixtures|dist|build|out|target|release|debug|node_modules|vendor|\.github|\.vscode|\.idea|\.gitlab|\.circleci|\.cargo|\.git|\.hg|\.svn|logs?|tmp|temp|cache)$`)
)

// Default 60+ programming language source extensions.
var defaultCodeExtensions = map[string]bool{
	".bend": true, ".c": true, ".carbon": true, ".cc": true, ".cjs": true,
	".clj": true, ".cljc": true, ".cljs": true, ".cpp": true, ".cs": true,
	".cxx": true, ".dart": true, ".erl": true, ".ex": true, ".exs": true,
	".fs": true, ".fsi": true, ".fsx": true, ".gleam": true, ".go": true,
	".groovy": true, ".h": true, ".hpp": true, ".hrl": true, ".hs": true,
	".hxx": true, ".java": true, ".jl": true, ".js": true, ".jsx": true,
	".kt": true, ".kts": true, ".lhs": true, ".lua": true, ".mjs": true,
	".ml": true, ".mli": true, ".mojo": true, ".nim": true, ".odin": true,
	".php": true, ".py": true, ".pyi": true, ".pyw": true, ".r": true,
	".rb": true, ".rs": true, ".scala": true, ".sol": true, ".swift": true,
	".ts": true, ".tsx": true, ".v": true, ".zig": true, ".🔥": true,
}

// Default documentation extensions.
var defaultDocExtensions = map[string]bool{
	".md": true, ".mdx": true, ".txt": true, ".rst": true, ".adoc": true, ".tex": true,
}

// Default binary, archive, image, media and font asset extensions.
var defaultAssetExtensions = map[string]bool{
	// Images & vector graphics
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true,
	".ico": true, ".webp": true, ".bmp": true, ".tiff": true, ".avif": true,
	// Audio & video
	".mp4": true, ".webm": true, ".avi": true, ".mov": true, ".mp3": true,
	".wav": true, ".ogg": true, ".flac": true,
	// Archives, binaries & compiled bytecode
	".zip": true, ".tar": true, ".gz": true, ".tgz": true, ".bz2": true,
	".xz": true, ".7z": true, ".rar": true, ".iso": true, ".dmg": true,
	".bin": true, ".wasm": true, ".exe": true, ".dll": true, ".so": true,
	".dylib": true, ".o": true, ".a": true, ".pyc": true, ".class": true,
	// Fonts & PDF assets
	".woff": true, ".woff2": true, ".ttf": true, ".eot": true, ".otf": true,
	".pdf": true,
}

// InfraClassifier provides a 4-layer polyglot non-teaching infrastructure classifier.
type InfraClassifier struct {
	patterns       Patterns
	lockfileRegex  *regexp.Regexp
	toolchainRegex *regexp.Regexp
	devopsRegex    *regexp.Regexp
}

var (
	defaultClassifier     *InfraClassifier
	defaultClassifierOnce sync.Once
)

// NewInfraClassifier creates an InfraClassifier. If patterns is nil, it uses native DefaultIngestPatterns.
func NewInfraClassifier(patterns Patterns) *InfraClassifier {
	if patterns == nil {
		patterns = DefaultIngestPatterns()
	}
	return &InfraClassifier{
		patterns:       patterns,
		lockfileRegex:  lockfileRegex,
		toolchainRegex: toolchainRegex,
		devopsRegex:    devopsRegex,
	}
}

// GetDefaultInfraClassifier returns a singleton classifier.
func GetDefaultInfraClassifier() *InfraClassifier {
	defaultClassifierOnce.Do(func() {
		defaultClassifier = NewInfraClassifier(nil)
	})
	return defaultClassifier
}

// IsCodeFile checks if a file is a recognized source code file (Layer 1).
func (c *InfraClassifier) IsCodeFile(p string) bool {
	if p == "" {
		return false
	}
	ext := strings.ToLower(filepath.Ext(p))
	if ext == "" {
		return false
	}
	if c.patterns != nil {
		return c.patterns.IsCodeFile(p)
	}
	return defaultCodeExtensions[ext]
}

// IsDocFile checks if a file is a recognized documentation file.
func (c *InfraClassifier) IsDocFile(p string) bool {
	if p == "" {
		return false
	}
	ext := strings.ToLower(filepath.Ext(p))
	if ext == "" {
		return false
	}
	if c.patterns != nil {
		return c.patterns.IsDocFile(p)
	}
	return defaultDocExtensions[ext]
}

// IsAssetFile checks if a file is a binary, archive, image, media or font asset.
func (c *InfraClassifier) IsAssetFile(p string) bool {
	if p == "" {
		return false
	}
	ext := strings.ToLower(filepath.Ext(p))
	if ext == "" {
		return false
	}
	return defaultAssetExtensions[ext]
}

// IsGeneratedContent sniffs up to 512 bytes for machine-generated signatures (Layer 3).
// Handles UTF-8 as well as UTF-16LE samples by stripping null bytes before matching.
func (c *InfraClassifier) IsGeneratedContent(sample []byte) bool {
	if len(sample) == 0 {
		return false
	}
	limit := 512
	if len(sample) < limit {
		limit = len(sample)
	}
	cleanSample := bytes.ReplaceAll(sample[:limit], []byte{0}, nil)
	lower := bytes.ToLower(cleanSample)
	signatures := [][]byte{
		[]byte("@generated"),
		[]byte("do not edit"),
		[]byte("code generated by"),
		[]byte("automatically generated"),
		[]byte("autogenerated by"),
	}
	for _, sig := range signatures {
		if bytes.Contains(lower, sig) {
			return true
		}
	}
	return false
}

// IsNonTeachingInfra evaluates whether path represents non-teaching infrastructure (Layer 1 ~ Layer 3).
func (c *InfraClassifier) IsNonTeachingInfra(p string, sample ...[]byte) bool {
	if p == "" {
		return false
	}
	normalized := filepath.ToSlash(filepath.Clean(p))
	normalized = strings.TrimPrefix(normalized, "./")
	base := filepath.Base(normalized)

	// 1. Non-content directory check (e.g. .github/, .gitlab/, vendor/, node_modules/, public/, assets/)
	if c.patterns != nil {
		if c.patterns.IsNonContentDir(normalized) {
			return true
		}
	} else {
		for _, seg := range strings.Split(normalized, "/") {
			if seg != "" && defaultNonContentDirRegex.MatchString(seg) {
				return true
			}
		}
	}

	// 2. Non-content governance files (e.g. LICENSE, CHANGELOG, CONTRIBUTING)
	if c.patterns != nil {
		if c.patterns.IsNonContentFile(normalized) {
			return true
		}
	} else if defaultNonContentFileRegex.MatchString(base) {
		return true
	}

	// 3. Layer 3: Header Fingerprint Sniffing (@generated / DO NOT EDIT)
	// Sniffing applies to ANY file format (including source code like user.pb.go)
	if len(sample) > 0 && len(sample[0]) > 0 {
		if c.IsGeneratedContent(sample[0]) {
			return true
		}
	}

	// 4. Layer 1 AST Semantic Sovereignty Check:
	// If it is a recognized source code file or doc file (outside non-content dirs and without generated header),
	// its sovereignty belongs to AST analysis (Layer 4) or Documentation!
	// It must NEVER be swallowed as toolchain, DevOps or lockfile infra.
	if c.IsCodeFile(normalized) || c.IsDocFile(normalized) {
		return false
	}

	// 5. Layer 2: Universal Pattern Matching (strictly for non-code, non-doc files)
	// 5.1 Universal lockfile pattern across all ecosystems
	if c.lockfileRegex.MatchString(normalized) || c.lockfileRegex.MatchString(base) {
		return true
	}

	// 5.2 DevOps & Containers (Dockerfile, docker-compose, Jenkinsfile, etc.)
	if c.devopsRegex.MatchString(normalized) || c.devopsRegex.MatchString(base) {
		return true
	}

	// 5.3 Toolchain & Linter configs (e.g. tsconfig.json, .eslintrc, .prettierrc, .editorconfig, dockerignore)
	if c.toolchainRegex.MatchString(normalized) || c.toolchainRegex.MatchString(base) {
		return true
	}

	// 5.4 Binary, Media & Asset Files (e.g. .png, .wasm, .pdf, .bin)
	if c.IsAssetFile(normalized) {
		return true
	}

	return false
}

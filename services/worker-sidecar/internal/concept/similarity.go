package concept

import (
	"crypto/md5"
	"encoding/hex"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/opengits/worker-sidecar/internal/cluster"
)

// GitNode represents a node in a git tree or archive.
type GitNode = cluster.GitNode

// IngestPatterns implements Patterns by parsing ingest-patterns.json.
type IngestPatterns = cluster.IngestPatterns

// DirPatternChecker tests whether a directory path matches non-content directory patterns.
type DirPatternChecker interface {
	IsNonContentDir(path string) bool
}

// AllowedFileExtensionsPattern matches permitted content/source extensions.
// Matches apps/client/src/lib/config.ts ALLOWED_FILE_EXTENSIONS.
var allowedFileExtensionsPattern = regexp.MustCompile(`(?i)\.(md|mdx|py|pyw|pyi|ts|tsx|js|jsx|cjs|mjs|go|rs|c|cpp|cxx|cc|h|hpp|java|cs|rb|php|swift|kt|kts|mojo|🔥|bend|zig|nim|gleam|odin|carbon|v|jl|r|sol|dart|lua|ex|exs|erl|hrl|scala|hs|lhs|ml|mli|clj|cljs|cljc|fs|fsi|fsx|groovy|sh|bash|json|yml|yaml|toml|ini|txt|csv)$`)

const (
	SkeletonMinPaths            = 8
	SkeletonMaxPaths            = 500
	SkeletonSimilarityThreshold = 0.85
	FingerprintPromptMaxChars   = 2000
)

// ExtractSkeletonPaths filters GitNodes to content blob paths matching allowed extensions and not in non-content dirs.
func ExtractSkeletonPaths(nodes []GitNode, patterns DirPatternChecker) []string {
	var paths []string
	for _, n := range nodes {
		if n.Type != "blob" || n.Path == "" {
			continue
		}
		if patterns != nil && patterns.IsNonContentDir(n.Path) {
			continue
		}
		if allowedFileExtensionsPattern.MatchString(n.Path) {
			paths = append(paths, n.Path)
		}
	}
	return paths
}

// BuildSkeleton creates a deterministic skeleton representation: lower-cased, sorted, truncated to 500, newline-separated.
func BuildSkeleton(paths []string) string {
	lowers := make([]string, len(paths))
	for i, p := range paths {
		lowers[i] = strings.ToLower(p)
	}
	sort.Strings(lowers)
	if len(lowers) > SkeletonMaxPaths {
		lowers = lowers[:SkeletonMaxPaths]
	}
	return strings.Join(lowers, "\n")
}

// SkeletonHashOf returns the MD5 hexadecimal digest of a skeleton string.
func SkeletonHashOf(skeleton string) string {
	h := md5.Sum([]byte(skeleton))
	return hex.EncodeToString(h[:])
}

// IsSkeletonComparable checks if a skeleton meets the minimum path count requirement (>= 8).
func IsSkeletonComparable(skeleton string) bool {
	if skeleton == "" {
		return false
	}
	lines := strings.Split(skeleton, "\n")
	return len(lines) >= SkeletonMinPaths
}

// NormalizePrompt cleans an instruction: lowercase, strips whitespace/punctuation/symbols, truncates to 2000 runes.
func NormalizePrompt(input string) string {
	var buf strings.Builder
	count := 0
	for _, r := range strings.ToLower(input) {
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			continue
		}
		if count >= FingerprintPromptMaxChars {
			break
		}
		buf.WriteRune(r)
		count++
	}
	return buf.String()
}

// BuildEditionFingerprint generates a 16-character MD5 hash representing an edition recipe.
func BuildEditionFingerprint(preset, customPrompt, lang, depth string) string {
	if preset == "" {
		preset = "standard"
	}
	if lang == "" {
		lang = "none"
	}
	if depth == "" {
		depth = "standard"
	}
	normalized := preset + "|" + NormalizePrompt(customPrompt) + "|" + lang + "|" + depth
	h := md5.Sum([]byte(normalized))
	return hex.EncodeToString(h[:])[:16]
}

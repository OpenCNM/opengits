package rsg

import (
	"encoding/json"
	"path"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
)

func PickDeterministicCandidate(candidates []string, currentFilePath string) string {
	return cognitive.PickDeterministicCandidate(candidates, currentFilePath)
}

func ParsePsr4Aliases(composerFiles []SourceFileInput) []Psr4Alias {
	var aliases []Psr4Alias
	for _, file := range composerFiles {
		if file.Content == "" {
			continue
		}
		var parsed struct {
			Autoload struct {
				PSR4 map[string]interface{} `json:"psr-4"`
			} `json:"autoload"`
		}
		if err := json.Unmarshal([]byte(file.Content), &parsed); err != nil {
			continue
		}
		for rawPrefix, rawDirs := range parsed.Autoload.PSR4 {
			var rawDir string
			switch v := rawDirs.(type) {
			case string:
				rawDir = v
			case []interface{}:
				if len(v) > 0 {
					if s, ok := v[0].(string); ok {
						rawDir = s
					}
				}
			}
			if rawPrefix == "" || rawDir == "" {
				continue
			}

			normalize := func(val string) string {
				s := strings.ReplaceAll(val, "\\", "/")
				s = strings.TrimRight(s, "/")
				if s != "" {
					return s + "/"
				}
				return ""
			}

			prefix := normalize(rawPrefix)
			dir := normalize(rawDir)
			if prefix == "" || prefix == "/" || dir == "" || dir == "/" {
				continue
			}
			aliases = append(aliases, Psr4Alias{Prefix: prefix, Dir: dir})
		}
	}

	sort.Slice(aliases, func(i, j int) bool {
		return aliases[i].Prefix < aliases[j].Prefix
	})
	return aliases
}

func (d *LanguageDefinitions) ResolveImportTarget(
	importStr string,
	currentFilePath string,
	filePathSet map[string]bool,
	psr4Aliases []Psr4Alias,
	tsAliases ...[]TsAlias,
) string {
	return d.resolveImportTarget(importStr, currentFilePath, filePathSet, nil, psr4Aliases, tsAliases...)
}

func BuildBasenameIndex(sortedPaths []string) map[string][]string {
	idx := make(map[string][]string, len(sortedPaths))
	for _, knownPath := range sortedPaths {
		knownFilename := path.Base(knownPath)
		baseFilename := knownFilename
		if dotIdx := strings.LastIndex(knownFilename, "."); dotIdx > 0 {
			baseFilename = knownFilename[:dotIdx]
		}
		idx[baseFilename] = append(idx[baseFilename], knownPath)
	}
	return idx
}

func (d *LanguageDefinitions) resolveImportTarget(
	importStr string,
	currentFilePath string,
	filePathSet map[string]bool,
	basenameIdx map[string][]string,
	psr4Aliases []Psr4Alias,
	tsAliases ...[]TsAlias,
) string {
	var ts []TsAlias
	for _, group := range tsAliases {
		ts = append(ts, group...)
	}
	if importStr == "" || currentFilePath == "" {
		return ""
	}

	normalizedImport := strings.ReplaceAll(importStr, "\\", "/")
	normalizedImport = strings.ReplaceAll(normalizedImport, "::", "/")
	normalizedImport = strings.TrimSuffix(normalizedImport, "*")

	normalizedCurrent := strings.ReplaceAll(currentFilePath, "\\", "/")
	currentDir := ""
	if idx := strings.LastIndex(normalizedCurrent, "/"); idx >= 0 {
		currentDir = normalizedCurrent[:idx]
	}

	if filePathSet[normalizedImport] {
		return normalizedImport
	}

	if currentDir != "" {
		sameDirCandidate := currentDir + "/" + normalizedImport
		if filePathSet[sameDirCandidate] {
			return sameDirCandidate
		}
		for _, ext := range d.ResolvableExtensions {
			if filePathSet[sameDirCandidate+ext] {
				return sameDirCandidate + ext
			}
		}
	}

	if strings.HasPrefix(normalizedImport, ".") {
		var parts []string
		if currentDir != "" {
			parts = append(parts, strings.Split(currentDir, "/")...)
		}
		parts = append(parts, strings.Split(normalizedImport, "/")...)

		var resolvedParts []string
		for _, p := range parts {
			if p == "" || p == "." {
				continue
			}
			if p == ".." {
				if len(resolvedParts) > 0 {
					resolvedParts = resolvedParts[:len(resolvedParts)-1]
				}
			} else {
				resolvedParts = append(resolvedParts, p)
			}
		}
		resolvedBase := strings.Join(resolvedParts, "/")

		if filePathSet[resolvedBase] {
			return resolvedBase
		}
		for _, ext := range d.ResolvableExtensions {
			if filePathSet[resolvedBase+ext] {
				return resolvedBase + ext
			}
			if filePathSet[resolvedBase+"/index"+ext] {
				return resolvedBase + "/index" + ext
			}
		}
		if filePathSet[resolvedBase+"/__init__.py"] {
			return resolvedBase + "/__init__.py"
		}
		if filePathSet[resolvedBase+"/mod.rs"] {
			return resolvedBase + "/mod.rs"
		}
	}

	tryCandidates := func(base string) bool {
		if base == "" {
			return false
		}
		if filePathSet[base] {
			return true
		}
		for _, ext := range d.ResolvableExtensions {
			if filePathSet[base+ext] || filePathSet[base+"/index"+ext] {
				return true
			}
		}
		return false
	}
	for _, alias := range ts {
		if alias.IsExact {
			if normalizedImport == alias.Prefix && tryCandidates(alias.Target) {
				return alias.Target
			}
			continue
		}
		if strings.HasPrefix(normalizedImport, alias.Prefix) {
			rest := strings.TrimPrefix(normalizedImport, alias.Prefix)
			base := alias.Target + "/" + strings.TrimPrefix(rest, "/")
			if filePathSet[base] {
				return base
			}
			for _, ext := range d.ResolvableExtensions {
				if filePathSet[base+ext] {
					return base + ext
				}
				if filePathSet[base+"/index"+ext] {
					return base + "/index" + ext
				}
			}
		}
	}

	normalizedAlias := normalizedImport
	if strings.HasPrefix(normalizedAlias, "~/") {
		normalizedAlias = strings.TrimPrefix(normalizedAlias, "~/")
	} else if strings.HasPrefix(normalizedAlias, "crate/") {
		normalizedAlias = "src/" + strings.TrimPrefix(normalizedAlias, "crate/")
	} else if strings.HasPrefix(normalizedAlias, "@/") && !hasTsAliasPrefix(ts, "@/") {
		normalizedAlias = "src/" + strings.TrimPrefix(normalizedAlias, "@/")
	}

	if filePathSet[normalizedAlias] {
		return normalizedAlias
	}
	for _, ext := range d.ResolvableExtensions {
		if filePathSet[normalizedAlias+ext] {
			return normalizedAlias + ext
		}
		if filePathSet[normalizedAlias+"/index"+ext] {
			return normalizedAlias + "/index" + ext
		}
	}

	for _, alias := range psr4Aliases {
		if strings.HasPrefix(normalizedImport, alias.Prefix) {
			candidateBase := alias.Dir + normalizedImport[len(alias.Prefix):]
			if filePathSet[candidateBase] {
				return candidateBase
			}
			if filePathSet[candidateBase+".php"] {
				return candidateBase + ".php"
			}
		}
	}

	if strings.Contains(normalizedImport, ".") && !strings.HasPrefix(normalizedImport, ".") {
		dotAsPath := strings.ReplaceAll(normalizedImport, ".", "/")
		if filePathSet[dotAsPath] {
			return dotAsPath
		}
		for _, ext := range d.ResolvableExtensions {
			if filePathSet[dotAsPath+ext] {
				return dotAsPath + ext
			}
			if filePathSet["src/"+dotAsPath+ext] {
				return "src/" + dotAsPath + ext
			}
			if filePathSet["src/main/java/"+dotAsPath+ext] {
				return "src/main/java/" + dotAsPath + ext
			}
		}
	}

	if strings.Contains(normalizedImport, "/") || strings.HasPrefix(normalizedImport, ".") {
		lastSegment := path.Base(normalizedImport)
		if lastSegment != "" && lastSegment != "." && lastSegment != "/" {
			var candidates []string
			if basenameIdx != nil {
				candidates = append(candidates, basenameIdx[lastSegment]...)

				filtered := candidates[:0]
				for _, c := range candidates {
					if c != normalizedCurrent {
						filtered = append(filtered, c)
					}
				}
				candidates = filtered
			} else {
				for knownPath := range filePathSet {
					knownFilename := path.Base(knownPath)
					baseFilename := knownFilename
					if dotIdx := strings.LastIndex(knownFilename, "."); dotIdx > 0 {
						baseFilename = knownFilename[:dotIdx]
					}
					if baseFilename == lastSegment && knownPath != normalizedCurrent {
						candidates = append(candidates, knownPath)
					}
				}
			}
			if len(candidates) > 0 {
				return PickDeterministicCandidate(candidates, normalizedCurrent)
			}
		}
	}

	return ""
}

// Yield convention fallbacks when tsconfig explicitly declares the same prefix.
func hasTsAliasPrefix(aliases []TsAlias, prefix string) bool {
	for _, a := range aliases {
		if a.Prefix == prefix {
			return true
		}
	}
	return false
}

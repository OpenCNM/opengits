package rsg

import (
	"encoding/json"
	"sort"
	"strings"
)

type TsAlias struct {
	Prefix  string
	Target  string
	IsExact bool
}

func ParseTsConfigAliases(configFiles []SourceFileInput) []TsAlias {
	var aliases []TsAlias
	seen := map[string]bool{}

	for _, file := range configFiles {
		if !isTsConfigPath(file.Path) {
			continue
		}
		var doc struct {
			CompilerOptions struct {
				BaseURL string              `json:"baseUrl"`
				Paths   map[string][]string `json:"paths"`
			} `json:"compilerOptions"`
		}
		if err := json.Unmarshal([]byte(stripJsoncComments(file.Content)), &doc); err != nil {
			continue
		}
		baseURL := strings.Trim(doc.CompilerOptions.BaseURL, "/")
		for pattern, targets := range doc.CompilerOptions.Paths {
			for _, rawTarget := range targets {
				target := strings.Trim(rawTarget, "/")
				if target == "" {
					continue
				}
				if baseURL != "" {
					target = baseURL + "/" + target
				}
				if strings.HasSuffix(pattern, "/*") || strings.HasSuffix(pattern, "*") {
					prefix := strings.TrimSuffix(pattern, "*")
					target = strings.TrimSuffix(target, "*")
					key := "w:" + prefix + "->" + target
					if !seen[key] {
						seen[key] = true
						aliases = append(aliases, TsAlias{Prefix: prefix, Target: strings.TrimSuffix(target, "/")})
					}
				} else {
					key := "e:" + pattern + "->" + target
					if !seen[key] {
						seen[key] = true
						aliases = append(aliases, TsAlias{Prefix: pattern, Target: target, IsExact: true})
					}
				}
			}
		}
	}

	sort.SliceStable(aliases, func(i, j int) bool {
		return len(aliases[i].Prefix) > len(aliases[j].Prefix)
	})
	return aliases
}

func isTsConfigPath(path string) bool {
	normalized := strings.TrimLeft(path, "/")
	if strings.Contains(normalized, "/") {

		return false
	}
	return normalized == "tsconfig.json" || normalized == "jsconfig.json" ||
		normalized == "tsconfig.base.json"
}

func stripJsoncComments(src string) string {
	var b strings.Builder
	b.Grow(len(src))
	inString := false
	escaped := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		if inString {
			b.WriteByte(c)
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		switch {
		case c == '"':
			inString = true
			b.WriteByte(c)
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
			if i < len(src) {
				b.WriteByte('\n')
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i++
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

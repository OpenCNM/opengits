package pipelineb

import (
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	promptPathPatternCap = 16
	promptPathMatchCap   = 32
)

func isPromptPathRune(r rune) bool {
	return (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9') ||
		r == '.' || r == '_' || r == '-' || r == '/' || r == '*' || r == '?' || r == '#'
}

func isUrlSchemePrefix(before string) bool {
	lower := strings.ToLower(before)
	return strings.HasSuffix(lower, "http:") ||
		strings.HasSuffix(lower, "https:") ||
		strings.HasSuffix(lower, "file:") ||
		strings.HasSuffix(lower, "ssh:") ||
		strings.HasSuffix(lower, "git:")
}

// Deterministically scans mixed-language text for repo paths and globs without regex using non-ASCII boundaries.
func ExtractPromptPathPatterns(prompt string) []string {
	if prompt == "" {
		return nil
	}
	var out []string
	seen := make(map[string]bool)

	n := len(prompt)
	i := 0
	for i < n {
		r, size := utf8.DecodeRuneInString(prompt[i:])
		if !isPromptPathRune(r) {
			i += size
			continue
		}
		start := i
		for i < n {
			if prompt[i] >= 0x80 {
				break
			}
			if !isPromptPathRune(rune(prompt[i])) {
				break
			}
			i++
		}
		rawTok := prompt[start:i]
		if start > 0 && isUrlSchemePrefix(prompt[:start]) {
			continue
		}
		if idx := strings.IndexByte(rawTok, '#'); idx >= 0 {
			rawTok = rawTok[:idx]
		}
		tok := filepath.ToSlash(strings.TrimSpace(rawTok))
		for strings.HasPrefix(tok, "./") || strings.HasPrefix(tok, "/") {
			tok = strings.TrimPrefix(tok, "./")
			tok = strings.TrimPrefix(tok, "/")
		}
		tok = strings.TrimRight(tok, "/.-")
		if len(tok) < 3 || !strings.Contains(tok, "/") || tok == "*/*" || strings.Contains(tok, "//") {
			continue
		}
		if !seen[tok] {
			seen[tok] = true
			out = append(out, tok)
			if len(out) >= promptPathPatternCap {
				break
			}
		}
	}
	return out
}

func MatchRepoGlob(pattern, candidate string) bool {
	pat := strings.Trim(filepath.ToSlash(pattern), "/")
	cand := strings.Trim(filepath.ToSlash(candidate), "/")
	if pat == "" || cand == "" {
		return false
	}
	return matchGlobSegments(strings.Split(pat, "/"), strings.Split(cand, "/"))
}

func matchGlobSegments(patSegs, candSegs []string) bool {
	if len(patSegs) == 0 {
		return len(candSegs) == 0
	}
	if patSegs[0] == "**" {
		next := 1
		for next < len(patSegs) && patSegs[next] == "**" {
			next++
		}
		if matchGlobSegments(patSegs[next:], candSegs) {
			return true
		}
		return len(candSegs) > 0 && matchGlobSegments(patSegs[next-1:], candSegs[1:])
	}
	if len(candSegs) == 0 {
		return false
	}
	ok, err := path.Match(patSegs[0], candSegs[0])
	if err != nil || !ok {
		return false
	}
	return matchGlobSegments(patSegs[1:], candSegs[1:])
}

func MatchPromptPathsInLeaves(prompt string, leaves []FileMap, scopePrefix string) []string {
	patterns := ExtractPromptPathPatterns(prompt)
	if len(patterns) == 0 || len(leaves) == 0 {
		return nil
	}
	scope := strings.Trim(filepath.ToSlash(scopePrefix), "/ ")

	type scoredMatch struct {
		file FileMap
		tier int
	}
	bestByPath := make(map[string]scoredMatch)

	for _, pat := range patterns {
		isGlob := strings.ContainsAny(pat, "*?")
		for _, f := range leaves {
			if f.IsTest || f.IsConfig {
				continue
			}
			tier := 0
			if isGlob {
				if MatchRepoGlob(pat, f.Path) ||
					(scope != "" && MatchRepoGlob(scope+"/"+pat, f.Path)) ||
					(scope != "" && strings.HasPrefix(f.Path, scope+"/") && MatchRepoGlob(pat, strings.TrimPrefix(f.Path, scope+"/"))) {
					tier = 2
				}
			} else {
				if f.Path == pat || (scope != "" && f.Path == scope+"/"+pat) {
					tier = 2
				} else if strings.HasPrefix(f.Path, pat+"/") || (scope != "" && strings.HasPrefix(f.Path, scope+"/"+pat+"/")) {
					tier = 1
				}
			}
			if tier > 0 {
				if prev, ok := bestByPath[f.Path]; !ok || tier > prev.tier {
					bestByPath[f.Path] = scoredMatch{file: f, tier: tier}
				}
			}
		}
	}

	if len(bestByPath) == 0 {
		return nil
	}

	matches := make([]scoredMatch, 0, len(bestByPath))
	for _, m := range bestByPath {
		matches = append(matches, m)
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].tier != matches[j].tier {
			return matches[i].tier > matches[j].tier
		}
		if matches[i].file.Hotness != matches[j].file.Hotness {
			return matches[i].file.Hotness > matches[j].file.Hotness
		}
		if matches[i].file.LOC != matches[j].file.LOC {
			return matches[i].file.LOC > matches[j].file.LOC
		}
		return matches[i].file.Path < matches[j].file.Path
	})

	limit := min(len(matches), promptPathMatchCap)
	out := make([]string, 0, limit)
	for i := 0; i < limit; i++ {
		out = append(out, matches[i].file.Path)
	}
	return out
}

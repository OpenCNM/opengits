package transcription

import (
	"strings"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type codeResolverDeps struct {
	archiveRoot    string
	owner          string
	repo           string
	ref            string
	branch         string
	snippets       []armor.ArmorAllocatedSnippet
	groundingIndex cognitive.GroundingIndex
}

const codeResolverWholeFileLines = 60

// Resolves symbols strictly from graph AST ranges (misses go to grounding gate) and caches archive lines only.
func buildCodeResolver(deps codeResolverDeps, snapped *int) armor.CodeSlotResolver {
	archiveLines := make(map[string][]string)
	return func(fileIndex int, relPath, symbol string, reqStart, reqEnd int) (string, int, int, bool) {
		cleanPath, _ := mdpat.SplitPathAnchor(relPath)
		if cleanPath == "" {
			cleanPath = relPath
		}
		lines, cached := archiveLines[cleanPath]
		if !cached {
			raw := chapter.ReadLocalArchiveFile(deps.archiveRoot, deps.owner, deps.repo, deps.ref, cleanPath)
			if raw == "" && deps.branch != "" && deps.branch != deps.ref {
				raw = chapter.ReadLocalArchiveFile(deps.archiveRoot, deps.owner, deps.repo, deps.branch, cleanPath)
			}
			if raw != "" {
				lines = strings.Split(raw, "\n")
				archiveLines[cleanPath] = lines
				cached = true
			}
		}
		if !cached && fileIndex >= 1 && fileIndex <= len(deps.snippets) {
			if snippet := deps.snippets[fileIndex-1].Snippet; snippet != "" {
				lines = strings.Split(snippet, "\n")
				cached = true
			}
		}
		if !cached {
			return "", 0, 0, false
		}
		if reqStart > 0 && reqEnd >= reqStart && reqStart <= len(lines) {
			end := reqEnd
			if end > len(lines) {
				end = len(lines)
				if snapped != nil {
					*snapped++
				}
			}
			return strings.Join(lines[reqStart-1:end], "\n"), reqStart, end, true
		}

		if symbol != "" {
			symStart, symEnd, ok := lookupSymbolRange(deps.groundingIndex, cleanPath, symbol)
			if !ok && cognitive.IsDocFile(cleanPath) {
				symStart, symEnd, ok = findDocCodeSnippet(lines, symbol)
			}
			if !ok || symStart > len(lines) {
				return "", 0, 0, false
			}
			if symEnd > len(lines) {
				symEnd = len(lines)
			}
			return strings.Join(lines[symStart-1:symEnd], "\n"), symStart, symEnd, true
		}

		end := codeResolverWholeFileLines
		if len(lines) < end {
			end = len(lines)
		}
		return strings.Join(lines[:end], "\n"), 1, end, true
	}
}

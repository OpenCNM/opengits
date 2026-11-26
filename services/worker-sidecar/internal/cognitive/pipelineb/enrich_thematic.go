package pipelineb

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
	"github.com/opengits/worker-sidecar/internal/rsg"
)

const (
	thematicSparseThreshold = 0.1
	thematicSampleCap       = 50
	thematicFetchTimeout    = 90 * time.Second
)

func thematicAstSparse(m *RepoMap) bool {
	if m == nil || m.Tree == nil {
		return false
	}
	files := m.Tree.LeafFiles()
	total, exported := 0, 0
	for i := range files {
		if files[i].IsTest || files[i].IsConfig {
			continue
		}
		total++
		if len(files[i].Exports) > 0 {
			exported++
		}
	}
	if total == 0 {
		return true
	}
	return float64(exported)/float64(total) < thematicSparseThreshold
}

// Build an isolated working RepoMap copy on sparse cached trees without mutating or writing back shared TreeMapCache.
func (h *Handler) enrichMapWithThematicSampling(ctx context.Context, m *RepoMap, req TreeOutlineRequest, patterns cognitive.Patterns, cb ProgressCallback) *RepoMap {
	if req.CustomPrompt == "" || m == nil || m.Tree == nil {
		return m
	}

	old := m.Tree.LeafFiles()
	leafIdx := make(map[string]FileMap, len(old))
	for _, f := range old {
		leafIdx[f.Path] = f
	}

	explicitMatched := MatchPromptPathsInLeaves(req.CustomPrompt, old, req.Prefix)
	explicitUnparsed := make([]string, 0, len(explicitMatched))
	for _, p := range explicitMatched {
		fm, ok := leafIdx[p]
		if !ok || fm.IsTest || fm.IsConfig || fm.IsDoc {
			continue
		}
		if len(fm.Exports) == 0 && len(fm.TopSymbols) == 0 && len(fm.Imports) == 0 {
			explicitUnparsed = append(explicitUnparsed, p)
			if len(explicitUnparsed) >= thematicSampleCap {
				break
			}
		}
	}

	sparse := thematicAstSparse(m)
	if !sparse && len(explicitUnparsed) == 0 {
		return m
	}

	sampler := h.samplerForReq(req.UserID, req.CustomPrompt, req.TeachingDepth, req.LearnerArchetype)
	if (sampler == nil && len(explicitUnparsed) == 0) || h.concurrentBlobFetcher == nil {
		return m
	}
	token := h.resolveOutlineToken(req)
	if token == "" || req.Owner == "" || req.Repo == "" || req.SHA == "" {
		log.Printf("[pipelineb] thematic enrich skipped: no remote git context (owner/repo/sha/token)")
		return m
	}
	defs := (*rsg.LanguageDefinitions)(nil)
	if h.defsFn != nil {
		defs = h.defsFn()
	}
	if defs == nil {
		log.Printf("[pipelineb] thematic enrich skipped: language definitions not wired")
		return m
	}

	seen := make(map[string]bool, thematicSampleCap)
	toFetch := make([]string, 0, thematicSampleCap)
	for _, p := range explicitUnparsed {
		if !seen[p] && len(toFetch) < thematicSampleCap {
			seen[p] = true
			toFetch = append(toFetch, p)
		}
	}

	subsystems := DiscoverSubsystems(SubsystemSourcesFromRepoMap(m), patterns)
	if sparse && sampler != nil && len(toFetch) < thematicSampleCap {
		skeleton := RenderSamplingSkeleton(m.Tree, defaultSamplingSkeletonBudget)
		if len(subsystems) > 0 {
			skeleton = RenderStratifiedSamplingSkeleton(m.Tree, subsystems, defaultSamplingSkeletonBudget)
		}

		// Skip AI sampler fallback output because rule fallback does not reflect user thematic intent.
		entries := make([]client.GitTreeEntry, 0, len(old))
		for _, f := range old {
			entries = append(entries, client.GitTreeEntry{Path: f.Path, Type: "blob", Size: int64(f.LOC)*32 + 1})
		}
		sreq := SampleRequest{
			Skeleton:         skeleton,
			Prefix:           req.Prefix,
			TeachingDepth:    req.TeachingDepth,
			LearnerArchetype: req.LearnerArchetype,
			CustomPrompt:     req.CustomPrompt,
		}
		corePaths, sampleMode := SampleOrFallbackCoreFiles(ctx, sampler, entries, sreq, patterns, subsystems)
		if sampleMode == SamplingStrategyFallback8 {
			if len(toFetch) == 0 {
				log.Printf("[pipelineb] thematic enrich skipped: sampler produced no directed files (fallback-8)")
				return m
			}
		} else {
			for _, p := range corePaths {
				clean := strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(p)), "/")
				if clean == "" || seen[clean] {
					continue
				}
				if fm, ok := leafIdx[clean]; !ok || len(fm.Exports) > 0 || len(fm.TopSymbols) > 0 {
					continue
				}
				seen[clean] = true
				toFetch = append(toFetch, clean)
				if len(toFetch) >= thematicSampleCap {
					break
				}
			}
			if len(toFetch) == 0 {
				log.Printf("[pipelineb] thematic enrich skipped: sampler named %d paths but none are sparse leaves", len(corePaths))
				return m
			}
		}
	}
	if len(toFetch) == 0 {
		return m
	}

	apiBase := h.GitHubAPIBase
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	ua := h.UserAgent
	if ua == "" {
		ua = "OpenGits-Engine/1.0"
	}

	fetchCtx, cancel := context.WithTimeout(ctx, thematicFetchTimeout)
	defer cancel()
	contents, truncated, err := h.concurrentBlobFetcher(fetchCtx, apiBase, req.Owner, req.Repo, req.SHA, toFetch, token, ua)
	if err != nil {
		log.Printf("[pipelineb] thematic enrich blob fetch failed (requested=%d): %v", len(toFetch), err)
		return m
	}
	if truncated {
		log.Printf("[pipelineb] thematic enrich blob fetch partial: fetched=%d/%d requested", len(contents), len(toFetch))
	}
	if len(contents) == 0 {
		log.Printf("[pipelineb] thematic enrich skipped: fetched 0/%d files", len(toFetch))
		return m
	}

	// Leave multiply-exported symbol names unlinked to avoid polluting Hotness and CallEdges with false edges.
	exportOwner := make(map[string]string, len(m.Files)*4)
	ambiguous := make(map[string]bool)
	for i := range m.Files {
		for _, e := range m.Files[i].Exports {
			if prev, dup := exportOwner[e]; dup && prev != m.Files[i].Path {
				ambiguous[e] = true
			} else if !dup {
				exportOwner[e] = m.Files[i].Path
			}
		}
	}

	enriched := make([]FileMap, 0, len(contents))
	newEdges := make([]ASTCallEdge, 0)
	for _, path := range toFetch {
		content, ok := contents[path]
		if !ok || content == "" {
			continue
		}
		fm := FileMap{
			Path:     path,
			LOC:      strings.Count(content, "\n") + 1,
			IsDoc:    patterns != nil && patterns.IsDocFile(path),
			IsTest:   patterns != nil && patterns.IsTestFile(path),
			IsConfig: patterns != nil && (patterns.IsConfigFile(path) || isMainConfigFile(strings.ToLower(filepath.Base(path)))),
		}
		ext := defs.ExtractFileAst(content, path)
		if ext != nil {
			for _, s := range ext.Symbols {
				if s.Exported && len(fm.Exports) < MaxExportsPerFile {
					fm.Exports = append(fm.Exports, s.Name)
				}
			}
			fm.TopSymbols = collectFallbackTopSymbols(ext, len(fm.Exports) > 0)
			for _, imp := range ext.Imports {
				if len(fm.Imports) < MaxImportsPerFile {
					fm.Imports = append(fm.Imports, imp.Module)
				}
			}
			localNames := make(map[string]bool, len(ext.Symbols))
			for _, sym := range ext.Symbols {
				localNames[sym.Name] = true
			}
			for _, cs := range ext.CallSites {
				if ambiguous[cs.Name] || localNames[cs.Name] {
					continue
				}
				if owner, ok := exportOwner[cs.Name]; ok && owner != path {
					fm.Hotness++
					newEdges = append(newEdges, ASTCallEdge{Caller: path, Callee: owner, Symbol: cs.Name})
				}
			}
		}
		enriched = append(enriched, fm)
	}
	if len(enriched) == 0 {
		log.Printf("[pipelineb] thematic enrich skipped: 0/%d fetched files parsed", len(toFetch))
		return m
	}

	byPath := make(map[string]FileMap, len(enriched))
	for _, f := range enriched {
		byPath[f.Path] = f
	}
	all := make([]FileMap, 0, len(old)+len(byPath))
	for _, f := range old {
		if nf, ok := byPath[f.Path]; ok {
			all = append(all, nf)
			continue
		}
		all = append(all, f)
	}
	m.CallEdges = append(m.CallEdges, newEdges...)
	m.Tree = BuildRepoTree(all, m.RepoName)
	m.Files = all
	m.TotalLOC = 0
	for _, f := range all {
		m.TotalLOC += f.LOC
	}
	m.EstTokens = estimateTokensFor(m)

	if cb != nil {
		cb(ProgressStep{
			Stage:  "sample",
			Title:  "专题定向提取",
			Detail: fmt.Sprintf("已定向补提 %d 个专题文件的 AST 符号", len(enriched)),
		})
	}
	log.Printf("[pipelineb] thematic enrich done: upgraded=%d sampled=%d leaves=%d", len(enriched), len(toFetch), len(old))
	return m
}

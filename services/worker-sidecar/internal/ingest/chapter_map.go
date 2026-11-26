package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

func profileToMap(profile SniffProfile) map[string]any {
	blob, err := json.Marshal(profile)
	if err != nil {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(blob, &m); err != nil {
		return map[string]any{}
	}
	if m == nil {
		return map[string]any{}
	}
	return m
}

func scopePrefixPtr(prefix string) *string {
	if prefix == "" {
		return nil
	}
	return &prefix
}

func resolveScopePrefix(prefixFilter, prefix string) string {
	if prefixFilter != "" {
		return prefixFilter
	}
	return prefix
}

var rootReadmeRe = regexp.MustCompile(`(?i)^readme\.(md|mdx|markdown)$`)

func splitScopePrefixes(prefixFilter string) []string {
	raw := strings.Split(prefixFilter, ",")
	out := make([]string, 0, len(raw))
	for _, p := range raw {
		p = strings.Trim(p, " ")
		p = strings.Trim(p, "/")
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Exempt root README from scope filtering so cross-scope entry docs are preserved.
func isRootReadme(p string) bool {
	return !strings.Contains(p, "/") && rootReadmeRe.MatchString(p)
}

func filterNodesByScope(nodes []GitNode, prefixFilter string) []GitNode {
	prefixes := splitScopePrefixes(prefixFilter)
	if len(prefixes) == 0 {
		return nodes
	}
	out := make([]GitNode, 0, len(nodes))
	for _, n := range nodes {
		under := false
		for _, p := range prefixes {
			if n.Path == p || strings.HasPrefix(n.Path, p+"/") {
				under = true
				break
			}
		}
		if under || isRootReadme(n.Path) {
			out = append(out, n)
		}
	}
	return out
}

// Drop translation roots overlapping scopePrefix so user-selected subtrees are not filtered empty.
func resolveTranslationScopeConflict(roots []string, prefixFilter string) []string {
	if prefixFilter == "" || len(roots) == 0 {
		return roots
	}
	normPrefix := prefixFilter
	if !strings.HasSuffix(normPrefix, "/") {
		normPrefix += "/"
	}
	kept := make([]string, 0, len(roots))
	for _, root := range roots {
		if root == normPrefix || strings.HasPrefix(root, normPrefix) || strings.HasPrefix(normPrefix, root) {
			continue
		}
		kept = append(kept, root)
	}
	return kept
}

func customOutlineFileUnderScope(filePath, prefixFilter string) bool {
	if prefixFilter == "" {
		return true
	}
	cleanPrefix := strings.Trim(prefixFilter, "/")
	if cleanPrefix == "" {
		return true
	}
	return filePath == cleanPrefix || strings.HasPrefix(filePath, cleanPrefix+"/") || isRootReadme(filePath)
}

var (
	mdExtRe        = mdpat.MdExtRe
	dashUnderscore = regexp.MustCompile(`[-_]`)
	wordStartRe    = regexp.MustCompile(`\b\w`)
)

func titleFromFileName(filePath string) string {
	base := path.Base(filePath)
	clean := mdExtRe.ReplaceAllString(base, "")
	clean = dashUnderscore.ReplaceAllString(clean, " ")
	clean = wordStartRe.ReplaceAllStringFunc(clean, strings.ToUpper)
	return clean
}

func buildChaptersFromCustomOutline(categories []CustomOutlineCategory, prefixFilter string) []ChapterInput {
	chapters := make([]ChapterInput, 0, len(categories))
	for _, cat := range categories {
		files := make([]ChapterFile, 0, len(cat.Files))
		for _, f := range cat.Files {
			basePath, anchor := mdpat.SplitPathAnchor(f.Path)
			if anchor == "" && f.Anchor != "" {
				anchor = f.Anchor
			}
			if basePath == "" || !customOutlineFileUnderScope(basePath, prefixFilter) {
				continue
			}
			title := f.ShortTitle
			if title == "" {
				title = f.Title
			}
			if title == "" {
				title = titleFromFileName(basePath)
				if anchor != "" {
					title = anchor
				}
			}
			files = append(files, ChapterFile{Path: basePath, Anchor: anchor, ShortTitle: title})
		}
		if len(files) == 0 {
			continue
		}
		title := cat.Name
		if title == "" {
			title = cat.Title
		}
		if title == "" {
			title = fmt.Sprintf("Chapter %d", len(chapters)+1)
		}
		chapters = append(chapters, ChapterInput{Title: title, PartTitle: cat.PartTitle, Files: files})
	}
	return chapters
}

type chapterMapChainDeps struct {
	LLM         LLMGenerator
	ArchiveRoot string
	Owner       string
	Repo        string
	Sha         string
	UserId      *string
}

func toChapterNodes(nodes []GitNode) []ChapterMapNode {
	out := make([]ChapterMapNode, len(nodes))
	for i, n := range nodes {
		out[i] = ChapterMapNode{Path: n.Path, Type: n.Type}
	}
	return out
}

const chapterMapLLMTimeout = 90 * time.Second

func runChapterMapChain(
	ctx context.Context,
	deps IngestBodyDeps,
	patterns *IngestPatterns,
	nodes []GitNode,
	textRoot string,
	chain chapterMapChainDeps,
) []ChapterMapEntry {
	cmNodes := toChapterNodes(nodes)

	if sidecarPath := patterns.FindTocSidecarPath(cmNodes, textRoot); sidecarPath != nil {
		content, readErr := readLocalArchiveFile(chain.ArchiveRoot, chain.Owner, chain.Repo, chain.Sha, *sidecarPath)
		if readErr != nil {
			log.Printf("[chapter-map] toc sidecar archive read failed %s: %v (fall through to next ladder step)", *sidecarPath, readErr)
		} else if strings.TrimSpace(content) != "" {
			if entries := patterns.ChapterMapFromSidecar(content, cmNodes, textRoot); len(entries) > 0 {
				return entries
			}
		}
	}

	if signal := patterns.DetectOrderSignal(cmNodes, "", "", textRoot); signal.Type == "numeric" {
		mainPaths := make([]string, 0, len(signal.Sequence))
		for _, p := range signal.Sequence {
			if patterns.IsDocFile(p) {
				mainPaths = append(mainPaths, p)
			}
		}
		if len(mainPaths) >= 2 {
			entries := make([]ChapterMapEntry, len(mainPaths))
			for i, p := range mainPaths {
				entries[i] = ChapterMapEntry{
					Order:      i + 1,
					Title:      chapter.DeriveChapterTitle(p),
					MainPath:   p,
					AssetPaths: []ChapterMapAsset{},
				}
			}
			return entries
		}
	}

	if deps.LLM == nil {
		return nil
	}
	candidates := patterns.BuildChapterCandidates(cmNodes, textRoot)
	if len(candidates.DocFiles) < 2 {
		return nil
	}
	displayRoot := textRoot
	if displayRoot == "" {
		displayRoot = "(repository root)"
	}
	variables := map[string]any{
		"owner":     chain.Owner,
		"repo":      chain.Repo,
		"textRoot":  displayRoot,
		"docFiles":  candidates.DocFiles,
		"codeFiles": candidates.CodeFiles,
	}
	llmCtx, cancel := context.WithTimeout(ctx, chapterMapLLMTimeout)
	defer cancel()
	var raw json.RawMessage
	if err := deps.LLM.Generate(llmCtx, "chapter_map", variables, chain.UserId, &raw); err != nil {
		if isMissingApiKeyErr(err) {
			return nil
		}
		log.Printf("[chapter-map] LLM chapter mapping failed for %s/%s: %v", chain.Owner, chain.Repo, err)
		return nil
	}
	return patterns.ValidateChapterMap(raw, cmNodes)
}

func isMissingApiKeyErr(err error) bool {
	type missingKey interface{ IsMissingApiKey() bool }
	mk, ok := err.(missingKey)
	return ok && mk.IsMissingApiKey()
}

var (
	docUrlExtRe   = mdpat.MdMarkdownExtRe
	trailingReadm = regexp.MustCompile(`(?i)/readme$`)
)

func toDocUrlPath(p string) string {
	urlPath := docUrlExtRe.ReplaceAllString(p, "")
	urlPath = trailingReadm.ReplaceAllString(urlPath, "")
	if strings.EqualFold(urlPath, "readme") {
		return ""
	}
	return urlPath
}

func buildCurriculumTreeFromMap(entries []ChapterMapEntry, owner, repo, targetLang string) []*NavNode {
	labels := curriculumLabelsFor(targetLang)
	ordered := make([]ChapterMapEntry, len(entries))
	copy(ordered, entries)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })

	chapters := make([]*NavNode, 0, len(ordered))
	for _, entry := range ordered {
		children := []*NavNode{{
			Name:       labels.MainText,
			Title:      labels.MainText,
			ShortTitle: labels.MainText,
			Type:       "file",
			Path:       entry.MainPath,
			PageType:   "text",
			Url:        fmt.Sprintf("/docs/%s/%s/%s", owner, repo, toDocUrlPath(entry.MainPath)),
		}}
		for _, asset := range entry.AssetPaths {
			if asset.Kind == "answer" {
				continue
			}
			filename := path.Base(asset.Path)
			label := fmt.Sprintf("%s · %s", labels.LabPrefix, filename)
			children = append(children, &NavNode{
				Name:       filename,
				Title:      label,
				ShortTitle: label,
				Type:       "file",
				Path:       asset.Path,
				PageType:   "readme",
				Url:        fmt.Sprintf("/docs/%s/%s/%s", owner, repo, toDocUrlPath(asset.Path)),
			})
		}
		title := entry.Title
		if title == "" {
			title = labels.ChapterTitle(entry.Order)
		}
		chapters = append(chapters, &NavNode{
			Title:    title,
			Type:     "directory",
			Children: children,
		})
	}
	return chapters
}

func chaptersFromChapterMap(entries []ChapterMapEntry) []ChapterInput {
	ordered := make([]ChapterMapEntry, len(entries))
	copy(ordered, entries)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Order < ordered[j].Order })

	chapters := make([]ChapterInput, 0, len(ordered))
	for _, entry := range ordered {
		if entry.MainPath == "" {
			continue
		}
		files := []ChapterFile{{Path: entry.MainPath, ShortTitle: entry.Title}}
		for _, asset := range entry.AssetPaths {
			if asset.Path == "" || asset.Kind == "answer" {
				continue
			}
			files = append(files, ChapterFile{Path: asset.Path, ShortTitle: path.Base(asset.Path)})
		}
		title := entry.Title
		if title == "" {
			title = fmt.Sprintf("Chapter %d", entry.Order)
		}
		chapters = append(chapters, ChapterInput{Title: title, Files: files})
	}
	return chapters
}

package chapter

import (
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// Alternates balanced one-level parens first for URLs like Go_(programming_language) without RE2 lookaround.
var chapterMapLinkPattern = regexp.MustCompile(`^\s*(?:[-*+]|\d{1,3}[.)])?\s*\[[^\]]*\]\(\s*(?:<([^>]+)>|((?:\([^)\r\n]*\)|[^)"'\r\n])+))\s*(?:["'][^"']*["'])?\s*\)`)

var chapterMapExternalLink = regexp.MustCompile(`(?i)^(https?:|mailto:)`)

var chapterMapMdExt = mdpat.MdMarkdownExtRe

var chapterMapReadmeFile = regexp.MustCompile(`(?i)^readme\.(md|mdx|markdown)$`)

type chapterTreeIndex struct {
	pathSet    map[string]bool
	blobPaths  []string
	dirFirstMd map[string]string
}

func indexChapterTree(scopedTree []ChapterMapNode) chapterTreeIndex {
	idx := chapterTreeIndex{
		pathSet:    map[string]bool{},
		dirFirstMd: map[string]string{},
	}
	for _, n := range scopedTree {
		if n.Type != "blob" {
			continue
		}
		if !idx.pathSet[n.Path] {
			idx.pathSet[n.Path] = true
			idx.blobPaths = append(idx.blobPaths, n.Path)
		}
	}
	dirs := map[string][]string{}
	var dirOrder []string
	for _, path := range idx.blobPaths {
		if !chapterMapMdExt.MatchString(path) {
			continue
		}
		dir := ""
		if i := strings.LastIndex(path, "/"); i >= 0 {
			dir = path[:i+1]
		}
		if _, ok := dirs[dir]; !ok {
			dirOrder = append(dirOrder, dir)
		}
		dirs[dir] = append(dirs[dir], path)
	}
	for _, dir := range dirOrder {
		files := dirs[dir]
		readme := ""
		for _, f := range files {
			name := f
			if i := strings.LastIndex(f, "/"); i >= 0 {
				name = f[i+1:]
			}
			if chapterMapReadmeFile.MatchString(name) {
				readme = f
				break
			}
		}
		if readme != "" {
			idx.dirFirstMd[dir] = readme
			continue
		}
		sorted := append([]string(nil), files...)
		sort.SliceStable(sorted, func(i, j int) bool { return mdpat.JsLocaleCompare(sorted[i], sorted[j]) < 0 })
		idx.dirFirstMd[dir] = sorted[0]
	}
	return idx
}

func parseMarkdownLinkSequence(text string, idx chapterTreeIndex, prefix string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, rawLine := range strings.Split(text, "\n") {
		rawLine = strings.TrimSuffix(rawLine, "\r")
		m := chapterMapLinkPattern.FindStringSubmatch(rawLine)
		if m == nil {
			continue
		}
		link := m[1]
		if link == "" {
			link = m[2]
		}
		if i := strings.Index(link, "#"); i >= 0 {
			link = link[:i]
		}
		link = strings.TrimSpace(link)
		if link == "" || chapterMapExternalLink.MatchString(link) {
			continue
		}
		if decoded, err := url.PathUnescape(link); err == nil {
			link = decoded
		}
		link = strings.TrimPrefix(link, "./")
		link = strings.TrimPrefix(link, "/")
		link = strings.TrimRight(link, "/")

		resolve := func(c string) (string, bool) {
			if idx.pathSet[c] {
				return c, true
			}
			if md, ok := idx.dirFirstMd[c+"/"]; ok {
				return md, true
			}
			return "", false
		}
		bases := []string{link}
		if prefix != "" {
			bases = append(bases, prefix+link)
		}
		hit := ""
		for _, b := range bases {
			if h, ok := resolve(b); ok {
				hit = h
				break
			}
		}
		if hit != "" && !seen[hit] {
			seen[hit] = true
			out = append(out, hit)
		}
	}
	return out
}

func normalizeRootPrefix(textRoot string) string {
	if textRoot == "" {
		return ""
	}
	if strings.HasSuffix(textRoot, "/") {
		return textRoot
	}
	return textRoot + "/"
}

func FindTocSidecarPath(nodes []ChapterMapNode, textRoot string) *string {
	return getDefaultPatterns().FindTocSidecarPath(nodes, textRoot)
}

func (p *ingestPatterns) FindTocSidecarPath(nodes []ChapterMapNode, textRoot string) *string {
	root := normalizeRootPrefix(textRoot)
	found := []string{}
	sidecarPatterns := p.tocSidecar
	if len(sidecarPatterns) == 0 {
		sidecarPatterns = mdpat.CompileJSRegexes([]mdpat.JsRegex{
			{Source: `^(?i)(?:summary|toc|table[-_]of[-_]contents|menu|index)\.(?:md|markdown|txt)$`, Flags: "i"},
		}, "chapter")
	}

	for _, node := range nodes {
		if node.Type != "blob" {
			continue
		}
		fileName := node.Path
		if i := strings.LastIndex(node.Path, "/"); i >= 0 {
			fileName = node.Path[i+1:]
		}
		matched := false
		for _, re := range sidecarPatterns {
			if re.MatchString(fileName) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		if root != "" && !strings.HasPrefix(node.Path, root) {
			continue
		}
		found = append(found, node.Path)
	}
	sort.SliceStable(found, func(i, j int) bool {
		di := strings.Count(found[i], "/")
		dj := strings.Count(found[j], "/")
		if di != dj {
			return di < dj
		}
		return naturalCompare(found[i], found[j]) < 0
	})
	if len(found) == 0 {
		return nil
	}
	return &found[0]
}

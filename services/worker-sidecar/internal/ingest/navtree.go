package ingest

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/opengits/worker-sidecar/internal/mdpat"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type NavNode struct {
	Name       string     `json:"name"`
	Title      string     `json:"title"`
	ShortTitle string     `json:"shortTitle,omitempty"`
	Type       string     `json:"type"`
	Path       string     `json:"path"`
	Url        string     `json:"url"`
	PageType   string     `json:"pageType,omitempty"`
	Children   []*NavNode `json:"children,omitempty"`
}

var mdExtStripRe = mdpat.MdExtRe
var camelCaseRe = regexp.MustCompile(`[a-z]+[A-Z]`)

func (p *IngestPatterns) FormatHumanReadableTitle(rawName string) string {
	if rawName == "" {
		return ""
	}
	name := mdExtStripRe.ReplaceAllString(rawName, "")
	name = p.stripNumericPrefix(name)
	name = strings.TrimSpace(strings.NewReplacer("-", " ", "_", " ").Replace(name))
	if name == "" {
		return ""
	}

	words := strings.Fields(name)
	out := make([]string, len(words))
	for i, w := range words {
		lower := strings.ToLower(w)
		if mapped, ok := p.TechAcronyms[lower]; ok {
			out[i] = mapped
			continue
		}
		if camelCaseRe.MatchString(w) {
			out[i] = w
			continue
		}
		out[i] = upperFirstRune(w)
	}
	return strings.Join(out, " ")
}

// Procedural prefix stripper preserves lookahead semantics unsupported by RE2 (e.g. keeps 4-digit years like 2024-report).
func (p *IngestPatterns) stripNumericPrefix(name string) string {
	s := name
	for {
		if next, ok := stripBracketedNumber(s); ok {
			s = next
			continue
		}
		if next, ok := stripNumberSeparator(s); ok {
			s = next
			continue
		}
		break
	}
	if i := digitsAt(s, 3); i > 0 && i < len(s) && isSpaceByte(s[i]) {
		s = strings.TrimLeft(s[i:], " \t\n\r")
	}
	return strings.TrimLeft(s, " \t\n\r")
}

var openBrackets = "((（【"
var closeBrackets = "))）】"
var seps = "-_.、）)：:"

func firstRune(s string) rune {
	for _, r := range s {
		return r
	}
	return 0
}

func stripBracketedNumber(s string) (string, bool) {
	if s == "" || !strings.ContainsRune(openBrackets, firstRune(s)) {
		return s, false
	}
	_, firstLen := utf8.DecodeRuneInString(s)
	n := digitsAt(s[firstLen:], 3)
	if n == 0 {
		return s, false
	}
	rest := s[firstLen+n:]
	if rest == "" || !strings.ContainsRune(closeBrackets, firstRune(rest)) {
		return s, false
	}
	_, closeLen := utf8.DecodeRuneInString(rest)
	rest = rest[closeLen:]
	for rest != "" && strings.ContainsRune(" \t._-", rune(rest[0])) {
		rest = rest[1:]
	}
	return rest, true
}

func stripNumberSeparator(s string) (string, bool) {
	for take := 3; take >= 1; take-- {
		if len(s) < take {
			continue
		}
		n := digitsAt(s, take)
		if n != take {
			continue
		}
		rest := strings.TrimLeft(s[n:], " \t")
		if rest == "" {
			continue
		}
		// Decode full rune before checking separators because multibyte CJK punctuation fails single-byte checks.
		sep, sepLen := utf8.DecodeRuneInString(rest)
		if !strings.ContainsRune(seps, sep) {
			continue
		}
		rest = strings.TrimLeft(rest[sepLen:], " \t")
		return rest, true
	}
	return s, false
}

func digitsAt(s string, max int) int {
	i := 0
	for i < len(s) && i < max && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return i
}

func isSpaceByte(b byte) bool { return b == ' ' || b == '\t' || b == '\n' || b == '\r' }

func upperFirstRune(w string) string {
	if w == "" {
		return w
	}
	r := []rune(w)
	r[0] = unicode.ToUpper(r[0])
	return string(r)
}

var urlMdStripRe = regexp.MustCompile(`\.mdx?$`)
var urlReadmeTailRe = regexp.MustCompile(`/[rR][eE][aA][dD][mM][eE]$`)

func BuildNavTree(p *Patterns, nodes []GitNode, owner, repo, prefixFilter string) []*NavNode {
	return p.BuildNavTree(nodes, owner, repo, prefixFilter)
}

func (p *IngestPatterns) BuildNavTree(nodes []GitNode, owner, repo, prefixFilter string) []*NavNode {
	var root []*NavNode

	var markdownFiles []GitNode
	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		lower := strings.ToLower(n.Path)
		for _, ext := range p.Sniffer.MarkdownExtensions {
			if strings.HasSuffix(lower, strings.ToLower(ext)) {
				markdownFiles = append(markdownFiles, n)
				break
			}
		}
	}
	if prefixFilter != "" {
		var filtered []GitNode
		for _, n := range markdownFiles {
			if strings.HasPrefix(n.Path, prefixFilter) {
				filtered = append(filtered, n)
			}
		}
		markdownFiles = filtered
	}

	for _, file := range markdownFiles {
		parts := strings.Split(file.Path, "/")
		currentLevel := &root
		for index := 0; index < len(parts); index++ {
			part := parts[index]
			isFile := index == len(parts)-1

			var existing *NavNode
			for _, n := range *currentLevel {
				if n.Name == part {
					existing = n
					break
				}
			}
			if existing == nil {
				rawPath := strings.Join(parts[:index+1], "/")
				urlPath := urlMdStripRe.ReplaceAllString(rawPath, "")
				if isFile {
					urlPath = urlReadmeTailRe.ReplaceAllString(urlPath, "")
				}
				if isFile && strings.ToLower(urlPath) == "readme" {
					urlPath = ""
				}
				node := &NavNode{
					Name:  part,
					Title: p.FormatHumanReadableTitle(part),
					Path:  rawPath,
					Url:   "/docs/" + owner + "/" + repo + "/" + urlPath,
				}
				if isFile {
					node.Type = "file"
				} else {
					node.Type = "directory"
					node.Children = []*NavNode{}
				}
				*currentLevel = append(*currentLevel, node)
				existing = node
			}
			if !isFile {
				currentLevel = &existing.Children
			}
		}
	}

	p.sortNavTree(root)
	return root
}

var navCollator = collate.New(language.Und)

// Sort CJK-leading titles before ASCII titles before root collation to match frontend localeCompare order.
func navTitleLess(a, b string) bool {
	ca, cb := titleClass(a), titleClass(b)
	if ca != cb {
		return ca < cb
	}
	return navCollator.CompareString(a, b) < 0
}

func titleClass(t string) int {
	r := firstRune(t)
	if unicode.Is(unicode.Han, r) {
		return 0
	}
	return 1
}

func (p *IngestPatterns) sortNavTree(nodes []*NavNode) {
	sort.SliceStable(nodes, func(i, j int) bool {
		numA, numB := p.navNumericPrefix(nodes[i].Name), p.navNumericPrefix(nodes[j].Name)
		if numA != numB {
			return numA < numB
		}
		return navTitleLess(nodes[i].Title, nodes[j].Title)
	})
	for _, n := range nodes {
		if len(n.Children) > 0 {
			p.sortNavTree(n.Children)
		}
	}
}

func (p *IngestPatterns) navNumericPrefix(name string) int {
	// Guard nil numericPrefix when RE2 compilation fails so sorting falls back safely to collation-only.
	if p.Sniffer.numericPrefix == nil {
		return 9999
	}
	if m := p.Sniffer.numericPrefix.FindStringSubmatch(name); m != nil {
		v := 0
		for _, c := range m[1] {
			v = v*10 + int(c-'0')
		}
		return v
	}
	return 9999
}

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

// NavNode 导航树节点（结构体 SSOT;短字段省略的 JSON 形态与 TS 消费一致）。
type NavNode struct {
	Name       string     `json:"name"`
	Title      string     `json:"title"`
	ShortTitle string     `json:"shortTitle,omitempty"` // 课程树正文/实验标签（缺省回退 title）
	Type       string     `json:"type"`                 // file | directory
	Path       string     `json:"path"`
	Url        string     `json:"url"`
	PageType   string     `json:"pageType,omitempty"` // text | readme（课程树教学分类）
	Children   []*NavNode `json:"children,omitempty"`
}

// ─────────────────────────────────────────────────────────────
// 规则导航树（原移植自 TS structurizer.ts buildNavTree，该原体已退役；
// prefix-cleaner.formatHumanReadableTitle 仍活且锁步；行为基准 = testdata/navtree.golden.json）。
// 刻意差异（FactDrift）：多级数字前缀剥离为过程式移植（原正则含 RE2 不支持
// 的 lookahead）；排序并列的 title 比较用 x/text root collation 近似 ICU
// localeCompare（ASCII 语义一致，冷门脚本序可能微差——golden 兜底）。
// ─────────────────────────────────────────────────────────────

var mdExtStripRe = mdpat.MdExtRe
var camelCaseRe = regexp.MustCompile(`[a-z]+[A-Z]`)

// FormatHumanReadableTitle 与 prefix-cleaner.formatHumanReadableTitle 逐字对齐：
// 去扩展名 → 剥数字前缀 → [-_]→空格 → 分词（缩写保真/camelCase 保留/首字母大写）。
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

// stripNumericPrefix 过程式移植 multiLevelNumericPrefixPattern（含回溯语义：
// "2024-report" 的 4 位年份不剥；"(1)-setup" 剥括号+分隔；(1) (2.5) (1.2.3-) 剥级联）。
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
	// 尾随裸数字：仅当其后紧跟空白才剥（对齐 (?=\s) lookahead）
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
	// [\s._-]* 尾随
	for rest != "" && strings.ContainsRune(" \t._-", rune(rest[0])) {
		rest = rest[1:]
	}
	return rest, true
}

// stripNumberSeparator 对齐 (?:\d{1,3}\s*[-_.、）)：:]\s*) 的一次重复
// （含 \d{1,3} 贪婪回溯：3/2/1 位依次试分隔符）。
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
		// seps 含多字节全角分隔符（、）），必须解码首 rune 再判定；
		// 用首字节转 rune 会得到 U+00E3/U+00EF 一类错值，永不命中。
		sep, sepLen := utf8.DecodeRuneInString(rest)
		if !strings.ContainsRune(seps, sep) {
			continue
		}
		rest = strings.TrimLeft(rest[sepLen:], " \t")
		return rest, true
	}
	return s, false
}

// digitsAt 返回 s 开头最多 max 位连续数字的长度。
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

// BuildNavTree 包级函数导出：使用 patterns 构建规则导航树。
func BuildNavTree(p *Patterns, nodes []GitNode, owner, repo, prefixFilter string) []*NavNode {
	return p.BuildNavTree(nodes, owner, repo, prefixFilter)
}

// BuildNavTree 与 Structurizer.buildNavTree 逐字对齐（markdown 过滤 → 路径
// 插入 → README url 规则 → 数字前缀排序 + collation 并列）。
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

// navTitleLess 排序并列的 title 比较：Node localeCompare 在本仓库观察语义
// 为 CJK 起始标题排在 ASCII 起始之前（golden 固化），其后按 root collation。
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
	// numericPrefix 编译失败（RE2 不兼容）时为 nil：按装载处 WARN 承诺回落
	// collation-only（恒 9999），旧实现无 nil 守卫直接 panic。
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

package cognitive

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// cleanShortTitle 生成人类可读文件名短标题
func cleanShortTitle(p string) string {
	base := p
	if idx := strings.LastIndex(p, "/"); idx >= 0 {
		base = p[idx+1:]
	}
	if dot := strings.LastIndex(base, "."); dot > 0 {
		base = base[:dot]
	}
	base = strings.ReplaceAll(base, "-", " ")
	base = strings.ReplaceAll(base, "_", " ")
	return base
}

// slugifyAnchor 规范化锚点标识符（支持 Unicode/CJK）
func slugifyAnchor(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimSuffix(s, "()")
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || mdpat.IsCJKRune(r) {
			b.WriteRune(r)
			lastDash = false
		} else if r == '-' || r == ' ' || r == '.' || r == '/' {
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	res := strings.Trim(b.String(), "-")
	if res == "" && s != "" {
		return "h-" + mdpat.Fnv64aHex(s)
	}
	return res
}

// BUG-65 已关闭(36 门语法资产内嵌,commit 0383ecf8):正则符号兜底整块
// 退役。零符号文件就是零符号——不得用关键词匹配伪造锚点(幻影锚点
// 正是下游 outline_sanitizer 锚点验证要清理的对象)。

// AnchorExtractContext 封装锚点抽取策略所需上下文
type AnchorExtractContext struct {
	CodeCandidates []CandidateOutlineFile
	DocCandidates  []CandidateOutlineFile
	AllNodes       []GitNode
	FileReader     FileReader
	Extractor      SymbolExtractor
	Patterns       Patterns
	SeenAnchorKey  map[string]bool
}

// SubFileAnchorExtractor 锚点抽取策略接口 (Strategy Pattern)
type SubFileAnchorExtractor interface {
	Name() string
	Extract(ctx *AnchorExtractContext) []CandidateOutlineFile
}

// CodeSymbolAnchorStrategy 代码语法树/符号锚点抽取策略
type CodeSymbolAnchorStrategy struct{}

func (s *CodeSymbolAnchorStrategy) Name() string { return "CodeSymbol" }

func (s *CodeSymbolAnchorStrategy) Extract(ctx *AnchorExtractContext) []CandidateOutlineFile {
	return extractCodeSymbolAnchors(ctx.CodeCandidates, ctx.FileReader, ctx.Extractor, ctx.SeenAnchorKey)
}

// DocHeadingAnchorStrategy Markdown 标题锚点抽取策略
type DocHeadingAnchorStrategy struct{}

func (s *DocHeadingAnchorStrategy) Name() string { return "DocHeading" }

func (s *DocHeadingAnchorStrategy) Extract(ctx *AnchorExtractContext) []CandidateOutlineFile {
	return extractDocHeadingAnchors(ctx.DocCandidates, ctx.FileReader, ctx.SeenAnchorKey)
}

// TestSpecAnchorStrategy 测试用例 Spec 锚点抽取策略
type TestSpecAnchorStrategy struct{}

func (s *TestSpecAnchorStrategy) Name() string { return "TestSpec" }

func (s *TestSpecAnchorStrategy) Extract(ctx *AnchorExtractContext) []CandidateOutlineFile {
	return extractTestSpecAnchors(ctx.AllNodes, ctx.FileReader, ctx.Extractor, ctx.Patterns, ctx.SeenAnchorKey)
}

// CompositeAnchorExtractor 复合锚点抽取策略协调器 (Composite Strategy)
type CompositeAnchorExtractor struct {
	strategies []SubFileAnchorExtractor
}

func NewCompositeAnchorExtractor(strategies ...SubFileAnchorExtractor) *CompositeAnchorExtractor {
	return &CompositeAnchorExtractor{strategies: strategies}
}

func (c *CompositeAnchorExtractor) Extract(ctx *AnchorExtractContext) []CandidateOutlineFile {
	var result []CandidateOutlineFile
	for _, strategy := range c.strategies {
		anchors := strategy.Extract(ctx)
		result = append(result, anchors...)
	}
	return result
}

var defaultAnchorExtractor = NewCompositeAnchorExtractor(
	&CodeSymbolAnchorStrategy{},
	&DocHeadingAnchorStrategy{},
	&TestSpecAnchorStrategy{},
)

func extractCodeSymbolAnchors(
	codeCandidates []CandidateOutlineFile,
	fileReader FileReader,
	extractor SymbolExtractor,
	seenAnchorKey map[string]bool,
) []CandidateOutlineFile {
	var anchors []CandidateOutlineFile
	for _, c := range codeCandidates {
		bytes, err := fileReader(c.Path)
		if err != nil || len(bytes) == 0 {
			continue
		}
		content := string(bytes)

		var symbols []SymbolEntry
		if extractor != nil {
			symbols = extractor.ExtractSymbols(content, c.Path)
		}

		var exported []SymbolEntry
		for _, s := range symbols {
			if s.Exported {
				exported = append(exported, s)
			}
		}
		if len(exported) == 0 && len(symbols) > 0 {
			exported = symbols
		}

		sort.SliceStable(exported, func(i, j int) bool {
			kindPriority := func(k string) int {
				switch k {
				case "function":
					return 3
				case "type", "class", "interface":
					return 2
				default:
					return 1
				}
			}
			pi, pj := kindPriority(exported[i].Kind), kindPriority(exported[j].Kind)
			if pi != pj {
				return pi > pj
			}
			return exported[i].StartLine < exported[j].StartLine
		})

		const maxSymbolsPerFile = 15
		if len(exported) > maxSymbolsPerFile {
			exported = exported[:maxSymbolsPerFile]
		}

		for _, sym := range exported {
			if sym.Name == "" {
				continue
			}
			key := c.Path + "#" + sym.Name
			if seenAnchorKey[key] {
				continue
			}
			seenAnchorKey[key] = true

			weight := 18
			if sym.Kind == "function" {
				weight = 20
			} else if sym.Kind == "type" || sym.Kind == "interface" {
				weight = 16
			}

			detail := ""
			if sym.StartLine > 0 && sym.EndLine >= sym.StartLine {
				linesCount := sym.EndLine - sym.StartLine + 1
				if linesCount <= 30 {
					detail = fmt.Sprintf("line %d-%d (%d lines, micro-component)", sym.StartLine, sym.EndLine, linesCount)
				} else {
					detail = fmt.Sprintf("line %d-%d (%d lines)", sym.StartLine, sym.EndLine, linesCount)
				}
			}

			anchors = append(anchors, CandidateOutlineFile{
				Path:   c.Path,
				Anchor: sym.Name,
				Kind:   sym.Kind,
				Detail: detail,
				IsDoc:  false,
				Role:   sym.Kind,
				Weight: weight,
			})
		}
	}
	return anchors
}

func extractDocHeadingAnchors(
	docCandidates []CandidateOutlineFile,
	fileReader FileReader,
	seenAnchorKey map[string]bool,
) []CandidateOutlineFile {
	var anchors []CandidateOutlineFile
	headingRe := regexp.MustCompile(`(?m)^#{2,3}\s+([^#\n\r]+)`)

	for _, d := range docCandidates {
		bytes, err := fileReader(d.Path)
		if err != nil || len(bytes) == 0 {
			continue
		}
		matches := headingRe.FindAllStringSubmatch(string(bytes), -1)
		headingCount := 0
		for _, sm := range matches {
			if len(sm) < 2 {
				continue
			}
			heading := strings.TrimSpace(sm[1])
			heading = strings.Trim(heading, "`*#")
			lower := strings.ToLower(heading)
			if lower == "" ||
				strings.Contains(lower, "license") ||
				strings.Contains(lower, "contributing") ||
				strings.Contains(lower, "badge") ||
				strings.Contains(lower, "changelog") ||
				strings.Contains(lower, "sponsor") ||
				strings.Contains(lower, "backer") ||
				strings.Contains(lower, "code of conduct") ||
				strings.Contains(lower, "table of contents") ||
				lower == "toc" ||
				lower == "contents" ||
				strings.Contains(lower, "acknowledgement") ||
				strings.Contains(lower, "security") ||
				strings.Contains(lower, "author") {
				continue
			}

			key := d.Path + "#" + heading
			if seenAnchorKey[key] {
				continue
			}
			seenAnchorKey[key] = true

			weight := 17
			if strings.EqualFold(heading, "usage") ||
				strings.EqualFold(heading, "quick start") ||
				strings.EqualFold(heading, "api") ||
				strings.EqualFold(heading, "examples") ||
				strings.Contains(lower, "example") {
				weight = 22
			}

			anchors = append(anchors, CandidateOutlineFile{
				Path:   d.Path,
				Anchor: heading,
				Kind:   "heading",
				Detail: "section",
				IsDoc:  true,
				Role:   "documentation",
				Weight: weight,
			})
			headingCount++
			if headingCount >= 8 {
				break
			}
		}
	}
	return anchors
}

func extractTestSpecAnchors(
	allNodes []GitNode,
	fileReader FileReader,
	extractor SymbolExtractor,
	patterns Patterns,
	seenAnchorKey map[string]bool,
) []CandidateOutlineFile {
	var anchors []CandidateOutlineFile
	var testNodes []GitNode
	for _, n := range allNodes {
		if n.Type == "blob" && patterns != nil && patterns.IsTestFile(n.Path) {
			testNodes = append(testNodes, n)
			if len(testNodes) >= 2 {
				break
			}
		}
	}

	// LINT-EXEMPT: code-syntax-regex-fallback (测试规格锚点为存量兜底:
	// it/test/t.Run/def test_ 等测试声明抽取作规格锚——待引擎补测试声明
	// 查询后迁 AST,go.scm 的 function_declaration 已天然覆盖 Go Test 函数)
	testSpecRe := regexp.MustCompile(`(?:it|test)(?:\.[a-zA-Z0-9_$]+)?\s*\(\s*['"` + "`" + `]([^'` + "`" + `"\r\n]+)['"` + "`" + `]`)
	goTestRe := regexp.MustCompile(`func\s+(Test[A-Za-z0-9_]+)\(`)
	goSubTestRe := regexp.MustCompile(`t\.Run\s*\(\s*["']([^"']+)["']`)
	pyTestRe := regexp.MustCompile(`def\s+(test_[A-Za-z0-9_]+)\(`)
	rustTestRe := regexp.MustCompile(`(?:#\[test\]\s+)?fn\s+(test_[A-Za-z0-9_]+)\(`)

	for _, tn := range testNodes {
		bytes, err := fileReader(tn.Path)
		if err != nil || len(bytes) == 0 {
			continue
		}
		content := string(bytes)

		var specs []string

		// 1. AST-based test declaration extraction (Tree-sitter)
		if extractor != nil {
			testSymbols := extractor.ExtractSymbols(content, tn.Path)
			for _, s := range testSymbols {
				if s.Kind == "function" {
					if strings.HasPrefix(s.Name, "Test") || strings.HasPrefix(s.Name, "test_") {
						specs = append(specs, s.Name)
					}
				}
			}
		}

		// 2. BDD string specs and subtests (it / test / t.Run) and regex fallback
		if len(specs) < 5 {
			for _, sm := range testSpecRe.FindAllStringSubmatch(content, -1) {
				if len(sm) > 1 && sm[1] != "" {
					specs = append(specs, strings.TrimSpace(sm[1]))
				}
			}
			for _, sm := range goSubTestRe.FindAllStringSubmatch(content, -1) {
				if len(sm) > 1 && sm[1] != "" {
					specs = append(specs, strings.TrimSpace(sm[1]))
				}
			}
			if len(specs) == 0 {
				for _, sm := range goTestRe.FindAllStringSubmatch(content, -1) {
					if len(sm) > 1 && sm[1] != "" {
						specs = append(specs, strings.TrimSpace(sm[1]))
					}
				}
				for _, sm := range pyTestRe.FindAllStringSubmatch(content, -1) {
					if len(sm) > 1 && sm[1] != "" {
						specs = append(specs, strings.TrimSpace(sm[1]))
					}
				}
				for _, sm := range rustTestRe.FindAllStringSubmatch(content, -1) {
					if len(sm) > 1 && sm[1] != "" {
						specs = append(specs, strings.TrimSpace(sm[1]))
					}
				}
			}
		}

		if len(specs) > 5 {
			specs = specs[:5]
		}

		for _, spec := range specs {
			key := tn.Path + "#" + spec
			if seenAnchorKey[key] {
				continue
			}
			seenAnchorKey[key] = true

			anchors = append(anchors, CandidateOutlineFile{
				Path:   tn.Path,
				Anchor: spec,
				Kind:   "spec",
				Detail: "test case",
				IsDoc:  false,
				Role:   "test_specification",
				Weight: 14,
			})
		}
	}
	return anchors
}

// ExtractSubFileAnchors 采用复合策略调度器从候选源码、文档与测试规范中提取 Zoom 2 锚点
func ExtractSubFileAnchors(
	codeCandidates []CandidateOutlineFile,
	docCandidates []CandidateOutlineFile,
	allNodes []GitNode,
	fileReader FileReader,
	extractor SymbolExtractor,
	patterns Patterns,
) []CandidateOutlineFile {
	if fileReader == nil {
		return nil
	}

	ctx := &AnchorExtractContext{
		CodeCandidates: codeCandidates,
		DocCandidates:  docCandidates,
		AllNodes:       allNodes,
		FileReader:     fileReader,
		Extractor:      extractor,
		Patterns:       patterns,
		SeenAnchorKey:  make(map[string]bool),
	}

	return defaultAnchorExtractor.Extract(ctx)
}

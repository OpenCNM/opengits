package concept

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode"

	"github.com/opengits/worker-sidecar/internal/chunker"
	"github.com/opengits/worker-sidecar/internal/mdpat"
	"github.com/opengits/worker-sidecar/internal/treesitter"
)

// ─────────────────────────────────────────────────────────────
// Heading 回退概念提取（移植 apps/client/src/lib/mcp/concept-extractor.ts
// :103-265 全语义）：无 manifest 的内容（web-doc 页、降级转录、零 LLM 复用）
// 从标题块提取最多 5 个概念——MCP 概念检索/共现边对这些文档不再恒空。
// ─────────────────────────────────────────────────────────────

const maxConceptsPerDoc = 5

var (
	tsEngine     *treesitter.Engine
	tsEngineOnce sync.Once
)

// SetTsEngine 设置或覆盖 Tree-sitter 引擎（用于单测或外部注入）。
func SetTsEngine(engine *treesitter.Engine) {
	tsEngine = engine
}

func getTsEngine() *treesitter.Engine {
	tsEngineOnce.Do(func() {
		if tsEngine != nil {
			return
		}
		ctx := context.Background()
		engine, err := treesitter.NewEngine(ctx)
		if err == nil {
			tsEngine = engine
		}
	})
	return tsEngine
}

func normalizeTsLang(rawLang string) string {
	switch strings.ToLower(strings.TrimSpace(rawLang)) {
	case "go", "golang":
		return "go"
	case "ts", "typescript", "tsx":
		return "tsx"
	case "js", "javascript", "jsx":
		return "javascript"
	case "py", "python":
		return "python"
	case "rs", "rust":
		return "rust"
	case "java":
		return "java"
	case "c":
		return "c"
	case "cpp", "c++", "cc", "cxx":
		return "cpp"
	case "cs", "csharp":
		return "csharp"
	case "php":
		return "php"
	case "rb", "ruby":
		return "ruby"
	case "kt", "kotlin":
		return "kotlin"
	case "swift":
		return "swift"
	case "dart":
		return "dart"
	case "scala":
		return "scala"
	case "sh", "bash", "zsh":
		return "bash"
	case "lua":
		return "lua"
	case "ex", "elixir":
		return "elixir"
	case "zig":
		return "zig"
	case "sql":
		return "sql"
	default:
		return rawLang
	}
}

type codeBlockSnippet struct {
	lang  string
	code  string
	lines []string
}

func isExportedSymbol(s treesitter.SymbolMatch, lines []string, lang string) bool {
	if s.Name == "" {
		return false
	}
	r := []rune(s.Name)
	if len(r) == 0 {
		return false
	}

	var line string
	if s.StartLine >= 1 && s.StartLine <= len(lines) {
		line = lines[s.StartLine-1]
	}
	trimmed := strings.TrimSpace(line)

	switch lang {
	case "go":
		return unicode.IsUpper(r[0])
	case "python", "ruby":
		indent := len(line) - len(strings.TrimLeft(line, " \t"))
		return indent == 0 && !strings.HasPrefix(s.Name, "_")
	case "tsx", "javascript":
		return strings.HasPrefix(trimmed, "export ") || strings.HasPrefix(trimmed, "export\t") || strings.Contains(trimmed, "export default") || s.Kind == "type"
	case "rust":
		return strings.Contains(trimmed, "pub ") || strings.Contains(trimmed, "pub(")
	case "java", "csharp", "php":
		return strings.Contains(trimmed, "public ") || s.Kind == "type"
	default:
		if unicode.IsUpper(r[0]) || strings.Contains(trimmed, "export") || strings.Contains(trimmed, "pub") {
			return true
		}
		return s.Kind == "type"
	}
}

// extractAstPhysicalConcepts 扫描代码块或源文件中的公开导出标识符/结构体/接口/函数。
func extractAstPhysicalConcepts(lines []string, content, docPath string, labels ConceptLabels) []ExtractedConcept {
	var codeBlocks []codeBlockSnippet
	var currentCodeLines []string
	currentLang := ""
	inCodeFence := false
	var fenceChar byte
	fenceLen := 0

	for _, line := range lines {
		fenceMatch := mdpat.FenceOpenRe.FindStringSubmatch(line)
		if !inCodeFence {
			if fenceMatch != nil {
				inCodeFence = true
				fenceChar = fenceMatch[1][0]
				fenceLen = len(fenceMatch[1])
				infoStr := strings.TrimSpace(fenceMatch[2])
				fields := strings.FieldsFunc(infoStr, func(r rune) bool {
					return unicode.IsSpace(r) || r == ':' || r == '{'
				})
				currentLang = ""
				if len(fields) > 0 {
					currentLang = strings.ToLower(fields[0])
				}
				currentCodeLines = nil
			}
		} else {
			if fenceMatch != nil && fenceMatch[1][0] == fenceChar && len(fenceMatch[1]) >= fenceLen && strings.TrimSpace(fenceMatch[2]) == "" {
				inCodeFence = false
				if len(currentCodeLines) > 0 {
					codeBlocks = append(codeBlocks, codeBlockSnippet{
						lang:  currentLang,
						code:  strings.Join(currentCodeLines, "\n"),
						lines: currentCodeLines,
					})
				}
				currentCodeLines = nil
			} else {
				currentCodeLines = append(currentCodeLines, line)
			}
		}
	}
	if inCodeFence && len(currentCodeLines) > 0 {
		codeBlocks = append(codeBlocks, codeBlockSnippet{
			lang:  currentLang,
			code:  strings.Join(currentCodeLines, "\n"),
			lines: currentCodeLines,
		})
	}

	// 若未发现 Markdown 围栏，探测文件自身是否是代码文件
	if len(codeBlocks) == 0 {
		detectedLang := treesitter.DetectLanguage(docPath)
		if detectedLang != "" {
			codeBlocks = append(codeBlocks, codeBlockSnippet{
				lang:  detectedLang,
				code:  content,
				lines: lines,
			})
		}
	}

	if len(codeBlocks) == 0 {
		return nil
	}

	engine := getTsEngine()
	if engine == nil {
		return nil
	}

	ctx := context.Background()
	seenNames := make(map[string]bool)
	var out []ExtractedConcept

	for _, cb := range codeBlocks {
		tsLang := normalizeTsLang(cb.lang)
		if tsLang == "" {
			tsLang = treesitter.DetectLanguage(docPath)
		}
		if tsLang == "" {
			continue
		}

		res, err := engine.ParseAndExtract(ctx, tsLang, []byte(cb.code))
		if err != nil || res == nil || len(res.Symbols) == 0 {
			continue
		}

		for _, s := range res.Symbols {
			if s.Name == "" || seenNames[s.Name] {
				continue
			}
			if !isExportedSymbol(s, cb.lines, tsLang) {
				continue
			}
			seenNames[s.Name] = true

			category := "principle"
			if s.Kind == "type" {
				category = "architecture"
			} else if s.Kind == "function" {
				category = "workflow"
			}

			var excerptLines []string
			startIdx := s.StartLine - 1
			if startIdx < 0 {
				startIdx = 0
			}
			endIdx := s.EndLine
			if endIdx > len(cb.lines) {
				endIdx = len(cb.lines)
			}
			if startIdx < endIdx {
				excerptLines = cb.lines[startIdx:endIdx]
			}
			excerpt := strings.Join(excerptLines, "\n")
			if len([]rune(excerpt)) > 2000 {
				excerpt = string([]rune(excerpt)[:2000])
			}
			if excerpt == "" {
				excerpt = cb.code
			}

			name := truncateRunes(s.Name, 60)
			summary := fmt.Sprintf("%s %s (%s)", s.Kind, name, labels.ExperienceTag)

			out = append(out, ExtractedConcept{
				ConceptName:       name,
				Slug:              SlugifyConcept(docPath + "-" + name),
				Category:          category,
				PrinciplesText:    excerpt,
				AuthorReflections: fmt.Sprintf("%s: %s", labels.MentorGuidanceTag, name),
				SopSteps:          []string{},
				Summary:           summary,
				SubTopics:         []string{category, "physical_symbol"},
				Tags:              []string{labels.ExperienceTag, category, "physical"},
				SourceHeading:     name,
				AnchorText:        name,
			})

			if len(out) >= maxConceptsPerDoc {
				return out
			}
		}
	}

	return out
}

// nonConceptHeadings 整标题停用词（Node NON_CONCEPT_HEADINGS + 标题停用
// 正则的等价集合匹配：cleanMarkdownHeading → trim → lower 后整串命中即弃块）。
var nonConceptHeadings = map[string]bool{
	"简介": true, "引言": true, "前言": true, "序言": true, "序": true, "导语": true,
	"结语": true, "结尾": true, "总结": true, "小结": true, "概述": true, "概览": true,
	"大纲": true, "目录": true, "附录": true, "后记": true, "致谢": true,
	"参考文献": true, "参考资料": true, "习题": true, "练习": true, "思考题": true, "常见问题": true,
	"introduction": true, "intro": true, "preface": true, "foreword": true,
	"summary": true, "conclusion": true, "overview": true, "outline": true,
	"toc": true, "table of contents": true, "appendix": true, "afterword": true,
	"references": true, "bibliography": true, "resources": true, "faq": true,
	"exercises": true, "exercise": true, "getting started": true, "credits": true,
}

var (
	// conceptReflectionLinePattern 反思句识别（Node conceptReflectionContentPatterns）。
	conceptReflectionLinePattern = regexp.MustCompile(`作者思考|设计哲学|为什么选择|权衡|思考|弃用|实战经验|trade-?offs?|design philosophy|why (?:we |it )?(?:choose|chose|picked)|lessons? learned|retrospective|pitfall`)
	// conceptStepPattern 步骤行（Node 同源）。
	conceptStepPattern = regexp.MustCompile(`^(?:Step\s*\d+|\d+[.．)]|Phase\s*\d+|步骤\s*\d+)\s*(.+)`)
	// workflow/principle 标题特征。
	conceptWorkflowTitlePattern = regexp.MustCompile(`流程|步骤|workflow|steps?|process|pipeline|procedure|walkthrough|guide`)
	conceptPrincipleTitlePattern = regexp.MustCompile(`原理|概念|机制|principles?|concepts?|fundamentals?|theory|how (?:it|this) works`)
)

type headingBlock struct {
	title        string
	hasHeading   bool
	bodyLines    []string
	hasCodeBlock bool
}

// ExtractConceptsFromHeadings 无 manifest 时的标题块回退提取。
func ExtractConceptsFromHeadings(content, docPath, locale string) []ExtractedConcept {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	labels := LabelsForLocale(locale)

	var blocks []headingBlock
	current := headingBlock{}
	inFence := false
	var fenceChar byte
	fenceLen := 0
	headinglessCount := 0
	flush := func() {
		if len(current.bodyLines) > 0 || current.hasHeading {
			blocks = append(blocks, current)
		}
		current = headingBlock{}
	}

	for _, line := range lines {
		fenceMatch := mdpat.FenceOpenRe.FindStringSubmatch(line)
		if !inFence {
			if fenceMatch != nil {
				inFence = true
				fenceChar = fenceMatch[1][0]
				fenceLen = len(fenceMatch[1])
				current.hasCodeBlock = true
				current.bodyLines = append(current.bodyLines, line)
				continue
			}
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "#") {
				flush()
				current = headingBlock{
					title:      strings.TrimSpace(strings.TrimLeft(trimmed, "#\t ")),
					hasHeading: true,
				}
				continue
			}
			current.bodyLines = append(current.bodyLines, line)
		} else {
			current.bodyLines = append(current.bodyLines, line)
			if fenceMatch != nil && fenceMatch[1][0] == fenceChar && len(fenceMatch[1]) >= fenceLen && strings.TrimSpace(fenceMatch[2]) == "" {
				inFence = false
			}
		}
	}
	flush()

	hasValidHeadings := false
	for _, b := range blocks {
		if b.hasHeading {
			clean := strings.ToLower(strings.TrimSpace(chunker.CleanMarkdownHeading(b.title)))
			if clean != "" && !nonConceptHeadings[clean] {
				hasValidHeadings = true
				break
			}
		}
	}

	if !hasValidHeadings {
		if physicalConcepts := extractAstPhysicalConcepts(lines, content, docPath, labels); len(physicalConcepts) > 0 {
			return physicalConcepts
		}
	}

	var out []ExtractedConcept
	for _, b := range blocks {
		title := b.title
		sourceHeading := ""
		if b.hasHeading {
			clean := strings.ToLower(strings.TrimSpace(chunker.CleanMarkdownHeading(title)))
			if clean == "" || nonConceptHeadings[clean] {
				continue
			}
			sourceHeading = title
		} else {
			headinglessCount++
			title = labels.UntitledConceptName
			if headinglessCount > 1 {
				title = labels.UntitledConceptName + " " + intToASCII(headinglessCount)
			}
		}

		body := strings.Join(b.bodyLines, "\n")
		trimmedBody := strings.TrimSpace(body)
		steps := extractConceptSteps(b.bodyLines)
		reflections := extractConceptReflections(b.bodyLines)

		// 低密度过渡块：真标题 + 无代码 + 无步骤 + 正文 < 10 字 → 弃
		if b.hasHeading && !b.hasCodeBlock && len(steps) == 0 && len([]rune(trimmedBody)) < 10 {
			continue
		}
		// 真标题但空正文 → 弃
		if b.hasHeading && trimmedBody == "" {
			continue
		}

		category := classifyConceptBlock(title, b.hasCodeBlock, reflections, steps, trimmedBody)
		name := truncateRunes(title, 60)

		summary := truncateRunes(strings.ReplaceAll(strings.TrimSpace(firstNonEmptyLine(b.bodyLines)), "\n", " "), 200)
		anchor := truncateRunes(strings.TrimSpace(firstNonEmptyLine(b.bodyLines)), 120)
		if anchor == "" {
			anchor = name
		}

		out = append(out, ExtractedConcept{
			ConceptName:       name,
			Slug:              SlugifyConcept(docPath + "-" + title),
			Category:          category,
			PrinciplesText:    truncateRunes(trimmedBody, 2000),
			AuthorReflections: truncateRunes(strings.Join(reflections, "\n\n"), 1500),
			SopSteps:          steps,
			Summary:           summary,
			SubTopics:         []string{category, labels.MentorGuidanceTag},
			Tags:              []string{labels.ExperienceTag, category},
			SourceHeading:     sourceHeading,
			AnchorText:        anchor,
		})
		if len(out) >= maxConceptsPerDoc {
			break
		}
	}
	if len(out) == 0 {
		if physicalConcepts := extractAstPhysicalConcepts(lines, content, docPath, labels); len(physicalConcepts) > 0 {
			return physicalConcepts
		}
		return []ExtractedConcept{}
	}
	return out
}

// extractConceptSteps 步骤行提取（≤10）。
func extractConceptSteps(lines []string) []string {
	var steps []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := conceptStepPattern.FindStringSubmatch(trimmed); m != nil {
			capture := strings.TrimSpace(m[1])
			if capture != "" {
				steps = append(steps, capture)
			}
			if len(steps) >= 10 {
				break
			}
		}
	}
	return steps
}

// extractConceptReflections 引用块与反思句（`>` 前缀或特征句式）。
func extractConceptReflections(lines []string) []string {
	var reflections []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, ">") {
			if c := strings.TrimSpace(strings.TrimPrefix(trimmed, ">")); c != "" {
				reflections = append(reflections, c)
			}
			continue
		}
		if conceptReflectionLinePattern.MatchString(trimmed) {
			reflections = append(reflections, trimmed)
		}
	}
	return reflections
}

// classifyConceptBlock 类别判定（优先级同 Node）：workflow > reflection >
// principle > architecture。
func classifyConceptBlock(title string, hasCode bool, reflections, steps []string, body string) string {
	if len(steps) > 0 || conceptWorkflowTitlePattern.MatchString(title) {
		return "workflow"
	}
	if len(reflections) > 0 {
		return "reflection"
	}
	if hasCode || conceptPrincipleTitlePattern.MatchString(title) || len([]rune(body)) > 300 {
		return "principle"
	}
	return "architecture"
}

func firstNonEmptyLine(lines []string) string {
	for _, l := range lines {
		if strings.TrimSpace(l) != "" && !strings.HasPrefix(strings.TrimSpace(l), "#") {
			return l
		}
	}
	return ""
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func intToASCII(n int) string {
	if n < 0 {
		return ""
	}
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

package mdx

import (
	"regexp"
	"strings"

	"github.com/opengits/worker-sidecar/internal/sanitize"

	"github.com/dop251/goja/parser"
)

// ─────────────────────────────────────────────────────────────
// MDX 预编译校验 Go 单实现（D组收刀 1/8：/api/internal/mdx/validate 下沉）。
//
// Node validateMdxDetailed = 快扫门禁 + 全量编译 + heal 再编译。Go 无
// fumadocs/acorn 编译器，按黄金夹具冻结的「编译器实测裁定口径」映射：
// - 未闭合 frontmatter/围栏 → 编译器容忍（thematic break / EOF 收尾）→ valid
// - 花括号任意问题（未闭合/孤儿/跨行）→ heal 全量转义后必过 → valid
// - 未闭合/错配 JSX 标签、泛型碰撞 <T>、坏 JSX 属性表达式 → 编译器必败
//   且 heal 只转义花括号不修标签 → invalid（错误文案供 mdx_repair 定位）
// 扫描器逐字移植 apps/client/src/lib/wasm/mdx-wasm-validator.ts 的
// scanLinearBuffer / extractJsxSegments / extractJsxAttributeExpressions；
// isValidJsExpression 与 Node 同构：JS 引擎解析探测（goja parser 纯解析、
// 零执行），失败模式天然覆盖 LLM 截断工况（悬挂操作符/未闭合括号/字符串）。
// ─────────────────────────────────────────────────────────────

// MaxSourceBytes 与 Node 路由 z.string().max(2_000_000) 同限。
const MaxSourceBytes = 2_000_000
const mdxSourceMaxBytes = MaxSourceBytes

// htmlVoidElements：HTML 规范 void 元素（无闭合标签），移植 Node 同名集合。
var htmlVoidElements = map[string]struct{}{
	"area": {}, "base": {}, "br": {}, "col": {}, "embed": {}, "hr": {},
	"img": {}, "input": {}, "link": {}, "meta": {}, "param": {},
	"source": {}, "track": {}, "wbr": {},
}

type mdxScanFlags struct {
	unclosedFrontmatter bool
	unclosedFence       bool
	hasGenerics         bool
	hasComplexBraces    bool
	unclosedBrace       bool
	hasComplexEsm       bool
	unclosedTag         string
	jsxElementsDetected bool
}

// scanMdxLinear 单趟线性字节扫描：frontmatter 边界、围栏配对、行内代码
// 隔离、ESM 探测、花括号配平与 JSX 标签栈（逐字对齐 Node scanLinearBuffer）。
func scanMdxLinear(u8 []byte) mdxScanFlags {
	var f mdxScanFlags
	len_ := len(u8)
	pos := 0

	// 1. frontmatter 边界（文档以 --- 开篇才有）
	if len_ >= 3 && u8[0] == 0x2d && u8[1] == 0x2d && u8[2] == 0x2d {
		fmClosed := false
		i := 3
		for i < len_ && u8[i] != 0x0a {
			i++
		}
		if i < len_ && u8[i] == 0x0a {
			i++
		}
		for i < len_ {
			isLine := i == 0 || u8[i-1] == 0x0a
			if !isLine || i+2 >= len_ || u8[i] != 0x2d || u8[i+1] != 0x2d || u8[i+2] != 0x2d {
				i++
				continue
			}
			nextChar := byte(0x0a)
			if i+3 < len_ {
				nextChar = u8[i+3]
			}
			if nextChar == 0x0a || nextChar == 0x0d || nextChar == 0x20 || i+3 == len_ {
				fmClosed = true
				for i < len_ && u8[i] != 0x0a {
					i++
				}
				if i < len_ && u8[i] == 0x0a {
					i++
				}
				pos = i
				break
			}
			i++
		}
		if !fmClosed {
			f.unclosedFrontmatter = true
			pos = 3
		}
	}

	inFence := false
	var fenceChar byte
	fenceLen := 0
	inInlineCode := false
	braceDepth := 0
	braceStartLine := 0
	currentLine := 1
	var tagStack []string

	isTagnameByte := func(b byte) bool {
		return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ||
			(b >= 0x30 && b <= 0x39) || b == 0x2d || b == 0x2e
	}

	for pos < len_ {
		b := u8[pos]

		if b == 0x0a {
			currentLine++
			pos++
			continue
		}

		isLineStart := pos == 0 || u8[pos-1] == 0x0a
		if isLineStart && (b == 0x60 || b == 0x7e) {
			count := 0
			p := pos
			for p < len_ && u8[p] == b {
				count++
				p++
			}
			if count >= 3 && !inFence {
				inFence = true
				fenceChar = b
				fenceLen = count
				pos = p
				for pos < len_ && u8[pos] != 0x0a {
					pos++
				}
				continue
			}
			if count >= 3 && inFence && b == fenceChar && count >= fenceLen {
				if afterFence, ok := isFenceClosing(u8, len_, p); ok {
					inFence = false
					fenceChar = 0
					fenceLen = 0
					pos = afterFence
					continue
				}
			}
		}

		if inFence {
			pos++
			continue
		}

		if b == 0x60 {
			inInlineCode = !inInlineCode
			pos++
			continue
		}
		if inInlineCode {
			pos++
			continue
		}

		// 行首 ESM import 探测
		if isLineStart && b == 0x69 && pos+7 < len_ &&
			u8[pos+1] == 0x6d && u8[pos+2] == 0x70 && u8[pos+3] == 0x6f &&
			u8[pos+4] == 0x72 && u8[pos+5] == 0x74 && u8[pos+6] == 0x20 {
			f.hasComplexEsm = true
		}

		// 花括号配平（代码块外）
		if b == 0x7b {
			if braceDepth == 0 {
				braceStartLine = currentLine
			}
			braceDepth++
			f.hasComplexBraces = true
		} else if b == 0x7d {
			braceDepth--
			if braceDepth < 0 {
				f.unclosedBrace = true
				f.hasComplexBraces = true
				braceDepth = 0
			}
			if braceDepth == 0 && currentLine > braceStartLine {
				f.hasComplexBraces = true
			}
		}

		// 尖括号：注释 / 闭合标签 / 开标签或泛型
		if b == 0x3c {
			// 1. 注释 <!-- ... -->
			if pos+3 < len_ && u8[pos+1] == 0x21 && u8[pos+2] == 0x2d && u8[pos+3] == 0x2d {
				pos += 4
				for pos+2 < len_ && !(u8[pos] == 0x2d && u8[pos+1] == 0x2d && u8[pos+2] == 0x3e) {
					if u8[pos] == 0x0a {
						currentLine++
					}
					pos++
				}
				pos += 3
				continue
			}

			// 2. 闭合标签 </TagName>
			if pos+1 < len_ && u8[pos+1] == 0x2f {
				f.jsxElementsDetected = true
				p := pos + 2
				for p < len_ && isTagnameByte(u8[p]) {
					p++
				}
				tagName := string(u8[pos+2 : p])
				for p < len_ && u8[p] != 0x3e && u8[p] != 0x0a {
					p++
				}
				if p < len_ && u8[p] == 0x3e {
					p++
				}
				var unclosed string
				tagStack, unclosed = popTag(tagStack, tagName)
				if unclosed != "" {
					f.unclosedTag = unclosed
				}
				pos = p
				continue
			}

			// 3. 开标签或泛型表达式
			p := pos + 1
			for p < len_ && isTagnameByte(u8[p]) {
				p++
			}
			token := string(u8[pos+1 : p])
			if len(token) == 0 {
				pos++
				continue
			}

			isSingleTypeParam := len(token) == 1 && token[0] >= 'A' && token[0] <= 'Z'
			if isSingleTypeParam && p < len_ && (u8[p] == 0x3e || u8[p] == 0x2c) {
				f.hasGenerics = true
			}

			tagEnd, isSelfClosing := scanTagEnd(u8, len_, p, &currentLine)

			_, isKnownVoid := htmlVoidElements[strings.ToLower(token)]
			isComponentTag := token[0] >= 'A' && token[0] <= 'Z' && !isSingleTypeParam
			isAllLetters := token != "" && isAsciiLetters(token)

			if isComponentTag || (!isKnownVoid && !isSelfClosing && len(token) > 1 && isAllLetters) {
				f.jsxElementsDetected = true
				if !isSelfClosing && !isKnownVoid {
					tagStack = append(tagStack, token)
				}
			}

			pos = tagEnd
			continue
		}

		pos++
	}

	if inFence {
		f.unclosedFence = true
	}
	if braceDepth != 0 {
		f.unclosedBrace = true
		f.hasComplexBraces = true
	}
	if len(tagStack) > 0 && f.unclosedTag == "" {
		f.unclosedTag = tagStack[len(tagStack)-1]
	}
	return f
}

func isAsciiLetters(s string) bool {
	for i := 0; i < len(s); i++ {
		b := s[i]
		if !((b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')) {
			return false
		}
	}
	return len(s) > 0
}

// extractJsxSegments 提取围栏代码块外的 JSX 标签段（含多行标签）。
func extractJsxSegments(content string) []string {
	var segments []string
	inFence := false
	var nonFenceLines []string
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		nonFenceLines = append(nonFenceLines, line)
	}
	clean := strings.Join(nonFenceLines, "\n")
	i := 0
	for i < len(clean) {
		if clean[i] != '<' || i+1 >= len(clean) {
			i++
			continue
		}
		next := clean[i+1]
		isTagStart := (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a)
		if !isTagStart {
			i++
			continue
		}
		start := i
		p := i + 1
		var quote byte
		braceDepth := 0
		for p < len(clean) {
			ch := clean[p]
			if quote != 0 {
				if ch == quote && (p == 0 || clean[p-1] != 0x5c) {
					quote = 0
				}
				p++
				continue
			}
			matchedClose := false
			switch ch {
			case 0x22, 0x27, 0x60:
				quote = ch
			case 0x7b:
				braceDepth++
			case 0x7d:
				if braceDepth > 0 {
					braceDepth--
				}
			case 0x3e:
				if braceDepth == 0 {
					p++
					matchedClose = true
				}
			}
			if matchedClose {
				break
			}
			p++
		}
		segments = append(segments, clean[start:p])
		i = p
	}
	return segments
}

// extractJsxAttributeExpressions 提取 JSX 属性表达式（attr={expr} 的 expr）。
func extractJsxAttributeExpressions(segment string) []string {
	var expressions []string
	i := 0
	for i < len(segment) {
		if segment[i] != '=' || i+1 >= len(segment) {
			i++
			continue
		}
		p := i + 1
		for p < len(segment) && (segment[p] == ' ' || segment[p] == '\t' || segment[p] == '\n' || segment[p] == '\r') {
			p++
		}
		if p >= len(segment) || segment[p] != '{' {
			i++
			continue
		}
		start := p + 1
		depth := 1
		var quote byte
		end := start
		for end < len(segment) && depth > 0 {
			ch := segment[end]
			if quote != 0 {
				if ch == quote && (end == 0 || segment[end-1] != 0x5c) {
					quote = 0
				}
				end++
				continue
			}
			switch ch {
			case 0x22, 0x27, 0x60:
				quote = ch
			case 0x7b:
				depth++
			case 0x7d:
				depth--
			}
			if depth == 0 {
				break
			}
			end++
		}
		if depth == 0 {
			expressions = append(expressions, segment[start:end])
			i = end + 1
			continue
		}
		expressions = append(expressions, segment[start:])
		break
	}
	return expressions
}

// tsTypeAssertionRe TS 类型断言剥离（对齐 Node 二次尝试语义 x as string）。
// 限定单行（[ \t] 代替 \s）：跨行贪婪会把两行各自的断言连成一段整体剥掉。
var tsTypeAssertionRe = regexp.MustCompile(`[ \t]+as[ \t]+[A-Za-z0-9_<>[\]|&, \t]+`)

// ─────────────────────────────────────────────────────────────
// MDX 预编译校验规约规则链（Specification Pattern / Rule Chain）
// ─────────────────────────────────────────────────────────────

type mdxValidationRule interface {
	Validate(rawContent string, scan mdxScanFlags) (valid bool, errMsg string)
}

type genericsCollisionRule struct{}

func (genericsCollisionRule) Validate(_ string, scan mdxScanFlags) (bool, string) {
	if scan.hasGenerics {
		return false, "Contains generic type parameter collision outside code block (e.g. <T>)"
	}
	return true, ""
}

type unclosedTagRule struct{}

func (unclosedTagRule) Validate(_ string, scan mdxScanFlags) (bool, string) {
	if scan.unclosedTag != "" {
		return false, "Expected a closing tag for `<" + scan.unclosedTag + ">` in MDX"
	}
	return true, ""
}

type jsxAttributeExpressionRule struct{}

func (jsxAttributeExpressionRule) Validate(rawContent string, scan mdxScanFlags) (bool, string) {
	if !scan.jsxElementsDetected {
		return true, ""
	}
	for _, seg := range extractJsxSegments(rawContent) {
		for _, expr := range extractJsxAttributeExpressions(seg) {
			if !isValidJsExpression(expr) {
				return false, "Unexpected character in JSX attribute expression: {" + truncate(expr, 60) + "}"
			}
		}
	}
	return true, ""
}

var defaultMdxValidationRules = []mdxValidationRule{
	genericsCollisionRule{},
	unclosedTagRule{},
	jsxAttributeExpressionRule{},
}

// ValidateDetailed MDX 预编译校验最终裁定（规约规则链驱动，黄金夹具冻结）。
// 裁定口径移植自 Node 快扫+编译+heal 管线的实测结论（见文件头注释）。
func ValidateDetailed(content string) (bool, string) {
	if len(content) > MaxSourceBytes {
		return false, "mdx source exceeds 2,000,000 byte limit"
	}
	if strings.TrimSpace(content) == "" {
		return true, ""
	}
	src := sanitize.PrepareMdxSource(content)
	scan := scanMdxLinear([]byte(src))

	for _, rule := range defaultMdxValidationRules {
		if valid, errMsg := rule.Validate(content, scan); !valid {
			return false, errMsg
		}
	}

	// 未闭合 frontmatter/围栏与花括号问题：编译器容忍或 heal 可救 → valid
	return true, ""
}

// IsValidJsExpression JS 表达式语法合法性探测（不执行代码）。
// Node 用 V8 new Function 解析；Go 以确定性规则近似，覆盖 LLM 截断
// 失败模式：括号/引号不配平、悬挂二元操作符、空表达式与值邻接（`a b`）。
func isValidJsExpression(expr string) bool {
	trimmed := strings.TrimSpace(expr)
	if trimmed == "" {
		return false
	}
	if jsExprSyntacticallyValid(trimmed) {
		return true
	}
	sanitized := tsTypeAssertionRe.ReplaceAllString(trimmed, "")
	if sanitized != trimmed {
		return jsExprSyntacticallyValid(sanitized)
	}
	return false
}

// goIsValidJsExpression is an alias for IsValidJsExpression.
func goIsValidJsExpression(expr string) bool {
	return isValidJsExpression(expr)
}

// jsExprSyntacticallyValid 单趟确定性校验：括号/引号配平 + 操作数邻接
// 结构 + 结尾无悬挂操作符（++/-- 后缀完整除外）。
// jsExprSyntacticallyValid JS 表达式语法探测：goja 解析器（纯解析、零执行），
// 与 Node 的 `new Function("return (" + expr + ")")` 括号包裹语义同构。
// 箭头函数、三元、可选链、展开、模板串等由真 JS 语法全覆盖——取代历史
// 140 行手写括号配平状态机（该实现无法处理箭头/三元/解构，频发误杀）。
func jsExprSyntacticallyValid(s string) (valid bool) {
	// LLM 输出为不可信高熵源：防御解析器对极端构造的历史性 panic
	defer func() {
		if recover() != nil {
			valid = false
		}
	}()
	_, err := parser.ParseFile(nil, "", "("+s+")", 0)
	return err == nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func isFenceClosing(u8 []byte, len_, p int) (int, bool) {
	afterFence := p
	for afterFence < len_ && (u8[afterFence] == 0x20 || u8[afterFence] == 0x09) {
		afterFence++
	}
	if afterFence >= len_ || u8[afterFence] == 0x0a || u8[afterFence] == 0x0d {
		return afterFence, true
	}
	return p, false
}

func popTag(tagStack []string, tagName string) ([]string, string) {
	if len(tagStack) == 0 {
		return tagStack, tagName
	}
	top := tagStack[len(tagStack)-1]
	if strings.EqualFold(top, tagName) {
		return tagStack[:len(tagStack)-1], ""
	}
	return tagStack, top
}

func scanTagEnd(u8 []byte, len_, p int, currentLine *int) (int, bool) {
	tagEnd := p
	isSelfClosing := false
	var quoteChar byte
	tagBraceDepth := 0
	for tagEnd < len_ {
		ch := u8[tagEnd]
		if ch == 0x0a {
			*currentLine++
		}
		if quoteChar != 0 {
			if ch == quoteChar && (tagEnd == 0 || u8[tagEnd-1] != 0x5c) {
				quoteChar = 0
			}
			tagEnd++
			continue
		}
		done := false
		switch ch {
		case 0x22, 0x27, 0x60:
			quoteChar = ch
		case 0x7b:
			tagBraceDepth++
		case 0x7d:
			if tagBraceDepth > 0 {
				tagBraceDepth--
			}
		case 0x2f:
			if tagBraceDepth == 0 && tagEnd+1 < len_ && u8[tagEnd+1] == 0x3e {
				isSelfClosing = true
				tagEnd += 2
				done = true
			}
		case 0x3e:
			if tagBraceDepth == 0 {
				tagEnd++
				done = true
			}
		}
		if done {
			break
		}
		tagEnd++
	}
	return tagEnd, isSelfClosing
}

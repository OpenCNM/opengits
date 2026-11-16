package sanitize

import "strings"

// ─────────────────────────────────────────────────────────────
// 确定性 HTML 标签扫描器（sanitizeHTML 内部引擎）。
//
// 输入是「代码块已 mask 的 Markdown 文本」——HTML 是嵌入客语言，不能整篇
// 当 HTML 文档解析。此扫描器只对标签区间做结构化处理（quote-aware 属性
// 边界），非标签文本逐字节透传，取代历史 12 条结构性正则
// （scriptTagRe/embedTagRe/voidTagRe/eventAttr*/proto* 等——正则处理
// 嵌套标签结构属 Chomsky 越界，且 `[^>]*` 类模式遇引号内 '>' 即断链）。
//
// 语义与被替换的正则集逐条对齐（golden 夹具锁定）：
// - 成对/自闭合/未闭合(截断到 EOF)的 script|iframe|object|embed 整段剥除
// - 非法 HTML 注释剥除；未闭合注释保留
// - void 标签（img/input/br/hr/meta/link）未自闭合时强制补 " />"
// - style 与 on* 属性整 token 删除；危险伪协议（javascript:/vbscript:/
//   data:text/html）属性值置空 ""
// ─────────────────────────────────────────────────────────────

type parsedTag struct {
	start, end int  // "<" 到 ">"（含）的字节区间
	name       string
	closing    bool
	selfClose  bool
}

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func isDigit(b byte) bool { return b >= '0' && b <= '9' }

func isHTMLSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\f'
}

// parseTag 解析 s[i] 起始的标签（'<' 已确认）；引号内的 '>' 不视为标签结束。
// 无闭合 '>' 时不是标签（返回 false，调用方按普通文本透传）。
func parseTag(s string, i int) (parsedTag, bool) {
	j := i + 1
	closing := false
	if j < len(s) && s[j] == '/' {
		closing = true
		j++
	}
	if j >= len(s) || !isASCIILetter(s[j]) {
		return parsedTag{}, false
	}
	k := j
	for k < len(s) && (isASCIILetter(s[k]) || isDigit(s[k]) || s[k] == '-' || s[k] == ':' || s[k] == '_' || s[k] == '.') {
		k++
	}
	name := strings.ToLower(s[j:k])

	q := byte(0)
	m := k
	for m < len(s) {
		c := s[m]
		if q != 0 {
			if c == q {
				q = 0
			}
			m++
			continue
		}
		if c == '\'' || c == '"' {
			q = c
			m++
			continue
		}
		if c == '>' {
			break
		}
		m++
	}
	if m >= len(s) {
		return parsedTag{}, false
	}
	end := m + 1
	selfClose := end-2 >= k && s[end-2] == '/'
	return parsedTag{start: i, end: end, name: name, closing: closing, selfClose: selfClose}, true
}

// indexTagFoldASCII 在 rest 内做大小写不敏感子串搜索（needle 为小写
// ASCII："</"+标签名）。命中窗口前保持纯 ASCII 时与旧路径
// strings.ToLower(rest) + strings.Index 逐位一致；命中前遇到非 ASCII
// 字节则整体回退旧路径——Unicode 变长 lowercase 折叠（U+0130→i、
// U+212A→k）会改变 ToLower 后串的偏移，旧路径的行为必须原样保留。
// 消除旧路径每次调用对剩余全文的 ToLower 拷贝分配。
func indexTagFoldASCII(rest, needle string) int {
	n := len(needle)
	if n == 0 || len(rest) < n {
		return -1
	}
	for i := 0; i+n <= len(rest); i++ {
		b := rest[i]
		if b >= 0x80 {
			return strings.Index(strings.ToLower(rest), needle)
		}
		if !tagFoldEq(b, needle[0]) {
			continue
		}
		eq := true
		for j := 1; j < n; j++ {
			c := rest[i+j]
			if c >= 0x80 || !tagFoldEq(c, needle[j]) {
				eq = false
				break
			}
		}
		if eq {
			return i
		}
	}
	return -1
}

// tagFoldEq 单字节折叠相等：needle 字节 b 为小写字母时 A-Z↔a-z 折叠，
// 其余（</、数字、- : _ .）要求逐字节相等——与 ASCII 输入上
// strings.ToLower 的映射严格一致。
func tagFoldEq(a, b byte) bool {
	if 'a' <= b && b <= 'z' {
		return a == b || a == b-('a'-'A')
	}
	return a == b
}

// findRawClose 从 from 起查找 </name>（大小写不敏感、闭名后允空白）。
// script/iframe/object/embed 均为 raw-text 元素：内容不嵌套同名标签，
// 首个闭标签即配对（与正则非贪婪 `[\s\S]*?<\/script>` 语义一致）。
func findRawClose(s string, from int, name string) int {
	needle := "</" + name
	offset := 0
	for {
		p := indexTagFoldASCII(s[from+offset:], needle)
		if p < 0 {
			return -1
		}
		p += offset
		m := from + p + len(needle)
		for m < len(s) && isHTMLSpace(s[m]) {
			m++
		}
		if m < len(s) && s[m] == '>' {
			return m + 1
		}
		offset = p + len(needle)
	}
}

// attrToken 标签内单个属性 token 的字节区间（含值；不含前导空白）。
type attrToken struct {
	start, end   int  // 相对标签体切片
	nameStart    int  // 名字起点
	nameEnd      int  // 名字终点（不含）
	valueStart   int  // 值区间起点（含引号），无值时 = valueEnd
	valueEnd     int
	hasValue     bool
	quoted       byte // 0=无引号/无值，否则引号字符
}

// scanAttrTokens 解析标签体（"name" 之后到 '>' 之前）的属性 token 流。
func scanAttrTokens(body string) []attrToken {
	var toks []attrToken
	i := 0
	for i < len(body) {
		for i < len(body) && isHTMLSpace(body[i]) {
			i++
		}
		if i >= len(body) || body[i] == '>' {
			break
		}
		tok := attrToken{start: i}
		j := i
		for j < len(body) && body[j] != '=' && body[j] != '>' && !isHTMLSpace(body[j]) {
			j++
		}
		tok.nameStart, tok.nameEnd = i, j
		// 可选空白 '=' 空白 值
		k := j
		for k < len(body) && isHTMLSpace(body[k]) {
			k++
		}
		if k < len(body) && body[k] == '=' {
			k++
			for k < len(body) && isHTMLSpace(body[k]) {
				k++
			}
			if k < len(body) && (body[k] == '"' || body[k] == '\'') {
				q := body[k]
				vEnd := k + 1
				for vEnd < len(body) && body[vEnd] != q {
					vEnd++
				}
				if vEnd < len(body) {
					vEnd++ // 含闭引号
				}
				tok.hasValue = true
				tok.quoted = q
				tok.valueStart, tok.valueEnd = k, vEnd
				j = vEnd
			} else {
				vEnd := k
				for vEnd < len(body) && !isHTMLSpace(body[vEnd]) && body[vEnd] != '>' {
					vEnd++
				}
				tok.hasValue = true
				tok.valueStart, tok.valueEnd = k, vEnd
				j = vEnd
			}
		}
		tok.end = j
		if tok.end <= tok.start {
			break // 防御：零长 token 死循环
		}
		toks = append(toks, tok)
		i = tok.end
	}
	return toks
}

// removeElementsWithContent 剥除 <name ...>...</name> 整段（含内容）；
// 自闭合仅剥标签；未闭合截断到 EOF。names 为小写标签名集合。
func removeElementsWithContent(s string, names map[string]bool) string {
	var out strings.Builder
	out.Grow(len(s))
	i := 0
	for i < len(s) {
		if s[i] != '<' {
			next := strings.IndexByte(s[i:], '<')
			if next < 0 {
				out.WriteString(s[i:])
				break
			}
			out.WriteString(s[i : i+next])
			i += next
			continue
		}
		tag, ok := parseTag(s, i)
		if !ok {
			out.WriteByte('<')
			i++
			continue
		}
		if names[tag.name] && !tag.closing {
			if tag.selfClose {
				i = tag.end
				continue
			}
			if closeEnd := findRawClose(s, tag.end, tag.name); closeEnd >= 0 {
				i = closeEnd
				continue
			}
			i = len(s)
			continue
		}
		out.WriteString(s[tag.start:tag.end])
		i = tag.end
	}
	return out.String()
}

// findRawCloseStart 与 findRawClose 同语义，额外返回闭标签 '<' 的位置。
func findRawCloseStart(s string, from int, name string) (closeStart, closeEnd int, ok bool) {
	needle := "</" + name
	offset := 0
	for {
		p := indexTagFoldASCII(s[from+offset:], needle)
		if p < 0 {
			return 0, 0, false
		}
		p += offset
		m := from + p + len(needle)
		for m < len(s) && isHTMLSpace(s[m]) {
			m++
		}
		if m < len(s) && s[m] == '>' {
			return from + p, m + 1, true
		}
		offset = p + len(needle)
	}
}

// unwrapElements 将 <name ...>inner</name> 替换为 inner（保留内文）；
// 未闭合配对保持原文（与历史非贪婪正则要求闭标签的口径一致）。
func unwrapElements(s string, name string) string {
	var out strings.Builder
	out.Grow(len(s))
	i := 0
	for i < len(s) {
		if s[i] != '<' {
			next := strings.IndexByte(s[i:], '<')
			if next < 0 {
				out.WriteString(s[i:])
				break
			}
			out.WriteString(s[i : i+next])
			i += next
			continue
		}
		tag, ok := parseTag(s, i)
		if !ok {
			out.WriteByte('<')
			i++
			continue
		}
		if tag.name == name && !tag.closing && !tag.selfClose {
			if cs, ce, found := findRawCloseStart(s, tag.end, tag.name); found {
				out.WriteString(s[tag.end:cs])
				i = ce
				continue
			}
		}
		out.WriteString(s[tag.start:tag.end])
		i = tag.end
	}
	return out.String()
}

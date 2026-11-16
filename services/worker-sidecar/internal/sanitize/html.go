package sanitize

import (
	"regexp"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// HTML 安全清洗器（Sanitizer Phase 2）：对齐 apps/client/src/engine/
// sanitizer.ts 的 Unified AST 节点清洗规则。
//
// 所有清洗均在已 mask 的文本上运行（代码块已被 PUA token 保护，绝不误触
// 示例代码中的 HTML / script / 属性）。结构处理由确定性标签扫描器
// （tagscan.go）执行——仅作用于真实标签区间，非标签 Markdown 文本
// 逐字节透传；取代历史正则集（详见 tagscan.go 头注）。
// ─────────────────────────────────────────────────────────────

// 剥除整段的 raw-text 元素（含全部内容到配对闭标签；未闭合截断到 EOF）
var strippedElements = map[string]bool{
	"script": true, "iframe": true, "object": true, "embed": true,
}

// Void HTML 元素：强制自闭合（<img ...> → <img ... />）
var voidElements = map[string]bool{
	"img": true, "input": true, "br": true, "hr": true, "meta": true, "link": true,
}

// URL 承载属性全集（属性面伪协议清洗；缺一即 <button formaction=...> 可绕过）
var urlAttrNames = map[string]bool{
	"href": true, "src": true, "data": true, "action": true,
	"formaction": true, "xlink:href": true,
}

// Markdown 链接伪协议防护：[label](javascript:...) —— Markdown 语法层
// 一维文本模式（正则合法辖区，非 HTML 结构）。
// scheme 后必须跟冒号：漏掉冒号会把 javascript.md / vbscript-notes.md 这类
// 相对文件名链接整体掏空成 [label]()。
// 目标段允许一层平衡括号（CommonMark 行内链接文法）：alert(1)/void(0) 这类
// 含括号 URL 必须整段吃掉，否则替换后残留孤立的右括号。
// 首段用懒惰量词：贪婪版优先把 "(" 吞进 [^)]* 导致在 URL 内层 ")" 提前闭链。
var mdProtoRe = regexp.MustCompile(`(?i)\[([^\]]*)\]\(\s*(?:javascript\s*:|vbscript\s*:|data\s*:\s*text\/html)[^)]*?(?:\([^)]*\)[^)]*)*\)`)

// sanitizeHTML 执行非代码区域的 HTML 结构与属性安全过滤。
func sanitizeHTML(content string) string {
	var out strings.Builder
	out.Grow(len(content))
	i := 0
	for i < len(content) {
		if content[i] != '<' {
			// 非标签文本按 run 整段透传（下一个 '<' 之前的连续区间）
			next := strings.IndexByte(content[i:], '<')
			if next < 0 {
				out.WriteString(content[i:])
				break
			}
			out.WriteString(content[i : i+next])
			i += next
			continue
		}
		// HTML 注释：<!-- ... --> 剥除；未闭合注释保留（与历史正则一致）
		if strings.HasPrefix(content[i:], "<!--") {
			if end := strings.Index(content[i+4:], "-->"); end >= 0 {
				i = i + 4 + end + 3
				continue
			}
			out.WriteByte('<')
			i++
			continue
		}
		tag, ok := parseTag(content, i)
		if !ok {
			out.WriteByte('<')
			i++
			continue
		}
		if strippedElements[tag.name] && !tag.closing {
			if tag.selfClose {
				i = tag.end // 自闭合：仅标签本身
				continue
			}
			if closeEnd := findRawClose(content, tag.end, tag.name); closeEnd >= 0 {
				i = closeEnd // 标签 + 内容 + 闭标签整段
				continue
			}
			i = len(content) // 未闭合：截断到 EOF（LLM 截断防御语义）
			continue
		}
		// 闭标签（含孤儿 </script>）与非剥除标签：属性清洗后透传
		out.WriteString(filterTagAttributes(content, tag))
		i = tag.end
	}
	return mdProtoRe.ReplaceAllString(out.String(), "[$1]()")
}

// filterTagAttributes 对单个标签做属性级清洗与 void 自闭合规范化，
// 标签文本未被编辑的部分逐字节保留。
func filterTagAttributes(s string, tag parsedTag) string {
	raw := s[tag.start:tag.end]
	if tag.closing {
		return raw // 闭标签无属性
	}
	// 标签体："<name" 之后到 '>' 之前
	lt := len(raw)
	bodyStart := 1
	for bodyStart < lt && !isHTMLSpace(raw[bodyStart]) && raw[bodyStart] != '>' && raw[bodyStart] != '/' {
		bodyStart++
	}
	bodyEnd := lt - 1 // '>' 位置
	if bodyEnd < bodyStart {
		return raw
	}
	body := raw[bodyStart:bodyEnd]

	var buf strings.Builder
	buf.Grow(len(raw))
	pos := 0 // body 内游标
	for _, tok := range scanAttrTokens(body) {
		name := strings.ToLower(body[tok.nameStart:tok.nameEnd])
		switch {
		case name == "style" && tok.hasValue:
			// 内联 style 属性剥离
			appendEdit(&buf, body, &pos, tok.start, tok.end, "")
		case strings.HasPrefix(name, "on") && len(name) > 2 && tok.hasValue:
			// 事件处理器属性（onclick 等）剥离
			appendEdit(&buf, body, &pos, tok.start, tok.end, "")
		case urlAttrNames[name] && tok.hasValue && dangerousProtoValue(body, tok):
			// 危险伪协议置空（保留属性名）
			appendEdit(&buf, body, &pos, tok.valueStart, tok.valueEnd, `""`)
		}
	}
	buf.WriteString(body[pos:])
	out := "<" + raw[1:bodyStart] + buf.String()
	// void 标签未自闭合：补 " />"（body 已以 "/" 收尾则仅补 ">"——
	// 对齐历史 voidTagRe 的 TrimSpace(attrs) 后缀判定）
	if voidElements[tag.name] && !tag.selfClose {
		if strings.HasSuffix(strings.TrimRight(out, " \t\n\r\f"), "/") {
			out += ">"
		} else {
			out += " />"
		}
	} else {
		out += ">"
	}
	return out
}

// appendEdit 将 body[cursor:start] 透传后写入 replacement，并推进 cursor 到 end。
func appendEdit(buf *strings.Builder, body string, cursor *int, start, end int, replacement string) {
	if start < *cursor {
		start = *cursor
	}
	buf.WriteString(body[*cursor:start])
	buf.WriteString(replacement)
	*cursor = end
}

// dangerousProtoValue 判定 URL 属性值是否危险伪协议
// （javascript: / vbscript: / data:text/html，大小写与空白宽容——
// 对齐历史 protoRe 族的 `"\s*(?:...)` 与 `data\s*:\s*text\/html` 口径）。
func dangerousProtoValue(body string, tok attrToken) bool {
	v := body[tok.valueStart:tok.valueEnd]
	if tok.quoted != 0 {
		v = strings.Trim(v, string(tok.quoted))
	}
	lower := strings.ToLower(strings.TrimLeft(v, " \t\n\r\f"))
	switch {
	case strings.HasPrefix(lower, "javascript:"), strings.HasPrefix(lower, "vbscript:"):
		return true
	case strings.HasPrefix(lower, "data:"):
		rest := strings.TrimLeft(lower[len("data:"):], " \t")
		return strings.HasPrefix(rest, "text/html")
	}
	return false
}

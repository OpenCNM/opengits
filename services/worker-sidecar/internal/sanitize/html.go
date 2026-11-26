package sanitize

import (
	"regexp"
	"strings"
)

// Run on code-masked text only; tagscan handles HTML structure while mdProtoRe targets 1D Markdown links.

var strippedElements = map[string]bool{
	"script": true, "iframe": true, "object": true, "embed": true,
}

var voidElements = map[string]bool{
	"img": true, "input": true, "br": true, "hr": true, "meta": true, "link": true,
}

// Cover all URL-bearing attributes (including formaction/xlink:href) to prevent attribute XSS bypasses.
var urlAttrNames = map[string]bool{
	"href": true, "src": true, "data": true, "action": true,
	"formaction": true, "xlink:href": true,
}

// Require colon after scheme (avoids stripping javascript.md) and balance one paren level for payloads like javascript:alert(1).
var mdProtoRe = regexp.MustCompile(`(?i)\[([^\]]*)\]\(\s*(?:javascript\s*:|vbscript\s*:|data\s*:\s*text\/html)[^)]*?(?:\([^)]*\)[^)]*)*\)`)

func sanitizeHTML(content string) string {
	var out strings.Builder
	out.Grow(len(content))
	i := 0
	for i < len(content) {
		if content[i] != '<' {
			next := strings.IndexByte(content[i:], '<')
			if next < 0 {
				out.WriteString(content[i:])
				break
			}
			out.WriteString(content[i : i+next])
			i += next
			continue
		}
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
				i = tag.end
				continue
			}
			if closeEnd := findRawClose(content, tag.end, tag.name); closeEnd >= 0 {
				i = closeEnd
				continue
			}
			i = len(content) // Truncate unclosed raw-text tags to EOF against truncated XSS payloads.
			continue
		}
		out.WriteString(filterTagAttributes(content, tag))
		i = tag.end
	}
	return mdProtoRe.ReplaceAllString(out.String(), "[$1]()")
}

func filterTagAttributes(s string, tag parsedTag) string {
	raw := s[tag.start:tag.end]
	if tag.closing {
		return raw
	}
	lt := len(raw)
	bodyStart := 1
	for bodyStart < lt && !isHTMLSpace(raw[bodyStart]) && raw[bodyStart] != '>' && raw[bodyStart] != '/' {
		bodyStart++
	}
	bodyEnd := lt - 1
	if bodyEnd < bodyStart {
		return raw
	}
	body := raw[bodyStart:bodyEnd]

	var buf strings.Builder
	buf.Grow(len(raw))
	pos := 0
	for _, tok := range scanAttrTokens(body) {
		name := strings.ToLower(body[tok.nameStart:tok.nameEnd])
		switch {
		case name == "style" && tok.hasValue:
			appendEdit(&buf, body, &pos, tok.start, tok.end, "")
		case strings.HasPrefix(name, "on") && len(name) > 2 && tok.hasValue:
			appendEdit(&buf, body, &pos, tok.start, tok.end, "")
		case urlAttrNames[name] && tok.hasValue && dangerousProtoValue(body, tok):
			appendEdit(&buf, body, &pos, tok.valueStart, tok.valueEnd, `""`)
		}
	}
	buf.WriteString(body[pos:])
	out := "<" + raw[1:bodyStart] + buf.String()
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

func appendEdit(buf *strings.Builder, body string, cursor *int, start, end int, replacement string) {
	if start < *cursor {
		start = *cursor
	}
	buf.WriteString(body[*cursor:start])
	buf.WriteString(replacement)
	*cursor = end
}

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

package sanitize

import "strings"

// Quote-aware HTML tag scanner on masked Markdown; avoids regex breakage on '>' inside attribute quotes.

type parsedTag struct {
	start, end int
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

// Fast ASCII case-fold scan; falls back to strings.ToLower on non-ASCII bytes because Unicode folding (e.g. U+0130) shifts offsets.
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

func tagFoldEq(a, b byte) bool {
	if 'a' <= b && b <= 'z' {
		return a == b || a == b-('a'-'A')
	}
	return a == b
}

// Raw-text elements (script/iframe/object/embed) cannot nest same-name tags, so the first closing tag pairs.
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

type attrToken struct {
	start, end int
	nameStart  int
	nameEnd    int
	valueStart int
	valueEnd   int
	hasValue   bool
	quoted     byte
}

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
					vEnd++
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
			break // Advance at least 1 byte on malformed attributes to guarantee scanner termination.
		}
		toks = append(toks, tok)
		i = tok.end
	}
	return toks
}

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

package armor

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// 转录确定性装甲三件套（M02）：与 apps/client/src/lib/transcription/
// pedagogy-armor.ts 的 TS 实现逐字段对齐的双实现。TS 为契约事实源
// （golden 夹具生成方），本文件所有正则均为 RE2 安全形态——JS 前瞻/
// 后顾已在保持语义等价的前提下手工改写（等价性论证见各注释与
// armor.golden.json 对拍夹具），移植时禁止「看着像」就改写。
// ─────────────────────────────────────────────────────────────

// replaceAllSubmatch 等价 JS String.replace(/.../g, (m, g1, g2...) => ...)：
// 按匹配序重建字符串，回调拿到完整匹配与各捕获组（缺失组为 ""）。
func replaceAllSubmatch(re *regexp.Regexp, input string, fn func(groups []string) string) string {
	var b strings.Builder
	last := 0
	for _, loc := range re.FindAllStringSubmatchIndex(input, -1) {
		b.WriteString(input[last:loc[0]])
		groups := make([]string, len(loc)/2)
		for i := range groups {
			if loc[i*2] >= 0 {
				groups[i] = input[loc[i*2]:loc[i*2+1]]
			} else {
				groups[i] = ""
			}
		}
		b.WriteString(fn(groups))
		last = loc[1]
	}
	b.WriteString(input[last:])
	return b.String()
}

// JS 真值语义：非空字符串即真（"0" 亦真），空串/缺失组为假。
func jsTruthyString(s string) bool { return s != "" }

// ─────────────────────────────────────────────────────────────
// ① resolveFileHandles：整数句柄确定性无损还原
//
// fence 头规则（JS 原型，gim 标志）：
//   /^(```[a-zA-Z0-9]*)[ \t]+(?:(?:\/\/|#|--)[ \t]*)?\[?File[ \t]+(\d+)(?:#(?:L?(\d+)(?:-L?(\d+))?|([a-zA-Z0-9_$]+)))?\]?[ \t]*$/
// 无前瞻/后顾/反向引用，RE2 直接逐字移植（g→ReplaceAll、i→(?i)、m→(?m)）。
// ─────────────────────────────────────────────────────────────

var armorFenceHandleRe = regexp.MustCompile("(?im)^((?:`{3,}|~{3,})[a-zA-Z0-9_-]*)[ \t]+(?:(?://|#|--)[ \t]*)?(?:\\[[ \t]*(?:File[ \t]+)?|File[ \t]+)(\\d+)(?:#(?:L?(\\d+)(?:-L?(\\d+))?|([a-zA-Z0-9_$]+)))?(?::[a-zA-Z0-9_$]+)?\\]?[ \t]*$")

// 正文规则（JS 原型，gi 标志，无前后顾）：
//
//	/`?\[File[ \t]+(\d+)(?:#(?:L?(\d+)(?:-L?(\d+))?|([a-zA-Z0-9_$]+)))?\]`?/
var armorInlineHandleRe = regexp.MustCompile("(?i)`?\\[File[ \t]+(\\d+)(?:#(?:L?(\\d+)(?:-L?(\\d+))?|([a-zA-Z0-9_$]+)))?\\]`?")

// handleSuffix 还原行号/符号后缀：JS 真值链 lStart&&lEnd ➔ 仅 lStart ➔ symbol。
func armorHandleSuffix(lStart, lEnd, symbol string) string {
	switch {
	case jsTruthyString(lStart) && jsTruthyString(lEnd):
		return fmt.Sprintf(" (L%s-L%s)", lStart, lEnd)
	case jsTruthyString(lStart):
		return fmt.Sprintf(" (L%s)", lStart)
	case jsTruthyString(symbol):
		return "#" + symbol
	default:
		return ""
	}
}

// ResolveFileHandles 与 TS resolveFileHandles 对齐：[File N] ➔ 真实物理路径。
// 围栏头保持历史形态（`path (Lx-Ly)`/`path#Symbol`，grounding 双正则依赖，
// 禁止改动）；正文内联走 resolveInlineHandles 的链接化 + 相邻去重升级。
func ResolveFileHandles(mdxContent string, files []ArmorFileRef) string {
	if mdxContent == "" || len(files) == 0 {
		return mdxContent
	}

	resolved := replaceAllSubmatch(armorFenceHandleRe, mdxContent, func(g []string) string {
		match, fence, fileIndexStr, lStart, lEnd, symbol := g[0], g[1], g[2], g[3], g[4], g[5]
		idx, err := strconv.Atoi(fileIndexStr)
		if err != nil || idx < 1 || idx > len(files) {
			return match
		}
		return fence + " // " + files[idx-1].Path + armorHandleSuffix(lStart, lEnd, symbol)
	})

	return resolveInlineHandles(resolved, files)
}

// ─────────────────────────────────────────────────────────────
// 正文内联句柄还原（prose 升级版）：code: 锚点链接 + 相邻去重。
//
// 历史形态是反引号全路径 span——模型"文件名 + 句柄"连写时被机械替换放大为
// 双路径轰炸（同路径贴两遍/长路径满天星）。升级后 prose 中的句柄还原为
// [display](code:path[:L<start>-L<end>]) markdown 链接：前端 a 拦截器转
// CodeAnchor（页内滚动/CodeDrawer），display 用 basename（跨文件 basename
// 冲突时末两段消歧），全路径锚点保留在 href（path[#anchor] 语义锚点准则）。
// 以下形态回退历史 span 形态：
//   - 符号锚 #symbol（code: 协议无符号形态，不发明 href）
//   - 路径含 [A-Za-z0-9._\-/] 之外字符（链接语法不安全）
//   - 位于代码围栏内部（围栏内容原样的冻结契约，字节级不变）
// 相邻去重（仅 prose）吸收三类连写：
//   A. 句柄连写两次（[File N] [File N] / [File N][File N]）
//   B. 模型写了 `path` 或 `basename` 反引号 span 再接句柄（截 span 发射链接）
//   C. 模型写了裸 basename 紧邻句柄（词边界 + 仅空白分隔时吸收）
// ─────────────────────────────────────────────────────────────

var armorPathLinkableRe = regexp.MustCompile(`^[A-Za-z0-9._\-/]+$`)

// armorBasename 取路径最后一段；无分隔符时原样返回。
func armorBasename(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// armorDisplayNames 生成 path → display 映射：basename 全局唯一用 basename，
// 跨文件冲突时用末两段（parent/basename）消歧。确定性，无硬编码名单。
func armorDisplayNames(files []ArmorFileRef) map[string]string {
	basenameCount := make(map[string]int, len(files))
	for _, f := range files {
		basenameCount[armorBasename(f.Path)]++
	}
	names := make(map[string]string, len(files))
	for _, f := range files {
		b := armorBasename(f.Path)
		if basenameCount[b] <= 1 {
			names[f.Path] = b
			continue
		}
		i := strings.LastIndex(f.Path, "/")
		j := -1
		if i >= 0 {
			j = strings.LastIndex(f.Path[:i], "/")
		}
		if j >= 0 {
			names[f.Path] = f.Path[j+1:]
		} else {
			names[f.Path] = f.Path
		}
	}
	return names
}

// armorInlineToken 计算句柄的 prose 首选形态（链接）与历史 span 形态（围栏/回退）。
func armorInlineToken(path, lStart, lEnd, symbol string, display map[string]string) (token, legacySpan string) {
	legacySpan = "`" + path + armorHandleSuffix(lStart, lEnd, symbol) + "`"
	if symbol != "" || !armorPathLinkableRe.MatchString(path) {
		return legacySpan, legacySpan
	}
	href := "code:" + path
	if jsTruthyString(lStart) {
		href += ":L" + lStart
		if jsTruthyString(lEnd) {
			href += "-L" + lEnd
		}
	}
	if d, ok := display[path]; ok {
		return "[" + d + "](" + href + ")", legacySpan
	}
	return legacySpan, legacySpan
}

// armorWordBoundaryBefore 判定 s[i] 前一字符是否构成词边界（ASCII 词符
// [A-Za-z0-9._-] 之外均算边界，多字节首字节 ≥ 0x80 恒为边界）。
func armorWordBoundaryBefore(s string, i int) bool {
	if i <= 0 {
		return true
	}
	c := s[i-1]
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '_', c == '-':
		return false
	}
	return true
}

// armorRtrimBytes 剥离尾部 ASCII 空白（空格/制表/换行/回车）。
func armorRtrimBytes(out []byte) []byte {
	n := len(out)
	for n > 0 {
		c := out[n-1]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			break
		}
		n--
	}
	return out[:n]
}

func armorIsAllWS(s string) bool {
	return strings.TrimLeft(s, " \t\n\r") == ""
}

// armorEmitDedup 发射 prose 句柄还原 token，按 A/B/C 规则吸收相邻重复。
func armorEmitDedup(out []byte, between, token, legacySpan, path string) []byte {
	// A：句柄连写两次——between 全空白且已发射内容以同 token/历史 span 结尾
	if armorIsAllWS(between) {
		rtrim := armorRtrimBytes(out)
		if bytes.HasSuffix(rtrim, []byte(token)) || bytes.HasSuffix(rtrim, []byte(legacySpan)) {
			return out
		}
		return append(append(out, between...), token...)
	}

	trimmed := strings.TrimRight(between, " \t\n\r")
	// B：模型先写了 `path` / `basename` 反引号 span 再接句柄——截掉 span 原位升级为链接
	for _, span := range []string{"`" + path + "`", "`" + armorBasename(path) + "`"} {
		if strings.HasSuffix(trimmed, span) {
			return append(append(out, trimmed[:len(trimmed)-len(span)]...), token...)
		}
	}
	// C：裸 basename 紧邻句柄（词边界 + 其后仅空白）——吸收裸名
	if b := armorBasename(path); b != "" && strings.HasSuffix(trimmed, b) &&
		armorWordBoundaryBefore(trimmed, len(trimmed)-len(b)) {
		return append(append(out, trimmed[:len(trimmed)-len(b)]...), token...)
	}
	return append(append(out, between...), token...)
}

// submatchGroups 从 FindAllStringSubmatchIndex 的单个 loc 提取捕获组（缺失组为 ""）。
func submatchGroups(input string, loc []int) []string {
	groups := make([]string, len(loc)/2)
	for i := range groups {
		if loc[i*2] >= 0 {
			groups[i] = input[loc[i*2]:loc[i*2+1]]
		} else {
			groups[i] = ""
		}
	}
	return groups
}

// resolveInlineHandles 正文内联句柄还原主循环：与历史实现同作用域（armorInlineHandleRe
// 全串匹配，含围栏内部），围栏内部字节级保持历史 span 形态，prose 走链接化 + 去重。
func resolveInlineHandles(resolved string, files []ArmorFileRef) string {
	display := armorDisplayNames(files)
	fences := findCodeFenceIndices(resolved)
	inFence := func(pos int) bool {
		for _, f := range fences {
			if pos >= f[0] && pos < f[1] {
				return true
			}
		}
		return false
	}

	var out []byte
	last := 0
	for _, loc := range armorInlineHandleRe.FindAllStringSubmatchIndex(resolved, -1) {
		between := resolved[last:loc[0]]
		g := submatchGroups(resolved, loc)
		match, fileIndexStr, lStart, lEnd, symbol := g[0], g[1], g[2], g[3], g[4]

		idx, err := strconv.Atoi(fileIndexStr)
		if err != nil || idx < 1 || idx > len(files) {
			out = append(out, between...)
			out = append(out, match...)
			last = loc[1]
			continue
		}

		path := files[idx-1].Path
		token, legacySpan := armorInlineToken(path, lStart, lEnd, symbol, display)
		if inFence(loc[0]) {
			out = append(out, between...)
			out = append(out, legacySpan...)
			last = loc[1]
			continue
		}
		out = armorEmitDedup(out, between, token, legacySpan, path)
		last = loc[1]
	}
	out = append(out, resolved[last:]...)
	return string(out)
}

// ─────────────────────────────────────────────────────────────
// ② sanitizeMdxForCompilation：确定性 MDX 语法消毒
// ─────────────────────────────────────────────────────────────

// 1a 闭合 manifest 剥离（JS 原型 gi，无前后顾，RE2 直译；
// 注意闭合标签与开放标签名可交叉——JS 原型两处交替独立）：
//
//	/<(?:concept_manifest|pedagogy_manifest)[^>]*>[\s\S]*?<\/(?:concept_manifest|pedagogy_manifest)>/gi
var armorClosedManifestRe = regexp.MustCompile(`(?i)<(?:concept_manifest|pedagogy_manifest)[^>]*>[\s\S]*?</(?:concept_manifest|pedagogy_manifest)>`)

// armorManifestTagRe 未闭合 manifest 剥离用的开放标签定位（armorStripUnclosedManifests）。
var armorManifestTagRe = regexp.MustCompile(`(?i)<(?:concept_manifest|pedagogy_manifest)[^>]*>`)

// armorStripUnclosedManifests 1b 未闭合 manifest 剥离。JS 原型带前瞻：
//
//	/<(?:concept_manifest|pedagogy_manifest)[^>]*>[\s\S]*?(?=\n#{1,6}\s|$)/gi
//
// RE2 无前瞻，改为手扫等价实现：懒惰游标 q 从 '>' 后逐字符推进，
// 在首个满足「q==串尾 ‖ (\n + 1..6 个 # + 单个空白符)」的位置截断，
// 前瞻文本（\n# 标题行开头）不消费、原样保留。7 个及以上 # 不构成边界
// （#{1,6} 回溯后仍无法接 \s），与 JS 行为一致。
func armorStripUnclosedManifests(input string) string {
	var b strings.Builder
	last := 0
	for _, loc := range armorManifestTagRe.FindAllStringIndex(input, -1) {
		if loc[0] < last {
			continue // 已被上一段截断吞掉的起点
		}
		q := loc[1]
		for q <= len(input) && !armorManifestBoundary(input, q) {
			q++
		}
		if q > len(input) {
			continue // 无边界（理论不可达：q==len 即边界），保守跳过
		}
		b.WriteString(input[last:loc[0]])
		last = q
	}
	b.WriteString(input[last:])
	return b.String()
}

// armorManifestBoundary 判定 q 位置是否满足前瞻 (?=\n#{1,6}\s|$)。
// 空白符按 ASCII 语义（与 Go \s 一致；流水线产物不含 Unicode 空白标题）。
func armorManifestBoundary(input string, q int) bool {
	if q == len(input) {
		return true
	}
	if input[q] != '\n' {
		return false
	}
	i := q + 1
	hashes := 0
	for i < len(input) && input[i] == '#' && hashes < 6 {
		i++
		hashes++
	}
	if hashes < 1 {
		return false
	}
	if i >= len(input) {
		return false
	}
	c := input[i]
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}

// armorFenceRe 历史代码围栏切分正则（保留以向后兼容）。
var armorFenceRe = regexp.MustCompile("```[\\s\\S]*?```")

// findCodeFenceIndices 确定性扫描 Markdown 代码围栏（``` 或 ~~~），严格遵循 CommonMark 规范与 Chomsky 边界准则：
// 1. 支持 3 个及以上连续字符的围栏（```, ````, ~~~ 等）；
// 2. 闭合围栏必须使用相同字符，且字符数 >= 起始围栏字符数；
// 3. 内嵌更短或不同字符的围栏（如 4 反引号包裹 3 反引号）属于代码内容，绝不提前闭合；
// 4. 支持行内紧凑围栏（如 ```code```）；
// 5. 返回每个完整代码围栏的 [startByte, endByte] 切片索引区间。
func findCodeFenceIndices(input string) [][2]int {
	var indices [][2]int
	n := len(input)
	if n < 3 {
		return indices
	}

	pos := 0
	for pos < n {
		lineStart := pos
		lineEnd := strings.IndexByte(input[pos:], '\n')
		if lineEnd < 0 {
			lineEnd = n
		} else {
			lineEnd = pos + lineEnd
		}
		line := input[lineStart:lineEnd]

		idx := 0
		matched := false
		for idx < len(line) {
			ch := line[idx]
			if ch == '`' || ch == '~' {
				count := 0
				cIdx := idx
				for cIdx < len(line) && line[cIdx] == ch {
					count++
					cIdx++
				}
				if count >= 3 {
					fenceStart := lineStart + idx
					fenceChar := ch
					fenceCount := count

					// 检查是否同一行闭合（如 ```code```）
					sameLineRest := line[cIdx:]
					sameClosePattern := strings.Repeat(string(fenceChar), fenceCount)
					sameLineClose := strings.Index(sameLineRest, sameClosePattern)
					if sameLineClose >= 0 {
						fenceEnd := lineStart + cIdx + sameLineClose + fenceCount
						indices = append(indices, [2]int{fenceStart, fenceEnd})
						pos = fenceEnd
						idx = cIdx + sameLineClose + fenceCount
						matched = true
						continue
					}

					// 跨行寻找匹配的闭合围栏
					blockEnd := -1
					nextPos := lineEnd
					if nextPos < n && input[nextPos] == '\n' {
						nextPos++
					}

					for nextPos < n {
						curLineStart := nextPos
						curLineEnd := strings.IndexByte(input[nextPos:], '\n')
						if curLineEnd < 0 {
							curLineEnd = n
						} else {
							curLineEnd = nextPos + curLineEnd
						}
						curLine := input[curLineStart:curLineEnd]

						curIndent := 0
						for curIndent < len(curLine) && curIndent < 4 && curLine[curIndent] == ' ' {
							curIndent++
						}

						if curIndent < 4 && curIndent < len(curLine) && curLine[curIndent] == fenceChar {
							curCount := 0
							k := curIndent
							for k < len(curLine) && curLine[k] == fenceChar {
								curCount++
								k++
							}
							if curCount >= fenceCount {
								rem := strings.TrimSpace(curLine[k:])
								if rem == "" {
									blockEnd = curLineStart + curIndent + curCount
									pos = curLineEnd
									if pos < n && input[pos] == '\n' {
										pos++
									}
									break
								}
							}
						}

						nextPos = curLineEnd
						if nextPos < n && input[nextPos] == '\n' {
							nextPos++
						}
					}

					if blockEnd == -1 {
						blockEnd = n
						pos = n
					}

					indices = append(indices, [2]int{fenceStart, blockEnd})
					matched = true
					break
				}
			}
			idx++
		}

		if !matched {
			pos = lineEnd
			if pos < n && input[pos] == '\n' {
				pos++
			}
		}
	}

	return indices
}

// armorSplitByFence 依据 CommonMark 规范切分 Markdown 代码围栏：
// 产出 [prose, code, prose, code, ...] 交替序列，首尾/相邻匹配间保留空串。
// 遵循 Chomsky 边界准则与反正则回溯：支持围栏升阶（例如 4 反引号包裹 3 反引号），
// 绝不因内嵌代码块提前闭合外层围栏。
func armorSplitByFence(input string) []string {
	var parts []string
	last := 0
	for _, loc := range findCodeFenceIndices(input) {
		parts = append(parts, input[last:loc[0]], input[loc[0]:loc[1]])
		last = loc[1]
	}
	return append(parts, input[last:])
}

// prose 规则 1（JS 原型前瞻 /<(?=[ \t=]|\d)/g，改写为消费重发，等价）：
var armorLtEscapeRe = regexp.MustCompile(`<([ \t=]|[0-9])`)

// prose 规则 2 泛型转义（JS 原型无前后顾，RE2 直译；注意大小写敏感）：
//
//	/<([A-Z][a-zA-Z0-9_]*<[^>]+>|[A-Z]|(?:string|number|boolean|any|unknown|void|T|K|V)(?:,\s*(?:string|number|boolean|any|unknown|void|T|K|V|\w+))*)\>/g
var armorGenericRe = regexp.MustCompile(`<([A-Z][a-zA-Z0-9_]*<[^>]+>|[A-Z]|(?:string|number|boolean|any|unknown|void|T|K|V)(?:,\s*(?:string|number|boolean|any|unknown|void|T|K|V|\w+))*)>`)

// 保留判定（JS 回调内两条无标志正则）：
//
//	/^<[A-Z][a-zA-Z0-9]*>$/ 且非 /^<(?:T|K|V|P|R|E|Props|State|Context)>$/
var armorJsxLikeRe = regexp.MustCompile(`^<[A-Z][a-zA-Z0-9]*>$`)
var armorKnownTypeParamRe = regexp.MustCompile(`^<(?:T|K|V|P|R|E|Props|State|Context)>$`)

// prose 规则 3 void tag 自闭合（JS 原型后顾 /<(br|hr|img)([^>]*?)(?<!\/)>/gi）。
// RE2 无后顾，改写为消费式并在回调判定 g2 结尾是否 '/'：
// [^>] 不含 '>'，故「> 前一字符」恰为 g2 末字符（g2 空时为标签名末字符，
// 永不为 '/'）——已自闭合的 <br /> 命中后原样返回，与 JS 不匹配等价。
var armorVoidTagRe = regexp.MustCompile(`(?i)<(br|hr|img)([^>]*?)>`)

// SanitizeMdxForCompilation 与 TS sanitizeMdxForCompilation 对齐：
// manifest 剥离 → 围栏切分（代码块 100% 原样）→ prose 转义 → 重组。
func SanitizeMdxForCompilation(mdxContent string) string {
	if mdxContent == "" {
		return ""
	}

	stripped := armorClosedManifestRe.ReplaceAllString(mdxContent, "")
	stripped = armorStripUnclosedManifests(stripped)

	parts := armorSplitByFence(stripped)
	for i := 0; i < len(parts); i += 2 {
		prose := parts[i]
		if prose == "" {
			continue
		}

		prose = armorLtEscapeRe.ReplaceAllString(prose, "&lt;$1")

		prose = replaceAllSubmatch(armorGenericRe, prose, func(g []string) string {
			m := g[0]
			if armorJsxLikeRe.MatchString(m) && !armorKnownTypeParamRe.MatchString(m) {
				return m
			}
			return strings.ReplaceAll(strings.ReplaceAll(m, "<", "&lt;"), ">", "&gt;")
		})

		prose = replaceAllSubmatch(armorVoidTagRe, prose, func(g []string) string {
			if strings.HasSuffix(g[2], "/") {
				return g[0]
			}
			return "<" + g[1] + g[2] + " />"
		})

		parts[i] = prose
	}

	return strings.Join(parts, "")
}

// PruneTerminalCliffhanger 在终章时确定性剪除末尾出现的下一课时/下一章预告等幻觉过渡句。
// 遵循零破窗公理：不触碰代码围栏，仅在正文末尾段落查找并修剪幻觉结尾。
func PruneTerminalCliffhanger(content string) string {
	if strings.TrimSpace(content) == "" {
		return content
	}

	parts := armorSplitByFence(content)
	// 找到最后一个非代码段（通常为结语段落）
	for i := len(parts) - 1; i >= 0; i-- {
		if i%2 == 1 {
			// 代码块，跳过
			continue
		}
		prose := parts[i]
		if strings.TrimSpace(prose) == "" {
			continue
		}

		// 检查该非代码段尾部是否包含终章幻觉过渡句
		if mdpat.TerminalCliffhangerRe.MatchString(prose) {
			cleaned := mdpat.TerminalCliffhangerRe.ReplaceAllStringFunc(prose, func(match string) string {
				// 保留句子前导标点（若有），如句号、感叹号、问号、换行
				r, _ := utf8.DecodeRuneInString(match)
				if r == '.' || r == '。' || r == '！' || r == '!' || r == '？' || r == '?' || r == '\n' {
					return string(r)
				}
				return ""
			})
			parts[i] = strings.TrimRight(cleaned, " \t\r\n") + "\n"
			break
		}
		// 仅检查最后一段有实质文本的 prose 块
		break
	}

	return strings.Join(parts, "")
}


// ─────────────────────────────────────────────────────────────
// ③ allocateBalancedSourceSnippets：输入端代码材料平滑配比分配
// ─────────────────────────────────────────────────────────────

const armorBaseAllotmentPerFile = 800
const armorDefaultBudgetChars = 40000

// AllocateBalancedSourceSnippets 与 TS allocateBalancedSourceSnippets 对齐：
// 每文件 800 字符保底 + 剩余预算按体积比例分配（预算不足时均分）。
func AllocateBalancedSourceSnippets(files []ArmorSourceFile, totalBudgetChars int) []ArmorAllocatedSnippet {
	if totalBudgetChars <= 0 {
		totalBudgetChars = armorDefaultBudgetChars
	}
	if len(files) == 0 {
		return []ArmorAllocatedSnippet{}
	}

	if len(files) == 1 {
		f := files[0]
		return []ArmorAllocatedSnippet{{
			Path:       f.Path,
			TotalLines: f.TotalLines,
			Snippet:    jsSliceTo(f.RawContent, totalBudgetChars),
		}}
	}

	reservedBaseTotal := len(files) * armorBaseAllotmentPerFile
	result := make([]ArmorAllocatedSnippet, 0, len(files))

	if reservedBaseTotal >= totalBudgetChars {
		evenShare := totalBudgetChars / len(files) // 非负整数除法 = Math.floor
		for _, f := range files {
			result = append(result, ArmorAllocatedSnippet{
				Path:       f.Path,
				TotalLines: f.TotalLines,
				Snippet:    jsSliceTo(f.RawContent, evenShare),
			})
		}
		return result
	}

	remainingBudget := totalBudgetChars - reservedBaseTotal
	totalRemainingChars := 0
	for _, f := range files {
		over := len(f.RawContent) - armorBaseAllotmentPerFile
		if over > 0 {
			totalRemainingChars += over
		}
	}

	for _, f := range files {
		rawLen := len(f.RawContent)
		baseShare := rawLen
		if armorBaseAllotmentPerFile < baseShare {
			baseShare = armorBaseAllotmentPerFile
		}
		extraCandidate := 0
		if rawLen-armorBaseAllotmentPerFile > 0 {
			extraCandidate = rawLen - armorBaseAllotmentPerFile
		}
		extraShare := 0
		if totalRemainingChars > 0 {
			extraShare = int(float64(extraCandidate) / float64(totalRemainingChars) * float64(remainingBudget)) // Math.floor 对非负数
		}

		result = append(result, ArmorAllocatedSnippet{
			Path:       f.Path,
			TotalLines: f.TotalLines,
			Snippet:    jsSliceTo(f.RawContent, baseShare+extraShare),
		})
	}

	return result
}

// jsSliceTo 复刻 JS String.slice(0, n)（n ≥ 0 前提下）：越界取整串。
func jsSliceTo(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if n > len(s) {
		return s
	}
	return s[:n]
}

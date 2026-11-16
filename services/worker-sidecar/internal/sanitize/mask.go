package sanitize

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// 代码块 mask/unmask：逐字节复刻 apps/client/src/engine/
// transformer.ts 的 maskCodeBlocks。
//
// token 格式（PUA 定界符在源码里不可见，显式转义声明）：
//   U+E800 (\uE800) + 'CODE_BLOCK_' + 十进制序号 + U+E001 (\uE001)
// ─────────────────────────────────────────────────────────────

const (
	// MaskTokenPrefix PUA 定界符前缀（源码不可见字符，显式转义声明）
	MaskTokenPrefix = "\uE800CODE_BLOCK_"
	// MaskTokenSuffix PUA 定界符后缀
	MaskTokenSuffix = "\uE001"
)

var (
	ogisUnmaskTokenRe = regexp.MustCompile("\uE800CODE_BLOCK_([0-9]+)\uE001")
	fenceOpenRe       = mdpat.FenceOpenRe

	langAliasMap = map[string]string{
		"dos": "bat",
		"env": "bash",
		"c#":  "csharp",
		"c++": "cpp",
	}
)

// MaskCodeBlocks 返回 masked 文本与代码块数组；UnmaskCodeBlocks 为其逆。
func MaskCodeBlocks(markdown string) (string, []CodeBlock) {
	var codeBlocks []CodeBlock
	lines := strings.Split(markdown, "\n")
	var processed []string

	inFenced := false
	var fenceChar byte
	fenceLen := 0
	var fencedBuffer []string

	pushBlock := func(text string, fenced bool) string {
		codeBlocks = append(codeBlocks, CodeBlock{Text: text, Fenced: fenced})
		return MaskTokenPrefix + strconv.Itoa(len(codeBlocks)-1) + MaskTokenSuffix
	}

	for _, line := range lines {
		m := fenceOpenRe.FindStringSubmatch(line)
		if !inFenced {
			if m != nil {
				inFenced = true
				fenceChar = m[1][0]
				fenceLen = len(m[1])
				fencedBuffer = []string{line}
				continue
			}
			processed = append(processed, maskInlineCode(line, &codeBlocks))
		} else {
			fencedBuffer = append(fencedBuffer, line)
			if m != nil && m[1][0] == fenceChar && len(m[1]) >= fenceLen && strings.TrimSpace(m[2]) == "" {
				inFenced = false
				processed = append(processed, pushBlock(strings.Join(fencedBuffer, "\n"), true))
				fencedBuffer = nil
			}
		}
	}
	if inFenced && len(fencedBuffer) > 0 {
		processed = append(processed, pushBlock(strings.Join(fencedBuffer, "\n"), true))
	}
	return strings.Join(processed, "\n"), codeBlocks
}

// UnmaskCodeBlocks 还原 token（越界/未知序号回空串，对齐 Node ?? ""）。
func UnmaskCodeBlocks(content string, codeBlocks []CodeBlock) string {
	return ogisUnmaskTokenRe.ReplaceAllStringFunc(content, func(tok string) string {
		idStr := ogisUnmaskTokenRe.FindStringSubmatch(tok)[1]
		id, err := strconv.Atoi(idStr)
		if err != nil || id < 0 || id >= len(codeBlocks) {
			return ""
		}
		b := codeBlocks[id]
		if b.Fenced {
			lines := strings.SplitN(b.Text, "\n", 2)
			if len(lines) == 2 {
				return normalizeFenceLang(lines[0]) + "\n" + lines[1]
			}
			return normalizeFenceLang(lines[0])
		}
		return b.Text
	})
}

// UnmaskCodeBlocksRaw 原始还原 token 为代码块原本内容，严格跳过语言归一化（零语法破坏不变式）。
func UnmaskCodeBlocksRaw(content string, codeBlocks []CodeBlock) string {
	return ogisUnmaskTokenRe.ReplaceAllStringFunc(content, func(tok string) string {
		idStr := ogisUnmaskTokenRe.FindStringSubmatch(tok)[1]
		id, err := strconv.Atoi(idStr)
		if err != nil || id < 0 || id >= len(codeBlocks) {
			return ""
		}
		return codeBlocks[id].Text
	})
}

func maskInlineCode(line string, codeBlocks *[]CodeBlock) string {
	var b strings.Builder
	i := 0
	for i < len(line) {
		if line[i] != '`' {
			b.WriteByte(line[i])
			i++
			continue
		}
		start := i
		for i < len(line) && line[i] == '`' {
			i++
		}
		runLen := i - start
		closeAt := -1
		for j := i; j+runLen <= len(line); j++ {
			allTicks := true
			for k := 0; k < runLen; k++ {
				if line[j+k] != '`' {
					allTicks = false
					break
				}
			}
			if allTicks {
				closeAt = j
				break
			}
		}
		if closeAt < 0 {
			b.WriteString(line[start:i])
			continue
		}
		end := closeAt + runLen
		*codeBlocks = append(*codeBlocks, CodeBlock{Text: line[start:end], Fenced: false})
		b.WriteString(MaskTokenPrefix + strconv.Itoa(len(*codeBlocks)-1) + MaskTokenSuffix)
		i = end
	}
	return b.String()
}

func normalizeFenceLang(fenceLine string) string {
	m := fenceOpenRe.FindStringSubmatch(fenceLine)
	if m == nil {
		return fenceLine
	}
	info := m[2]
	trimmed := strings.TrimSpace(info)
	if trimmed == "" {
		return fenceLine
	}
	firstWord := strings.Fields(trimmed)[0]
	lang := strings.SplitN(firstWord, "|", 2)[0]
	mapped, aliased := langAliasMap[strings.ToLower(lang)]
	if !aliased && !strings.Contains(firstWord, "|") {
		return fenceLine
	}
	if aliased {
		lang = mapped
	}
	indent := m[0][:len(m[0])-len(m[1])-len(m[2])]
	if i := strings.Index(info, firstWord); i >= 0 {
		if suffix := strings.TrimSpace(info[i+len(firstWord):]); suffix != "" {
			return indent + m[1] + lang + " " + suffix
		}
	}
	return indent + m[1] + lang
}

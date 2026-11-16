// Package mdpat 统一集中跨包复用的 Markdown、文本和 Slug 处理规则（SSOT）。
// 严格遵守 AGENTS.md III.5 与 IV.2：禁止在各包散落 ASCII 正则；所有 CJK
// 字符集统一升级为全面 Unicode 脚本类（Han+Hiragana+Katakana+Hangul），
// 杜绝空串漂移，纯符号输入确定性回退至 FNV-64a 哈希。
package mdpat

import (
	"hash/fnv"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	// SlugNonWordRe 匹配所有非单词字符（\w = [a-zA-Z0-9_]）且不在 CJK 脚本类中的字符。
	SlugNonWordRe = regexp.MustCompile(`[^\w` + CJKScriptClass + `]+`)
)

// IsCJKRune 判定字符是否属于 CJK 全脚本族（汉字、平假名、片假名、谚文及长音符/叠字符）。
func IsCJKRune(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r) ||
		r == 0x30fc || r == 0x3005
}

// Fnv64a 计算字符串 s 的 64 位 FNV-1a 稳定非加密哈希。
func Fnv64a(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

// Fnv64aHex 将字符串 s 的 FNV-1a 64 位哈希格式化为十六进制小写字符串。
func Fnv64aHex(s string) string {
	return strconv.FormatUint(Fnv64a(s), 16)
}

// Slugify 将文本转换为规范的 URL/锚点 Slug（以 '-' 连接）：
//  1. 去除首尾空白并转为小写。
//  2. 将非 \w、非 CJK 字符替换为 '-'。
//  3. 剥离首尾 '-'。
//  4. 防御空串漂移：若原始非空白输入清洗后退化为空串（如纯标点 "???"），
//     确定性回退至 "h-" + Fnv64aHex(raw)，杜绝 Contains(_, "") 恒真与空锚点崩溃。
func Slugify(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	slug := SlugNonWordRe.ReplaceAllString(lower, "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		return "h-" + Fnv64aHex(trimmed)
	}
	return slug
}

// SlugifyUnderscore 将文本转换为下划线连接的模块/目录合法标识符：
// 1. 去除首尾空白并转为小写。
// 2. 将非 \w、非 CJK 字符替换为 '_'。
// 3. 剥离首尾 '_'。
// 4. 防御空串漂移：若非空白输入清洗后退化为空串，确定性回退至 "id_" + Fnv64aHex(raw)。
func SlugifyUnderscore(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	slug := SlugNonWordRe.ReplaceAllString(lower, "_")
	slug = strings.Trim(slug, "_")
	if slug == "" {
		return "id_" + Fnv64aHex(trimmed)
	}
	return slug
}

// SplitPathAnchor 解析并规范化 path[#anchor] 物理语义锚点：
// 1. 统一正斜杠、剥离首尾空白与前导 ./ 与 /。
// 2. 切分文件物理路径 path 与锚点 anchor。
// 3. 若无 '#' 或 anchor 为空，anchor 返回空字符串。
func SplitPathAnchor(raw string) (path string, anchor string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ""
	}
	trimmed = strings.ReplaceAll(trimmed, "\\", "/")
	if idx := strings.Index(trimmed, "#"); idx >= 0 {
		path = strings.TrimSpace(trimmed[:idx])
		anchor = strings.TrimSpace(trimmed[idx+1:])
	} else {
		path = trimmed
		anchor = ""
	}
	for strings.HasPrefix(path, "./") {
		path = strings.TrimPrefix(path, "./")
	}
	path = strings.TrimLeft(path, "/")
	return path, anchor
}

// JoinPathAnchor 规范化拼接 path 与 anchor：
// 若 anchor 为空，返回规范化后的 clean path；否则返回 "path#anchor"。
func JoinPathAnchor(rawPath, rawAnchor string) string {
	path, existingAnchor := SplitPathAnchor(rawPath)
	anchor := strings.TrimSpace(rawAnchor)
	if anchor == "" {
		anchor = existingAnchor
	}
	if anchor == "" {
		return path
	}
	if path == "" {
		return "#" + anchor
	}
	return path + "#" + anchor
}

package mdpat

import (
	"log"
	"regexp"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// 模式文件装载原语（五合一收敛 2026-11）
//
// jsRegex 结构 / JS 旗标编译器 / 扩展名提取 / ingest-patterns.json 路径解析，
// 原chapter/cluster/cognitive/rsg/ingest 五处逐字重复的机制收敛至此。
// 谓词与解析键语义仍归各层所有——ingest 为顶层编排者（依赖四卫星做正文分流），
// 卫星不得反向引 ingest（成环），故共享原语的唯一合法落点是本包
// （宪章：All Go Markdown and text patterns must be centralized in internal/mdpat）。
// ─────────────────────────────────────────────────────────────

// JsRegex 承载 JS 侧正则的 source/flags 序列化形态（ingest-patterns.json 内嵌）。
type JsRegex struct {
	Source string `json:"source"`
	Flags  string `json:"flags"`
}

// CompileJSRegexes 把 JS 正则（含 i/m/s 旗标）编译为 RE2：不兼容语法告警并视为
// 永不匹配（golden 对拍兜底）；label 仅用于告警定位。
func CompileJSRegexes(raw []JsRegex, label string) []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, r := range raw {
		prefix := ""
		for _, f := range r.Flags {
			switch f {
			case 'i':
				prefix += "(?i)"
			case 'm':
				prefix += "(?m)"
			case 's':
				prefix += "(?s)"
			}
		}
		re, err := regexp.Compile(prefix + r.Source)
		if err != nil {
			log.Printf("[ingest-patterns] WARN %s pattern not RE2-compatible, treated as never-match: %v (%s)", label, err, r.Source)
			continue
		}
		out = append(out, re)
	}
	return out
}

// fileNameOf 取路径末段（兼容 \ 与 / 分隔）；空路径返回空串。
func fileNameOf(filePath string) string {
	lastSlash := strings.LastIndexAny(filePath, "/\\")
	filename := filePath
	if lastSlash >= 0 {
		filename = filePath[lastSlash+1:]
	}
	return filename
}

// dotIndexOf 取扩展名点下标；dotfile（.gitignore 等 lastDot==0）与无扩展名返回 -1。
func dotIndexOf(filename string) int {
	lastDot := strings.LastIndex(filename, ".")
	if lastDot <= 0 {
		return -1
	}
	return lastDot
}

// ExtractExtension 带点原样大小写（cognitive/rsg/ingest 原三胞胎语义，调用方自理 ToLower）。
func ExtractExtension(filePath string) string {
	if filePath == "" {
		return ""
	}
	filename := fileNameOf(filePath)
	if i := dotIndexOf(filename); i >= 0 {
		return filename[i:]
	}
	return ""
}

// ExtractExtensionLower 带点且小写（chapter 语义）。
func ExtractExtensionLower(filePath string) string {
	return strings.ToLower(ExtractExtension(filePath))
}

// ExtractExtensionBase 无点原样（cluster 语义：直接作扩展名映射键）。
func ExtractExtensionBase(filePath string) string {
	if filePath == "" {
		return ""
	}
	filename := fileNameOf(filePath)
	if i := dotIndexOf(filename); i >= 0 {
		return filename[i+1:]
	}
	return ""
}


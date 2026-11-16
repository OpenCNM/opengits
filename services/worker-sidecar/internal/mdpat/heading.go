// heading.go 大纲节点标题的确定性推导资产（SSOT）：
// 1. IsRunRecordDump：评测/训练「运行记录转储」路径判定（UUID/散列命名 .txt、.log）；
// 2. FirstAtxHeading：围栏感知的结构化行扫描，提取 Markdown 首个 ATX 一级标题。
// 两者服务于同一条认知红线：File ≠ Cognitive Unit——裸文件名不是教学标题，
// 机器产出的原始日志更不是认知单元，严禁直接充当一等大纲节点标题。
package mdpat

import (
	"path"
	"regexp"
	"strings"
)

// AtxH1LineRe 单行 ATX 一级标题（≤3 空格缩进 + 单个 # + 标题文本 + 可选尾部 # 装饰）。
// 捕获组: 1=标题文本（裸 "#" 空标题行为 nil，视为无效标题继续扫描）。
var AtxH1LineRe = regexp.MustCompile(`^ {0,3}#(?:[ \t]+(.+?))?[ \t]*#*[ \t]*$`)

// FrontmatterDelimRe YAML frontmatter 边界行（--- 或 ...；frontmatter 内的
// "# 注释" 是 YAML 注释而非标题，必须整体跳过）。
var FrontmatterDelimRe = regexp.MustCompile(`^(?:---|\.\.\.)[ \t]*$`)

// UuidBasenameRe UUID 文件基名（8-4-4-4-12 十六进制；运行记录转储的典型命名）。
var UuidBasenameRe = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// HexHashBasenameRe 十六进制散列文件基名（md5/sha1/sha256 段，16~64 位）。
var HexHashBasenameRe = regexp.MustCompile(`(?i)^[0-9a-f]{16,64}$`)

// runRecordDumpExts 运行记录转储候选扩展名（小写；.log 恒转储，
// .txt/.out 仅在基名为 UUID/散列时判定为转储）。
var runRecordDumpExts = map[string]bool{
	".txt": true,
	".out": true,
}

// IsRunRecordDump 判定路径是否为「评测/训练运行记录转储」：.log 文件，或基名为
// UUID / 十六进制散列的 .txt/.out 文件（如 records/**/08cd60f9-….txt）。
// 此类文件是机器产出的原始日志，无稳定认知语义，不配成为一等大纲节点。
func IsRunRecordDump(p string) bool {
	base := path.Base(strings.TrimSpace(strings.Trim(p, "/")))
	if base == "" || base == "." || base == "/" {
		return false
	}
	ext := strings.ToLower(path.Ext(base))
	if ext == ".log" {
		return true
	}
	if !runRecordDumpExts[ext] {
		return false
	}
	stem := base[:len(base)-len(ext)]
	return UuidBasenameRe.MatchString(stem) || HexHashBasenameRe.MatchString(stem)
}

// FirstAtxHeading 结构化行扫描提取首个 ATX 一级标题：跳过 YAML frontmatter
// 与围栏代码块（```/~~~，复用 CodeFenceLineRe 的 CommonMark ≤3 缩进语义），
// 返回剥去装饰（尾部 #、包裹的强调/反引号）后的标题文本；无合法 H1 返回 ""。
// 确定性纯函数，零 LLM 依赖——文档标题信号优先于文件名兜底的第一性依据。
func FirstAtxHeading(text string) string {
	lines := strings.Split(text, "\n")
	inFence := false
	inFrontmatter := false
	for i, raw := range lines {
		line := strings.TrimRight(raw, "\r")

		if i == 0 && FrontmatterDelimRe.MatchString(line) {
			inFrontmatter = true
			continue
		}
		if inFrontmatter {
			if FrontmatterDelimRe.MatchString(line) {
				inFrontmatter = false
			}
			continue
		}

		if CodeFenceLineRe.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}

		m := AtxH1LineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if title := CleanHeadingTitle(m[1]); title != "" {
			return title
		}
	}
	return ""
}

// maxHeadingTitleRunes H1 摩热为大纲 shortTitle 的长度上限（超长截断，防侧栏爆宽）。
const maxHeadingTitleRunes = 80

// CleanHeadingTitle 标题文本净化：剥尾部 # 装饰已由 AtxH1LineRe 完成，此处
// 剥包裹的强调符（*/_）与反引号、压缩空白并截断超长文本。
func CleanHeadingTitle(s string) string {
	s = strings.TrimSpace(s)
	for len(s) >= 2 {
		first, last := s[0], s[len(s)-1]
		if (first == '*' || first == '_' || first == '`') && first == last {
			s = strings.TrimSpace(s[1 : len(s)-1])
			continue
		}
		break
	}
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > maxHeadingTitleRunes {
		s = strings.TrimSpace(string(r[:maxHeadingTitleRunes]))
	}
	return s
}

// CJKRuneRe 标题内 CJK 脚本命中判定（复用 CJKScriptClass 全脚本字符类）。
var CJKRuneRe = regexp.MustCompile("[" + CJKScriptClass + "]")

// PureStatLineRe 纯统计/测量行（"p=0.0049"、"99.2%"、"3.28"、"1e-5" 等——
// relay 偶发把实验记录的显著性数值行当 H1，不配成为教学标题）。
var PureStatLineRe = regexp.MustCompile(`(?i)^[pP]?\s*[=<>~]?\s*[-+]?[\d.,\s%eE+\-]+$`)

// UsableChapterH1 判定 H1 是否有资格充当教学标题（转录后节点标题同步的噪声门禁）：
//   - 长度 2~80 runes；
//   - 非纯统计/测量行（p=0.0049、99.2%）；
//   - 不含 "#"（"Record #360's FA3 build…" 等代码引用注释信号）；
//   - requireCJK 时必须含 CJK 脚本（中文讲法下拦截未翻译的源文行与
//     代码注释行——relay 生成的目标语言标题恒含 CJK）。
func UsableChapterH1(title string, requireCJK bool) bool {
	t := strings.TrimSpace(title)
	r := []rune(t)
	if len(r) < 2 || len(r) > maxHeadingTitleRunes {
		return false
	}
	if PureStatLineRe.MatchString(t) {
		return false
	}
	if strings.Contains(t, "#") {
		return false
	}
	if requireCJK && !CJKRuneRe.MatchString(t) {
		return false
	}
	return true
}

// RequireCJKTitle 目标语言是否要求 CJK 教学标题（zh 系缺省 true——与
// 大纲/转录管线的 isZh 判定同口径；ja/ko 同属 CJK 脚本圈）。
func RequireCJKTitle(targetLanguage string) bool {
	switch strings.ToLower(strings.TrimSpace(targetLanguage)) {
	case "", "zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant", "ja", "ko":
		return true
	}
	return false
}

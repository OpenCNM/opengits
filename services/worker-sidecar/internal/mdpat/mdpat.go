// Package mdpat 集中跨包复用的文本/Markdown 模式常量（SSOT）：
// 完全相同的正则禁止在各包内散落复制；CJK 脚本类统一升级为 Unicode
// 脚本字符类，与 Node 侧 token-counter.ts 的宽集合先例保持同等覆盖。
package mdpat

import "regexp"

// CJKScriptClass CJK 全脚本字符类（汉 + 日文假名 + 韩文谚文 + 长音符/叠字符）。
// 历史上各包硬编码 \x{4e00}-\x{9fa5}（仅中文常用区），假名/谚文被
// 整体当噪声剥离，导致日韩仓库的搜索分词、slug 与 CJK 判定全部失效。
// 注：日文长音符 U+30FC (ー) 与叠字符 U+3005 (々) 在 Unicode 中 Script 为 Common，
// 必须显式补充，否则日文片假名长词（如 アーキテクチャ、サーバー）会被截断拆裂。
const CJKScriptClass = `\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}\x{30fc}\x{3005}`

// FenceOpenRe CommonMark 围栏开行（≤3 空格缩进 + ```/~~~ 及 info string）。
var FenceOpenRe = regexp.MustCompile(`^[ \t]{0,3}(` + "`{3,}" + `|~{3,})(.*)$`)

// FenceCloseRe CommonMark 围栏闭合行（≤3 空格缩进 + ```/~~~）。
var FenceCloseRe = regexp.MustCompile(`^[ \t]{0,3}(` + "`{3,}" + `|~{3,})\s*$`)

// FenceOpenLangRe 列 0 围栏开行（可带 markdown/mdx/md 语言标注；LLM 输出壳层归一判定）。
var FenceOpenLangRe = regexp.MustCompile("(?i)^(`{3,}|~{3,})(markdown|mdx|md)?\\s*$")

// FenceCloseBareRe 列 0 围栏闭行（严格无缩进变体；≤3 缩进宽容版见 FenceCloseRe）。
var FenceCloseBareRe = regexp.MustCompile("^(`{3,}|~{3,})\\s*$")

// CodeFenceLineRe 围栏行判定（≤3 缩进，(?m) 多行模式；供 token 预算/截断的代码块配平计数）。
var CodeFenceLineRe = regexp.MustCompile("(?m)^[ \t]{0,3}(`{3,}|~{3,})")

// SkeletonLabelRe Mermaid 骨架节点标签（["label"] 与 (["label"]) 两种形态）。
var SkeletonLabelRe = regexp.MustCompile(`\["([^"]+)"\]|\(\["([^"]+)"\]\)`)

// ThinkingBlockRe 思考块标签（<think>...</think> 或 <thought>...</thought>，含未闭合流式截断防护）。
var ThinkingBlockRe = regexp.MustCompile(`(?is)<think(?:ing)?>.*?(?:</think(?:ing)?>|$)|<thought>.*?(?:</thought>|$)`)

// MermaidFenceOpenRe Mermaid 围栏代码块起始检测（≤3 空格缩进 + ```/~~~ mermaid）。
var MermaidFenceOpenRe = regexp.MustCompile(`(?i)^[ \t]{0,3}(` + "`{3,}" + `|~{3,})\s*mermaid\b`)

// MermaidDiagramHeaderRe Mermaid 合法图表声明头类型检测。
var MermaidDiagramHeaderRe = regexp.MustCompile(`(?i)^\s*(graph\b|flowchart\b|sequenceDiagram\b|classDiagram\b|stateDiagram\b|erDiagram\b|gitGraph\b|gantt\b|pie\b|mindmap\b|timeline\b|quadrantChart\b|architecture-beta\b|packet-beta\b|block-beta\b|sankey-beta\b|zenuml\b|C4Context\b|C4Container\b|C4Component\b|C4Dynamic\b|C4Deployment\b)`)

// ExtTailRe 路径尾部文件扩展名（含点）。
var ExtTailRe = regexp.MustCompile(`\.[a-zA-Z0-9]+$`)

// MdExtRe Markdown 扩展名 .md/.mdx（大小写不敏感）。
var MdExtRe = regexp.MustCompile(`(?i)\.mdx?$`)

// MdMarkdownExtRe Markdown 扩展名族 .md/.mdx/.markdown（大小写不敏感）。
var MdMarkdownExtRe = regexp.MustCompile(`(?i)\.(md|mdx|markdown)$`)

// NumericHeadingPrefixRe 多级数字序号前缀（"(2)" / "1.2 " / "3、" 等带分隔符或
// 括号形态；裸 "1 intro" 不剥，防概念归并过 merge）。
var NumericHeadingPrefixRe = regexp.MustCompile(`^(?:[(（]\d{1,3}[)）][\s._-]*|(?:\d{1,3}\s*[-_.、)．:]\s*)+(?:\d{1,3}\s+)?)`)

// GitShaRe 短/完整 git sha（7~40 位十六进制；归档目录构造与回源校验共用）。
var GitShaRe = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

// PathSegmentRe 归档路径段白名单（字母数字与 ._-；须配合显式拒绝 "."/".." 防路径穿越）。
var PathSegmentRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// VoidBrRe HTML 换行单标签（未自闭合）。
var VoidBrRe = regexp.MustCompile(`(?i)<br\s*>`)

// VoidHrRe HTML 水平分割线单标签（未自闭合）。
var VoidHrRe = regexp.MustCompile(`(?i)<hr\s*>`)

// VoidWbrRe HTML 软换行单标签（未自闭合）。
var VoidWbrRe = regexp.MustCompile(`(?i)<wbr\s*>`)

// VoidImgInputRe HTML img/input 单标签（未自闭合）。
var VoidImgInputRe = regexp.MustCompile(`(?i)<(img|input)(\s+[^>]*?[^\/>])\s*>`)

// ChapterPrefixRe 章节编号前缀（"第 1 章: ..." / "第 1 章：..." / "Chapter 1: ..." / "Chapter 1. ..." 等形态）。
// 捕获组: 1=中文章号数字, 2=英文章号数字, 3=章节主体标题。
var ChapterPrefixRe = regexp.MustCompile(`^(?i)(?:第\s*(\d+)\s*章|Chapter\s*(\d+))\s*[:：\-—–、.]*\s*(.*)$`)

// TerminalCliffhangerRe 终章幻觉过渡/预告句式（下一课时/下一章/下节课/后续课时等）。
// 包含中英形态，匹配句子或段落尾部的预告句，便于收敛漏斗在教程终章时执行确定性无损剪除。
var TerminalCliffhangerRe = regexp.MustCompile(`(?im)(?:[.。！!？?\n]|^)[ \t]*(?:(?:在)?(?:下一(?:课时?|章节?|节课?)|下节课|接下来的(?:课时|章节?)|后续(?:课时|章节?))(?:中|里)?)[，,：:\s]?[^\n]*$|(?im)(?:[.。！!？?\n]|^)[ \t]*(?:In the next (?:lesson|chapter|module)|Next (?:lesson|chapter))[，,：:\s]?[^\n]*$`)

// TrailingFileWithExtRe 尾随代码/文档物理文件名（如 " train.py", " utils.py", " (types.go)", " `train.py`"）。
// 捕获组: 1=前置分隔符, 2=带扩展名的文件名, 3=扩展名。
var TrailingFileWithExtRe = regexp.MustCompile(`(?i)([\s,，:：(（\["'\x60]+)([\w.-]+\.(py|tsx?|jsx?|go|rs|java|cpp|cc|c|h|hpp|vue|rb|php|cs|swift|kt|scala|sh|bash|zsh|sql|json|ya?ml|toml|md|mdx))[)）\]"'\x60]*$`)

// EmbeddedCodeExtRe 嵌入式源码扩展名（如 ".py", ".go"）。
var EmbeddedCodeExtRe = regexp.MustCompile(`(?i)\.(py|tsx?|jsx?|go|rs|java|cpp|cc|c|h|hpp|vue|rb|php|cs|swift|kt|scala|sh|bash|zsh|sql|json|ya?ml|toml|md|mdx)\b`)

// PreservedTechNamesRe 知名技术框架/生态白名单（严禁误杀 Node.js / Vue.js 等专有名词）。
var PreservedTechNamesRe = regexp.MustCompile(`(?i)\b(?:node|vue|next|nuxt|three|d3|react|express|nest|alpine|chart|anime|phaser|babylon|day|moment)\.js\b`)

// TrailingParenSymbolsRe 章节末尾括号罗列符号模式（如 " (Domain、NewDomain 与 matcherset)", " (Address, Port)", " (Command、errors)"）。
// 捕获组: 1=括号内文本。
var TrailingParenSymbolsRe = regexp.MustCompile(`(?i)\s*[(（]([^()（）]+)[)）]\s*$`)

// DimensionPrefixZhRe 章节标题前置抽象维度标签（如 "门面契约与...", "核心执行引擎: ...", "网络领域模型：..."）。
var DimensionPrefixZhRe = regexp.MustCompile(`^(?:交付入口与门面契约|门面契约|交付入口|(?:[\p{Han}]{0,6})?领域模型与核心状态|(?:[\p{Han}]{0,6})?领域模型|核心执行引擎与管线|核心执行引擎|核心引擎|特化算法与扩展实现|特化算法与扩展|特化算法|规范约束与验证边界|规范约束与验证|规范约束)(?:[:：\s\-—–]+|[与及和]\s*)`)

// DimensionPrefixEnRe 章节标题英文前置抽象维度标签（如 "Core Engine: ...", "Interface & Facade: ..."）。
var DimensionPrefixEnRe = regexp.MustCompile(`(?i)^(?:Interface\s*&\s*Facade|Domain\s*Models?\s*&\s*State|Core\s*Engine\s*(?:&\s*Pipelines?)?|Specialized\s*Implementations?|Verification\s*&\s*Invariants)(?:\s*[:：\-—–]+\s*|\s+(?:and|&)\s+)`)

// CodeIdentifierRe 单个代码标识符（如 multi_buffer, matcherset, train.py, Command）。
var CodeIdentifierRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]*$`)

// TrailingEscapedQuoteJsonClosingRe 模型输出长 JSON 时尾部转义引号与虚假换行残缺闭合模式（如 \"\n} 或 \"}）。
// 用于在标准 json.Unmarshal 报未闭合字符串失败时，确定性修复末尾误转义的双引号。
var TrailingEscapedQuoteJsonClosingRe = regexp.MustCompile(`\\"[ \t]*(?:\\n|[ \t\r\n])*\}\s*$`)

// PaginationPatternRe 分页路径黑洞模式（如 /page/2, /page/44, /p/3 等归档列表分页路径，阻断单向无限链表）。
var PaginationPatternRe = regexp.MustCompile(`(?i)(?:/(?:page|p)/\d+(?:/\d+)?/?$|/(?:page|p)/\d+/)`)

// PaginationQueryRe 分页查询参数黑洞模式（如 ?page=2, &page=44, ?p=3 等分页查询）。
var PaginationQueryRe = regexp.MustCompile(`(?i)(?:^|&)(?:page|p|pg)=\d+`)

// WebDocEditChromeLineRe 网页抓取纯 Markdown 降级路径的外链编辑/反馈工具条单行模式（SSOT，禁止在 webdoc 散落硬编码词表）。
var WebDocEditChromeLineRe = regexp.MustCompile(`(?i)^[ \t]*\[?\s*(?:edit this page(?:\s+on\s+(?:github|gitlab|bitbucket))?|suggest an edit|improve this page|give feedback|leave feedback|report an issue)\s*\]\(\s*https?://[^)\s]+/(?:edit/|issues/new|forms|feedback)[^)\s]*\s*\)[ \t]*$`)

// WebDocStandaloneActionLineRe 网页抓取纯 Markdown 降级路径的孤立按钮文案单行模式（整行精确匹配，不误伤正文句子）。
var WebDocStandaloneActionLineRe = regexp.MustCompile(`(?i)^[ \t]*(?:copy page|copy for llm|view as markdown|open in chatgpt|open in claude|edit this page on github|give feedback)[ \t]*$`)

// IsWebDocChromeLine 判定 Markdown 孤立行是否为已知页头/页尾工具 chrome（在代码块已 mask 后调用）。
func IsWebDocChromeLine(line string) bool {
	return WebDocEditChromeLineRe.MatchString(line) || WebDocStandaloneActionLineRe.MatchString(line)
}



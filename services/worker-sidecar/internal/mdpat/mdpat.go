package mdpat

import (
	"regexp"
	"strconv"
)

// Includes U+30FC (ー) and U+3005 (々) (Unicode Common) so Japanese katakana/kanji words are not split.
const CJKScriptClass = `\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}\x{30fc}\x{3005}`

var FenceOpenRe = regexp.MustCompile(`^[ \t]{0,3}(` + "`{3,}" + `|~{3,})(.*)$`)

var FenceCloseRe = regexp.MustCompile(`^[ \t]{0,3}(` + "`{3,}" + `|~{3,})\s*$`)

var FenceOpenLangRe = regexp.MustCompile("(?i)^(`{3,}|~{3,})(markdown|mdx|md)?\\s*$")

var FenceCloseBareRe = regexp.MustCompile("^(`{3,}|~{3,})\\s*$")

var CodeFenceLineRe = regexp.MustCompile("(?m)^[ \t]{0,3}(`{3,}|~{3,})")

var SkeletonLabelRe = regexp.MustCompile(`\["([^"]+)"\]|\(\["([^"]+)"\]\)`)

var ThinkingBlockRe = regexp.MustCompile(`(?is)<think(?:ing)?>.*?(?:</think(?:ing)?>|$)|<thought>.*?(?:</thought>|$)`)

var MermaidFenceOpenRe = regexp.MustCompile(`(?i)^[ \t]{0,3}(` + "`{3,}" + `|~{3,})\s*mermaid\b`)

var MermaidDiagramHeaderRe = regexp.MustCompile(`(?i)^\s*(graph\b|flowchart\b|sequenceDiagram\b|classDiagram\b|stateDiagram\b|erDiagram\b|gitGraph\b|gantt\b|pie\b|mindmap\b|timeline\b|quadrantChart\b|architecture-beta\b|packet-beta\b|block-beta\b|sankey-beta\b|zenuml\b|C4Context\b|C4Container\b|C4Component\b|C4Dynamic\b|C4Deployment\b)`)

var ExtTailRe = regexp.MustCompile(`\.[a-zA-Z0-9]+$`)

var MdExtRe = regexp.MustCompile(`(?i)\.mdx?$`)

var MdMarkdownExtRe = regexp.MustCompile(`(?i)\.(md|mdx|markdown)$`)

// Requires separator or parens so bare "1 intro" is preserved against concept over-merging.
var NumericHeadingPrefixRe = regexp.MustCompile(`^(?:[(（]\d{1,3}[)）][\s._-]*|(?:\d{1,3}\s*[-_.、)．:]\s*)+(?:\d{1,3}\s+)?)`)

var GitShaRe = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

// Must pair with explicit "."/".." checks to prevent archive path traversal.
var PathSegmentRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

var VoidBrRe = regexp.MustCompile(`(?i)<br\s*>`)

var VoidHrRe = regexp.MustCompile(`(?i)<hr\s*>`)

var VoidWbrRe = regexp.MustCompile(`(?i)<wbr\s*>`)

var VoidImgInputRe = regexp.MustCompile(`(?i)<(img|input)(\s+[^>]*?[^\/>])\s*>`)

var ChapterPrefixRe = regexp.MustCompile(`^(?i)(?:第\s*(\d+)\s*章|Chapter\s*(\d+))\s*[:：\-—–、.]*\s*(.*)$`)

var TerminalCliffhangerRe = regexp.MustCompile(`(?im)(?:[.。！!？?\n]|^)[ \t]*(?:(?:在)?(?:下一(?:课时?|章节?|节课?)|下节课|接下来的(?:课时|章节?)|后续(?:课时|章节?))(?:中|里)?)[，,：:\s]?[^\n]*$|(?im)(?:[.。！!？?\n]|^)[ \t]*(?:In the next (?:lesson|chapter|module)|Next (?:lesson|chapter))[，,：:\s]?[^\n]*$`)

var TrailingFileWithExtRe = regexp.MustCompile(`(?i)([\s,，:：(（\["'\x60]+)([\w.-]+\.(py|tsx?|jsx?|go|rs|java|cpp|cc|c|h|hpp|vue|rb|php|cs|swift|kt|scala|sh|bash|zsh|sql|json|ya?ml|toml|md|mdx))[)）\]"'\x60]*$`)

var EmbeddedCodeExtRe = regexp.MustCompile(`(?i)\.(py|tsx?|jsx?|go|rs|java|cpp|cc|c|h|hpp|vue|rb|php|cs|swift|kt|scala|sh|bash|zsh|sql|json|ya?ml|toml|md|mdx)\b`)

// Whitelist protects proper nouns like Node.js and Vue.js from filename stripping.
var PreservedTechNamesRe = regexp.MustCompile(`(?i)\b(?:node|vue|next|nuxt|three|d3|react|express|nest|alpine|chart|anime|phaser|babylon|day|moment)\.js\b`)

var TrailingParenSymbolsRe = regexp.MustCompile(`(?i)\s*[(（]([^()（）]+)[)）]\s*$`)

var DimensionPrefixZhRe = regexp.MustCompile(`^(?:交付入口与门面契约|门面契约|交付入口|(?:[\p{Han}]{0,6})?领域模型与核心状态|(?:[\p{Han}]{0,6})?领域模型|核心执行引擎与管线|核心执行引擎|核心引擎|特化算法与扩展实现|特化算法与扩展|特化算法|规范约束与验证边界|规范约束与验证|规范约束)(?:[:：\s\-—–]+|[与及和]\s*)`)

var DimensionPrefixEnRe = regexp.MustCompile(`(?i)^(?:Interface\s*&\s*Facade|Domain\s*Models?\s*&\s*State|Core\s*Engine\s*(?:&\s*Pipelines?)?|Specialized\s*Implementations?|Verification\s*&\s*Invariants)(?:\s*[:：\-—–]+\s*|\s+(?:and|&)\s+)`)

var CodeIdentifierRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]*$`)

var TrailingEscapedQuoteJsonClosingRe = regexp.MustCompile(`\\"[ \t]*(?:\\n|[ \t\r\n])*\}\s*$`)

var PaginationPatternRe = regexp.MustCompile(`(?i)(?:/(?:page|p)/\d+(?:/\d+)?/?$|/(?:page|p)/\d+/)`)

var PaginationQueryRe = regexp.MustCompile(`(?i)(?:^|&)(?:page|p|pg)=\d+`)

var WebDocEditChromeLineRe = regexp.MustCompile(`(?i)^[ \t]*\[?\s*(?:edit this page(?:\s+on\s+(?:github|gitlab|bitbucket))?|suggest an edit|improve this page|give feedback|leave feedback|report an issue)\s*\]\(\s*https?://[^)\s]+/(?:edit/|issues/new|forms|feedback)[^)\s]*\s*\)[ \t]*$`)

var WebDocStandaloneActionLineRe = regexp.MustCompile(`(?i)^[ \t]*(?:copy page|copy for llm|view as markdown|open in chatgpt|open in claude|edit this page on github|give feedback)[ \t]*$`)

func IsWebDocChromeLine(line string) bool {
	return WebDocEditChromeLineRe.MatchString(line) || WebDocStandaloneActionLineRe.MatchString(line)
}

// Scan prose only; matching patterns inside fenced code blocks are not chapter references.
var ChapterRefRe = regexp.MustCompile(`(?i)(?:第\s*(\d+)\s*[章课]|Chapter\s+(\d+))`)

func FindChapterRefs(text string) []int {
	var refs []int
	for _, m := range ChapterRefRe.FindAllStringSubmatch(text, -1) {
		digits := m[1]
		if digits == "" {
			digits = m[2]
		}
		n, err := strconv.Atoi(digits)
		if err != nil || n <= 0 {
			continue
		}
		refs = append(refs, n)
	}
	return refs
}

// Truncates by rune count so multi-byte UTF-8 sequences are never split mid-character.
func TruncateRunes(s string, max int, ellipsis string) string {
	runes := []rune(s)
	if max <= 0 || len(runes) <= max {
		return s
	}
	return string(runes[:max]) + ellipsis
}

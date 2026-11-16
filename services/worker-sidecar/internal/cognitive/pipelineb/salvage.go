package pipelineb

import (
	"encoding/json"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/pipeline"
)

// ─────────────────────────────────────────────────────────────
// 截断 JSON 章节抢救器（Deadline Salvage）。
//
// 物理动机：流式大纲被预算切断（ErrStreamPartial）时，已完整落章的
// JSON 对象是真实产出——非流式超时是全损，流式截止可部分回收。扫描器
// 为确定性花括号深度状态机（尊字符串与转义，零 regex），逐候选子串过
// 与 ParseOutlineJSON 完全相同的逐章校验闸门（validateAndAssembleOutline），
// 之后仍走 SanitizeAndIntersectOutline 路径幻觉装甲——抢救产物不享受
// 任何校验豁免权。
// ─────────────────────────────────────────────────────────────

// SalvageOutlineChapters 从截断或外壳包装的模型输出中抢救已完整的章节对象。
// 输入为空 / 无完整对象 / 全部无效时返回 nil（进入 Layer 2 续写或 Layer 3 失效封闭）。
func SalvageOutlineChapters(truncated string) []cognitive.OutlineChapter {
	if len(truncated) == 0 {
		return nil
	}
	clean, _ := pipeline.StripPayloadShell(truncated)
	clean = strings.TrimSpace(clean)
	if len(clean) == 0 {
		clean = truncated
	}

	candidates := scanChapterArrayElements(clean, maxChapters)
	if len(candidates) == 0 && clean != truncated {
		// 备用兜底：若剥壳过于激进，尝试对原文本进行状态机扫描
		candidates = scanChapterArrayElements(truncated, maxChapters)
	}
	if len(candidates) == 0 {
		return nil
	}
	items := make([]rawChapterItem, 0, len(candidates))
	for _, c := range candidates {
		var item rawChapterItem
		if err := json.Unmarshal([]byte(c), &item); err != nil {
			continue // 截断残章/非章节对象（如外层容器壳）静默丢弃
		}
		items = append(items, item)
	}
	if len(items) == 0 {
		return nil
	}
	out, err := validateAndAssembleOutline(items)
	if err != nil {
		return nil
	}
	return out
}

// scanChapterArrayElements 定位章节数组并在其元素层扫描平衡对象子串：
// 优先锚定 "chapters" 键之后的 `[`（外层容器形态——容器在截断流中永不
// 闭合，章节对象处于容器内部深度，顶层扫描收不到）；无该键时回退首个
// `[`（裸数组形态，与 ParseOutlineJSON Case A 同构）。状态机尊字符串与
// 转义（零 regex）；遇到数组闭合 `]` 即止（此后内容非章节）。
func scanChapterArrayElements(text string, limit int) []string {
	arrStart := -1
	if idx := strings.Index(text, `"chapters"`); idx >= 0 {
		if rel := strings.Index(text[idx:], "["); rel >= 0 {
			arrStart = idx + rel
		}
	}
	if arrStart < 0 {
		arrStart = strings.Index(text, "[")
	}
	if arrStart < 0 {
		return nil
	}

	var out []string
	depth := 0
	inString := false
	escaped := false
	start := -1
	for i := arrStart + 1; i < len(text) && len(out) < limit; i++ {
		ch := text[i]
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if ch == '"' {
			inString = !inString
			continue
		}
		if inString {
			continue
		}
		switch ch {
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			if depth > 0 {
				depth--
				if depth == 0 && start >= 0 {
					out = append(out, text[start:i+1])
					start = -1
				}
			}
		case ']':
			if depth == 0 {
				return out // 数组闭合：此后内容非章节元素
			}
		}
	}
	return out
}

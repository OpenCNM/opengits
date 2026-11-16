package transcription

import (
	"context"
	"log"
	"strings"
	"time"
)

// SampleTranslationFidelity 使用轻量 Micro-LLM 快速采样质检（识别截断/复读英文夹生饭）。
// 规则：
// 1. 若有效尾部 Prose < 50 字符（如纯代码/图表结尾），跳过采样免除无谓开销；
// 2. 调度极简 doc_translation_sample 提示词（目标语言验证，微输出，无 thinking 消耗）；
// 3. 返回 isPassed (true 为合格译文，false 为尾部夹生/未翻译)。
func SampleTranslationFidelity(ctx context.Context, llm LlmGatewayAPI, draft string, targetLanguage string, uid *string) (bool, string) {
	if llm == nil || strings.TrimSpace(draft) == "" || targetLanguage == "" || targetLanguage == "none" {
		return true, ""
	}

	tail := ExtractTailProse(draft, 300)
	if len([]rune(tail.Prose)) < 50 {
		// 尾部有效 Prose 过短，物理事实不支持采样，放行常规 AST 装甲
		return true, ""
	}

	sampleCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	vars := map[string]any{
		"targetLanguage": targetLanguage,
		"snippet":        tail.Prose,
	}

	res, err := llm.Complete(sampleCtx, "doc_translation_sample", vars, uid)
	if err != nil {
		log.Printf("[sampling-audit] translation sampling failed for targetLang=%s: %v (skipping audit)", targetLanguage, err)
		return true, "" // 采样探针不可用时放行至 AST 校验闸门
	}

	text := strings.TrimSpace(res.Text)
	if strings.Contains(text, "<FAIL>") {
		return false, "untranslated_tail_prose"
	}

	return true, ""
}

// HealUntranslatedTail 对夹生的尾部段落进行微创断点补翻与就地缝合（Layer 3）。
func HealUntranslatedTail(ctx context.Context, llm LlmGatewayAPI, draft string, targetLanguage string, uid *string) (string, bool) {
	if llm == nil || strings.TrimSpace(draft) == "" || targetLanguage == "" || targetLanguage == "none" {
		return draft, false
	}

	tail := ExtractTailProse(draft, 400)
	if tail.RawSnippet == "" {
		return draft, false
	}

	patchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	res, err := llm.Complete(patchCtx, "doc_translate", map[string]any{
		"content":        tail.RawSnippet,
		"targetLanguage": targetLanguage,
	}, uid)
	if err != nil || res.FinishReason == "length" || strings.TrimSpace(res.Text) == "" {
		return draft, false
	}

	healedSnippet, herr := translatedTextOrOriginal(res.Text, tail.RawSnippet)
	if herr != nil || strings.TrimSpace(healedSnippet) == "" || healedSnippet == tail.RawSnippet {
		return draft, false
	}

	// 缝合替换：优先精准子串 LastIndex 替换
	var splicedDraft string
	if idx := strings.LastIndex(draft, tail.RawSnippet); idx >= 0 {
		splicedDraft = draft[:idx] + healedSnippet + draft[idx+len(tail.RawSnippet):]
	} else if tail.StartLine > 0 {
		lines := strings.Split(draft, "\n")
		if tail.StartLine <= len(lines) {
			head := lines[:tail.StartLine-1]
			splicedDraft = strings.Join(append(head, healedSnippet), "\n")
		} else {
			return draft, false
		}
	} else {
		return draft, false
	}

	// 二次采样复核
	pass, _ := SampleTranslationFidelity(ctx, llm, splicedDraft, targetLanguage, uid)
	if !pass {
		return draft, false
	}

	return splicedDraft, true
}

// VerifyAndHealTranslation 完整的翻译质检、断点微创自愈与结构化原文保全仲裁器。
// 返回:
//   - finalContent: 最终内容（自愈成功为译文；自愈失败为原结构化 clean 原文）
//   - isDegraded: 是否降级（true 表示翻译未完成，以结构化原文交付）
func VerifyAndHealTranslation(
	ctx context.Context,
	llm LlmGatewayAPI,
	draft string,
	originalCleanDoc string,
	targetLanguage string,
	uid *string,
) (string, bool) {
	// 若本身已是原文（命中哨兵等），直接放行
	if draft == originalCleanDoc || strings.TrimSpace(draft) == "" {
		return draft, false
	}

	// Layer 2 采样质检
	pass, _ := SampleTranslationFidelity(ctx, llm, draft, targetLanguage, uid)
	if pass {
		return draft, false
	}

	log.Printf("[sampling-audit] detected untranslated tail prose in translation draft; triggering Layer 3 surgical healing...")

	// Layer 3 尾部微创断点补翻
	healed, ok := HealUntranslatedTail(ctx, llm, draft, targetLanguage, uid)
	if ok {
		log.Printf("[sampling-audit] surgical tail healing SUCCEEDED")
		return healed, false
	}

	// Layer 4 自愈彻底失败：保全结构化原文，绝不输出夹生饭，绝不乱拉仓库散件
	log.Printf("[sampling-audit] surgical tail healing FAILED; preserving clean structured original document")
	return originalCleanDoc, true
}

package transcription

import (
	"context"
	"log"
	"strings"
	"time"
)

func SampleTranslationFidelity(ctx context.Context, llm LlmGatewayAPI, draft string, targetLanguage string, uid *string) (bool, string) {
	if llm == nil || strings.TrimSpace(draft) == "" || targetLanguage == "" || targetLanguage == "none" {
		return true, ""
	}

	tail := ExtractTailProse(draft, 300)
	if len([]rune(tail.Prose)) < 50 {
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
		return true, ""
	}

	text := strings.TrimSpace(res.Text)
	if strings.Contains(text, "<FAIL>") {
		return false, "untranslated_tail_prose"
	}

	return true, ""
}

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

	pass, _ := SampleTranslationFidelity(ctx, llm, splicedDraft, targetLanguage, uid)
	if !pass {
		return draft, false
	}

	return splicedDraft, true
}

// Preserves structured source when tail sampling + micro-heal fail rather than shipping half-translated output.
func VerifyAndHealTranslation(
	ctx context.Context,
	llm LlmGatewayAPI,
	draft string,
	originalCleanDoc string,
	targetLanguage string,
	uid *string,
) (string, bool) {
	if draft == originalCleanDoc || strings.TrimSpace(draft) == "" {
		return draft, false
	}

	pass, _ := SampleTranslationFidelity(ctx, llm, draft, targetLanguage, uid)
	if pass {
		return draft, false
	}

	log.Printf("[sampling-audit] detected untranslated tail prose in translation draft; triggering Layer 3 surgical healing...")

	healed, ok := HealUntranslatedTail(ctx, llm, draft, targetLanguage, uid)
	if ok {
		log.Printf("[sampling-audit] surgical tail healing SUCCEEDED")
		return healed, false
	}

	log.Printf("[sampling-audit] surgical tail healing FAILED; preserving clean structured original document")
	return originalCleanDoc, true
}

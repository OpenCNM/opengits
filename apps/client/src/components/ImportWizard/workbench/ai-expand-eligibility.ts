export const AI_EXPAND_MIN_EFFECTIVE_CHARS = 4;
export const AI_EXPAND_MAX_EFFECTIVE_CHARS = 100;
export const AI_EXPAND_MIN_SELECTION_CHARS = 4;

export interface AiExpandEligibilityInput {
  text: string;
  selectionLength?: number;
  isComposing?: boolean;
  isExpanding?: boolean;
  hasExpandedDraft?: boolean;
  lastExpandedPrompt?: string;
  hasOutline?: boolean;
}

export function countEffectiveChars(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '').length;
}

function isAlreadyStructured(trimmed: string): boolean {
  const newlineCount = trimmed.match(/\n/g)?.length ?? 0;
  if (newlineCount >= 2) return true;

  if (/^\s*(?:\d+[.)、]|[-*•])\s+/m.test(trimmed)) return true;

  return false;
}

export function shouldShowAiExpand({
  text,
  selectionLength = 0,
  isComposing = false,
  isExpanding = false,
  hasExpandedDraft = false,
  lastExpandedPrompt = '',
  hasOutline = true,
}: AiExpandEligibilityInput): boolean {
  if (!hasOutline || isComposing || isExpanding || hasExpandedDraft) {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (lastExpandedPrompt && trimmed === lastExpandedPrompt.trim()) {
    return false;
  }

  if (selectionLength >= AI_EXPAND_MIN_SELECTION_CHARS) {
    return true;
  }

  const effectiveLength = countEffectiveChars(trimmed);
  if (effectiveLength < AI_EXPAND_MIN_EFFECTIVE_CHARS) {
    return false;
  }
  if (effectiveLength > AI_EXPAND_MAX_EFFECTIVE_CHARS) {
    return false;
  }

  if (isAlreadyStructured(trimmed)) {
    return false;
  }

  return true;
}

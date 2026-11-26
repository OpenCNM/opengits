import { z } from 'zod';
import { ignoreBestEffort } from '@/lib/best-effort';
import { generateText } from 'ai';

export type LanguageModelLike = Parameters<typeof generateText>[0]['model'];

const THINKING_TAG_RE = /(?:<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)|<thought>[\s\S]*?(?:<\/thought>|$))/gi;

const CODE_FENCE_BLOCK_RE = /(?:^|\n)```(?:json)?\s*\n?([\s\S]*?)\n?```(?:\n|$)/gi;

const TRAILING_COMMA_RE = /,\s*([}\]])/g;

// Deterministic 0ms salvage strips thinking tags/fences and closes truncated JSON containers before falling back to LLM repair.
export function fastExtractJsonObject(rawText: string): unknown | undefined {
  if (!rawText || typeof rawText !== 'string') return undefined;

  let cleaned = rawText.replace(THINKING_TAG_RE, '').trim();
  if (!cleaned) return undefined;

  cleaned = cleaned.replace(CODE_FENCE_BLOCK_RE, '$1').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIdx = -1;

  if (firstBrace >= 0 && firstBracket >= 0) {
    startIdx = Math.min(firstBrace, firstBracket);
  } else if (firstBrace >= 0) {
    startIdx = firstBrace;
  } else if (firstBracket >= 0) {
    startIdx = firstBracket;
  }

  if (startIdx < 0) return undefined;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let endIdx = -1;

  for (let i = startIdx; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === '{') {
          stack.pop();
          if (stack.length === 0) {
            endIdx = i + 1;
            break;
          }
        }
      } else if (ch === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === '[') {
          stack.pop();
          if (stack.length === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
    }
  }

  let jsonCandidate = '';
  if (endIdx > 0) {
    jsonCandidate = cleaned.slice(startIdx, endIdx);
  } else {
    jsonCandidate = cleaned.slice(startIdx);
    if (inString) {
      jsonCandidate += '"';
    }
    for (let j = stack.length - 1; j >= 0; j--) {
      jsonCandidate += stack[j] === '{' ? '}' : ']';
    }
  }

  jsonCandidate = jsonCandidate.replace(TRAILING_COMMA_RE, '$1');

  try {
    return JSON.parse(jsonCandidate);
  } catch {
    return undefined;
  }
}

export function fastSalvageJson<T>(rawText: string, schema: z.ZodType<T>): T | null {
  const parsed = fastExtractJsonObject(rawText);
  if (parsed === undefined) return null;

  try {
    const directCheck = schema.safeParse(parsed);
    if (directCheck.success) {
      return directCheck.data;
    }

    if (Array.isArray(parsed)) {
      const wrappedCheck = schema.safeParse({ quizzes: parsed });
      if (wrappedCheck.success) {
        return wrappedCheck.data;
      }
    }

    if (parsed && typeof parsed === 'object') {
      const targetArr = Array.isArray(parsed) ? parsed : (parsed as any).quizzes;
      if (Array.isArray(targetArr)) {
        let hasOneBased = false;
        const normalizedItems = targetArr.map((item: any) => {
          if (item && typeof item === 'object' && typeof item.correctIndex === 'number') {
            if (item.correctIndex === 4 || (item.options && item.correctIndex === item.options.length)) {
              hasOneBased = true;
              return { ...item, correctIndex: item.correctIndex - 1 };
            }
          }
          return item;
        });

        if (hasOneBased) {
          const reNormalized = Array.isArray(parsed) ? normalizedItems : { ...parsed, quizzes: normalizedItems };
          const normalizedCheck = schema.safeParse(reNormalized);
          if (normalizedCheck.success) {
            return normalizedCheck.data;
          }
        }
      }
    }
  } catch {
    ignoreBestEffort();
  }

  return null;
}

export async function repairStructuredJsonViaLlm<T>(
  rawBroken: string,
  schema: z.ZodType<T>,
  errorReason: string,
  model: LanguageModelLike,
  abortSignal?: AbortSignal
): Promise<T | null> {
  const truncatedPayload = rawBroken.slice(0, 4000);
  const prompt = `CRITICAL INSTRUCTION:
You are an expert JSON syntax repair engine.
The following JSON payload has syntax errors or failed schema validation:
--- Validation Error ---
${errorReason}

--- Malformed Payload ---
${truncatedPayload}

Fix the syntax errors and ensure it is 100% valid JSON.
CRITICAL RULES:
1. Return ONLY the raw valid JSON payload.
2. Do NOT output markdown code fences (\`\`\`json).
3. Do NOT output explanations or conversational text.
4. Do NOT output thinking tags (<think>).`;

  try {
    const textResult = await generateText({
      model,
      prompt,
      temperature: 0.1,
      maxOutputTokens: 4000,
      abortSignal,
    });

    return fastSalvageJson(textResult.text, schema);
  } catch (err) {
    console.warn('[repairStructuredJsonViaLlm] LLM repair call failed:', err);
    return null;
  }
}

export async function salvageOrRepairStructured<T>(
  rawText: string,
  schema: z.ZodType<T>,
  options: {
    model?: LanguageModelLike;
    abortSignal?: AbortSignal;
    onRepaired?: (tier: 'fast_salvage' | 'llm_repair') => void;
  } = {}
): Promise<{ data: T; tier: 'fast_salvage' | 'llm_repair' } | null> {
  const fast = fastSalvageJson(rawText, schema);
  if (fast !== null) {
    options.onRepaired?.('fast_salvage');
    return { data: fast, tier: 'fast_salvage' };
  }

  if (options.model) {
    const repaired = await repairStructuredJsonViaLlm(
      rawText,
      schema,
      'Invalid JSON syntax or schema mismatch',
      options.model,
      options.abortSignal
    );
    if (repaired !== null) {
      options.onRepaired?.('llm_repair');
      return { data: repaired, tier: 'llm_repair' };
    }
  }

  return null;
}

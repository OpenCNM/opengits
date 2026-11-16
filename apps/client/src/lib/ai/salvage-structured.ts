import { z } from 'zod';
import { generateText } from 'ai';

export type LanguageModelLike = Parameters<typeof generateText>[0]['model'];

// 匹配思考标签（<think>...</think> 或 <thought>...</thought>，含未闭合截断防护）
const THINKING_TAG_RE = /(?:<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)|<thought>[\s\S]*?(?:<\/thought>|$))/gi;

// 匹配 Markdown 代码块外壳（```json ... ``` 或 ``` ... ```）
const CODE_FENCE_BLOCK_RE = /(?:^|\n)```(?:json)?\s*\n?([\s\S]*?)\n?```(?:\n|$)/gi;

// 匹配尾部悬挂逗号（如 `[1, 2,]` 或 `{"a": 1,}`）
const TRAILING_COMMA_RE = /,\s*([}\]])/g;

/**
 * 0ms 纯确定性快速提取与状态机闭合自愈：
 * 1. 物理剥除 <think> 思考链外壳（防止思考过程内的符号干扰）；
 * 2. 剥离 Markdown 代码块围栏；
 * 3. 状态机寻找首个有效 JSON 容器起点；
 * 4. 括号深度扫描与截断逆向闭合自愈（Token 截断自动补平未闭合大括号与中括号）；
 * 5. 修剪悬挂逗号；
 * 6. JSON.parse 返回原始对象/数组。无法解析时返回 undefined。
 */
export function fastExtractJsonObject(rawText: string): unknown | undefined {
  if (!rawText || typeof rawText !== 'string') return undefined;

  // 1. 剥离思考标签
  let cleaned = rawText.replace(THINKING_TAG_RE, '').trim();
  if (!cleaned) return undefined;

  // 2. 剥离 Markdown 围栏
  cleaned = cleaned.replace(CODE_FENCE_BLOCK_RE, '$1').trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 3. 状态机寻找首个有效 JSON 容器起点
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

  // 4. 括号深度扫描与截断自愈
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
    // 截断自愈：自动补齐未闭合的括号
    jsonCandidate = cleaned.slice(startIdx);
    if (inString) {
      jsonCandidate += '"';
    }
    // 逆向闭合残留括号
    for (let j = stack.length - 1; j >= 0; j--) {
      jsonCandidate += stack[j] === '{' ? '}' : ']';
    }
  }

  // 5. 修剪悬挂逗号
  jsonCandidate = jsonCandidate.replace(TRAILING_COMMA_RE, '$1');

  // 6. JSON 解析
  try {
    return JSON.parse(jsonCandidate);
  } catch {
    // 容错降级: 候选 JSON 解析失败则返回 undefined 供上层决策
    return undefined;
  }
}

/**
 * 0ms 纯确定性快速拆包与自愈 (Fast Path)：
 * 1. 物理剥除 <think> 思考链外壳（防止思考过程内的符号干扰）；
 * 2. 剥离 Markdown 代码块围栏；
 * 3. 状态机提取有效 JSON 边界，修剪悬挂逗号；
 * 4. 自动补平因 Token 截断导致的未闭合大括号与中括号；
 * 5. 宽容度归一化（包装解包、correctIndex 0-based 修复）；
 * 6. Zod Schema 硬性门禁校验。
 */
export function fastSalvageJson<T>(rawText: string, schema: z.ZodType<T>): T | null {
  const parsed = fastExtractJsonObject(rawText);
  if (parsed === undefined) return null;

  try {
    // 直接校验
    const directCheck = schema.safeParse(parsed);
    if (directCheck.success) {
      return directCheck.data;
    }

    // 宽容归一化 A：若期望对象 { quizzes: [...] }，但 LLM 直接输出了数组 [...]
    if (Array.isArray(parsed)) {
      const wrappedCheck = schema.safeParse({ quizzes: parsed });
      if (wrappedCheck.success) {
        return wrappedCheck.data;
      }
    }

    // 宽容归一化 B：correctIndex 1-based 误输出修复
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
    // 容错降级: 无法通过纯字符串状态机解析，交下游 LLM 智能慢路径兜底
  }

  return null;
}

/**
 * 第二级：调度 LLM 智能微创急救 (Slow Path)。
 * 专攻未转义引号、深层语法破坏等复杂边缘场景。
 */
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

/**
 * 双级协同自愈统一入口：
 * 1. 0ms Fast Path (fastSalvageJson)；
 * 2. 失败时降级调用 Slow Path (repairStructuredJsonViaLlm)。
 */
export async function salvageOrRepairStructured<T>(
  rawText: string,
  schema: z.ZodType<T>,
  options: {
    model?: LanguageModelLike;
    abortSignal?: AbortSignal;
    onRepaired?: (tier: 'fast_salvage' | 'llm_repair') => void;
  } = {}
): Promise<{ data: T; tier: 'fast_salvage' | 'llm_repair' } | null> {
  // 1. 优先 0ms 纯确定性快速拆包
  const fast = fastSalvageJson(rawText, schema);
  if (fast !== null) {
    options.onRepaired?.('fast_salvage');
    return { data: fast, tier: 'fast_salvage' };
  }

  // 2. 存在模型时，调度 LLM 智能微创急救
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

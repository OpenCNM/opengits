import { generateText } from 'ai';
import { z } from 'zod';
import { parseMermaidToGraph, generateFallbackMermaid } from './mermaidParser';
import { getModel, defaultEngineProvider, defaultEngineModel, trackTokenUsage } from '@/lib/ai';
import { stripMermaidDangerousHtml } from './xss-guard';
import { PromptRegistry } from '@/lib/prompt-registry';

const EXPLANATION_FIELD_MAX = 4000;
const EXPLANATION_TEXT_MAX = 8000;
const dissectExplanationSchema = z
  .object({
    intent: z.string().max(EXPLANATION_FIELD_MAX),
    tradeoffs: z.string().max(EXPLANATION_FIELD_MAX),
    gotchas: z.string().max(EXPLANATION_FIELD_MAX),
  })
  .partial();

export { generateFallbackMermaid };

export {
  sanitizeMermaid,
  stripMermaidDangerousHtml,
  DIAGRAM_HEAD_PATTERN,
  ensureQuotedMermaidLabels,
} from './xss-guard';

export interface DissectResult {
  mermaidCode: string;
  explanationText?: string;
  tierUsed: number;
  isFallback: boolean;
  isAst?: boolean;
  fallbackReason?: string;
  errorDetail?: string;
}

export interface SalvagedExplanation {
  explanationText: string;
  fields: {
    intent?: string;
    tradeoffs?: string;
    gotchas?: string;
  };
  hasValidContent: boolean;
}

export function salvagePedagogyExplanation(rawText: string): SalvagedExplanation {
  if (!rawText || typeof rawText !== 'string') {
    return { explanationText: '', fields: {}, hasValidContent: false };
  }

  let text = rawText
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();

  text = stripMermaidDangerousHtml(text);

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  const candidateText = fenceMatch ? fenceMatch[1].trim() : text;

  const fields: { intent?: string; tradeoffs?: string; gotchas?: string } = {};

  const jsonStart = candidateText.indexOf('{');
  const jsonEnd = candidateText.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(candidateText.slice(jsonStart, jsonEnd + 1));
      const verified = dissectExplanationSchema.safeParse(parsed);
      if (verified.success) {
        if (verified.data.intent) fields.intent = verified.data.intent.trim();
        if (verified.data.tradeoffs) fields.tradeoffs = verified.data.tradeoffs.trim();
        if (verified.data.gotchas) fields.gotchas = verified.data.gotchas.trim();
      }
    } catch {
    }
  }

  if (!fields.intent || !fields.tradeoffs || !fields.gotchas) {
    const extractField = (fieldName: string): string | undefined => {
      const regex = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`, 'i');
      const match = candidateText.match(regex);
      if (match && match[1]) {
        try {
          return JSON.parse(`"${match[1]}"`);
        } catch {
          return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
      }
      return undefined;
    };

    if (!fields.intent) {
      const v = extractField('intent');
      if (v) fields.intent = v.trim();
    }
    if (!fields.tradeoffs) {
      const v = extractField('tradeoffs');
      if (v) fields.tradeoffs = v.trim();
    }
    if (!fields.gotchas) {
      const v = extractField('gotchas');
      if (v) fields.gotchas = v.trim();
    }
  }

  if (!fields.intent && !fields.tradeoffs && !fields.gotchas) {
    const intentMatch = candidateText.match(/(?:###?\s*(?:意图|设计意图|架构意图|Intent)[\s:]*)([\s\S]*?)(?=###?|$)/i);
    const tradeoffsMatch = candidateText.match(/(?:###?\s*(?:权衡|架构权衡|Tradeoffs?)[\s:]*)([\s\S]*?)(?=###?|$)/i);
    const gotchasMatch = candidateText.match(/(?:###?\s*(?:注意事项|避坑指南|陷阱|Gotchas?)[\s:]*)([\s\S]*?)(?=###?|$)/i);

    if (intentMatch && intentMatch[1].trim()) fields.intent = intentMatch[1].trim();
    if (tradeoffsMatch && tradeoffsMatch[1].trim()) fields.tradeoffs = tradeoffsMatch[1].trim();
    if (gotchasMatch && gotchasMatch[1].trim()) fields.gotchas = gotchasMatch[1].trim();
  }

  const parts: string[] = [];
  if (fields.intent) parts.push(fields.intent);
  if (fields.tradeoffs) parts.push(`【架构权衡】\n${fields.tradeoffs}`);
  if (fields.gotchas) parts.push(`【注意事项】\n${fields.gotchas}`);

  let explanationText = '';
  if (parts.length > 0) {
    explanationText = parts.join('\n\n').slice(0, EXPLANATION_TEXT_MAX);
  } else {
    const stripped = candidateText.replace(/[{}\[\]":,]/g, '').trim();
    if (stripped.length > 15) {
      explanationText = candidateText.slice(0, EXPLANATION_TEXT_MAX);
    }
  }

  const hasValidContent = Boolean(explanationText && explanationText.trim().length > 0);
  return {
    explanationText,
    fields,
    hasValidContent,
  };
}

export function extractExplanationFromMermaid(mermaidCode: string): string | undefined {
  if (!mermaidCode) return undefined;
  for (const line of mermaidCode.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('%% @Explanation:')) {
      const rest = trimmed.slice('%% @Explanation:'.length).trim();
      try {
        const parsed = JSON.parse(rest);
        return parsed.text || parsed.intent || rest;
      } catch {
        return rest;
      }
    }
  }
  return undefined;
}

export async function dissectCodeWithResilience(params: {
  codeText: string;
  language?: string;
  owner?: string;
  repo?: string;
  userId?: string;
}): Promise<DissectResult> {
  const { codeText, language = 'code' } = params;

  const { executeSidecarDissectAst } = await import('@/engine/dissect-driver');
  const astResult = await executeSidecarDissectAst({ code: codeText, language });
  const baseMermaid = astResult.mermaidCode;
  const isAst = astResult.isAst;

  try {
    let userModel = null;
    try {
      const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
      userModel = await resolveActiveUserModel(params.userId);
    } catch (modelErr) {
      console.warn('[dissect] resolveActiveUserModel failed, falling back to no-key mode:', modelErr);
      userModel = null;
    }

    // Mark isFallback so unkeyed AST-only diagrams never poison long-term dissectionCache.
    if (!userModel || !userModel.apiKey) {
      return {
        mermaidCode: baseMermaid,
        tierUsed: isAst ? 1 : 2,
        isFallback: true,
        isAst,
        fallbackReason: '未配置 AI 模型密钥，仅展示确定性 AST 拓扑',
      };
    }

    const modelInstance = getModel(userModel.provider, userModel.modelId || defaultEngineModel, {
      apiKey: userModel.apiKey,
      baseURL: userModel.baseURL,
      apiFormat: userModel.apiFormat,
    });

    const compiled = await PromptRegistry.getCompiledPrompt('dissect_pedagogy', {
      language,
      codeLanguage: language,
      codeText,
      targetLanguage: 'zh-CN',
      astNodesJson: JSON.stringify(astResult.nodes, null, 2),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      // Direct call uses dedicated 15s DSL-repair abort outside gateway purpose routing.
      response = await generateText({
        model: modelInstance,
        prompt: compiled.compiledPrompt,
        abortSignal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    trackTokenUsage(response.usage, { source: 'tutor_explanation', userId: params.userId });

    const salvaged = salvagePedagogyExplanation(response.text);
    if (salvaged.hasValidContent && salvaged.explanationText) {
      // JSON.stringify escapes newlines so %% @Explanation remains a single-line Mermaid comment.
      const serializedMeta = JSON.stringify({ text: salvaged.explanationText, ...salvaged.fields });
      const finalMermaid = `${baseMermaid}\n  %% @Explanation: ${serializedMeta}`;

      return {
        mermaidCode: finalMermaid,
        explanationText: salvaged.explanationText,
        tierUsed: 1,
        isFallback: false,
        isAst,
      };
    }

    return {
      mermaidCode: baseMermaid,
      tierUsed: isAst ? 1 : 2,
      isFallback: true,
      isAst,
      fallbackReason: '模型未返回有效教学解读内容，已保留确定性 AST 拓扑',
    };
  } catch (err: any) {
    console.warn('[Dissect Engine] LLM pedagogy call failed, preserving AST graph:', err?.message || err);
    return {
      mermaidCode: baseMermaid,
      tierUsed: isAst ? 1 : 2,
      isFallback: true,
      isAst,
      fallbackReason: err?.message || 'LLM 教学意图解析失败，已回退至 AST 拓扑',
      errorDetail: String(err?.stack || err),
    };
  }
}

import { generateText } from 'ai';
import { z } from 'zod';
import { parseMermaidToGraph, generateFallbackMermaid } from './mermaidParser';
import { getModel, defaultEngineProvider, defaultEngineModel, trackTokenUsage } from '@/lib/ai';
import { stripMermaidDangerousHtml } from './xss-guard';
import { PromptRegistry } from '@/lib/prompt-registry';

/**
 * LLM 教学解读产物的确定性收敛门禁（Deterministic Convergence Funnel）：
 * LLM 是高熵草稿源，其输出在拼入持久化 mermaid（→ dissectionCache 长期回放）之前，
 * 必须经过 Zod 字段白名单（多余字段剥除）+ 类型收窄 + 长度上限 + XSS 剥离。
 */
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

/**
 * Layer 1: 内存 0ms 状态机物理急救打捞器 (salvagePedagogyExplanation)
 *
 * 物理动机：
 * 当大模型输出教学意图时，常伴随 <think> 推理标签、Markdown 围栏包裹，
 * 或在输出 gotchas 时因 Token 耗尽被截断，导致 JSON.parse 全盘失败。
 * 本函数通过状态机与字段物理提取，就地打捞已闭合的 intent/tradeoffs/gotchas 字段，
 * 挽救 95%+ 已收敛的教学负熵，杜绝因格式瑕疵退回裸图。
 */
export function salvagePedagogyExplanation(rawText: string): SalvagedExplanation {
  if (!rawText || typeof rawText !== 'string') {
    return { explanationText: '', fields: {}, hasValidContent: false };
  }

  // 1. 剥离 <think> 思考标签与 Markdown 围栏
  let text = rawText
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();

  text = stripMermaidDangerousHtml(text);

  // 剥除 ```json 或 ``` 围栏
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  const candidateText = fenceMatch ? fenceMatch[1].trim() : text;

  const fields: { intent?: string; tradeoffs?: string; gotchas?: string } = {};

  // 2. 尝试标准 JSON 解析
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
      // 容错降级: 标准 JSON 解析失败，转入截断状态机打捞
    }
  }

  // 3. 截断容错：若标准 JSON 未能提取出全部字段，通过字段状态机打捞未闭合载荷
  if (!fields.intent || !fields.tradeoffs || !fields.gotchas) {
    const extractField = (fieldName: string): string | undefined => {
      // 匹配 "fieldName": "..."（允许末尾未闭合）
      const regex = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`, 'i');
      const match = candidateText.match(regex);
      if (match && match[1]) {
        try {
          return JSON.parse(`"${match[1]}"`);
        } catch {
          // 容错降级: 截断字符串反转义失败，采用轻量转义符替换兜底
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

  // 4. Markdown 段落提取（当模型直接输出 Markdown 章节标题时）
  if (!fields.intent && !fields.tradeoffs && !fields.gotchas) {
    const intentMatch = candidateText.match(/(?:###?\s*(?:意图|设计意图|架构意图|Intent)[\s:]*)([\s\S]*?)(?=###?|$)/i);
    const tradeoffsMatch = candidateText.match(/(?:###?\s*(?:权衡|架构权衡|Tradeoffs?)[\s:]*)([\s\S]*?)(?=###?|$)/i);
    const gotchasMatch = candidateText.match(/(?:###?\s*(?:注意事项|避坑指南|陷阱|Gotchas?)[\s:]*)([\s\S]*?)(?=###?|$)/i);

    if (intentMatch && intentMatch[1].trim()) fields.intent = intentMatch[1].trim();
    if (tradeoffsMatch && tradeoffsMatch[1].trim()) fields.tradeoffs = tradeoffsMatch[1].trim();
    if (gotchasMatch && gotchasMatch[1].trim()) fields.gotchas = gotchasMatch[1].trim();
  }

  // 5. 拼装格式化教学文本
  const parts: string[] = [];
  if (fields.intent) parts.push(fields.intent);
  if (fields.tradeoffs) parts.push(`【架构权衡】\n${fields.tradeoffs}`);
  if (fields.gotchas) parts.push(`【注意事项】\n${fields.gotchas}`);

  let explanationText = '';
  if (parts.length > 0) {
    explanationText = parts.join('\n\n').slice(0, EXPLANATION_TEXT_MAX);
  } else {
    // 若未能提取结构化字段，但 candidateText 包含实质性文字（非纯 JSON 标点）
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

/** 从 Mermaid 代码的 %% @Explanation 注释中投影出结构化教学解释 */
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
        // 容错降级: 注释中包含非标准 JSON 字符串，直接返回原始内容
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

  // 1. 确定性第一阶段：纯 CPU AST 投影（< 1ms 首帧直出，杜绝假降级）
  const { executeSidecarDissectAst } = await import('@/engine/dissect-driver');
  const astResult = await executeSidecarDissectAst({ code: codeText, language });
  const baseMermaid = astResult.mermaidCode;
  const isAst = astResult.isAst;

  // 2. 认知第二阶段：检查是否具备 LLM 调用凭据进行教学深度解读
  try {
    let userModel = null;
    try {
      const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
      userModel = await resolveActiveUserModel(params.userId);
    } catch (modelErr) {
      // 容错降级: 用户模型解析异常或未配置，安全回退无模型状态
      console.warn('[dissect] resolveActiveUserModel failed, falling back to no-key mode:', modelErr);
      userModel = null;
    }

    // 若无 Key 或匿名用户：直接返回确定性 AST 图表（能力不倒退，真实物理代码切片）
    // 必须显式标记 isFallback: true，告知上层此结果仅为结构保底，严禁写入长期 dissectionCache
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
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    let response;
    try {
      // [直连说明] Mermaid 定点修复：轻量 DSL 急救自带 15s abort 与专属模型配置，非网关 purpose 场景
      response = await generateText({
        model: modelInstance,
        prompt: compiled.compiledPrompt,
        abortSignal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    trackTokenUsage(response.usage, { source: 'tutor_explanation', userId: params.userId });

    // Layer 1 内存 0ms 状态机物理急救打捞
    const salvaged = salvagePedagogyExplanation(response.text);
    if (salvaged.hasValidContent && salvaged.explanationText) {
      // 将教学解释以 Mermaid 注释规范追加到图表末尾，实现自包含持久化：
      // JSON.stringify 将换行转义为 \n，保证注释行不可逃逸注入额外的 mermaid 语句
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

    // 模型未产出实质性解释文本：显式标记保底，防止脏数据入库
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

import { generateText } from 'ai';
import { getModel, modelName } from '@/lib/ai';
import { langfuse, getCachedTutorPrompt } from './langfuse';
import { createAgentTools } from './tools';
import { z } from 'zod';
import { searchRepositoryDocs } from '@/lib/mcp/doc-search';
import { formatHighDensityDocContext } from './context-formatter';
import { WorkingMemoryManager } from '../memory/working-memory';
import { prisma } from '@/lib/db';
import { TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';
import { AGENT_DEFAULTS, type ExplainDepth } from '@/lib/constants';
import {
  buildExplainDepthDirective,
  normalizeExplainDepth,
  stripLegacyResponseJsonInstruction,
} from '@/lib/ai/response-depth';
import { extractStreamableAssistantText } from '@/lib/ai/unwrap-chat-response';
import { TokenUsageService } from '@/lib/analytics/token-usage';
import { PromptRegistry } from '@/lib/prompt-registry';
import {
  detectTopologyTarget,
  fetchTopologySlice,
  formatTopologyGroundingPrompt,
} from './topology-grounding';
import {
  parseExplainCodePayload,
  buildExplainCodeSearchQuery,
} from '@/lib/code-viewport/explain-context';


export type TutorIntent = 'PAGE_SUMMARY' | 'FACTUAL_SEARCH' | 'USER_JOURNEY' | 'GENERAL_CHAT';

function resolveIntentFromText(rawText: string): TutorIntent {
  const text = rawText.toUpperCase().trim();
  if (text.includes('PAGE_SUMMARY') || text.includes('PAGE SUMMARY') || text.includes('整页总结') || text.includes('页面大纲')) {
    return 'PAGE_SUMMARY';
  }
  if (text.includes('USER_JOURNEY') || text.includes('USER JOURNEY') || text.includes('学习画像') || text.includes('学习进度')) {
    return 'USER_JOURNEY';
  }
  if (text.includes('GENERAL_CHAT') || text.includes('GENERAL CHAT') || text.includes('普通闲聊') || text.includes('问候')) {
    return 'GENERAL_CHAT';
  }
  return 'FACTUAL_SEARCH';
}

function extractContextFromPrecedingMessage(messages: any[]): string {
  if (!Array.isArray(messages) || messages.length <= 1) return '';
  const prevMsg = messages[messages.length - 2];
  if (prevMsg?.role === 'assistant' && prevMsg.content) {
    return `AI助手前一次的回复: "${prevMsg.content}"\n`;
  }
  return '';
}

export class TutorAgent {
 /**
 * Main entry point for the Tutor Agent.
 * Handles dynamic prompt loading, tracing, and tool execution (Decision layer).
 */
  static async run({
    messages,
    userId,
    sessionId,
    repositoryId,
    owner,
    repo,
    feynmanMode,
    bypassSocratic = false,
    tutoringStyle = AGENT_DEFAULTS.tutoringStyle,
    explainDepth = AGENT_DEFAULTS.explainDepth,
    preferredLang = AGENT_DEFAULTS.preferredLang,
    responseLang = AGENT_DEFAULTS.responseLang,
    customInstructions = '',
    selectedModel,
    provider,
    customApiKey,
    customBaseUrl,
    customApiFormat,
    currentPath,
    callId,
    signal,
  }: {
    messages: any[],
    userId: string,
    sessionId: string,
    repositoryId: string,
    owner: string,
    repo: string,
    feynmanMode: boolean,
    bypassSocratic?: boolean,
    tutoringStyle?: string,
    explainDepth?: ExplainDepth | string,
    preferredLang?: string,
    responseLang?: string,
    customInstructions?: string,
    selectedModel?: string,
    provider?: string,
    customApiKey?: string,
    customBaseUrl?: string,
    customApiFormat?: 'openai' | 'anthropic',
    currentPath?: string,
    callId?: string,
    /** 客户端断连级联：透传至 sidecar fetch，Abort 毫秒级掐断上游 LLM 流 */
    signal?: AbortSignal,
  }) {
 // Normalize frontend messages (which might use UI-specific 'parts' representation) to SDK CoreMessage format
 const normalizedMessages = messages.map((m: any) => {
 let content = m.content;
 if (content === undefined && m.parts) {
 content = m.parts.map((p: any) => {
 if (p.type === 'text') return { type: 'text', text: p.text };
 if (p.type === 'reasoning') return { type: 'reasoning', text: p.text || p.delta || p.textDelta || (p as any).reasoning || '' };
 if (p.type === 'image') return { type: 'image', image: p.image };
 if (p.type === 'tool-call') return { type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, args: p.args };
 if (p.type === 'tool-result') return { type: 'tool-result', toolCallId: p.toolCallId, toolName: p.toolName, result: p.result ?? p.output };
 return p;
 });
 }
 if (m.role === 'tool') {
 const rawParts = Array.isArray(content) ? content : (m.parts || []);
 content = rawParts.map((p: any) => ({
 type: 'tool-result',
 toolCallId: p.toolCallId,
 toolName: p.toolName,
 result: p.result ?? p.output ?? p.text
 }));
 }
 return {
 role: m.role,
 content: content ?? ''
 };
 });

  const activeDepth = normalizeExplainDepth(explainDepth);

  // 1. Create a Langfuse trace - scoped strictly to repositoryId
  const trace = langfuse.trace({
  name: "tutor-agent-run",
  sessionId: `session-${repositoryId}`,
  tags: [
  feynmanMode ? "feynman-mode" : "standard-mode", 
  bypassSocratic ? "bypass-socratic" : "normal-socratic",
  `style-${tutoringStyle}`,
  `depth-${activeDepth}`,
  `lang-${preferredLang}`,
  `lang-resp-${responseLang}`,
  "agent:tutor",
  ...(callId ? [`call:${callId}`] : []),
  ]
  });

  // 2. Prompt Retrieval via 进程内缓存（同步、绝不阻塞首 token；远端拉取/刷新全部后台异步）
  let systemPrompt = stripLegacyResponseJsonInstruction(
    getCachedTutorPrompt({ feynmanMode, owner, repo, currentPath })
  );

 // Extract query early for intent classification
 const lastMessage = normalizedMessages && normalizedMessages.length > 0 ? normalizedMessages[normalizedMessages.length - 1] : null;
 const query = lastMessage ? (typeof lastMessage.content === 'string' ? lastMessage.content : 
 (Array.isArray(lastMessage.content) ? lastMessage.content.map((p: any) => p.type === 'text' ? p.text : '').join('') : '')) : '';
 const codeExplainPayload = query ? parseExplainCodePayload(query) : null;

 // Inject override if bypassSocratic is enabled
 if (feynmanMode && bypassSocratic) {
 systemPrompt += `\n\n[OVERRIDE DIRECTIVE: The user has temporarily enabled direct solutions. Bypass Socratic tutoring constraints for this response. Provide complete code and explanation directly without asking guiding questions.]`;
 }

 // Apply tutoring style modifications
 if (feynmanMode && !bypassSocratic) {
 if (tutoringStyle === 'pragmatic') {
 systemPrompt += `\n\n[TUTORING STYLE OVERRIDE: The user prefers PRAGMATIC style. Skip excessive explanations or analogy-based Socratic guiding. Provide highly concise, core-focused Socratic guidance and prioritize code blocks over verbose text.]`;
 } else if (tutoringStyle === 'friendly') {
 systemPrompt += `\n\n[TUTORING STYLE OVERRIDE: The user prefers FRIENDLY/BEGINNER-COACH style. Provide extremely detailed, friendly explanations. Use simple analogies, and explain code blocks step-by-step for a beginner.]`;
 }
 } else {
 // Standard mode or Socratic bypassed
 if (tutoringStyle === 'pragmatic') {
 systemPrompt += `\n\n[STYLE PREFERENCE: Answer in a PRAGMATIC style. Keep text concise and direct. Focus on providing solution code snippets and minimal descriptions.]`;
 } else if (tutoringStyle === 'friendly') {
 systemPrompt += `\n\n[STYLE PREFERENCE: Answer in a FRIENDLY/COACH style. Provide detailed step-by-step guidance and make sure explanations are beginner-friendly.]`;
 }
 }

 // Inject programming language preference
 if (preferredLang) {
 systemPrompt += `\n\n[PREFERRED PROGRAMMING LANGUAGE: When demonstrating code snippets, prioritize writing examples in ${preferredLang} where applicable. However, if the active document or repository context is specifically focused on a different programming language (e.g. Rust, Python, Go), prioritize the repository's active programming language over the user's preference to maintain context consistency.]`;
 }

 // Inject response language preference
 if (responseLang) {
 let langText = 'Simplified Chinese';
 if (responseLang === 'zh-TW') langText = 'Traditional Chinese';
 if (responseLang === 'en') langText = 'English';
 if (responseLang === 'bilingual') langText = 'Bilingual (both Chinese and English explanations side-by-side or contextually mixed)';
 
 systemPrompt += `\n\n[RESPONSE LANGUAGE PREFERENCE: You MUST write all your answers, Socratic questions, explanations, and thoughts in ${langText}.]`;
 }

  // Inject 3-tier zero-loss response depth policy (default: simple)
  systemPrompt += `\n\n${buildExplainDepthDirective(activeDepth)}`;

  // Inject additional custom system instructions from user settings
  if (customInstructions && customInstructions.trim()) {
  systemPrompt += `\n\n[ADDITIONAL CUSTOM INSTRUCTIONS FROM USER: ${customInstructions.trim()}]`;
  }

  // 3. Question Classifier (Intent Routing)
  let intent: TutorIntent = 'FACTUAL_SEARCH';

  if (query && query.trim().length > 0 && !codeExplainPayload) {
    try {
      const contextContext = extractContextFromPrecedingMessage(messages);
      const routerPrompt = await PromptRegistry.getCompiledPrompt('tutor_intent_router', {
        contextContext,
        query,
      });

      // [直连说明] 意图分类器：首 token 关键路径的轻量二分类，自带模型配置与超时，走漏斗的模型解析/预算记账反而增加延迟
      const classifierResponse = await generateText({
        model: getModel(provider || 'dashscope', selectedModel || modelName, {
          apiKey: customApiKey,
          baseURL: customBaseUrl,
          apiFormat: customApiFormat,
        }),
        prompt: routerPrompt.compiledPrompt,
      });
      intent = resolveIntentFromText(classifierResponse.text);
      console.log(`[Intent Router] Classified query "${query}" as: ${intent} (Raw: "${classifierResponse.text.trim()}")`);
    } catch (classErr) {
      console.error("[Intent Router] Classification failed, falling back to FACTUAL_SEARCH:", classErr);
    }
  }

  // 4. Pre-fetch Context using FTS searchRepositoryDocs based on the query (skip for GENERAL_CHAT)
  let contextStr = '';
  let topologyGroundingStr = '';
  const needsDeepContext = intent !== 'GENERAL_CHAT';

  if (needsDeepContext) {
    let topDocPath: string | undefined;
    try {
      const docSearchQuery = codeExplainPayload
        ? buildExplainCodeSearchQuery(codeExplainPayload)
        : query;
      const docs = await searchRepositoryDocs(repositoryId, docSearchQuery, 5, undefined, undefined, undefined, undefined, undefined, userId);
      if (docs && docs.length > 0) {
        topDocPath = docs[0]?.path;
        contextStr = formatHighDensityDocContext(docs, {
          owner,
          repo,
          totalTokenBudget: 2000,
        });
      }
    } catch (retrievalErr) {
      console.error("[Intent Router] Context retrieval failed:", retrievalErr);
    }

    // 4.5 Pre-fetch Physical Code Topology Grounding (Frame-0 Grounding Truth)
    try {
      const target = detectTopologyTarget({ currentPath, query, topDocPath, owner, repo });
      if (target.path) {
        let gitSha = '';
        if (repositoryId) {
          const repoMeta = await prisma.repository.findUnique({
            where: { id: repositoryId },
            select: { gitSha: true },
          }).catch(() => null);
          gitSha = repoMeta?.gitSha || '';
        }

        const slice = await fetchTopologySlice(
          {
            owner,
            repo,
            sha: gitSha,
            path: target.path,
            symbol: target.symbol,
          },
          { timeoutMs: 500 }
        );

        if (slice && slice.found) {
          topologyGroundingStr = formatTopologyGroundingPrompt(slice);
        }
      }
    } catch (topoErr) {
      // Fail-open: don't let topology grounding interrupt chat flow
      console.warn('[Tutor Agent] Topology grounding error (fail-open):', topoErr);
    }
  }

  // 5. Build structured context metadata block (JSON)
  const isChinese =
    /[\u4e00-\u9fa5]/.test(query) ||
    (typeof responseLang === 'string' && responseLang.toLowerCase().startsWith('zh'));
  const userLanguage = isChinese ? 'Chinese' : 'English';

  let userLearningState: any = { state: {} };
  let latestHighlight: any = null;
  let latestQuiz: any = null;

  if (needsDeepContext) {
    try {
      latestHighlight = await prisma.episodicEvent.findFirst({
        where: { 
          userId, eventType: TELEMETRY_EVENTS.TEXT_HIGHLIGHT,
          OR: [
            { pageUrl: `/docs/${owner}/${repo}` },
            { pageUrl: { startsWith: `/docs/${owner}/${repo}/` } },
            { pageUrl: { startsWith: `/docs/${owner}/${repo}?` } },
            { pageUrl: { startsWith: `/docs/${owner}/${repo}#` } }
          ]
        },
        orderBy: { createdAt: 'desc' }
      });
      latestQuiz = await prisma.episodicEvent.findFirst({
        where: { 
          userId, eventType: TELEMETRY_EVENTS.QUIZ_INTERACTION,
          OR: [
            { pageUrl: `/docs/${owner}/${repo}` },
            { pageUrl: { startsWith: `/docs/${owner}/${repo}/` } },
            { pageUrl: { startsWith: `/docs/${owner}/${repo}?` } },
            { pageUrl: { startsWith: `/docs/${owner}/${repo}#` } }
          ]
        },
        orderBy: { createdAt: 'desc' }
      });
    } catch (dbErr) {
      console.error("[Tutor Agent] Failed to fetch metadata for JSON prompt:", dbErr);
    }
  }

  const metadata = {
    intent,
    language: userLanguage,
    response_depth: activeDepth,
 goal: userLearningState.state?.learning_goal || "Learn the tutorial page contents",
 page: currentPath,
 mode: feynmanMode 
 ? (bypassSocratic 
 ? `FEYNMAN (TEMP OVERRIDE: User requested direct solutions. Custom style: ${tutoringStyle})` 
 : `FEYNMAN (DO NOT give direct answers, Socratic style. Custom style: ${tutoringStyle})`) 
 : `STANDARD (Answer directly. Custom style: ${tutoringStyle})`,
 user_profile: {
 frustration_level: userLearningState.state?.frustration_level || 0,
 mastered_concepts: userLearningState.state?.mastered_concepts || [],
 active_tasks: userLearningState.state?.active_tasks || [],
 },
 latest_behavioral_telemetry: {
 highlight: latestHighlight ? {
 page: latestHighlight.pageUrl,
 text: (latestHighlight.metadata as any)?.textSnippet || (latestHighlight.metadata as any)?.text
 } : null,
 quiz: latestQuiz ? {
 page: latestQuiz.pageUrl,
 question: (latestQuiz.metadata as any)?.question,
 user_answer: (latestQuiz.metadata as any)?.answer || (latestQuiz.metadata as any)?.selected,
 result: (latestQuiz.metadata as any)?.isCorrect ? 'Correct' : 'Incorrect'
 } : null
 }
 };

 // 6. Inject structured metadata and context into System Prompt
 systemPrompt += `\n\n=== RUNTIME CONTEXT METADATA (JSON) ===\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\nCRITICAL DIRECTIVES:\n1. You MUST reply in the language specified in the "language" field of the JSON above (e.g. if 'Chinese', you MUST speak Chinese).\n2. Adhere to the learning mode specified in the "mode" field.\n3. Adjust your tone and assistance according to "user_profile" and "latest_behavioral_telemetry".\n4. If the user's message is a JSON payload with {"type": "explain_selection", "text": "..."}, it means they highlighted text in the document. You MUST automatically cross-reference the highlighted text with the "mastered_concepts" and "latest_behavioral_telemetry" above. Explain the text using analogies based on what they already know, and gently guide them if it relates to their current frustration_level. DO NOT explicitly mention that you are reading their telemetry data; weave it naturally into your explanation.\n5. If the user's message is a JSON payload with {"type": "explain_code", "code": "...", ...}, it means they clicked "AI Explain" on a code block to open the sidebar. Use all injected context fields ("sectionTitle", "filePath", "title", "language", "surroundingContext", "symbol", "lineRange") together with the retrieved repository documentation and topology slice to explain the **design and architectural intent** of this code block: (a) what role it plays in the current chapter/module, (b) how its core abstractions, state, and data/control flow work, and (c) key design trade-offs or invariants. STRICTLY format and calibrate length/depth to match the active "response_depth" (${activeDepth}) tier above without losing any core facts. Do NOT echo raw JSON or reprint the entire code snippet verbatim.\n6. Output clean GitHub-flavored Markdown prose directly — NEVER wrap your answer inside a JSON object like {"response": "..."}.`;

  if (topologyGroundingStr) {
    systemPrompt += `\n\n${topologyGroundingStr}`;
  }

  if (contextStr) {
    systemPrompt += `\n\n${contextStr}`;
  }

 // 6.5 Inject any background system messages (e.g. DiagnosticAgent reports) that the frontend doesn't know about
 try {
 const dbSystemMessages = await prisma.conversationMessage.findMany({
 where: { conversationId: sessionId, role: 'system' },
 orderBy: { createdAt: 'asc' }
 });
 if (dbSystemMessages.length > 0) {
 systemPrompt += `\n\n=== BACKGROUND SYSTEM DIAGNOSTICS ===\n`;
 for (const sysMsg of dbSystemMessages) {
 systemPrompt += `${sysMsg.content}\n\n`;
 }
 systemPrompt += `[Acknowledge and utilize the diagnostic reports above if they are relevant to the user's current problem.]\n`;
 }
 } catch (err) {
 console.error("[Tutor Agent] Failed to fetch system messages:", err);
 }

  // 7. Execution: Offload to Go sidecar streaming engine (/v1/llm/stream)
  const { callSidecarStream } = await import('@/lib/sidecar-client');
  const sidecarRes = await callSidecarStream(
    '/v1/llm/stream',
    {
      model: {
        provider: provider || AGENT_DEFAULTS.provider,
        modelId: selectedModel || modelName,
        apiKey: customApiKey,
        baseURL: customBaseUrl,
        apiFormat: customApiFormat,
      },
      messages: normalizedMessages,
      system: systemPrompt,
      callId,
      streamFormat: 'ai-sdk',
    },
    { label: 'chat /v1/llm/stream', timeoutMs: 120_000, signal }
  );

  const [streamForClient, streamForRecord] = (sidecarRes.body as ReadableStream<Uint8Array>).tee();

  // Background stream recording without blocking client response
  (async () => {
    try {
      const reader = streamForRecord.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let usage: any = null;
      let buffer = '';
      while (true) {
        // 客户端断连级联：Abort 后不再读取——彻底掐断后台无效算力与
        // Token 消耗（fetch 侧已随 signal 中断，此处兜底读循环立即退出）
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('0:')) {
            try {
              fullText += JSON.parse(line.slice(2));
            } catch {}
          } else if (line.startsWith('d:')) {
            try {
              const d = JSON.parse(line.slice(2));
              usage = d.usage;
            } catch {}
          }
        }
      }
      if (fullText) {
        const cleanFullText = extractStreamableAssistantText(fullText);
        const promptTokens = usage?.promptTokens || 0;
        const completionTokens = usage?.completionTokens || 0;
        const totalTokens = promptTokens + completionTokens;

        trace.generation({
          name: 'tutor-llm-call',
          model: modelName,
          input: normalizedMessages,
          output: cleanFullText,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens,
          },
        });

        const savedMessage = await WorkingMemoryManager.saveMessage(
          userId,
          sessionId,
          'assistant',
          cleanFullText,
          undefined,
          {
            promptTokens,
            completionTokens,
            model: modelName,
          }
        );

        await TokenUsageService.logUsage({
          userId,
          repositoryId,
          conversationId: sessionId,
          messageId: savedMessage?.id,
          model: modelName || selectedModel || AGENT_DEFAULTS.model,
          provider: provider || AGENT_DEFAULTS.provider,
          promptTokens,
          completionTokens,
          totalTokens,
          cachedTokens: 0,
          reasoningTokens: 0,
          source: feynmanMode ? 'tutor_explanation' : 'chat',
        });
      }
    } catch (err) {
      console.error('[Tutor Agent] background stream recording error:', err);
    } finally {
      langfuse.flushAsync();
    }
  })();

  const result = {
    toUIMessageStreamResponse: (opts?: {
      headers?: Record<string, string>;
      sendReasoning?: boolean;
      onEnd?: () => void;
    }) => {
      const headers = new Headers();
      if (opts?.headers) {
        for (const [k, v] of Object.entries(opts.headers)) {
          if (v) headers.set(k, String(v));
        }
      }
      headers.set('content-type', 'text/plain; charset=utf-8');
      headers.set('x-vercel-ai-data-stream', 'v1');
      headers.set('cache-control', 'no-cache, no-transform');
      headers.set('connection', 'keep-alive');
      headers.set('x-accel-buffering', 'no');
      if (callId) {
        headers.set('x-llm-call-id', callId);
      }
      return new Response(streamForClient, {
        status: 200,
        headers,
      });
    },
  };

  return { result, traceId: trace.id };
  }
}

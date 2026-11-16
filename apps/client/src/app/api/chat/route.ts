import { prisma } from '@/lib/db';
import { AGENT_DEFAULTS } from '@/lib/constants';
import { ENGINE_CONFIG } from '@/lib/config';
import { NextResponse } from 'next/server';
import { TutorAgent } from '@/lib/agent/tutor-agent';
import { resolveActiveUserModel } from '@/lib/ai/user-model-resolver';
import { normalizeExplainDepth } from '@/lib/ai/response-depth';
import { WorkingMemoryManager } from '@/lib/memory/working-memory';
import { defineRoute } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { assert, assertFound } from '@/lib/api/server/api-guards';
import { estimateTokens } from '@/lib/token-counter';
import { truncateCognitiveBudget } from '@/lib/agent/semantic-truncator';
import { callSidecar } from '@/lib/sidecar-client';

export const maxDuration = 30;

function normalizeMessages(messages: any[]): any[] {
 return messages.map((msg: any) => {
 // If content is already defined and not empty, use it
 if (msg.content !== undefined && msg.content !== null && msg.content !== '') {
 return msg;
 }

 // If parts exist, map them to content
 if (Array.isArray(msg.parts)) {
 const content = msg.parts.map((part: any) => {
 if (part.type === 'text') {
 return { type: 'text', text: part.text };
 }
 if (part.type === 'tool-invocation') {
 const inv = part.toolInvocation;
 if (inv.state === 'result' || inv.state === 'output-available') {
 return {
 type: 'tool-result',
 toolCallId: inv.toolCallId,
 toolName: inv.toolName,
 result: inv.result || inv.output
 };
 }
 return {
 type: 'tool-call',
 toolCallId: inv.toolCallId,
 toolName: inv.toolName,
 args: inv.args || inv.input
 };
 }
 return part;
 });

 if (msg.role === 'tool') {
 return {
 role: 'tool',
 content: content.filter((p: any) => p.type === 'tool-result')
 };
 }

 if (msg.role === 'user') {
 const textParts = content.filter((p: any) => p.type === 'text');
 if (textParts.length === content.length) {
 return {
 ...msg,
 content: textParts.map((p: any) => p.text).join('\n')
 };
 }
 }

 return {
 ...msg,
 content
 };
 }

 return {
 ...msg,
 content: ''
 };
 });
}

/**
 * chat 主对话路由：成功响应是 AI SDK UI message stream（流式，非 JSON），
 * 走 NextResponse 透传逃生舱不套信封；预检错误（鉴权/限流/BYOK 门禁/参数）
 * 统一转 ApiError 由 defineRoute 信封化。
 */
export const POST = defineRoute({
  scope: 'POST /api/chat',
  auth: 'user',
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.chatMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.chatWindowMs,
    identifier: ({ userId }) => `chat:${userId}`,
  },
  handler: async ({ request, userId }) => {
    const streamStartTime = Date.now();
    const callId =
      request.headers.get('x-llm-call-id') ||
      (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36));
    const body = await request.json().catch(() => ({}));
    const url = new URL(request.url);

    const rawMessages = body.messages || [];
    const messages = normalizeMessages(rawMessages);
    let owner = body.owner || url.searchParams.get('owner');
    let repo = body.repo || url.searchParams.get('repo');
    const feynmanModeStr = url.searchParams.get('feynmanMode');
    const feynmanMode = body.feynmanMode ?? (feynmanModeStr === 'true');
    const bypassSocraticStr = url.searchParams.get('bypassSocratic');
    const bypassSocratic = body.bypassSocratic ?? (bypassSocraticStr === 'true');
    const tutoringStyle = body.tutoringStyle || url.searchParams.get('tutoringStyle') || AGENT_DEFAULTS.tutoringStyle;
    const explainDepth = normalizeExplainDepth(
      body.explainDepth || url.searchParams.get('explainDepth') || AGENT_DEFAULTS.explainDepth
    );
    const preferredLang = body.preferredLang || url.searchParams.get('preferredLang') || AGENT_DEFAULTS.preferredLang;
    const responseLang = body.responseLang || url.searchParams.get('responseLang') || AGENT_DEFAULTS.responseLang;
    const customInstructions = body.customInstructions || '';
    const modelStr = url.searchParams.get('model');
    const selectedModel = body.model || modelStr;
    const provider = body.provider || url.searchParams.get('provider') || AGENT_DEFAULTS.provider;
    // ── BYOK 统一（Phase 2 #9 / P-14）：废弃 localStorage 明文直传。
    // 凭据一律走加密静态存储（AES-256-GCM UserModelProvider）经 resolveActiveUserModel 解密；
    // 明文字段若仍被旧客户端发送，仅记告警并忽略，不参与任何 LLM 调用。
    const legacyPlaintextByok = body.apiKey || request.headers.get('x-user-api-key') || '';
    if (legacyPlaintextByok) {
      console.warn('[chat] plaintext BYOK fields are deprecated and ignored; configure API Key in settings (encrypted at rest)');
    }
    const currentPath = body.currentPath || url.searchParams.get('path') || 'Unknown';

    // ── BYOK 门禁：必须配置并激活自备 API Key，无 .env 平台兜底 ──
    const resolvedUserModel = await resolveActiveUserModel(userId).catch(() => null);
    assert(resolvedUserModel?.apiKey, 'MISSING_API_KEY');

    // Load global user preferences for smart defaults
    const userPrefs = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        preferredLang1: true,
        primaryProgLang: true,
      },
    });

    let finalResponseLang = responseLang;
    if (userPrefs?.preferredLang1 && userPrefs.preferredLang1 !== 'none') {
      finalResponseLang = userPrefs.preferredLang1;
    }

    let finalPreferredLang = preferredLang;
    if (userPrefs?.primaryProgLang) {
      finalPreferredLang = userPrefs.primaryProgLang.toLowerCase();
    }

    const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : null;
    const isToolResult = lastMessage?.role === 'tool';

    let query = '';
    if (!isToolResult && lastMessage) {
      query =
        typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.parts
            ? lastMessage.parts.map((p: any) => (p.type === 'text' ? p.text : '')).join('')
            : '';

      assert(query && query.trim() !== '', 'INVALID_PARAM', 'Message content is empty');
    }

    let conversationId = body.conversationId || url.searchParams.get('conversationId');
    let repositoryId = '';

    if (conversationId) {
      const existingConv = assertFound(
        await prisma.conversation.findFirst({
          where: { id: conversationId, userId },
          include: { repository: true },
        }),
        'Conversation not found or unauthorized'
      );
      // Populate owner and repo from the existing conversation if they were missing
      owner = owner || existingConv.repository.owner;
      repo = repo || existingConv.repository.repo;
      repositoryId = existingConv.repositoryId;
    }

    if (!owner || !repo) {
      const referer = request.headers.get('referer');
      if (referer) {
        // Fallback to /docs/[owner]/[repo]
        const legacyMatch = referer.match(/\/docs\/([^\/]+)\/([^\/]+)/);
        if (legacyMatch) {
          owner = owner || legacyMatch[1];
          repo = repo || legacyMatch[2];
        }
      }
    }

    assert(owner && repo, 'INVALID_PARAM', 'Missing owner or repo');

    if (!conversationId) {
      const repository = assertFound(
        await prisma.repository.findFirst({
          where: {
            owner,
            repo,
          },
        }),
        'Repository not found'
      );
      repositoryId = repository.id;
      const pageTitle = currentPath.split('/').pop() || 'Docs';
      const convRes = await callSidecar<{
        ok: boolean;
        conversation?: { id: string };
        error?: string;
      }>(
        '/v1/conversations/create',
        {
          repositoryId: repository.id,
          userId,
          title: `Chat on ${pageTitle}`,
        },
        { label: 'chat /v1/conversations/create' }
      );
      if (!convRes.ok || !convRes.conversation) {
        throw ApiError.internal(convRes.error || 'Failed to create conversation');
      }
      conversationId = convRes.conversation.id;
    }

 const sessionId = conversationId;

 // 1. Save user message to Level 1 Working Memory (Only if it's a real user query, not a tool roundtrip)
 if (isToolResult && lastMessage) {
 await WorkingMemoryManager.saveMessage(
 userId, 
 sessionId, 
 'tool', 
 JSON.stringify(lastMessage.content)
 );
 } else if (!isToolResult && query) {
 await WorkingMemoryManager.saveMessage(userId, sessionId, 'user', query);
 }

 // 2. Retrieve sliding window context constrained by Token Budget
 // We use the frontend messages to preserve complex tool-call/tool-result structures that our DB schema cannot hold.
 const maxTokens = 4000;
 let currentTokens = 0;
 const budgetedMessages = [];
 
 for (let i = messages.length - 1; i >= 0; i--) {
 const msg = messages[i];
 const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
 const tokens = estimateTokens(contentStr);
 if (currentTokens + tokens > maxTokens) {
 if (i === messages.length - 1) { // It's the newest message
 const remainingForNewest = Math.max(100, maxTokens - currentTokens);
 const truncatedRes = truncateCognitiveBudget(contentStr, {
 maxTokens: remainingForNewest,
 suffix: '\n... [Message content truncated to fit cognitive budget]',
 });
 const newMsg = { ...msg, content: truncatedRes.text };
 budgetedMessages.unshift(newMsg);
 currentTokens += truncatedRes.finalTokens;
 }
 break;
 }
 currentTokens += tokens;
 budgetedMessages.unshift(msg);
 }

 // 2.5 Ensure atomic pairing of tool-calls and tool-results to prevent AI Provider crashes
 // If we truncated history and the oldest message we kept is a 'tool' result, it is missing its 'tool-call'
 // This will cause a fatal provider error. We must shift out orphaned tool results.
 while (budgetedMessages.length > 0 && budgetedMessages[0].role === 'tool') {
 budgetedMessages.shift();
 }

 // 3. Hand off to Tutor Agent (Decision Layer)
 // We pass the budgetedMessages instead of raw frontend messages to prevent Context Overflow!
 const { result, traceId } = await TutorAgent.run({
 messages: budgetedMessages,
 userId,
 sessionId,
 repositoryId,
 owner,
 repo,
 feynmanMode,
 bypassSocratic,
 tutoringStyle,
 explainDepth,
 preferredLang: finalPreferredLang,
 responseLang: finalResponseLang,
 customInstructions,
 selectedModel: selectedModel || resolvedUserModel.modelId,
 provider: resolvedUserModel.provider || provider,
 customApiKey: resolvedUserModel.apiKey,
 customBaseUrl: resolvedUserModel.baseURL,
 customApiFormat: (resolvedUserModel.apiFormat || 'openai') as 'openai' | 'anthropic',
 currentPath,
 callId,
 // 客户端断连级联：请求 Abort 毫秒级掐断 sidecar LLM 流与后台记录循环
 signal: request.signal,
 });

 const streamResponse: Response = (result as any).toUIMessageStreamResponse({
 headers: {
 'x-llm-call-id': callId,
 'x-langfuse-trace-id': traceId,
 'x-conversation-id': conversationId
 },
 sendReasoning: true,
      onEnd: () => {
        const elapsed = Date.now() - streamStartTime;
        console.log(`[chat] [${callId}] Stream completed in ${elapsed}ms`);
        console.log(`[chat-stream] call=${callId} duration_ms=${elapsed} outcome=success`);
      },
    });

    console.log(
      `[chat] [${callId}] Stream prepared in ${Date.now() - streamStartTime}ms (messages_in=${messages.length} budgeted=${budgetedMessages.length} tokens=${currentTokens})`
    );

 // defineRoute 逃生舱要求 NextResponse 实例：包一层保持流式 body 与自定义响应头原样透传
 return new NextResponse(streamResponse.body, {
 status: streamResponse.status,
 headers: streamResponse.headers,
 });
  },
});

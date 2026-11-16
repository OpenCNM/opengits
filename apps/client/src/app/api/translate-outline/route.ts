import { NextRequest } from 'next/server';
import { getSessionHelper } from '@/lib/auth-helper';
import { getModel, trackTokenUsage } from '@/lib/ai';
import { streamText } from 'ai';


import { TRANSLATION_LANGUAGES } from '@/lib/constants';
import { checkRateLimit } from '@/lib/rate-limit';
import { PromptRegistry } from '@/lib/prompt-registry';

// Use a lightweight fast model for translation (qwen3.6-flash is the fastest new generation model)
const TRANSLATE_MODEL = 'qwen3.6-flash';

// 逐条 SSE 流式 LLM 调用：SSE 自定义 handler 无法走 defineRoute——手动接同一限流器（30 次/分钟，与 check-dedup 同量级）
const TRANSLATE_RATE_LIMIT = 30;

export async function POST(req: NextRequest) {
 try {
 const session = await getSessionHelper();
 if (!session || !session.user) {
 return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
 }

 const allowed = await checkRateLimit(`translate-outline:${session.user.id}`, TRANSLATE_RATE_LIMIT, 60000);
 if (!allowed) {
 return new Response(JSON.stringify({ error: '翻译请求过于频繁，请稍后再试' }), { status: 429 });
 }

 const { outline, targetLanguage } = await req.json();
 if (!outline || !Array.isArray(outline)) {
 return new Response(JSON.stringify({ error: 'Invalid outline format' }), { status: 400 });
 }

 const lang = targetLanguage || TRANSLATION_LANGUAGES.DEFAULT_NAME;

 // ── Extract only translatable strings into a flat numbered list ──
 const stringsToTranslate: string[] = [];
 const indexMap: { type: 'name' | 'shortTitle', catIdx: number, fileIdx?: number }[] = [];

 for (let ci = 0; ci < outline.length; ci++) {
 const cat = outline[ci];
 stringsToTranslate.push(cat.name);
 indexMap.push({ type: 'name', catIdx: ci });

 if (cat.files) {
 for (let fi = 0; fi < cat.files.length; fi++) {
 const file = cat.files[fi];
 if (file.shortTitle) {
 stringsToTranslate.push(file.shortTitle);
 indexMap.push({ type: 'shortTitle', catIdx: ci, fileIdx: fi });
 }
 }
 }
 }

 if (stringsToTranslate.length === 0) {
 return new Response(JSON.stringify({ translatedOutline: outline }), {
 headers: { 'Content-Type': 'application/json' }
 });
 }

 const numberedList = stringsToTranslate.map((s, i) => `${i}. ${s}`).join('\n');

  const compiled = await PromptRegistry.getCompiledPrompt('translate_outline_titles', {
    targetLanguage: lang === 'none' ? 'original language' : lang,
    numberedList,
  });
  const prompt = compiled.compiledPrompt;

  const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
  const userModel = await resolveActiveUserModel(session.user.id);

  // 翻译是用户内容消费，仅走 BYOK——平台 key 不做兜底（避免无限额度的平台补贴通道）
  if (!userModel) {
    return new Response(
      JSON.stringify({ error: 'MISSING_API_KEY', message: '未配置或未激活 AI 服务商 API Key，请先前往设置配置。' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── Stream the AI response via SSE ──
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Send the index map first so the client knows how to map translations
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'init', indexMap, totalCount: stringsToTranslate.length })}\n\n`));

        const modelInstance = getModel(userModel.provider, userModel.modelId || TRANSLATE_MODEL, {
          apiKey: userModel.apiKey,
          baseURL: userModel.baseURL,
          apiFormat: userModel.apiFormat,
        });

        // [直连说明] 大纲标题流式翻译：逐段透传客户端的自定义流编排（含 abort 语义），ai.ts 漏斗不承载此形态
        const result = streamText({
          model: modelInstance,
          prompt,
          temperature: 0.1,
          // 客户端断连级联：Abort 即取消 BYOK provider 生成（否则整份
          // 大纲翻译在无人接收时照常烧完）
          abortSignal: req.signal,
          onFinish({ usage }) {
            trackTokenUsage(usage, {
              userId: session.user.id,
              source: 'tutor_explanation',
              model: userModel.modelId || TRANSLATE_MODEL,
              provider: userModel.provider,
            });
          },
        });

 let buffer = '';

 for await (const chunk of result.textStream) {
 if (req.signal.aborted) break;
 buffer += chunk;

 // Process complete lines from buffer
 while (buffer.includes('\n')) {
 const newlineIdx = buffer.indexOf('\n');
 const line = buffer.substring(0, newlineIdx).trim();
 buffer = buffer.substring(newlineIdx + 1);

 if (!line) continue;

 // Parse "N. translated text" format
 const match = line.match(/^(\d+)[\.\):：]\s*(.+)$/);
 if (match) {
 const idx = parseInt(match[1], 10);
 const translated = match[2].trim();
 if (idx >= 0 && idx < indexMap.length) {
 const entry = indexMap[idx];
 controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'translation', field: entry.type, catIdx: entry.catIdx, fileIdx: entry.fileIdx, translated })}\n\n`));
 }
 }
 }
 }

 // Process any remaining buffer content
 if (buffer.trim()) {
 const match = buffer.trim().match(/^(\d+)[\.\):：]\s*(.+)$/);
 if (match) {
 const idx = parseInt(match[1], 10);
 const translated = match[2].trim();
 if (idx >= 0 && idx < indexMap.length) {
 const entry = indexMap[idx];
 controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'translation', field: entry.type, catIdx: entry.catIdx, fileIdx: entry.fileIdx, translated })}\n\n`));
 }
 }
 }

 controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
 controller.close();
 } catch (err: any) {
 // 断连后流已取消：enqueue/close 会二次抛错（悬空 rejection）——
 // 吞掉静默收尾；仅存活连接才向客户端回报错误
 try {
 if (!req.signal.aborted) {
 controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`));
 }
 controller.close();
 } catch {}
 }
 }
 });

 return new Response(stream, {
 headers: {
 'Content-Type': 'text/event-stream',
 'Cache-Control': 'no-cache',
 'Connection': 'keep-alive',
 }
 });

 } catch (err: any) {
 console.error('Translate Outline Error:', err);
 return new Response(JSON.stringify({ error: err.message }), { status: 500 });
 }
}

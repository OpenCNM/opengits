import { NextRequest } from 'next/server';
import { getSessionHelper } from '@/lib/auth-helper';
import { getModel, trackTokenUsage } from '@/lib/ai';
import { streamText } from 'ai';

import { TRANSLATION_LANGUAGES } from '@/lib/constants';
import { checkRateLimit } from '@/lib/rate-limit';
import { PromptRegistry } from '@/lib/prompt-registry';
import { getLocalizedErrorMessage } from '@/lib/api/server/api-error';
import { extractUpstreamError } from '@/lib/llm-gateway/upstream-error';

const TRANSLATE_MODEL = 'qwen3.6-flash';

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

  const { resolveUserModelWithKeyStatus } = await import('@/lib/ai/user-model-resolver');
  const keyResolution = await resolveUserModelWithKeyStatus(session.user.id);

  if (!keyResolution.ok) {
    return new Response(
      JSON.stringify({
        error: keyResolution.code,
        message: getLocalizedErrorMessage(keyResolution.code),
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const userModel = keyResolution.model;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let capturedStreamError: unknown = null;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'init', indexMap, totalCount: stringsToTranslate.length })}\n\n`));

        const modelInstance = getModel(userModel.provider, userModel.modelId || TRANSLATE_MODEL, {
          apiKey: userModel.apiKey,
          baseURL: userModel.baseURL,
          apiFormat: userModel.apiFormat,
        });

        const result = streamText({
          model: modelInstance,
          prompt,
          temperature: 0.1,
          abortSignal: req.signal,
          onError({ error }) {
            capturedStreamError = error;
          },
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

 while (buffer.includes('\n')) {
 const newlineIdx = buffer.indexOf('\n');
 const line = buffer.substring(0, newlineIdx).trim();
 buffer = buffer.substring(newlineIdx + 1);

 if (!line) continue;

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
 try {
 if (!req.signal.aborted) {
 const info = extractUpstreamError(capturedStreamError ?? err, {
   provider: userModel.provider,
   model: userModel.modelId || TRANSLATE_MODEL,
 });
 controller.enqueue(encoder.encode(`data: ${JSON.stringify({
   type: 'error',
   code: info.code,
   message: info.message,
   provider: info.provider,
   model: info.model,
   upstreamStatus: info.upstreamStatus,
   upstreamCode: info.upstreamCode,
 })}\n\n`));
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

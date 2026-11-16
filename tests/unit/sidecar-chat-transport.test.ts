import { describe, expect, it } from 'vitest';
import { readUIMessageStream, type UIMessageChunk } from 'ai';
import { transformDataStreamOrSseToUiChunks } from '@/lib/ai/sidecar-chat-transport';

async function collectChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function byteStreamFromParts(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

describe('SidecarChatTransport protocol adapter', () => {
  it('converts Go sidecar AI SDK v4 data-stream lines into AI SDK v7 UIMessage chunks and materializes text/reasoning parts', async () => {
    const encoder = new TextEncoder();
    const payload = [
      ': ping\n\n',
      'b:"分析 Neuron 类结构"\n',
      '0:"该类的核心作用是"\n',
      '0:"封装单个神经元的前向计算。"\n',
      'd:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":12}}\n',
      'e:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":12},"isContinued":false}\n',
    ].join('');

    // Split mid-UTF8 & mid-line to verify buffering
    const fullBytes = encoder.encode(payload);
    const split1 = fullBytes.slice(0, 23);
    const split2 = fullBytes.slice(23, 55);
    const split3 = fullBytes.slice(55);

    const uiChunkStream = transformDataStreamOrSseToUiChunks(
      byteStreamFromParts([split1, split2, split3])
    );

    let lastMessage: unknown = null;
    for await (const msg of readUIMessageStream({ stream: uiChunkStream })) {
      lastMessage = msg;
    }

    expect(lastMessage).toMatchObject({
      role: 'assistant',
      parts: expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', text: '分析 Neuron 类结构', state: 'done' }),
        expect.objectContaining({
          type: 'text',
          text: '该类的核心作用是封装单个神经元的前向计算。',
          state: 'done',
        }),
      ]),
    });
  });

  it('passes through standard AI SDK v7 SSE UIMessageChunk streams unchanged', async () => {
    const encoder = new TextEncoder();
    const sse = [
      'data: {"type":"start"}\n\n',
      'data: {"type":"start-step"}\n\n',
      'data: {"type":"text-start","id":"txt-1"}\n\n',
      'data: {"type":"text-delta","id":"txt-1","delta":"Hello SSE"}\n\n',
      'data: {"type":"text-end","id":"txt-1"}\n\n',
      'data: {"type":"finish-step"}\n\n',
      'data: {"type":"finish","finishReason":"stop"}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const chunks = await collectChunks(
      transformDataStreamOrSseToUiChunks(byteStreamFromParts([encoder.encode(sse)]))
    );

    expect(chunks.map((c) => c.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
  });

  it('surfaces sidecar 3: error frames as UIMessage error chunks immediately', async () => {
    const encoder = new TextEncoder();
    const raw = '3:{"code":"PROVIDER_ERROR","message":"Upstream rate limit"}\n';
    const chunks = await collectChunks(
      transformDataStreamOrSseToUiChunks(byteStreamFromParts([encoder.encode(raw)]))
    );

    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'Upstream rate limit',
    });
  });
});

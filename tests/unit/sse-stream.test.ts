import { describe, expect, it } from 'vitest';
import { readSseStream } from '@/lib/sse';

/** 用内存 ReadableStream 构造 SSE 字节流 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe('readSseStream（SSE 文本流统一解析）', () => {
  it('标准分帧：event + data', async () => {
    const events: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf(['event: step\ndata: {"a":1}\n\nevent: complete\ndata: {"b":2}\n\n']), (e) => {
      events.push(e);
    });
    expect(events).toEqual([
      { event: 'step', data: '{"a":1}' },
      { event: 'complete', data: '{"b":2}' },
    ]);
  });

  it('跨 chunk 断帧：半帧缓冲到下一个 chunk 拼接', async () => {
    const events: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf(['event: step\nda', 'ta: {"x":1}\n\n']), (e) => events.push(e));
    expect(events).toEqual([{ event: 'step', data: '{"x":1}' }]);
  });

  it('无 event 行默认 message；多行 data 以 \\n 连接', async () => {
    const events: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf(['data: line1\ndata: line2\n\n']), (e) => events.push(e));
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('流结束时的残余帧（未以空行收尾）也被派发', async () => {
    const events: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf(['event: done\ndata: "last"']), (e) => events.push(e));
    expect(events).toEqual([{ event: 'done', data: '"last"' }]);
  });

  it('无 data 行的心跳帧被忽略', async () => {
    const events: Array<{ event: string; data: string }> = [];
    await readSseStream(streamOf([': ping\n\n:event: keepalive\n\n']), (e) => events.push(e));
    expect(events).toEqual([]);
  });

  it('事件按序异步回调（调用方可 await 串行处理）', async () => {
    const order: string[] = [];
    await readSseStream(
      streamOf(['data: 1\n\ndata: 2\n\ndata: 3\n\n']),
      async ({ data }) => {
        await Promise.resolve();
        order.push(data);
      }
    );
    expect(order).toEqual(['1', '2', '3']);
  });
});

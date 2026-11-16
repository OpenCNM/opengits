/**
 * SSE 文本流解析（全站唯一实现）。
 * 收编此前散落在 ImportWizard（scout/translate-outline/reextract）与
 * UserDashboardView 的 4 份手写 buffer 分帧解析；import-job-subscription
 * 因自带重连/游标语义保持独立，不在此收敛范围。
 */

export interface SseEvent {
  /** event: 字段值；无 event 行时为 'message'（SSE 规范默认） */
  event: string;
  /** data: 字段原始字符串（调用方自行 JSON.parse 或识别哨兵如 [DONE]） */
  data: string;
}

/**
 * 逐事件消费一条 SSE 文本流，流结束（reader done）后返回。
 * - 事件以空行（\n\n）分帧；
 * - 每帧取首个 `event:` 行与拼接的 `data:` 行（多行 data 按 SSE 规范以 \n 连接）；
 * - JSON 解析失败不抛出，以原始字符串形式回调（由调用方决定容错）。
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void | Promise<void>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = async (frame: string): Promise<void> => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
    if (dataLines.length > 0) {
      await onEvent({ event, data: dataLines.join('\n') });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      await dispatch(frame);
    }
  }

  // 流结束时的残余帧（服务端未以空行收尾的最后一个事件）
  if (buffer.trim()) {
    await dispatch(buffer);
  }
}

/** 便捷封装：data 字段按 JSON 解析（解析失败的帧静默跳过，返回 false 供调用方计数） */
export async function readSseJsonStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: { event: string; data: T }) => void | Promise<void>
): Promise<void> {
  await readSseStream(body, async ({ event, data }) => {
    try {
      await onEvent({ event, data: JSON.parse(data) as T });
    } catch (e) {
      console.error('Failed to parse SSE event chunk', e);
    }
  });
}

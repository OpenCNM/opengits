import { HttpChatTransport, type UIMessage, type UIMessageChunk } from 'ai';

type StreamProtocol = 'unknown' | 'sse' | 'data-stream';

type FinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

const VALID_FINISH_REASONS = new Set<FinishReason>([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
]);

function normalizeFinishReason(raw: unknown): FinishReason {
  if (typeof raw === 'string' && VALID_FINISH_REASONS.has(raw as FinishReason)) {
    return raw as FinishReason;
  }
  return 'stop';
}

function parseErrorText(payload: unknown): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message;
    }
    if (typeof obj.error === 'string' && obj.error.trim()) {
      return obj.error;
    }
  }
  return 'Chat stream failed';
}

/**
 * 将 Go Sidecar 的 AI SDK v4 Data-Stream (`0:"..."`, `b:"..."`, `d:{...}`, `3:...`)
 * 与 AI SDK v7 UIMessageChunk SSE (`data: {...}`) 统一适配为 `@ai-sdk/react` 可消费的 `ReadableStream<UIMessageChunk>`。
 */
export function transformDataStreamOrSseToUiChunks(
  stream: ReadableStream<Uint8Array>
): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  let buffer = '';
  let protocol: StreamProtocol = 'unknown';
  let started = false;
  let finished = false;
  let partSeq = 0;
  let activeTextId: string | null = null;
  let activeReasoningId: string | null = null;

  const ensureStarted = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    if (!started) {
      controller.enqueue({ type: 'start' });
      controller.enqueue({ type: 'start-step' });
      started = true;
    }
  };

  const closeActiveText = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    if (activeTextId) {
      controller.enqueue({ type: 'text-end', id: activeTextId });
      activeTextId = null;
    }
  };

  const closeActiveReasoning = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    if (activeReasoningId) {
      controller.enqueue({ type: 'reasoning-end', id: activeReasoningId });
      activeReasoningId = null;
    }
  };

  const closeAllParts = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    closeActiveReasoning(controller);
    closeActiveText(controller);
  };

  const emitFinish = (
    controller: TransformStreamDefaultController<UIMessageChunk>,
    finishReason?: FinishReason
  ) => {
    if (finished) return;
    ensureStarted(controller);
    closeAllParts(controller);
    controller.enqueue({ type: 'finish-step' });
    controller.enqueue({
      type: 'finish',
      ...(finishReason ? { finishReason } : {}),
    });
    finished = true;
  };

  const processDataStreamLine = (
    line: string,
    controller: TransformStreamDefaultController<UIMessageChunk>
  ) => {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) return;

    const prefix = line.slice(0, colonIdx);
    const rawPayload = line.slice(colonIdx + 1);

    let parsedPayload: unknown = rawPayload;
    try {
      parsedPayload = JSON.parse(rawPayload);
    } catch {
      // lint-ignore: SWALLOW-001 — 个别厂商错误帧可能返回纯文本而非 JSON，回退为原始文本载荷
      parsedPayload = rawPayload;
    }

    switch (prefix) {
      case '0': {
        const delta = typeof parsedPayload === 'string' ? parsedPayload : String(parsedPayload ?? '');
        if (!delta) return;
        ensureStarted(controller);
        closeActiveReasoning(controller);
        if (!activeTextId) {
          partSeq += 1;
          activeTextId = `text-${partSeq}`;
          controller.enqueue({ type: 'text-start', id: activeTextId });
        }
        controller.enqueue({ type: 'text-delta', id: activeTextId, delta });
        break;
      }
      case 'b': {
        const delta = typeof parsedPayload === 'string' ? parsedPayload : String(parsedPayload ?? '');
        if (!delta) return;
        ensureStarted(controller);
        closeActiveText(controller);
        if (!activeReasoningId) {
          partSeq += 1;
          activeReasoningId = `reasoning-${partSeq}`;
          controller.enqueue({ type: 'reasoning-start', id: activeReasoningId });
        }
        controller.enqueue({ type: 'reasoning-delta', id: activeReasoningId, delta });
        break;
      }
      case '9': {
        if (parsedPayload && typeof parsedPayload === 'object') {
          const call = parsedPayload as Record<string, unknown>;
          const toolCallId = typeof call.toolCallId === 'string' ? call.toolCallId : `tool-${++partSeq}`;
          const toolName = typeof call.toolName === 'string' ? call.toolName : 'tool';
          ensureStarted(controller);
          closeAllParts(controller);
          controller.enqueue({
            type: 'tool-input-available',
            toolCallId,
            toolName,
            input: call.args ?? call.input ?? {},
          });
        }
        break;
      }
      case 'a': {
        if (parsedPayload && typeof parsedPayload === 'object') {
          const res = parsedPayload as Record<string, unknown>;
          const toolCallId = typeof res.toolCallId === 'string' ? res.toolCallId : `tool-${partSeq}`;
          ensureStarted(controller);
          controller.enqueue({
            type: 'tool-output-available',
            toolCallId,
            output: res.result ?? res.output ?? null,
          });
        }
        break;
      }
      case '3': {
        ensureStarted(controller);
        closeAllParts(controller);
        controller.enqueue({
          type: 'error',
          errorText: parseErrorText(parsedPayload),
        });
        break;
      }
      case 'd':
      case 'e': {
        const meta = parsedPayload && typeof parsedPayload === 'object'
          ? (parsedPayload as Record<string, unknown>)
          : undefined;
        emitFinish(controller, normalizeFinishReason(meta?.finishReason));
        break;
      }
      default:
        break;
    }
  };

  const processSseLine = (
    line: string,
    controller: TransformStreamDefaultController<UIMessageChunk>
  ) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data) as UIMessageChunk;
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
        if (parsed.type === 'start') started = true;
        if (parsed.type === 'finish') finished = true;
        controller.enqueue(parsed);
      }
    } catch {
      // lint-ignore: SWALLOW-001 — SSE 传输若含非 JSON 控制片段则安全跳过
    }
  };

  const processLine = (
    rawLine: string,
    controller: TransformStreamDefaultController<UIMessageChunk>
  ) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.startsWith(':')) {
      return;
    }

    if (protocol === 'unknown') {
      protocol = line.startsWith('data:') ? 'sse' : 'data-stream';
    }

    if (protocol === 'sse') {
      processSseLine(line, controller);
    } else {
      processDataStreamLine(line, controller);
    }
  };

  return stream.pipeThrough(
    new TransformStream<Uint8Array, UIMessageChunk>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line, controller);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          processLine(buffer, controller);
        }
        if (protocol === 'data-stream') {
          if (started && !finished) {
            emitFinish(controller, 'stop');
          } else {
            closeAllParts(controller);
          }
        }
      },
    })
  );
}

/**
 * 兼容 Go Sidecar Data-Stream (`x-vercel-ai-data-stream: v1`) 与标准 AI SDK v7 UIMessageStream 的传输器。
 */
export class SidecarChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
> extends HttpChatTransport<UI_MESSAGE> {
  protected processResponseStream(stream: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
    return transformDataStreamOrSseToUiChunks(stream);
  }
}

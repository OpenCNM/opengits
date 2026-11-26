export interface SseEvent {
  event: string;
  data: string;
}

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

  if (buffer.trim()) {
    await dispatch(buffer);
  }
}

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

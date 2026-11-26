// Normalizes heterogeneous provider stream parts and heuristically recovers non-standard reasoning text fields on Frame 1.

type StreamPartKind = 'content' | 'reasoning' | 'other' | 'unknown';

interface NormalizedStreamPart {
  kind: StreamPartKind;
  text?: string;
  rawType: string;
  keys?: string[];
}

const PRIORITY_KEYS = ['delta', 'text', 'content', 'reasoning', 'textDelta'] as const;

const LIFECYCLE_OTHER_TYPES = new Set([
  'text-start',
  'text-end',
  'reasoning-start',
  'reasoning-end',
  'start',
  'finish',
  'abort',
  'error',
  'raw',
  'custom',
  'file',
  'reasoning-file',
  'start-step',
  'finish-step',
  'step-start',
  'step-finish',
  'tool-call',
  'tool-result',
  'tool-error',
  'tool-call-streaming-start',
  'tool-call-delta',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-end',
  'tool-output-denied',
  'tool-approval-request',
  'tool-approval-response',
  'response-metadata',
  'source',
  'redaction',
  'ping',
]);

const CONTENT_DELTA_TYPES = new Set([
  'text-delta',
  'text',
  'content',
  'text-chunk',
]);

const REASONING_DELTA_TYPES = new Set([
  'reasoning-delta',
  'reasoning',
  'reasoning-chunk',
  'reasoning-content',
  'thought',
  'thinking',
]);

const METADATA_KEYS = new Set([
  'type',
  'id',
  'kind',
  'role',
  'model',
  'status',
  'finishReason',
  'finish_reason',
  'callId',
  'call_id',
  'name',
]);

export function normalizeStreamPart(part: unknown): NormalizedStreamPart {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return {
      kind: 'unknown',
      rawType: '',
      keys: [],
    };
  }

  const record = part as Record<string, unknown>;
  const rawType = typeof record.type === 'string' ? record.type : '';
  const keys = Object.keys(record);

  const normalizedType = rawType.toLowerCase().replace(/_/g, '-');

  let kind: StreamPartKind = 'unknown';

  if (
    LIFECYCLE_OTHER_TYPES.has(normalizedType) ||
    normalizedType.endsWith('-start') ||
    normalizedType.endsWith('-end') ||
    normalizedType.startsWith('tool-') ||
    normalizedType.startsWith('step-') ||
    normalizedType.startsWith('response-')
  ) {
    kind = 'other';
  } else if (
    CONTENT_DELTA_TYPES.has(normalizedType) ||
    normalizedType.startsWith('text-delta')
  ) {
    kind = 'content';
  } else if (
    REASONING_DELTA_TYPES.has(normalizedType) ||
    normalizedType.startsWith('reasoning-delta') ||
    normalizedType.startsWith('reasoning-content')
  ) {
    kind = 'reasoning';
  } else {
    kind = 'unknown';
  }

  let text: string | undefined;

  for (const key of PRIORITY_KEYS) {
    const val = record[key];
    if (typeof val === 'string' && val.length > 0) {
      text = val;
      break;
    }
  }

  if (kind === 'reasoning' && text === undefined) {
    const candidateKeys = keys.filter(
      (k) =>
        !METADATA_KEYS.has(k) &&
        typeof record[k] === 'string' &&
        (record[k] as string).length > 0
    );
    if (candidateKeys.length > 0) {
      candidateKeys.sort((a, b) => {
        const score = (k: string) => {
          const lk = k.toLowerCase();
          if (lk.includes('thought') || lk.includes('reason') || lk.includes('think')) return 2;
          if (lk.includes('content') || lk.includes('text') || lk.includes('delta')) return 1;
          return 0;
        };
        return score(b) - score(a);
      });

      const recoveredKey = candidateKeys[0];
      text = record[recoveredKey] as string;
      console.warn(
        `[llm-stream] Shape drift self-healed: type=${rawType} recovered_from_key=${recoveredKey}`
      );
    }
  }

  return {
    kind,
    ...(text !== undefined ? { text } : {}),
    rawType,
    keys,
  };
}

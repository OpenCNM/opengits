import { callSidecar } from '../lib/sidecar-client';
import type {
  ChapterMeta,
  ProgressResult,
  RawTelemetryEvent,
  ReadingFingerprintConfig,
} from './reading-fingerprint/types';

// Must stay field-for-field identical to Go DefaultFingerprintConfig.
const DEFAULT_CONFIG: ReadingFingerprintConfig = {
  weights: { sectionCoverage: 0.5, timeAdequacy: 0.5, skipPenalty: 0.0, revisitBonus: 0.0 },
  thresholds: {
    sectionFocusMs: 10_000,
    contentSkipMs: 1_000,
    revisitWindowMs: 24 * 60 * 60 * 1000,
    readingSpeedWpm: 300,
    minReadTimeMs: 10_000,
    effectivelyReadScore: 60,
  },
  contentWeights: { wordWeight: 1.0, codeBlockWeight: 50, headingWeight: 20 },
  eventTypes: {
    pageView: 'PAGE_VIEW',
    sectionFocus: 'SECTION_FOCUS',
    contentSkip: 'CONTENT_SKIP',
    codeCopy: 'CODE_COPY',
  },
};

function mergeConfig(partial?: Partial<ReadingFingerprintConfig>): ReadingFingerprintConfig {
  if (!partial) return { ...DEFAULT_CONFIG };
  return {
    weights: { ...DEFAULT_CONFIG.weights, ...partial.weights },
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...partial.thresholds },
    contentWeights: { ...DEFAULT_CONFIG.contentWeights, ...partial.contentWeights },
    eventTypes: { ...DEFAULT_CONFIG.eventTypes, ...partial.eventTypes },
  };
}

interface FingerprintDriverOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function toWireEvent(event: RawTelemetryEvent) {
  return {
    eventType: event.eventType,
    pageUrl: event.pageUrl,
    duration: event.duration ?? null,
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt ?? ''),
    metadata: event.metadata ?? null,
  };
}

function assertProgressResult(value: unknown, label = 'fingerprint /v1/fingerprint/compute'): ProgressResult {
  if (
    typeof value === 'object' && value !== null &&
    typeof (value as ProgressResult).overallProgress === 'number' &&
    typeof (value as ProgressResult).totalChapters === 'number' &&
    typeof (value as ProgressResult).effectivelyRead === 'number' &&
    Array.isArray((value as ProgressResult).chapterScores)
  ) {
    return value as ProgressResult;
  }
  throw new Error(`${label}: malformed result payload`);
}

interface FingerprintBatchItemInput {
  repoId: string;
  chapters: ChapterMeta[];
  events: RawTelemetryEvent[];
}

export async function computeReadingFingerprintBatchViaSidecar(
  items: FingerprintBatchItemInput[],
  configOverride?: Partial<ReadingFingerprintConfig>,
  options?: FingerprintDriverOptions
): Promise<Record<string, ProgressResult>> {
  if (!items || items.length === 0) {
    return {};
  }
  const config = mergeConfig(configOverride);

  const remote = await callSidecar<{ ok: boolean; results?: Record<string, unknown> }>(
    '/v1/fingerprint/compute-batch',
    {
      items: items.map((item) => ({
        repoId: item.repoId,
        chapters: item.chapters ?? [],
        events: (item.events ?? []).map(toWireEvent),
      })),
      config,
    },
    { label: 'fingerprint /v1/fingerprint/compute-batch', ...options }
  );

  if (!remote || typeof remote !== 'object' || typeof remote.results !== 'object' || remote.results === null) {
    throw new Error('fingerprint /v1/fingerprint/compute-batch: malformed result payload');
  }

  const results: Record<string, ProgressResult> = {};
  for (const [repoId, res] of Object.entries(remote.results)) {
    results[repoId] = assertProgressResult(res, 'fingerprint /v1/fingerprint/compute-batch');
  }
  return results;
}

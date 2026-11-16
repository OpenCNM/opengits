/**
 * apps/client/src/engine/fingerprint-driver.ts
 *
 * 阅读指纹进度计算驱动（TypeScript 端向 Go worker-sidecar 发起调用）。
 *
 * 架构不变式（2026-09-11 收刀裁定）：
 * 1. Zero-Event-Loop-Lag: 阅读指纹跑在用户请求热路径（首页书架与进度同步），
 *    经 Go worker-sidecar 原生接口（POST /v1/fingerprint/compute）计算，
 *    逐章打分与加权聚合不在 Node 事件循环内执行；
 * 2. Fail-Closed 单实现：本地 TS 纯函数已物理删除——sidecar 故障是显式
 *    SidecarError（修复动作在 Go 端），绝不静默回退 Node 重算；
 * 3. 契约由冻结夹具 reading-fingerprint.golden.json 锁定（Go 单端断言）；
 * 4. config 本地合并后传全量（微秒级合并按不对称计算法则留在本地），
 *    createdAt/targetId 不参与打分，线上契约刻意省略以压缩热路径载荷。
 */

import { callSidecar } from '../lib/sidecar-client';
import type {
  ChapterMeta,
  ProgressResult,
  RawTelemetryEvent,
  ReadingFingerprintConfig,
} from './reading-fingerprint/types';

/** 与 Go DefaultFingerprintConfig 逐字段一致的线上默认配置（冻结契约）。 */
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

/** 深合并部分覆盖到默认配置（仅覆盖已提供字段）。 */
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

/** 线上事件投影：仅保留打分消费的字段，Date 序列化为 ISO 字符串。 */
function toWireEvent(event: RawTelemetryEvent) {
  return {
    eventType: event.eventType,
    pageUrl: event.pageUrl,
    duration: event.duration ?? null,
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt ?? ''),
    metadata: event.metadata ?? null,
  };
}

/** 校验 sidecar 响应形态，畸形载荷视为 sidecar 故障（Fail-Closed 抛错）。 */
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

/**
 * 批量阅读指纹计算（Go worker-sidecar 原生批量单实现，Zero-Event-Loop-Lag & Fail-Closed）。
 * 一次性将多个仓库的章节与事件传递至 Go 端在微秒级纯内存聚合计算，消除串行 N 次 HTTP 往返。
 */
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


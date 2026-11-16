import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * ─────────────────────────────────────────────────────────────
 * 内容寻址层（Phase 2 / P-11）核心原语。
 *
 * 双哈希设计：
 * - contentHash = sha256(规范化正文 + \0 + lang)：存储去重键（唯一）
 * - requestFingerprint = sha256(生成请求稳定 JSON)：同请求必产出同内容，
 *   命中即零 LLM 复用（全局转录命中）。可空——回填的存量行只有 contentHash。
 *
 * 双写语义：legacy Document.content/chunks 列在过渡期保留，
 * 由 DOCUMENT_CONTENT_DUAL_WRITE / DOCUMENT_CONTENT_READS 控制节奏。
 * ─────────────────────────────────────────────────────────────
 */

/** 正文规范化：统一换行 + 去首尾空白（避免编辑器差异导致哈希漂移） */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

export function computeContentHash(content: string, lang: string): string {
  return createHash('sha256')
    .update(`${normalizeContent(content)}\0${lang}`)
    .digest('hex');
}

export interface RequestFingerprintInput {
  repositoryId: string;
  path: string;
  gitSha?: string | null;
  lang?: string;
  /** 生成模型：跨模型输出不保证一致，必须参与指纹 */
  model: string;
  preset?: string | null;
  teachingDepth?: string | number | null;
  aiCondensation?: string | boolean | null;
  customPrompt?: string | null;
}

/** 生成请求指纹：键排序后稳定序列化，与字段书写顺序无关 */
export function computeRequestFingerprint(input: RequestFingerprintInput): string {
  const sorted = Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export function isDualWriteEnabled(): boolean {
  return ENGINE_CONFIG.contentAddressing.dualWrite;
}

export function isContentReadsEnabled(): boolean {
  return ENGINE_CONFIG.contentAddressing.reads;
}

/**
 * 正文读取切换（Phase 2 收官 T1）：READS 开启且薄行已指内容层时，
 * 以 DocumentContent.content 覆盖 legacy 列（浅克隆不污染调用方对象）。
 * 需查询侧 include contentRef；未 include/未启用/无覆盖时原样返回。
 */
export function applyContentLayerRead<
  T extends {
    contentId: string | null;
    content: string | null;
    contentRef?: { content: string | null } | null;
  }
>(doc: T): T {
  if (!isContentReadsEnabled()) return doc;
  if (!doc?.contentRef || doc.contentRef.content === null || doc.contentRef.content === '') return doc;
  if (doc.contentId === null) return doc;
  return { ...doc, content: doc.contentRef.content };
}

/**
 * 按 contentHash upsert 内容层行，返回 contentId。
 * 并发竞态安全：create 撞唯一键时回落重查；命中已有行时尽力回填指纹。
 */
export async function upsertContentLayer(params: {
  contentHash: string;
  requestFingerprint?: string | null;
  content: string;
  lang: string;
  generationModel?: string | null;
}): Promise<string> {
  const resp = await callSidecar<{ ok: boolean; contentId: string }>(
    '/v1/cas/content/upsert',
    {
      contentHash: params.contentHash,
      requestFingerprint: params.requestFingerprint ?? null,
      content: params.content,
      lang: params.lang,
      generationModel: params.generationModel ?? null,
    },
    { label: 'upsert content layer' },
  );
  return resp.contentId;
}

/**
 * 将 legacy per-document chunk 复制进内容层（contentId 归属）。
 * 委托给 Go sidecar 单一写者高性能事务直写。
 */
export async function attachContentChunks(contentId: string, documentId: string): Promise<number> {
  const resp = await callSidecar<{ ok: boolean; count: number }>(
    '/v1/cas/chunks/attach',
    { contentId, documentId },
    { label: 'attach content chunks' },
  );
  return resp.count;
}

/**
 * 孤儿内容层回收（Phase 2 #4，worker 每日任务）：
 * 委托给 Go sidecar 单一写者内核批量安全回收。
 */
export interface OrphanContentReport {
  scanned: number;
  removed: number;
  dryRun: boolean;
}

const ORPHAN_GC_MAX_PER_RUN = 50_000;

export async function orphanContentGcOnce(opts?: {
  dryRun?: boolean;
  graceDays?: number;
}): Promise<OrphanContentReport> {
  const graceDays = opts?.graceDays ?? ENGINE_CONFIG.serverTranscription.orphanContentGraceDays;
  const dryRun = opts?.dryRun ?? false;

  const resp = await callSidecar<{
    ok: boolean;
    scanned: number;
    removed: number;
    dryRun: boolean;
  }>(
    '/v1/cas/content/orphan-gc',
    {
      graceDays,
      dryRun,
      maxPerRun: ORPHAN_GC_MAX_PER_RUN,
    },
    { label: 'orphan content gc' },
  );

  const report: OrphanContentReport = {
    scanned: resp.scanned,
    removed: resp.removed,
    dryRun: resp.dryRun,
  };

  console.log(
    `[ContentGC] orphan sweep done: scanned=${report.scanned} removed=${report.removed} graceDays=${graceDays} dryRun=${dryRun}`,
  );
  return report;
}

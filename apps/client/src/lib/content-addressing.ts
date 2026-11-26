import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

// Keys deduplicated object storage by sha256(normalized + NUL + lang) alongside requestFingerprint reuse.
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
  model: string;
  preset?: string | null;
  teachingDepth?: string | number | null;
  aiCondensation?: string | boolean | null;
  customPrompt?: string | null;
}

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

export async function attachContentChunks(contentId: string, documentId: string): Promise<number> {
  const resp = await callSidecar<{ ok: boolean; count: number }>(
    '/v1/cas/chunks/attach',
    { contentId, documentId },
    { label: 'attach content chunks' },
  );
  return resp.count;
}

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

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DocumentStatus,
  TRANSCRIPTION_JOB_STATUS,
  type TranscriptionJobStatus,
} from '@/lib/state/status-vocabularies';
import { projectCourseLifecycleState } from '@/lib/state/curriculum-state-projector';
import { projectDockTutorialFacts } from '@/lib/state/dock-status-projector';
import type { ChapterDocumentInput } from '@/lib/state/curriculum-lifecycle-contract';

/**
 * 跨语言契约金样本（Consumer-Driven Contract）——Node 消费端。
 *
 * 与 Go 侧 internal/userinteraction/contract_golden_test.go 消费同一份
 * services/worker-sidecar/internal/userinteraction/testdata/ingest-status.response.json
 * （金样本放 Go 包内 testdata/ 以获得测试缓存跟踪；TS 跨目录读取，
 * 与 states.go / credits.sql.go 对拍锁同款模式）：Go 改 DTO 后金样本再生成，
 * 本测试随即回答「Node 是否仍认得新形状」。三重锁定：
 *   1) Node 路由实际消费的每个字段存在且类型正确（对照 ingest-status route 的接口声明）；
 *   2) 状态字面量 ∈ 词汇 SSOT（文档级/任务级/审核级）；
 *   3) 金样本可被投影族完整解析（端到端形状冒烟）。
 */

const GOLDEN_DIR = join(
  __dirname,
  '../../services/worker-sidecar/internal/userinteraction/testdata'
);
const readGolden = (name: string): any =>
  JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8'));

interface GoldenIngestStatus {
  ok: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  repository: Record<string, unknown>;
  documents?: Array<Record<string, unknown>>;
  publishRequested?: boolean;
  avgJobSeconds?: number | null;
}

const REVIEW_STATUS_VOCAB = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'] as const;

describe('sidecar 契约金样本：/v1/repos/ingest-status（Node 消费端）', () => {
  const raw = readGolden('ingest-status.response.json') as GoldenIngestStatus;

  it('信封契约：ok 恒存在；notFound/forbidden 为 omittance 语义（false 时省略）', () => {
    expect(typeof raw.ok).toBe('boolean');
    expect(raw.ok).toBe(true);
    expect(raw.notFound).toBeUndefined();
    expect(raw.forbidden).toBeUndefined();
  });

  it('repository：Node 路由消费的全部字段存在且类型正确', () => {
    const repo = raw.repository;
    const expectStr = (k: string) => expect(typeof repo[k]).toBe('string');
    for (const k of ['id', 'owner', 'repo', 'branch', 'edition', 'reviewStatus']) expectStr(k);
    expect(typeof repo.isPublic).toBe('boolean');
    expect(typeof repo.transcriptionPaused).toBe('boolean');
    expect(typeof repo.transcriptionCreditsEarned).toBe('number');
    // 可空/可省字段的两种合法形态：string|null / number
    expect(['string', 'object']).toContain(typeof repo.ownerUserId);
    expect(['string', 'object', 'undefined']).toContain(typeof repo.publishedAt);
    expect(['number', 'undefined']).toContain(typeof repo.transcriptionTokens);
    // RawMessage 透传字段：必须是可解析的 JSON 值（对象或数组）
    expect(repo.repoProfile).toBeTruthy();
    expect(repo.navTree).toBeTruthy();
  });

  it('repository.reviewStatus ∈ 审核词汇（ReviewStatus 四态）', () => {
    expect(REVIEW_STATUS_VOCAB).toContain(raw.repository.reviewStatus);
  });

  it('documents：每行 id/path/status 必在，title/errorMessage 可空；status ∈ DocumentStatus 词汇', () => {
    expect(Array.isArray(raw.documents)).toBe(true);
    for (const doc of raw.documents ?? []) {
      expect(typeof doc.id).toBe('string');
      expect(typeof doc.path).toBe('string');
      expect(typeof doc.status).toBe('string');
      expect(Object.values(DocumentStatus)).toContain(doc.status);
      expect(['string', 'object', 'undefined']).toContain(typeof doc.title);
      expect(['string', 'object', 'undefined']).toContain(typeof doc.errorMessage);
    }
  });

  it('transcriptionJob：status ∈ TRANSCRIPTION_JOB_STATUS 词汇；计数与可空字段形态合法', () => {
    for (const doc of raw.documents ?? []) {
      const tj = doc.transcriptionJob;
      if (tj === null || tj === undefined) continue;
      const job = tj as Record<string, unknown>;
      expect(Object.values(TRANSCRIPTION_JOB_STATUS)).toContain(job.status);
      expect(typeof job.savedChunks).toBe('number');
      expect(['number', 'object']).toContain(typeof job.totalChunks);
      if (job.queuePosition !== undefined) {
        expect(typeof job.queuePosition).toBe('number');
        expect(job.queuePosition as number).toBeGreaterThanOrEqual(1);
      }
      for (const k of ['claimedAt', 'createdAt']) {
        if (job[k] !== undefined) expect(typeof job[k]).toBe('string');
      }
      if (job.startedAtMs !== undefined) expect(typeof job.startedAtMs).toBe('number');
    }
  });

  it('金样本可被投影族端到端解析（形状与 ChapterDocumentInput 对齐 + 划分完整）', () => {
    const docs = (raw.documents ?? []).map((d) => ({
      id: d.id as string,
      path: d.path as string,
      title: (d.title as string | null) ?? null,
      status: d.status as DocumentStatus,
      errorMessage: (d.errorMessage as string | null) ?? null,
      transcriptionJob: (d.transcriptionJob as { status: TranscriptionJobStatus } | null) ?? null,
    })) as ChapterDocumentInput[];

    const course = projectCourseLifecycleState(docs);
    expect(course.total).toBe(docs.length);
    expect(course.readyCount + course.runningCount + course.queuedCount + course.failedCount).toBe(
      course.total
    );
    // 金样本内含 PROCESSED/PROCESSING/UNPROCESSED/ERROR 各一：四种投影相位全命中
    expect(course.readyCount).toBe(1);
    expect(course.runningCount).toBe(1);
    expect(course.failedCount).toBe(1);
    expect(course.queuedCount).toBe(1);

    const dockFacts = projectDockTutorialFacts(docs);
    expect(dockFacts.totalChapters).toBe(docs.length);
    expect(dockFacts.activeDocPath).toBe('docs/engine.md');
  });

  it('延期发布意图事实在位（publishRequested / avgJobSeconds 形态）', () => {
    expect(typeof raw.publishRequested).toBe('boolean');
    expect(['number', 'object', 'undefined']).toContain(typeof raw.avgJobSeconds);
  });
});

describe('sidecar 契约金样本：/v1/chapter-versions/list（Node 消费端）', () => {
  const golden = readGolden('chapter-versions-list.response.json');

  it('信封与版本列表：Node docs-page-loader 消费的全部字段存在且类型正确', () => {
    expect(golden.ok).toBe(true);
    expect(Array.isArray(golden.versions)).toBe(true);
    for (const v of golden.versions) {
      expect(typeof v.id).toBe('string');
      expect(typeof v.authorId).toBe('string');
      expect(typeof v.voteCount).toBe('number');
      expect(typeof v.isCanonical).toBe('boolean');
      expect(typeof v.visibility).toBe('string');
      expect(typeof v.source).toBe('string');
      expect(typeof v.createdAt).toBe('string');
      expect(['string', 'object']).toContain(typeof v.contentId);
      expect(v.author).toBeTruthy();
      expect(['string', 'object']).toContain(typeof v.author.name);
      expect(typeof v.hasVoted).toBe('boolean');
      expect(typeof v.isContentValid).toBe('boolean');
      if (v.content !== undefined) expect(typeof v.content).toBe('string');
    }
  });

  it('可见性词汇 ∈ {PUBLIC, PRIVATE}；来源词汇 ∈ {RELAY, RETRANSLATE}（Node 过滤分支依赖）', () => {
    for (const v of golden.versions) {
      expect(['PUBLIC', 'PRIVATE']).toContain(v.visibility);
      expect(['RELAY', 'RETRANSLATE']).toContain(v.source);
    }
  });

  it('金样本同时覆盖 Content 出现/省略双形态（两段式正文获取的分支输入）', () => {
    const withContent = golden.versions.filter((v: any) => v.content !== undefined);
    const withoutContent = golden.versions.filter((v: any) => v.content === undefined);
    expect(withContent.length).toBeGreaterThan(0);
    expect(withoutContent.length).toBeGreaterThan(0);
    // Content 出现 ⇔ isContentValid 为 true（inlineContentById 只收有效正文）
    for (const v of withContent) expect(v.isContentValid).toBe(true);
  });
});

describe('sidecar 契约金样本：/v1/reading/progress-sync（Node 消费端）', () => {
  const golden = readGolden('reading-progress-sync.response.json');

  it('讲法隔离进度的响应形状：分数表/总进度/已读数/最近阅读（可空双形态）', () => {
    expect(golden.ok).toBe(true);
    expect(typeof golden.chapterScores).toBe('object');
    for (const score of Object.values(golden.chapterScores)) {
      expect(typeof score).toBe('number');
      expect(score as number).toBeGreaterThanOrEqual(0);
      expect(score as number).toBeLessThanOrEqual(100);
    }
    expect(typeof golden.overallProgress).toBe('number');
    expect(typeof golden.viewedCount).toBe('number');
    if (golden.lastReadPath !== undefined) expect(typeof golden.lastReadPath).toBe('string');
    if (golden.lastReadAt !== undefined) expect(typeof golden.lastReadAt).toBe('string');
  });
});

describe('sidecar 契约金样本：/v1/repos/patch 请求侧（Node → Go 写路径）', () => {
  const golden = readGolden('repos-patch.request.json');

  it('Node 调用点发送的关键字段在 Go 输入结构上全部存在且命名正确', () => {
    // 发布流水线字段（publish-repository.ts / publish-fanout.ts）
    expect(golden.isPublic).toBe(true);
    expect(golden.reviewStatus).toBe('APPROVED');
    expect(golden.touchPublishedAt).toBe(true);
    expect(golden.touchReviewedAt).toBe(true);
    expect(golden.clearRejectionReason).toBe(true);
    expect(golden.relayEnabled).toBe(true);
    // 发布扇出事实戳（touchRelayNotifiedAt / clearRelayNotifiedAt 同族，此处锁 touch）
    expect(golden.touchRelayNotifiedAt).toBe(true);
    // 上游探测回写字段（upstream-check）
    expect(golden.gitSha).toBe('abc123');
    expect(golden.hasUpstreamUpdate).toBe(false);
    expect(golden.upstreamEtag).toBeTruthy();
    expect(golden.touchUpstreamCheckedAt).toBe(true);
  });
});

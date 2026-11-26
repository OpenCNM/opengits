import { test, expect, describe, it } from 'vitest';
import { z } from 'zod';
import { REPO_METADATA_CATEGORIES, chapterDocPath, normalizeCategory, UNTAGGED_CATEGORIES, CATEGORY_ALIASES, KNOWN_CATEGORY_LABELS } from '@/lib/constants';
import { buildOutlineEvidence } from '@/lib/scout/pipeline/repo-metadata-classifier';
import { isIngestModeGrayZone, type RepoProfile } from '@/engine/repo-sniffer';
import { buildDirEvidence, deriveArbitratedProfile, ARBITRATION_CACHE_TTL_MS, ARBITRATION_FAILURE_TTL_MS, type ArbitrationVerdict } from '@/lib/scout/pipeline/ingest-mode-arbiter';
import { computeQueueEtaSeconds } from '@/lib/ingest-queue-eta';
import { orchestrateFromClusters } from '@/lib/mcp/ingest-orchestrator';
import { parseChapterTitle } from '@/lib/chapter-title';

describe('repo-metadata-classifier & category & chapter-title', () => {
  test('REPO_METADATA_CATEGORIES 封闭词表、buildOutlineEvidence 采样截断与 Zod 校验', () => {
    expect(REPO_METADATA_CATEGORIES).toEqual(['AI', 'Systems', 'Cloud', 'Web', 'Mobile', 'Gaming', 'Hardware', 'Finance', 'Science', 'Books', 'Others']);
    const chapters = Array.from({ length: 25 }, (_, i) => ({
      name: `第 ${i + 1} 章: 测试章节`,
      summary: '摘要'.repeat(60),
      files: Array.from({ length: 8 }, (_, j) => ({ path: `src/mod-${i}/file-${j}.ts` })),
    }));
    const lines = buildOutlineEvidence(chapters).split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0].split(' | ')[2].split(', ')).toHaveLength(4);

    const tolerant = buildOutlineEvidence([
      { name: '架构章', summary: '', files: ['pkg/core.go'] },
      { title: '无名列', files: [{ path: 'lib/x.py' }] },
      { name: '', summary: '跳过' },
    ]).split('\n');
    expect(tolerant).toEqual(['架构章 |  | pkg/core.go', '无名列 |  | lib/x.py']);

    const schema = z.object({
      category: z.enum(REPO_METADATA_CATEGORIES as [string, ...string[]]),
      tags: z.array(z.string().min(1).max(40)).min(1).max(6),
    });
    expect(schema.safeParse({ category: 'AI', tags: ['MCP'] }).success).toBe(true);
    expect(schema.safeParse({ category: 'DevTools', tags: ['CLI'] }).success).toBe(false);
    expect(schema.safeParse({ category: 'Web', tags: [] }).success).toBe(false);
  });

  test('normalizeCategory: 中英文别名、赛道优先级、空值边界、幂等性与 UNTAGGED_CATEGORIES', () => {
    for (const [input, expected] of [
      ['llm', 'AI'],
      ['web-docs', 'Web Docs'],
      ['Frontend', 'Web'],
      ['cloud-native', 'Cloud'],
      ['CS', 'Science'],
      ['flutter', 'Mobile'],
      ['unity', 'Gaming'],
      ['arduino', 'Hardware'],
      ['quant', 'Finance'],
      ['awesome', 'Others'],
      ['云原生', 'Cloud'],
      ['系统底层', 'Systems'],
      ['AI / 大模型', 'AI'],
      ['Web 全栈', 'Web'],
      ['官方文档', 'Web Docs'],
      ['赛道二：现代云原生 GPU、Serverless 算力', 'Cloud'],
      ['赛道十：软件设计哲学、经典架构模式', 'Cloud'],
      ['赛道十：可重现构建与构建系统', 'Systems'],
      ['赛道一：GPU 算力内核、CUDA 架构', 'AI'],
      ['量子计算', '量子计算'],
      [null, 'Others'],
      [undefined, 'Others'],
      ['  ', ''],
    ] as const) {
      expect(normalizeCategory(input), String(input)).toBe(expected);
    }

    for (const [key, label] of Object.entries(KNOWN_CATEGORY_LABELS)) {
      if (key !== 'all') expect(normalizeCategory(label)).toBe(normalizeCategory(key));
    }
    for (const target of new Set(Object.values(CATEGORY_ALIASES))) {
      expect(normalizeCategory(target)).toBe(target);
    }
    expect([UNTAGGED_CATEGORIES.has('Web Docs'), UNTAGGED_CATEGORIES.has('Others'), UNTAGGED_CATEGORIES.has('AI')]).toEqual([true, true, false]);
  });

  test('parseChapterTitle: 中英文序数前缀、裸数字及不误拆边界', () => {
    for (const [raw, expected] of [
      ['第 0 章 — 引言：设计哲学', { index: '00', cleanTitle: '引言：设计哲学' }],
      ['第1章：标题', { index: '01', cleanTitle: '标题' }],
      ['第 3 课 函数与闭包', { index: '03', cleanTitle: '函数与闭包' }],
      ['第 2 单元 测试入门', { index: '02', cleanTitle: '测试入门' }],
      ['Chapter 1: Getting Started', { index: '01', cleanTitle: 'Getting Started' }],
      ['Lesson 3 - Loops', { index: '03', cleanTitle: 'Loops' }],
      ['Module 10 · 总结', { index: '10', cleanTitle: '总结' }],
      ['01 - 快速上手', { index: '01', cleanTitle: '快速上手' }],
      ['3、基础', { index: '03', cleanTitle: '基础' }],
      ['全景架构总览', { index: null, cleanTitle: '全景架构总览' }],
      ['第3天连续集成', { index: null, cleanTitle: '第3天连续集成' }],
      ['v15 迁移指南', { index: null, cleanTitle: 'v15 迁移指南' }],
      ['', { index: null, cleanTitle: '' }],
    ] as const) {
      expect(parseChapterTitle(raw), raw).toEqual(expected);
    }
  });
});

describe('ingest-mode-gray-zone & eta & reoutline-clusters', () => {
  const makeProfile = (): RepoProfile =>
    ({
      repoType: 'docs',
      tier: 'B',
      ingestMode: 'text_only',
      docCodeRatio: { docFiles: 144, codeFiles: 127, otherFiles: 21, totalFiles: 842, ratio: 0.5314, codeExtensions: {}, docExtensions: {}, codeBytes: 5 * 1024 * 1024, docBytes: 900 * 1024 },
      textRoot: 'docs/',
      labRoots: [],
      chapterCount: 0,
      hasTranslations: false,
      translationRoots: [],
      excludeFromNav: [],
      globalAssets: { pdfs: [], buildScripts: [] },
      answerFile: null,
      semanticTags: {},
    } as unknown as RepoProfile);

  test('isIngestModeGrayZone / deriveArbitratedProfile / buildDirEvidence / TTL 契约', () => {
    expect(isIngestModeGrayZone(makeProfile())).toBe(true);
    const book = makeProfile();
    book.docCodeRatio.codeFiles = 30;
    book.docCodeRatio.codeBytes = 80 * 1024;
    expect(isIngestModeGrayZone(book)).toBe(false);

    const lowDoc = makeProfile();
    lowDoc.docCodeRatio.docFiles = 3;
    expect(isIngestModeGrayZone(lowDoc)).toBe(false);

    const hybrid = makeProfile();
    hybrid.ingestMode = 'hybrid';
    expect(isIngestModeGrayZone(hybrid)).toBe(false);

    const legacy = makeProfile();
    delete legacy.docCodeRatio.codeBytes;
    expect(isIngestModeGrayZone(legacy)).toBe(false);

    const codeVerdict: ArbitrationVerdict = { teachingFocus: 'code', rationale: 'code' };
    const docsVerdict: ArbitrationVerdict = { teachingFocus: 'docs', rationale: 'docs' };
    expect(deriveArbitratedProfile(makeProfile(), codeVerdict)).toMatchObject({ ingestMode: 'hybrid', repoType: 'codebase', textRoot: '' });
    const src = makeProfile();
    expect(deriveArbitratedProfile(src, docsVerdict)).toBe(src);

    expect(ARBITRATION_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(ARBITRATION_FAILURE_TTL_MS).toBeGreaterThan(0);
    expect(ARBITRATION_FAILURE_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);

    const evidence = buildDirEvidence([
      { path: 'docs/', name: 'docs', depth: 1, mdCount: 94, totalFiles: 100, children: [{ path: 'docs/features/', name: 'features', depth: 2, mdCount: 30, totalFiles: 30, children: [] }] },
      { path: 'sdk/', name: 'sdk', depth: 1, mdCount: 2, totalFiles: 60, children: [] },
    ]).split('\n');
    expect(evidence[0]).toContain('docs/ | 94/100 docs | depth 1');
    expect(evidence[2]).toContain('docs/features/ | 30/30 docs | depth 2');
  });

  it('computeQueueEtaSeconds 排队与运行态耗时估算矩阵', () => {
    for (const [name, input, expected] of [
      ['无历史耗时', { status: 'QUEUED', queuePosition: 3, avgJobSeconds: null, concurrency: 6 }, null],
      ['非正平均耗时', { status: 'QUEUED', queuePosition: 3, avgJobSeconds: 0, concurrency: 6 }, null],
      ['无排队位置', { status: 'QUEUED', queuePosition: null, avgJobSeconds: 90, concurrency: 6 }, null],
      ['位置<=并发', { status: 'QUEUED', queuePosition: 3, avgJobSeconds: 90, concurrency: 6 }, 180],
      ['位置=7 并发=6', { status: 'QUEUED', queuePosition: 7, avgJobSeconds: 60, concurrency: 6 }, 180],
      ['concurrency=0 容错', { status: 'QUEUED', queuePosition: 2, avgJobSeconds: 60, concurrency: 0 }, 180],
      ['RUNNING 占比', { status: 'RUNNING', avgJobSeconds: 100, savedChunks: 6, totalChunks: 8, concurrency: 6 }, 25],
      ['RUNNING 已满', { status: 'RUNNING', avgJobSeconds: 100, savedChunks: 8, totalChunks: 8, concurrency: 6 }, 0],
      ['RUNNING 半程', { status: 'RUNNING', avgJobSeconds: 100, totalChunks: null, concurrency: 6 }, 50],
      ['DONE 不估算', { status: 'DONE', avgJobSeconds: 90, concurrency: 6 }, null],
    ] as const) {
      expect(computeQueueEtaSeconds(input), name).toBe(expected);
    }
  });

  it('orchestrateFromClusters 保留 partTitle、自动分篇与附录文档无损保留', () => {
    const draft = orchestrateFromClusters([
      { title: 'Overview', teachingOrder: 1, partTitle: 'Part 1: Getting Started' },
      { title: 'Core', teachingOrder: 2, partTitle: 'Part 2: Deep Dive' },
    ]);
    expect(draft.parts).toEqual([
      { title: 'Part 1: Getting Started', teachingOrder: 1 },
      { title: 'Part 2: Deep Dive', teachingOrder: 2 },
    ]);
    expect(draft.chapters[0].nodes[0].sourcePath).toBe(chapterDocPath(1));

    const autoParts = orchestrateFromClusters(Array.from({ length: 9 }, (_, i) => ({ title: `Ch ${i + 1}`, teachingOrder: i + 1 })));
    expect(autoParts.parts.map((p) => p.title)).toEqual(['Basics', 'Core', 'Advanced']);
  });
});

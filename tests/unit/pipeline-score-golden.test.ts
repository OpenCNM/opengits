import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, vi } from 'vitest';

/**
 * pipeline-score 黄金对拍（后续刀 1：换入 re-audit 已 Go 单实现
 * pipelineScoreTotal）。Node computePipelineScore 仍承载 admin 审核路径——
 * 两侧共用五维加权数学，夹具双端同源断言。
 */
const docsFixture = vi.fn();
const outlineFixture = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    repository: { findUnique: () => outlineFixture() },
    document: { findMany: () => docsFixture() },
  },
}));

const { computePipelineScoreLocal: computePipelineScore } = await import('@/lib/review/pipeline-score');

interface GoldenCase {
  name: string;
  chapterCount: number;
  docs: Array<{ status: string; content: string }>;
  expected: number;
}

function loadGolden(): GoldenCase[] {
  const raw = readFileSync(
    join(__dirname, '../../services/worker-sidecar/testdata/pipeline-score.golden.json'),
    'utf8'
  );
  const fixture = JSON.parse(raw) as { cases: GoldenCase[] };
  if (!fixture.cases?.length) throw new Error('pipeline-score.golden.json empty');
  return fixture.cases;
}

describe('pipeline-score golden parity（Node 审核路径 vs Go 换入 re-audit）', () => {
  const cases = loadGolden();

  it.for(cases)('$# $name 总分与夹具一致', async ({ chapterCount, docs, expected }, { expect }) => {
    outlineFixture.mockResolvedValue({ outlines: [{ chapters: Array.from({ length: chapterCount }) }] });
    docsFixture.mockResolvedValue(docs.map((d) => ({ status: d.status, content: d.content, title: 't' })));
    const score = await computePipelineScore('repo-x');
    expect(score.total).toBe(expected);
  });
});

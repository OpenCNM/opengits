import { describe, expect, it } from 'vitest';
import { computeQueueEtaSeconds } from '@/lib/ingest-queue-eta';

describe('computeQueueEtaSeconds（排队完成秒数估算）', () => {
  it.each([
    // [名称, 输入, 期望秒数]
    ['无历史耗时不编数', { status: 'QUEUED', queuePosition: 3, avgJobSeconds: null, concurrency: 6 }, null],
    ['非正平均耗时不编数', { status: 'QUEUED', queuePosition: 3, avgJobSeconds: 0, concurrency: 6 }, null],
    ['QUEUED 无排队位置不估算', { status: 'QUEUED', queuePosition: null, avgJobSeconds: 90, concurrency: 6 }, null],
    ['QUEUED 位置≤并发数：等待 1 批 + 自身 1 个平均耗时', { status: 'QUEUED', queuePosition: 3, avgJobSeconds: 90, concurrency: 6 }, 180],
    ['QUEUED 位置=7 并发=6：等待 2 批', { status: 'QUEUED', queuePosition: 7, avgJobSeconds: 60, concurrency: 6 }, 180],
    ['QUEUED 位置=13 并发=6：等待 3 批', { status: 'QUEUED', queuePosition: 13, avgJobSeconds: 60, concurrency: 6 }, 240],
    ['并发容错：concurrency=0 按 1 处理', { status: 'QUEUED', queuePosition: 2, avgJobSeconds: 60, concurrency: 0 }, 180],
    ['RUNNING 按剩余块占比估算', { status: 'RUNNING', avgJobSeconds: 100, savedChunks: 6, totalChunks: 8, concurrency: 6 }, 25],
    ['RUNNING 存档已满：0 秒', { status: 'RUNNING', avgJobSeconds: 100, savedChunks: 8, totalChunks: 8, concurrency: 6 }, 0],
    ['RUNNING 无块进度：半程假设', { status: 'RUNNING', avgJobSeconds: 100, totalChunks: null, concurrency: 6 }, 50],
    ['DONE/FAILED 不估算', { status: 'DONE', avgJobSeconds: 90, concurrency: 6 }, null],
  ] as const)('%s', (_name, input, expected) => {
    expect(computeQueueEtaSeconds(input)).toBe(expected);
  });
});

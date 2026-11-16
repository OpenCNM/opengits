import { describe, expect, it } from 'vitest';

/**
 * graph-condense 单测（纯确定性核心）：
 * repoProfile 超主题区块解析（存量数据兼容读）。
 * LLM 凝聚管线（condenseRepositoryGraph / graphCondenseOnce / 调度器 / evaluator
 * 擂台赛）已整体裁撤，相关测试一并移除；condenseConceptGraph 纯计算紧缩由
 * tests/unit/knowledge-graph-first-principles.test.ts §4 覆盖。
 */
const { parseSuperTopicsBlock } = await import('@/lib/mcp/graph-condense');

describe('parseSuperTopicsBlock repoProfile 区块解析', () => {
  it('合法区块通过 Zod 校验', () => {
    const block = {
      topics: [{ title: 'JS 异步模型', summary: 's', memberKeys: ['k1'] }],
      generatedAt: '2026-08-29T00:00:00.000Z',
      model: 'openai/gpt-x',
    };
    expect(parseSuperTopicsBlock({ conceptSuperTopics: block })?.topics).toHaveLength(1);
  });

  it('脏数据/缺失返回 null（降级到下一数据源）', () => {
    expect(parseSuperTopicsBlock(undefined)).toBeNull();
    expect(parseSuperTopicsBlock({ conceptSuperTopics: { nope: true } })).toBeNull();
    expect(parseSuperTopicsBlock({ conceptSuperTopics: { topics: 'not-array', generatedAt: '', model: '' } })).toBeNull();
  });
});

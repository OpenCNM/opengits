import { test, expect } from 'vitest';
import { z } from 'zod';
import { generateStructured } from '@/lib/ai';

/** fake LanguageModel：按调用序返回预置行为（抛错模拟不支持 / 文本模拟输出），零真实 API */
function makeFakeModel(script: Array<{ throwMsg?: string; text?: string }>) {
  let calls = 0;
  const model: any = {
    specificationVersion: 'v4',
    provider: 'test-fake',
    modelId: 'fake',
    doGenerate: async () => {
      const step = script[Math.min(calls, script.length - 1)];
      calls++;
      if (step.throwMsg) throw new Error(step.throwMsg);
      return {
        content: [{ type: 'text', text: step.text }],
        text: step.text,
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, noCache: 1 },
          totalTokens: { total: 2 },
        },
        finishReason: { unified: 'stop' },
        response: { id: 'fake-response', modelId: 'fake', timestamp: new Date() },
        warnings: [],
        rawCallResponse: {},
      };
    },
  };
  return { model, calls: () => calls };
}

test('json_schema 不支持 → 自动降级 json_mode（1 次试错 + 1 次生成）', async () => {
  const t = makeFakeModel([{ throwMsg: 'This response_format type is unavailable now' }, { text: '{"ok": true}' }]);
  const r = await generateStructured({
    provider: 'fake-provider-a',
    modelId: 'fake-model',
    model: t.model,
    schema: z.object({ ok: z.boolean() }),
    prompt: '测试',
  });
  expect(r.mode).toBe('json_mode');
  expect(r.object.ok).toBe(true);
  expect(t.calls()).toBe(2);
});

test('失败探测缓存：同 provider 二次调用跳过试错直接 json_mode', async () => {
  const t = makeFakeModel([{ text: '{"ok": true}' }]);
  const r = await generateStructured({
    provider: 'fake-provider-a', // 上一测已缓存为「不支持 json_schema」
    model: t.model,
    schema: z.object({ ok: z.boolean() }),
    prompt: '测试',
  });
  expect(r.mode).toBe('json_mode');
  expect(t.calls()).toBe(1);
});

test('校验失败反馈重试：{} 空输出被 ZodError 回传修正', async () => {
  const t = makeFakeModel([
    { throwMsg: 'This response_format type is unavailable now' },
    { text: '{}' },
    { text: '{"ok": true}' },
  ]);
  const r = await generateStructured({
    provider: 'fake-provider-b',
    model: t.model,
    schema: z.object({ ok: z.boolean() }),
    prompt: '测试',
  });
  expect(r.mode).toBe('json_mode');
  expect(r.object.ok).toBe(true);
  expect(t.calls()).toBe(3);
});

test('非格式错误（超时）原样上抛，不误降级', async () => {
  const t = makeFakeModel([{ throwMsg: 'Timeout after 30s' }]);
  await expect(
    generateStructured({
      provider: 'fake-provider-c',
      model: t.model,
      schema: z.object({ ok: z.boolean() }),
      prompt: '测试',
    })
  ).rejects.toThrow(/Timeout/);
});

test('支持 json_schema 的 provider 保持严格模式', async () => {
  const t = makeFakeModel([{ text: '{"ok": true}' }]);
  const r = await generateStructured({
    provider: 'fake-provider-d',
    model: t.model,
    schema: z.object({ ok: z.boolean() }),
    prompt: '测试',
  });
  expect(r.mode).toBe('json_schema');
});

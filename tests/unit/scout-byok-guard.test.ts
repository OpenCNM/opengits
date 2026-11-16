import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Scout BYOK 守卫链单测:toInjectableStructuredModel 的四条分支
 * (null / 安全阀关闭 / 非 openai 格式 / 正常注入)。
 */

const envBackup = { ...process.env };

describe('scout BYOK 守卫(toInjectableStructuredModel)', () => {
  afterEach(() => {
    process.env = { ...envBackup };
    vi.resetModules();
  });

  const userModel = {
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    apiKey: 'sk-user',
    baseURL: 'https://api.deepseek.com/v1',
    apiFormat: 'openai' as const,
  };

  it('null(未配置/解密失败)→ undefined 回落平台', async () => {
    const { toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
    expect(toInjectableStructuredModel(null)).toBeUndefined();
  });

  it('安全阀 SCOUT_BYOK_DISABLED=1 → undefined(一键止血)', async () => {
    process.env.SCOUT_BYOK_DISABLED = '1';
    const { toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
    expect(toInjectableStructuredModel(userModel)).toBeUndefined();
  });

  it('非 openai 格式(anthropic)→ undefined(getDynamicModel 缺口守卫,防静默落平台 key)', async () => {
    const { toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
    expect(
      toInjectableStructuredModel({ ...userModel, apiFormat: 'anthropic' })
    ).toBeUndefined();
  });

  it('openai 格式 + 开关开启 → 返回可注入的 model 实例', async () => {
    const { toInjectableStructuredModel } = await import('@/lib/ai/user-model-resolver');
    const model = toInjectableStructuredModel(userModel);
    // ai-sdk LanguageModelV1 封装:非空对象即可注入 generateStructured 的 model 槽
    expect(model).toBeDefined();
    expect(typeof model).toBe('object');
  });

  it('isScoutByokEnabled 默认开启', async () => {
    delete process.env.SCOUT_BYOK_DISABLED;
    const { isScoutByokEnabled } = await import('@/lib/ai/user-model-resolver');
    expect(isScoutByokEnabled()).toBe(true);
  });
});

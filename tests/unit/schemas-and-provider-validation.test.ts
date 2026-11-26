import { describe, it, expect, test } from 'vitest';
import { CreateModelProviderSchema, UpdateModelProviderSchema, TestConnectionSchema } from '@/lib/schemas/model-provider';
import { AI_PROVIDER_PRESETS } from '@/lib/constants';
import { mergeCloudProviders, runtimeApiKeyToWrite } from '@/lib/model-providers-sync';
import { type UserModelProviderDTO } from '@/types/user-model-provider';
import { promotionCreateSchema, promotionUpdateSchema } from '@/lib/promotions';

describe('model-provider-schema & admin-providers-validation', () => {
  it('AI_PROVIDER_PRESETS 2026 预设完备性、Google 3.7 与 DeepSeek V4 迁移', () => {
    for (const key of ['google', 'deepseek', 'zhipu', 'dashscope', 'openai', 'anthropic', 'custom']) {
      expect(Object.keys(AI_PROVIDER_PRESETS)).toContain(key);
    }
    for (const preset of Object.values(AI_PROVIDER_PRESETS)) {
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(['openai', 'anthropic']).toContain(preset.apiFormat);
      expect(preset.models).toContain(preset.defaultModel);
    }
    expect(AI_PROVIDER_PRESETS.google.models).toContain('gemini-3.7-flash');
    expect(AI_PROVIDER_PRESETS.google.models).toContain('gemini-3.1-pro');
    expect(AI_PROVIDER_PRESETS.deepseek.models).toContain('deepseek-v4-pro');
    expect(AI_PROVIDER_PRESETS.deepseek.models).not.toContain('deepseek-chat');
  });

  it('CreateModelProviderSchema / UpdateModelProviderSchema / TestConnectionSchema 合法与边界拒绝', () => {
    const valid = {
      providerKey: 'google_cloud_custom',
      name: 'Google Custom',
      label: 'Google Custom (Vertex)',
      badgeLabel: '🔴 Google Custom',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      defaultModel: 'gemini-3.7-flash',
      models: ['gemini-3.7-flash', 'gemini-3.1-pro'],
      isEnabled: true,
    };
    expect(CreateModelProviderSchema.safeParse(valid).success).toBe(true);
    expect(CreateModelProviderSchema.safeParse({ ...valid, baseUrl: 'not-a-valid-url' }).success).toBe(false);
    expect(CreateModelProviderSchema.safeParse({ ...valid, models: [] }).success).toBe(false);
    expect(CreateModelProviderSchema.safeParse({ ...valid, defaultModel: 'gpt 4o', models: ['gpt 4o'] }).success).toBe(false);
    expect(CreateModelProviderSchema.safeParse({ ...valid, models: ['a'.repeat(121)] }).success).toBe(false);

    for (const ssrfUrl of [
      'http://localhost:8000',
      'http://127.0.0.1:11434',
      'http://192.168.1.100:8000',
      'http://10.0.0.1/v1',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      expect(CreateModelProviderSchema.safeParse({ ...valid, baseUrl: ssrfUrl }).success, ssrfUrl).toBe(false);
    }

    expect(UpdateModelProviderSchema.safeParse({ baseUrl: 'http://127.0.0.1:8000' }).success).toBe(false);
    expect(UpdateModelProviderSchema.safeParse({ defaultModel: 'model with spaces' }).success).toBe(false);

    expect(TestConnectionSchema.safeParse({ baseUrl: valid.baseUrl, apiKey: 'AIzaKey', apiFormat: 'openai', model: 'gemini-3.7-flash' }).success).toBe(true);
    expect(TestConnectionSchema.safeParse({ baseUrl: valid.baseUrl, apiKey: '', model: 'gemini-3.7-flash' }).success).toBe(false);
  });
});

describe('model-providers-sync & promotions schemas', () => {
  const base = { apiFormat: 'openai' as const, models: ['m1'], selectedModel: 'm1', isActive: true, healthStatus: 'healthy' as const };
  const cloud = (over: Partial<UserModelProviderDTO> = {}): UserModelProviderDTO => ({
    id: 'c1',
    providerKey: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://x',
    maskedApiKey: 'sk-12••••••••••••wxyz',
    hasApiKey: true,
    ...base,
    ...over,
  });
  const local = (over: Partial<UserModelProviderDTO> = {}): UserModelProviderDTO => ({
    id: 'l1',
    providerKey: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://x',
    apiKey: 'sk-plaintext-123',
    ...base,
    ...over,
  });

  it('mergeCloudProviders & runtimeApiKeyToWrite 合并守卫与运行时写入', () => {
    const merged = mergeCloudProviders([cloud({ name: '云端名', selectedModel: 'm2' })], [local()]);
    expect(merged[0]).toMatchObject({ apiKey: 'sk-plaintext-123', name: '云端名', selectedModel: 'm2' });

    expect(mergeCloudProviders([cloud()], [local({ apiKey: undefined })])[0].apiKey).toBeUndefined();
    expect(
      mergeCloudProviders([cloud({ providerKey: 'deepseek' })], [local({ providerKey: 'zhipu', apiKey: 'sk-z', isActive: false })]).map(
        (p) => p.providerKey
      )
    ).toEqual(['deepseek', 'zhipu']);

    const localOnly = [local()];
    expect(mergeCloudProviders([], localOnly)).toBe(localOnly);

    const multi = mergeCloudProviders(
      [cloud({ providerKey: 'a' }), cloud({ providerKey: 'b' })],
      [local({ providerKey: 'a', apiKey: 'sk-a' }), local({ providerKey: 'b', apiKey: 'sk-b' })]
    );
    expect(multi.find((p) => p.providerKey === 'a')?.apiKey).toBe('sk-a');
    expect(multi.find((p) => p.providerKey === 'b')?.apiKey).toBe('sk-b');

    expect(runtimeApiKeyToWrite(local())).toBe('sk-plaintext-123');
    expect(runtimeApiKeyToWrite(cloud())).toBeNull();
    expect(runtimeApiKeyToWrite(undefined)).toBe('CLEAR');
  });

  test('promotionCreateSchema & promotionUpdateSchema 校验与日期顺序精炼', () => {
    const ok = promotionCreateSchema.safeParse({ title: '  秋季推荐  ' });
    expect(ok.success && ok.data.title).toBe('秋季推荐');
    expect(promotionCreateSchema.safeParse({ title: '' }).success).toBe(false);
    expect(promotionCreateSchema.safeParse({ title: 'x', kind: 'banner' }).success).toBe(false);
    expect(promotionCreateSchema.safeParse({ title: 'x', startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-08-01T00:00:00.000Z' }).success).toBe(false);
    expect(promotionCreateSchema.safeParse({ title: 'x', startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z' }).success).toBe(true);
    expect(promotionCreateSchema.safeParse({ title: 'x', startsAt: 'not-a-date' }).success).toBe(false);
    expect(promotionUpdateSchema.safeParse({ isPinned: false }).success).toBe(true);
    expect(promotionUpdateSchema.safeParse({ subtitle: null }).success).toBe(true);
  });
});

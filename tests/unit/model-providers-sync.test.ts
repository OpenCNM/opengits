import { describe, expect, it } from 'vitest';
import {
  mergeCloudProviders,
  runtimeApiKeyToWrite,
} from '@/lib/model-providers-sync';
import type { UserModelProviderDTO } from '@/types/user-model-provider';

const base = {
  apiFormat: 'openai' as const,
  models: ['m1'],
  selectedModel: 'm1',
  isActive: true,
  healthStatus: 'healthy' as const,
};

function cloud(over: Partial<UserModelProviderDTO> = {}): UserModelProviderDTO {
  return { id: 'c1', providerKey: 'deepseek', name: 'DeepSeek', baseUrl: 'https://x', maskedApiKey: 'sk-12••••••••••••wxyz', hasApiKey: true, ...base, ...over };
}

function local(over: Partial<UserModelProviderDTO> = {}): UserModelProviderDTO {
  return { id: 'l1', providerKey: 'deepseek', name: 'DeepSeek', baseUrl: 'https://x', apiKey: 'sk-plaintext-123', ...base, ...over };
}

describe('mergeCloudProviders（合并守卫）', () => {
  it('云端记录无明文时从本地继承 apiKey，其余字段以云端为准', () => {
    const merged = mergeCloudProviders(
      [cloud({ name: 'DeepSeek 云端名', selectedModel: 'm2' })],
      [local()]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].apiKey).toBe('sk-plaintext-123');
    expect(merged[0].name).toBe('DeepSeek 云端名');
    expect(merged[0].selectedModel).toBe('m2');
    expect(merged[0].maskedApiKey).toBeTruthy();
  });

  it('本地也没有明文时（新设备首登）不捏造 key', () => {
    const merged = mergeCloudProviders([cloud()], [local({ apiKey: undefined })]);
    expect(merged[0].apiKey).toBeUndefined();
  });

  it('本地独有（未上云）的记录被保留并追加', () => {
    const merged = mergeCloudProviders(
      [cloud({ providerKey: 'deepseek', isActive: true })],
      [local({ providerKey: 'zhipu', apiKey: 'sk-z', isActive: false })]
    );
    expect(merged.map((p) => p.providerKey)).toEqual(['deepseek', 'zhipu']);
  });

  it('云端为空时原样返回本地（Local-First 不破坏）', () => {
    const l = [local()];
    expect(mergeCloudProviders([], l)).toBe(l);
  });

  it('同 providerKey 多服务商隔离（dashscope 与 custom 同厂多行不串 key）', () => {
    const merged = mergeCloudProviders(
      [cloud({ providerKey: 'a' }), cloud({ providerKey: 'b' })],
      [local({ providerKey: 'a', apiKey: 'sk-a' }), local({ providerKey: 'b', apiKey: 'sk-b' })]
    );
    expect(merged.find((p) => p.providerKey === 'a')?.apiKey).toBe('sk-a');
    expect(merged.find((p) => p.providerKey === 'b')?.apiKey).toBe('sk-b');
  });
});

describe('runtimeApiKeyToWrite（运行时写入守卫）', () => {
  it('active 带明文 → 写入该值', () => {
    expect(runtimeApiKeyToWrite(local())).toBe('sk-plaintext-123');
  });

  it('active 无明文（云端掩码记录）→ 保持现状不写', () => {
    expect(runtimeApiKeyToWrite(cloud())).toBeNull();
  });

  it('无任何服务商 → 清除', () => {
    expect(runtimeApiKeyToWrite(undefined)).toBe('CLEAR');
  });
});

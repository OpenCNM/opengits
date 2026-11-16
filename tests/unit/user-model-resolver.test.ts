import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveActiveUserModel,
  invalidateUserModelCache,
  clearUserModelCache,
} from '@/lib/ai/user-model-resolver';

const findFirstMock = vi.fn();
const tryDecryptMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    userModelProvider: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
    },
  },
}));

vi.mock('@/lib/crypto/api-key-cipher', () => ({
  tryDecryptApiKey: (...args: unknown[]) => tryDecryptMock(...args),
}));

describe('user-model-resolver 内存高速缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearUserModelCache();
  });

  it('🧪 [11.7.4.2] 同一用户多切片连续解析：首次查库解密，后续调用 0 DB 0 解密内存命中', async () => {
    findFirstMock.mockResolvedValue({
      providerKey: 'dashscope',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'enc:v1:encrypted-blob',
      apiFormat: 'openai',
      selectedModel: 'qwen3.6-flash',
    });
    tryDecryptMock.mockReturnValue('sk-decrypted-plain-key');

    // 第一次解析：查库并解密
    const m1 = await resolveActiveUserModel('user-123');
    expect(m1).toEqual({
      provider: 'dashscope',
      modelId: 'qwen3.6-flash',
      apiKey: 'sk-decrypted-plain-key',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiFormat: 'openai',
    });
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(tryDecryptMock).toHaveBeenCalledTimes(1);

    // 第二次解析（模拟同一文档下一个切片）：内存命中，0 DB 0 解密
    const m2 = await resolveActiveUserModel('user-123');
    expect(m2).toEqual(m1);
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(tryDecryptMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateUserModelCache：用户更新配置后缓存失效，再次查询穿透回库', async () => {
    findFirstMock.mockResolvedValue({
      providerKey: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'enc:v1:deepseek-blob',
      apiFormat: 'openai',
      selectedModel: 'deepseek-chat',
    });
    tryDecryptMock.mockReturnValue('sk-deepseek-key');

    await resolveActiveUserModel('user-456');
    expect(findFirstMock).toHaveBeenCalledTimes(1);

    // 显式清除
    invalidateUserModelCache('user-456');

    // 再次查询：重新查库
    await resolveActiveUserModel('user-456');
    expect(findFirstMock).toHaveBeenCalledTimes(2);
  });

  it('未配置用户 10s 负缓存：防空查击穿 DB', async () => {
    findFirstMock.mockResolvedValue(null);

    const res1 = await resolveActiveUserModel('user-unconfigured');
    expect(res1).toBeNull();
    expect(findFirstMock).toHaveBeenCalledTimes(1);

    // 第二次查询：命中负缓存，不重复查库
    const res2 = await resolveActiveUserModel('user-unconfigured');
    expect(res2).toBeNull();
    expect(findFirstMock).toHaveBeenCalledTimes(1);
  });

  it('userId 为空时直接返回 null 且零 DB 查询', async () => {
    const res = await resolveActiveUserModel(null);
    expect(res).toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('并发单飞防击穿：同一用户并发多个切片同时解析仅触发 1 次查库与解密', async () => {
    findFirstMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        providerKey: 'dashscope',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'enc:v1:encrypted-blob',
        apiFormat: 'openai',
        selectedModel: 'qwen-plus',
      };
    });
    tryDecryptMock.mockReturnValue('sk-decrypted-concurrent');

    const results = await Promise.all([
      resolveActiveUserModel('user-concurrent'),
      resolveActiveUserModel('user-concurrent'),
      resolveActiveUserModel('user-concurrent'),
      resolveActiveUserModel('user-concurrent'),
    ]);

    expect(results).toHaveLength(4);
    expect(results[0]?.apiKey).toBe('sk-decrypted-concurrent');
    expect(results[1]?.apiKey).toBe('sk-decrypted-concurrent');
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(tryDecryptMock).toHaveBeenCalledTimes(1);
  });

  it('在途期间显式失效：已淘汰的在途加载不回写脏缓存', async () => {
    let resolveDb: (val: unknown) => void;
    findFirstMock.mockImplementation(() => new Promise((r) => { resolveDb = r; }));
    tryDecryptMock.mockReturnValue('sk-old-key');

    const p1 = resolveActiveUserModel('user-race');
    // 在途期间调用失效
    invalidateUserModelCache('user-race');

    // 随后完成
    resolveDb!({
      providerKey: 'dashscope',
      baseUrl: 'https://dashscope.aliyuncs.com',
      apiKey: 'enc:v1:old',
      apiFormat: 'openai',
      selectedModel: 'qwen',
    });
    await p1;

    // 再次查询应触发新的查库（旧在途未回写脏缓存）
    findFirstMock.mockResolvedValue(null);
    const m2 = await resolveActiveUserModel('user-race');
    expect(m2).toBeNull();
    expect(findFirstMock).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * langfuse tutor prompt 进程内缓存单测:
 * 首调用同步返回 fallback / 异步填充后返回远端 / TTL 过期供旧值并后台刷新 /
 * 拉取失败持续回落 fallback。每用例 resetModules 取全新模块态。
 */

const getPromptMock = vi.fn();

vi.mock('langfuse', () => ({
  Langfuse: class {
    getPrompt = getPromptMock;
  },
}));

const ARGS = { feynmanMode: false, owner: 'acme', repo: 'docs', currentPath: '/docs/start' };

function remotePrompt(text: string) {
  return { compile: (vars: Record<string, unknown>) => `${text}[${vars.owner}/${vars.repo}]` };
}

async function freshModule() {
  vi.resetModules();
  return import('@/lib/agent/langfuse');
}

describe('getCachedTutorPrompt(同步缓存+后台刷新)', () => {
  beforeEach(() => {
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';
    getPromptMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.LANGFUSE_SECRET_KEY;
  });

  it('未命中:首调用同步返回内置 fallback,同时后台拉取填充', async () => {
    let resolveFetch!: (v: unknown) => void;
    getPromptMock.mockReturnValue(new Promise((res) => { resolveFetch = res; }));
    const mod = await freshModule();

    const first = mod.getCachedTutorPrompt(ARGS);
    expect(first).toBe(mod.buildTutorPromptFallback(ARGS)); // 同步即返回,不等远端

    resolveFetch(remotePrompt('REMOTE_V1'));
    await vi.advanceTimersByTimeAsync(0);
    const second = mod.getCachedTutorPrompt(ARGS);
    expect(second).toBe('REMOTE_V1[acme/docs]'); // 填充后返回远端
  });

  it('TTL 过期:继续供旧值 + 触发后台刷新,刷新后供新值', async () => {
    getPromptMock.mockResolvedValueOnce(remotePrompt('V1'));
    const mod = await freshModule();
    // 预热填充
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.getCachedTutorPrompt(ARGS)).toBe('V1[acme/docs]');

    // 快进 11 分钟(> TTL 10min):旧值仍立即可用
    getPromptMock.mockResolvedValueOnce(remotePrompt('V2'));
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(mod.getCachedTutorPrompt(ARGS)).toBe('V1[acme/docs]');
    // 刷新完成后切新值
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.getCachedTutorPrompt(ARGS)).toBe('V2[acme/docs]');
  });

  it('拉取一直失败:每次调用都安全回落 fallback,不抛错', async () => {
    getPromptMock.mockRejectedValue(new Error('langfuse down'));
    const mod = await freshModule();
    await vi.advanceTimersByTimeAsync(0); // 让预热的 rejection 落地
    const out = mod.getCachedTutorPrompt({ ...ARGS, feynmanMode: true });
    expect(out).toBe(mod.buildTutorPromptFallback({ ...ARGS, feynmanMode: true }));
    expect(out).toContain('FEYNMAN MODE');
  });

  it('feynman 与 standard 使用不同缓存键互不串扰', async () => {
    getPromptMock
      .mockResolvedValueOnce(remotePrompt('STD'))
      .mockResolvedValueOnce(remotePrompt('FEYN'));
    const mod = await freshModule();
    await vi.advanceTimersByTimeAsync(0);

    expect(mod.getCachedTutorPrompt(ARGS)).toBe('STD[acme/docs]');
    expect(mod.getCachedTutorPrompt({ ...ARGS, feynmanMode: true })).toBe('FEYN[acme/docs]');
    // 两次预热(standard/feynman 各一)
    expect(getPromptMock).toHaveBeenCalledWith('tutor_system_v1');
    expect(getPromptMock).toHaveBeenCalledWith('tutor_feynman_v1');
  });
});

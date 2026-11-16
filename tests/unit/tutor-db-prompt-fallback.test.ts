import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * tutor prompt 兜底链次序单测（修复"伪可编辑陷阱"后的契约）：
 * Langfuse 远端 > PromptRegistry DB 托管版本（admin 热编辑成果）> 代码预设。
 * DB 未命中触发后台预热（下次请求即用 DB 版本）。
 */

const getPromptMock = vi.fn();
const compileFromCacheSync = vi.fn();
const compilePresetSync = vi.fn();
const getCompiledPrompt = vi.fn();

vi.mock('langfuse', () => ({
  Langfuse: class {
    getPrompt = getPromptMock;
  },
}));

vi.mock('@/lib/prompt-registry', () => ({
  PromptRegistry: {
    compileFromCacheSync: (...args: unknown[]) => compileFromCacheSync(...args),
    compilePresetSync: (...args: unknown[]) => compilePresetSync(...args),
    getCompiledPrompt: (...args: unknown[]) => getCompiledPrompt(...args),
  },
}));

const ARGS = { feynmanMode: false, owner: 'acme', repo: 'docs', currentPath: '/docs/start' };

async function freshModule() {
  vi.resetModules();
  return import('@/lib/agent/langfuse');
}

describe('tutor 兜底链: DB 托管版本优先于代码预设', () => {
  beforeEach(() => {
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';
    vi.clearAllMocks();
    getPromptMock.mockResolvedValue(new Promise(() => {})); // Langfuse 永不返回（保持未命中态）
    compileFromCacheSync.mockReturnValue(null);
    compilePresetSync.mockReturnValue('CODE_PRESET');
    getCompiledPrompt.mockResolvedValue({});
  });

  it('DB 缓存命中 → admin 热编辑版本生效（伪可编辑陷阱已修复）', async () => {
    compileFromCacheSync.mockReturnValue('DB_EDITED_V7');
    const mod = await freshModule();

    expect(mod.buildTutorPromptFallback(ARGS)).toBe('DB_EDITED_V7');
    expect(compileFromCacheSync).toHaveBeenCalledWith('tutor_system_v1', expect.objectContaining({ owner: 'acme' }));
    expect(compilePresetSync).not.toHaveBeenCalled();
  });

  it('DB 缓存未命中 → 代码预设兜底 + 触发后台 DB 预热', async () => {
    const mod = await freshModule();
    const out = mod.buildTutorPromptFallback(ARGS);
    expect(out).toBe('CODE_PRESET');
    expect(getCompiledPrompt).toHaveBeenCalledWith('tutor_system_v1');
  });

  it('Langfuse 主链仍最高优先：远端命中时不触及 DB/代码兜底', async () => {
    getPromptMock.mockResolvedValue({
      compile: (vars: Record<string, unknown>) => `REMOTE[${vars.owner}]`,
    });
    const mod = await freshModule();
    await vi.waitFor(() => expect(mod.getCachedTutorPrompt(ARGS)).toBe('REMOTE[acme]'));

    expect(compilePresetSync).not.toHaveBeenCalled();
    expect(mod.getCachedTutorPrompt(ARGS)).toBe('REMOTE[acme]');
  });
});

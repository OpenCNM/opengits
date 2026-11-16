import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 统一错误采集器：上报器永不抛错；DSN 门控（未配置/占位 → 纯本地日志）。
 */

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
vi.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

async function errors() {
  return import('@/lib/observability/errors');
}

describe('captureError / captureWarn（上报器永不抛错）', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SENTRY_DSN;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('未配置 DSN：仅本地结构化日志，不触达 SDK，不抛错', async () => {
    const { captureError, captureWarn } = await errors();
    await expect(
      captureError(new Error('boom'), { scope: 'test/none', extra: { id: 1 } })
    ).resolves.toBeUndefined();
    await expect(captureWarn('w', { scope: 'test/none' })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[test/none] boom'));
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('DSN 占位值（含 example）视为未配置', async () => {
    process.env.SENTRY_DSN = 'https://key@example.com/1';
    const { captureError } = await errors();
    await captureError(new Error('x'), { scope: 'test/placeholder' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('DSN 已配置：异常透传 SDK，带 scope 标签与 extra', async () => {
    process.env.SENTRY_DSN = 'https://key@errors.invalid/1';
    const { captureError, captureWarn } = await errors();
    const err = new Error('real boom');
    await captureError(err, { scope: 'test/sdk', extra: { jobId: 'j1' } });
    await captureWarn('degraded', { scope: 'test/sdk' });

    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      tags: { scope: 'test/sdk' },
      extra: { jobId: 'j1' },
    });
    expect(captureMessageMock).toHaveBeenCalledWith('[test/sdk] degraded', 'warning');
  });

  it('非 Error 值：安全字符串化，不抛错', async () => {
    const { captureError } = await errors();
    await expect(captureError('plain string failure', { scope: 'test/string' })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('plain string failure'));
  });
});

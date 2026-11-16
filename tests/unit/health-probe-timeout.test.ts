import { describe, it, expect } from 'vitest';
import { withTimeout } from '@/lib/health-probe';

describe('Health Probe withTimeout Utility (A1)', () => {
  it('resolves successfully when promise finishes within timeout', async () => {
    const fastPromise = new Promise<string>((resolve) => setTimeout(() => resolve('success'), 20));
    const res = await withTimeout(fastPromise, 200);
    expect(res).toBe('success');
  });

  it('rejects when underlying promise rejects within timeout (no fallback)', async () => {
    const failingPromise = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('DB Boom')), 20));
    await expect(withTimeout(failingPromise, 200)).rejects.toThrow('DB Boom');
  });

  it('returns fallback value when underlying promise rejects and fallback is provided', async () => {
    const failingPromise = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('DB Boom')), 20));
    const res = await withTimeout(failingPromise, 200, 'fallback_val');
    expect(res).toBe('fallback_val');
  });

  it('rejects with timeout error when promise exceeds ms and no fallback', async () => {
    const slowPromise = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 150));
    await expect(withTimeout(slowPromise, 30)).rejects.toThrow('Operation timed out after 30ms');
  });

  it('returns fallback value when promise times out and fallback is provided', async () => {
    const slowPromise = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 150));
    const res = await withTimeout(slowPromise, 30, 'timed_out_fallback');
    expect(res).toBe('timed_out_fallback');
  });
});

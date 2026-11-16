import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  savePendingImportReauth,
  readPendingImportReauth,
  clearPendingImportReauth,
  recordReauthAttempt,
  isReauthInCooldown,
  clearReauthAttempt,
} from '@/lib/stores/pending-import-reauth';
import { STORAGE_KEYS } from '@/lib/constants';

describe('Pending Import Reauth Store (OAuth bridge persistence)', () => {
  const mockStorage = new Map<string, string>();

  beforeEach(() => {
    mockStorage.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => mockStorage.get(k) ?? null,
      setItem: (k: string, v: string) => mockStorage.set(k, String(v)),
      removeItem: (k: string) => mockStorage.delete(k),
      clear: () => mockStorage.clear(),
    });
  });

  it('成功保存并读取待恢复向导任务草稿', () => {
    savePendingImportReauth({
      url: 'https://github.com/cline/cline',
      createEdition: true,
      targetLanguage: 'zh-CN',
      isPublic: true,
      importMode: 'github',
    });

    const restored = readPendingImportReauth();
    expect(restored).not.toBeNull();
    expect(restored?.url).toBe('https://github.com/cline/cline');
    expect(restored?.createEdition).toBe(true);
    expect(restored?.targetLanguage).toBe('zh-CN');
    expect(restored?.isPublic).toBe(true);
    expect(restored?.importMode).toBe('github');
  });

  it('空 URL 时静默拒绝写入', () => {
    savePendingImportReauth({
      url: '   ',
      createEdition: false,
    });

    expect(readPendingImportReauth()).toBeNull();
  });

  it('超过 15 分钟 TTL 时自动判定过期并清理', () => {
    const expiredTimestamp = Date.now() - 16 * 60 * 1000;
    mockStorage.set(
      STORAGE_KEYS.PENDING_IMPORT_REAUTH,
      JSON.stringify({
        url: 'https://github.com/cline/cline',
        createEdition: true,
        createdAt: expiredTimestamp,
      })
    );

    const restored = readPendingImportReauth();
    expect(restored).toBeNull();
    // 确保已从 storage 清除
    expect(mockStorage.has(STORAGE_KEYS.PENDING_IMPORT_REAUTH)).toBe(false);
  });

  it('解析异常或脏数据时静默 Fail-Closed 并清理', () => {
    mockStorage.set(STORAGE_KEYS.PENDING_IMPORT_REAUTH, 'invalid-json{{{');
    const restored = readPendingImportReauth();
    expect(restored).toBeNull();
    expect(mockStorage.has(STORAGE_KEYS.PENDING_IMPORT_REAUTH)).toBe(false);
  });

  it('clearPendingImportReauth 能安全清除存储', () => {
    savePendingImportReauth({
      url: 'https://github.com/cline/cline',
    });
    expect(readPendingImportReauth()).not.toBeNull();

    clearPendingImportReauth();
    expect(readPendingImportReauth()).toBeNull();
  });

  it('重新授权冷却期防死循环控制', () => {
    expect(isReauthInCooldown()).toBe(false);

    recordReauthAttempt();
    expect(isReauthInCooldown()).toBe(true);

    // 超过 20 秒冷却期后解除
    const pastTime = Date.now() - 25 * 1000;
    mockStorage.set(STORAGE_KEYS.PENDING_IMPORT_REAUTH_LAST_ATTEMPT, String(pastTime));
    expect(isReauthInCooldown()).toBe(false);

    // clearReauthAttempt 清除标记
    recordReauthAttempt();
    expect(isReauthInCooldown()).toBe(true);
    clearReauthAttempt();
    expect(isReauthInCooldown()).toBe(false);
  });
});

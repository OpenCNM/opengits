import { STORAGE_KEYS } from '@/lib/constants';

export interface PendingImportReauth {
  url: string;
  createEdition?: boolean;
  targetLanguage?: string;
  isPublic?: boolean;
  importMode?: 'github' | 'web';
  createdAt: number;
}

const MAX_REAUTH_PENDING_AGE_MS = 15 * 60 * 1000; // 15 分钟有效生命周期
const REAUTH_COOLDOWN_MS = 20 * 1000; // 20 秒防死循环重定向冷却窗口

/**
 * 记录一次向导发起的 GitHub 重新授权尝试
 */
export function recordReauthAttempt(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEYS.PENDING_IMPORT_REAUTH_LAST_ATTEMPT, String(Date.now()));
  } catch {
    // Fail-closed
  }
}

/**
 * 判断是否在重新授权冷却期内（防死循环：刚回跳再次收到 401 时不再自动跳转）
 */
export function isReauthInCooldown(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.PENDING_IMPORT_REAUTH_LAST_ATTEMPT);
    if (!raw) return false;
    const last = Number(raw) || 0;
    return Date.now() - last < REAUTH_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/**
 * 清理重新授权尝试标记
 */
export function clearReauthAttempt(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEYS.PENDING_IMPORT_REAUTH_LAST_ATTEMPT);
  } catch {
    // Fail-closed
  }
}

/**
 * 在触发 GitHub OAuth 重新授权前，保存当前导入向导未完成的目标教程与上下文。
 */
export function savePendingImportReauth(
  data: Omit<PendingImportReauth, 'createdAt'> & { createdAt?: number }
): void {
  if (typeof sessionStorage === 'undefined' || !data.url) return;
  try {
    const payload: PendingImportReauth = {
      url: data.url.trim(),
      createEdition: Boolean(data.createEdition),
      targetLanguage: data.targetLanguage,
      isPublic: data.isPublic,
      importMode: data.importMode || 'github',
      createdAt: data.createdAt || Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEYS.PENDING_IMPORT_REAUTH, JSON.stringify(payload));
  } catch {
    // Fail-closed
  }
}

/**
 * 授权回跳后读取待恢复的向导草稿。过期（>15min）或异常时安全返回 null 并清理。
 */
export function readPendingImportReauth(): PendingImportReauth | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.PENDING_IMPORT_REAUTH);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingImportReauth>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.url !== 'string' || !parsed.url.trim()) {
      clearPendingImportReauth();
      return null;
    }

    const age = Date.now() - (Number(parsed.createdAt) || 0);
    if (age < 0 || age > MAX_REAUTH_PENDING_AGE_MS) {
      clearPendingImportReauth();
      return null;
    }

    return {
      url: parsed.url.trim(),
      createEdition: Boolean(parsed.createEdition),
      targetLanguage: typeof parsed.targetLanguage === 'string' ? parsed.targetLanguage : undefined,
      isPublic: typeof parsed.isPublic === 'boolean' ? parsed.isPublic : undefined,
      importMode: parsed.importMode === 'web' ? 'web' : 'github',
      createdAt: Number(parsed.createdAt) || Date.now(),
    };
  } catch {
    clearPendingImportReauth();
    return null;
  }
}

/**
 * 清理已消费或已过期的待恢复向导任务。
 */
export function clearPendingImportReauth(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEYS.PENDING_IMPORT_REAUTH);
  } catch {
    // Fail-closed
  }
}

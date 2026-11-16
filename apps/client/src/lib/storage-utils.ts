/**
 * 自愈式客户端本地存储工具 (Self-healing LocalStorage Utilities)
 * 消除生吞异常的 catch {}，在 JSON 解析崩溃时自动告警并清空脏键，防止状态永久僵死。
 */

export function safeGetJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw === undefined) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[safeStorage] Corrupted JSON detected for key "${key}", auto-purging corrupted key:`, err);
    try {
      window.localStorage.removeItem(key);
    } catch {
      // 存储访问受限环境静默跳过
    }
    return fallback;
  }
}

export function safeSetJSON<T>(key: string, value: T): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[safeStorage] Failed to set item for key "${key}":`, err);
    return false;
  }
}

export function safeRemove(key: string): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch (err) {
    console.warn(`[safeStorage] Failed to remove key "${key}":`, err);
  }
}

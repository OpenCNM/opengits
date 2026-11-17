import { create } from 'zustand';
import { STORAGE_KEYS } from '@/lib/constants';

export const ENABLE_GUEST_MODE = true;

interface GuestSessionData {
  isGuest: boolean;
  lastViewedRepo?: string | null;
  activatedAt?: number;
}

function readStoredGuestSession(): GuestSessionData {
  if (typeof window === 'undefined') {
    return { isGuest: false, lastViewedRepo: null };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.GUEST_SESSION);
    if (!raw) return { isGuest: false, lastViewedRepo: null };
    const parsed = JSON.parse(raw);
    return {
      isGuest: Boolean(parsed?.isGuest),
      lastViewedRepo: parsed?.lastViewedRepo ?? null,
      activatedAt: parsed?.activatedAt,
    };
  } catch {
    return { isGuest: false, lastViewedRepo: null };
  }
}

function writeStoredGuestSession(data: GuestSessionData | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!data) {
      localStorage.removeItem(STORAGE_KEYS.GUEST_SESSION);
    } else {
      localStorage.setItem(STORAGE_KEYS.GUEST_SESSION, JSON.stringify(data));
    }
  } catch {
    // Fail silently on storage write failure (e.g. private browsing quota)
  }
}

export interface GuestState {
  isGuest: boolean;
  lastViewedRepo: string | null;
  enableGuestMode: (lastViewedRepo?: string | null) => void;
  setGuestMode: (enabled: boolean, lastViewedRepo?: string | null) => void;
  clearGuestMode: () => void;
}

const initialSession = readStoredGuestSession();

export const useGuestStore = create<GuestState>((set, get) => ({
  isGuest: ENABLE_GUEST_MODE && initialSession.isGuest,
  lastViewedRepo: initialSession.lastViewedRepo ?? null,

  enableGuestMode: (lastViewedRepo?: string | null) => {
    get().setGuestMode(true, lastViewedRepo);
  },

  setGuestMode: (enabled: boolean, lastViewedRepo?: string | null) => {
    if (!ENABLE_GUEST_MODE) return;
    const sessionData: GuestSessionData = {
      isGuest: enabled,
      lastViewedRepo: lastViewedRepo ?? null,
      activatedAt: Date.now(),
    };
    writeStoredGuestSession(enabled ? sessionData : null);
    set({
      isGuest: enabled,
      lastViewedRepo: lastViewedRepo ?? null,
    });
  },

  clearGuestMode: () => {
    writeStoredGuestSession(null);
    set({
      isGuest: false,
      lastViewedRepo: null,
    });
  },
}));

// Cross-tab synchronization via storage event:
// Guarantees zero-lag sync across multiple browser tabs when logging in or out
export function initGuestCrossTabSync(): (() => void) | undefined {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return undefined;
  }

  const handler = (event: StorageEvent) => {
    if (event.key === STORAGE_KEYS.GUEST_SESSION) {
      if (!event.newValue) {
        useGuestStore.setState({ isGuest: false, lastViewedRepo: null });
      } else {
        try {
          const parsed = JSON.parse(event.newValue);
          useGuestStore.setState({
            isGuest: Boolean(parsed?.isGuest),
            lastViewedRepo: parsed?.lastViewedRepo ?? null,
          });
        } catch {
          // 容错降级: 跨标签页消息解析失败时忽略畸变载荷
        }
      }
    }
  };

  window.addEventListener('storage', handler);
  return () => {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('storage', handler);
    }
  };
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  initGuestCrossTabSync();
}

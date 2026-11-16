import { create } from 'zustand';
import { api } from '@/lib/api/client';

export interface UserCreditsData {
  loggedIn: boolean;
  dailyLimit: number;
  usedCredits: number;
  frozenCredits: number;
  availableCredits: number;
  isUnlimited: boolean;
  maxPerImport: number;
  resetIntervalHours?: number;
  nextResetAt?: string | null;
  /** 贡献余额（持久钱包）：导入公开教程所得，加入个人项目时消耗 */
  creditBalance?: number;
}

interface UserCreditsStoreState {
  data: UserCreditsData | null;
  loading: boolean;
  initialized: boolean;

  fetchCredits: (options?: { force?: boolean }) => Promise<UserCreditsData | null>;
  setCreditsData: (data: UserCreditsData | null) => void;
  deductCredits: (fee: number, authoritativeBalance?: number) => void;
  addCredits: (amount: number, authoritativeBalance?: number) => void;
  setBalance: (balance: number) => void;
  reset: () => void;
  invalidate: () => Promise<void>;
}

let inFlightFetch: Promise<UserCreditsData | null> | null = null;

export const useUserCreditsStore = create<UserCreditsStoreState>()((set, get) => ({
  data: null,
  loading: false,
  initialized: false,

  setCreditsData: (data) => set({ data, initialized: true }),

  fetchCredits: async (options) => {
    const { force = false } = options || {};
    if (!force && get().initialized && get().data) {
      return get().data;
    }

    if (inFlightFetch) {
      return inFlightFetch;
    }

    set({ loading: true });

    inFlightFetch = (async () => {
      try {
        const json = await api.get<UserCreditsData>('/api/user/credits', {
          onUnauthorized: 'throw',
        });
        set({ data: json, initialized: true, loading: false });
        return json;
      } catch {
        set({ loading: false });
        return get().data;
      } finally {
        inFlightFetch = null;
      }
    })();

    return inFlightFetch;
  },

  deductCredits: (fee, authoritativeBalance) => {
    set((state) => {
      const current = state.data;
      const currentBalance = current?.creditBalance ?? 0;
      const safeFee = typeof fee === 'number' && Number.isFinite(fee) ? Math.max(0, fee) : 0;
      const nextBalance =
        typeof authoritativeBalance === 'number' && Number.isFinite(authoritativeBalance)
          ? authoritativeBalance
          : Math.max(0, currentBalance - safeFee);

      if (!current) {
        return {
          data: {
            loggedIn: true,
            dailyLimit: 0,
            usedCredits: 0,
            frozenCredits: 0,
            availableCredits: nextBalance,
            isUnlimited: false,
            maxPerImport: 0,
            creditBalance: nextBalance,
          },
          initialized: true,
        };
      }

      return {
        data: {
          ...current,
          creditBalance: nextBalance,
          availableCredits: current.isUnlimited ? current.availableCredits : nextBalance,
        },
      };
    });
  },

  addCredits: (amount, authoritativeBalance) => {
    set((state) => {
      const current = state.data;
      const currentBalance = current?.creditBalance ?? 0;
      const safeAmount = typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, amount) : 0;
      const nextBalance =
        typeof authoritativeBalance === 'number' && Number.isFinite(authoritativeBalance)
          ? authoritativeBalance
          : currentBalance + safeAmount;

      if (!current) {
        return {
          data: {
            loggedIn: true,
            dailyLimit: 0,
            usedCredits: 0,
            frozenCredits: 0,
            availableCredits: nextBalance,
            isUnlimited: false,
            maxPerImport: 0,
            creditBalance: nextBalance,
          },
          initialized: true,
        };
      }

      return {
        data: {
          ...current,
          creditBalance: nextBalance,
          availableCredits: current.isUnlimited ? current.availableCredits : nextBalance,
        },
      };
    });
  },

  setBalance: (balance) => {
    set((state) => {
      const safeBalance = typeof balance === 'number' && Number.isFinite(balance) ? Math.max(0, balance) : 0;
      if (!state.data) {
        return {
          data: {
            loggedIn: true,
            dailyLimit: 0,
            usedCredits: 0,
            frozenCredits: 0,
            availableCredits: safeBalance,
            isUnlimited: false,
            maxPerImport: 0,
            creditBalance: safeBalance,
          },
          initialized: true,
        };
      }
      return {
        data: {
          ...state.data,
          creditBalance: safeBalance,
          availableCredits: state.data.isUnlimited ? state.data.availableCredits : safeBalance,
        },
      };
    });
  },

  reset: () => {
    set({ data: null, initialized: false, loading: false });
  },

  invalidate: async () => {
    await get().fetchCredits({ force: true });
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    const state = useUserCreditsStore.getState();
    if (state.initialized && state.data?.loggedIn) {
      state.invalidate().catch(() => {});
    }
  });
}

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useUserCreditsStore, type UserCreditsData } from '@/lib/stores/user-credits-store';
import { api } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  api: {
    get: vi.fn(),
  },
}));

describe('useUserCreditsStore (第一性原理用户积分响应式状态机)', () => {
  const mockCredits: UserCreditsData = {
    loggedIn: true,
    dailyLimit: 1000,
    usedCredits: 0,
    frozenCredits: 0,
    availableCredits: 151,
    creditBalance: 151,
    isUnlimited: false,
    maxPerImport: 300,
    resetIntervalHours: 24,
    nextResetAt: '2026-10-11T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useUserCreditsStore.getState().reset();
  });

  it('初始状态为未初始化且无数据', () => {
    const state = useUserCreditsStore.getState();
    expect(state.data).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.initialized).toBe(false);
  });

  it('fetchCredits 成功拉取数据并更新状态', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(mockCredits);

    const result = await useUserCreditsStore.getState().fetchCredits();
    expect(result).toEqual(mockCredits);
    expect(useUserCreditsStore.getState().data).toEqual(mockCredits);
    expect(useUserCreditsStore.getState().initialized).toBe(true);
    expect(useUserCreditsStore.getState().loading).toBe(false);
  });

  it('并发多次 fetchCredits 进行请求去重，仅发起一次实际网络请求', async () => {
    let resolveApi: (value: UserCreditsData) => void;
    const promise = new Promise<UserCreditsData>((resolve) => {
      resolveApi = resolve;
    });
    vi.mocked(api.get).mockReturnValueOnce(promise);

    const call1 = useUserCreditsStore.getState().fetchCredits();
    const call2 = useUserCreditsStore.getState().fetchCredits();

    expect(api.get).toHaveBeenCalledTimes(1);

    resolveApi!(mockCredits);
    const [res1, res2] = await Promise.all([call1, call2]);

    expect(res1).toEqual(mockCredits);
    expect(res2).toEqual(mockCredits);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('已初始化且已有数据时，非 force 调用不再重复发起请求', async () => {
    useUserCreditsStore.getState().setCreditsData(mockCredits);
    expect(useUserCreditsStore.getState().initialized).toBe(true);

    const result = await useUserCreditsStore.getState().fetchCredits({ force: false });
    expect(result).toEqual(mockCredits);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('force: true 强制重新拉取最新物理数据', async () => {
    useUserCreditsStore.getState().setCreditsData(mockCredits);
    const updatedCredits: UserCreditsData = { ...mockCredits, creditBalance: 120, availableCredits: 120 };
    vi.mocked(api.get).mockResolvedValueOnce(updatedCredits);

    const result = await useUserCreditsStore.getState().fetchCredits({ force: true });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(result?.creditBalance).toBe(120);
    expect(useUserCreditsStore.getState().data?.creditBalance).toBe(120);
  });

  it('deductCredits 即时扣减积分，驱动 0ms 实时响应', () => {
    useUserCreditsStore.getState().setCreditsData(mockCredits);

    // 扣减 25 积分
    useUserCreditsStore.getState().deductCredits(25);
    expect(useUserCreditsStore.getState().data?.creditBalance).toBe(126);
    expect(useUserCreditsStore.getState().data?.availableCredits).toBe(126);

    // 再次扣减 26 积分
    useUserCreditsStore.getState().deductCredits(26);
    expect(useUserCreditsStore.getState().data?.creditBalance).toBe(100);
    expect(useUserCreditsStore.getState().data?.availableCredits).toBe(100);
  });

  it('deductCredits 传入服务端返回的权威余额时，精确对齐权威值', () => {
    useUserCreditsStore.getState().setCreditsData(mockCredits);

    // 服务端返回权威余额 141
    useUserCreditsStore.getState().deductCredits(10, 141);
    expect(useUserCreditsStore.getState().data?.creditBalance).toBe(141);
    expect(useUserCreditsStore.getState().data?.availableCredits).toBe(141);
  });

  it('deductCredits 扣减超额时下限钳制为 0，防止负余额', () => {
    useUserCreditsStore.getState().setCreditsData(mockCredits);

    useUserCreditsStore.getState().deductCredits(200);
    expect(useUserCreditsStore.getState().data?.creditBalance).toBe(0);
    expect(useUserCreditsStore.getState().data?.availableCredits).toBe(0);
  });

  it('addCredits 即时增加入账积分', () => {
    useUserCreditsStore.getState().setCreditsData(mockCredits);

    // 增加 30 礼金
    useUserCreditsStore.getState().addCredits(30);
    expect(useUserCreditsStore.getState().data?.creditBalance).toBe(181);
    expect(useUserCreditsStore.getState().data?.availableCredits).toBe(181);
  });

  it('setBalance 直接对齐权威余额', () => {
    useUserCreditsStore.getState().setCreditsData(mockCredits);

    useUserCreditsStore.getState().setBalance(88);
    expect(useUserCreditsStore.getState().data?.creditBalance).toBe(88);
    expect(useUserCreditsStore.getState().data?.availableCredits).toBe(88);
  });

  it('reset 重置所有状态', () => {
    useUserCreditsStore.getState().setCreditsData(mockCredits);
    useUserCreditsStore.getState().reset();

    const state = useUserCreditsStore.getState();
    expect(state.data).toBeNull();
    expect(state.initialized).toBe(false);
    expect(state.loading).toBe(false);
  });
});
